const express = require('express');
const WebSocket = require('ws');
const https = require('https');
const app = express();

const SYMBOL = (process.env.SYMBOL || 'BTCUSDT').trim().toUpperCase();
const MAIN_TF = (process.env.MAIN_TF || '8h').trim();
const TF1 = (process.env.TF1 || '1h').trim();
const TF2 = (process.env.TF2 || '2h').trim();
const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
let TELEGRAM_CHAT_ID = (process.env.TELEGRAM_CHAT_ID || '').trim();
let telegramOffset = 0;

const BB_LEN = Number(process.env.BB_LEN || 20);
const BB_MULT = Number(process.env.BB_MULT || 2);
const RSI_MAX = Number(process.env.RSI_MAX || 50);
const VOL_MULT = Number(process.env.VOL_MULT || 1.15);
const SIDE_LOOKBACK = Number(process.env.SIDE_LOOKBACK || 6);
const SIDE_RANGE_PCT = Number(process.env.SIDE_RANGE_PCT || 1.2);

let main = [], c1 = [], c2 = [];
let phase = 0;
let lastPrice = null;
let lastAlert = {};
let instantUpperAlerted = false;
let instantLowerAlerted = false;
let statusText = 'starting';

function nowTH(){ return new Date().toLocaleString('th-TH', {timeZone:'Asia/Bangkok'}); }
function log(msg){ console.log(`[${nowTH()}] ${msg}`); }
function getJson(url){
  return new Promise((resolve,reject)=>{
    https.get(url, res=>{
      let data='';
      res.on('data', c=>data+=c);
      res.on('end', ()=>{
        if(res.statusCode < 200 || res.statusCode >= 300){ reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0,160)}`)); return; }
        try{ resolve(JSON.parse(data)); }catch(e){ reject(e); }
      });
    }).on('error', reject);
  });
}
async function loadHistory(symbol, interval, limit=350){
  const urls = [
    `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
    `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
    `https://www.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
  ];
  let lastErr = null;
  for(const url of urls){
    try{
      const data = await getJson(url);
      if(!Array.isArray(data) || data.length === 0) throw new Error('empty kline data');
      return data.map(k=>({time:Math.floor(k[0]/1000), open:+k[1], high:+k[2], low:+k[3], close:+k[4], volume:+k[5]}));
    }catch(e){ lastErr = e; log(`โหลด ${symbol} ${interval} จาก endpoint หนึ่งไม่ผ่าน: ${e.message}`); }
  }
  throw new Error(`โหลดประวัติไม่ได้ ${symbol} ${interval}: ${lastErr ? lastErr.message : ''}`);
}
function sma(a){ return a.reduce((x,y)=>x+y,0)/a.length; }
function std(a,m){ return Math.sqrt(a.reduce((s,x)=>s+(x-m)*(x-m),0)/a.length); }
function ema(values, period){
  if(values.length < period) return [];
  const k=2/(period+1); let out=[]; let prev=sma(values.slice(0,period)); out[period-1]=prev;
  for(let i=period;i<values.length;i++){ prev=values[i]*k+prev*(1-k); out[i]=prev; }
  return out;
}
function bbCalc(arr){
  if(arr.length < BB_LEN) return null;
  const closes=arr.slice(-BB_LEN).map(x=>x.close); const mid=sma(closes); const sd=std(closes,mid);
  return {upper:mid+BB_MULT*sd, mid, lower:mid-BB_MULT*sd};
}
function rsi(arr, period=14){
  if(arr.length < period+1) return null;
  let gains=0, losses=0;
  for(let i=arr.length-period;i<arr.length;i++){ const d=arr[i].close-arr[i-1].close; if(d>=0) gains+=d; else losses-=d; }
  const avgGain=gains/period, avgLoss=losses/period; if(avgLoss===0) return 100;
  return 100-(100/(1+avgGain/avgLoss));
}
function macd(arr){
  if(arr.length < 35) return null;
  const closes=arr.map(x=>x.close); const e12=ema(closes,12), e26=ema(closes,26); let line=[];
  for(let i=0;i<closes.length;i++){ if(e12[i]!==undefined && e26[i]!==undefined) line[i]=e12[i]-e26[i]; }
  const valid=line.filter(x=>x!==undefined); if(valid.length < 10) return null;
  const sig=ema(valid,9); const signal=sig[sig.length-1], prevSignal=sig[sig.length-2]; const m=valid[valid.length-1], pm=valid[valid.length-2];
  return {macd:m, signal, hist:m-signal, prevHist:pm-prevSignal};
}
function upsert(arr,c){ const last=arr[arr.length-1]; if(last && last.time===c.time) arr[arr.length-1]=c; else arr.push(c); if(arr.length>800) arr.shift(); }
function canAlert(key, sec=60){ const t=Date.now(); if(!lastAlert[key] || t-lastAlert[key]>sec*1000){ lastAlert[key]=t; return true; } return false; }
function telegramSend(text, chatId=TELEGRAM_CHAT_ID){
  if(!TELEGRAM_BOT_TOKEN || !chatId){ log('ยังไม่มี TELEGRAM_BOT_TOKEN หรือยังไม่รู้ CHAT_ID ให้กด /start ในบอทก่อน'); return; }
  const payload=JSON.stringify({chat_id:chatId, text, parse_mode:'HTML', disable_web_page_preview:true});
  const req=https.request({hostname:'api.telegram.org', path:`/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, method:'POST', headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}}, res=>res.on('data',()=>{}));
  req.on('error', e=>log('Telegram error: '+e.message)); req.write(payload); req.end();
}
function alert(key,title,message){
  if(!canAlert(key, key.includes('decision') ? 120 : 60)) return;
  const text=`🔔 <b>${title}</b>\n\n${message}\n\nเหรียญ: <b>${SYMBOL}</b>\nราคา: <b>${lastPrice ?? '-'}</b>\nเวลา: ${nowTH()}`;
  log(text.replace(/<[^>]+>/g,'')); telegramSend(text);
}
function candlePower(arr){
  if(arr.length<10) return {buy:0,sell:0,reasons:[],volBuy:false,volSell:false};
  const c=arr[arr.length-1], p=arr[arr.length-2]; const range=Math.max(c.high-c.low,1e-9); const body=Math.abs(c.close-c.open);
  const closePos=(c.close-c.low)/range*100; const lowerWick=(Math.min(c.open,c.close)-c.low)/range*100; const upperWick=(c.high-Math.max(c.open,c.close))/range*100;
  const avgVol=sma(arr.slice(-10,-1).map(x=>x.volume)); const volStrong=c.volume >= avgVol*VOL_MULT;
  let buy=0,sell=0,volBuy=false,volSell=false,reasons=[];
  if(c.close>c.open){buy+=2; reasons.push('แท่งเขียว');} else {sell+=2; reasons.push('แท่งแดง');}
  if(closePos>=65){buy+=2; reasons.push('ปิดใกล้ High');}
  if(lowerWick>=45){buy+=2; reasons.push('ไส้ล่างยาว');}
  if(p.close<p.open && c.close>c.open && c.close>p.open && c.open<p.close){buy+=3; reasons.push('Bullish Engulfing');}
  if(body/range>=.55 && c.close>c.open){buy+=2; reasons.push('บอดี้เขียวเต็ม');}
  if(volStrong && c.close>c.open){buy+=3; volBuy=true; reasons.push('Volume ซื้อเข้าจริง');}
  if(upperWick>=50 && c.close<c.open){sell+=3; reasons.push('ไส้บนยาว + แดง');}
  if(c.close<p.low){sell+=2; reasons.push('ปิดต่ำกว่า Low ก่อนหน้า');}
  if(volStrong && c.close<c.open){sell+=3; volSell=true; reasons.push('Volume ขายเข้าจริง');}
  return {buy,sell,reasons,volBuy,volSell};
}
function combinedPower(){ const a=candlePower(c1), b=candlePower(c2); return {buy:a.buy+b.buy, sell:a.sell+b.sell, volBuy:a.volBuy||b.volBuy, volSell:a.volSell||b.volSell, reasons:[...a.reasons.map(x=>`${TF1}: ${x}`), ...b.reasons.map(x=>`${TF2}: ${x}`)]}; }
function indicatorConfirm(){
  const arr=c1.length>=c2.length?c1:c2; const rv=rsi(arr), mv=macd(arr); const rsiOk=rv!==null && rv<RSI_MAX; let macdOk=false, reasons=[];
  if(rsiOk) reasons.push(`RSI ${rv.toFixed(1)} ต่ำกว่า ${RSI_MAX}`);
  if(mv){ const sellWeak=mv.hist<0 && mv.hist>mv.prevHist; const crossUp=mv.hist>0 && mv.prevHist<=0; const nearCross=Math.abs(mv.macd-mv.signal)<=Math.max(Math.abs(mv.macd)*0.25,0.000001); macdOk=sellWeak||crossUp||nearCross; if(macdOk) reasons.push('MACD Histogram แรงขายลด/ใกล้ตัดขึ้น'); }
  return {rsiOk, macdOk, reasons};
}
function isSideway(arr){ if(arr.length<SIDE_LOOKBACK) return {hit:false,pct:null}; const s=arr.slice(-SIDE_LOOKBACK); const hi=Math.max(...s.map(x=>x.high)), lo=Math.min(...s.map(x=>x.low)); const pct=(hi-lo)/((hi+lo)/2)*100; return {hit:pct<=SIDE_RANGE_PCT,pct}; }
function decide(){
  if(phase<2) return; const p=combinedPower(), ind=indicatorConfirm(); const buyComplete=p.buy>=p.sell+3 && p.volBuy && ind.rsiOk && ind.macdOk;
  if(buyComplete && phase===2){ phase=3; alert('completeBuy','สัญญาณซื้อเริ่มครบ',`หลังแตะ BB Lower และ Rebound\n✅ แท่ง ${TF1}/${TF2} บอกซื้อชนะ\n✅ Volume เข้าจริง\n✅ ${ind.reasons.join('\n✅ ')}\n\nเหตุผลแท่ง: ${p.reasons.join(' + ')}`); }
  if(phase>=3){ const side1=isSideway(c1), side2=isSideway(c2); if(side1.hit||side2.hit){ phase=4; const latest=combinedPower(); if(latest.buy>=latest.sell+3 && latest.volBuy){ alert('decisionBuy','จุดตัดสิน: ฝั่งซื้อชนะ',`ราคาเริ่มย่ำ Sideway หลัง Rebound จาก BB Lower\n✅ เด้งขึ้นพร้อม Volume เข้า\n✅ Buy Score ${latest.buy} > Sell Score ${latest.sell}`); } else if(latest.sell>=latest.buy+3||latest.volSell){ alert('decisionSell','จุดตัดสิน: ฝั่งขายยังชนะ',`ราคาเริ่ม Sideway แล้ว แต่แรงขายยังเด่น\nSell Score ${latest.sell} / Buy Score ${latest.buy}`); } else { alert('decisionNeutral','จุดตัดสิน: ยังสูสี',`เริ่ม Sideway แล้ว แต่ซื้อขายยังไม่ขาด\nBuy Score ${latest.buy} / Sell Score ${latest.sell}`); } } }
}
function analyzeLivePrice(price){
  lastPrice=price; const b=bbCalc(main); if(!b) return;
  if(phase===0 && !instantUpperAlerted && price>=b.upper){ instantUpperAlerted=true; phase=1; alert('instantUpper',`แตะ BB Upper TF ${MAIN_TF} แล้ว`,`ราคาแตะ BB Upper แบบ Live Tick\nBB Upper: ${b.upper.toFixed(2)}`); }
  if(phase===1 && !instantLowerAlerted && price<=b.lower){ instantLowerAlerted=true; alert('instantLower',`แตะ BB Lower TF ${MAIN_TF} แล้ว`,`ราคาแตะ BB Lower แบบ Live Tick\nเตรียมดู Rebound + แท่ง ${TF1}/${TF2} + Volume + RSI + MACD\nBB Lower: ${b.lower.toFixed(2)}`); }
  if(phase===1 && instantLowerAlerted && price>b.lower){ const reboundPct=((price-b.lower)/b.lower)*100; if(reboundPct>=0.03){ phase=2; alert('instantRebound','เริ่ม Rebound จาก BB Lower',`ราคาดีดกลับขึ้นจาก BB Lower แล้ว\nRebound: ${reboundPct.toFixed(3)}%`); decide(); } }
}
function klineToCandle(k){ return {time:Math.floor(k.t/1000),open:+k.o,high:+k.h,low:+k.l,close:+k.c,volume:+k.v}; }
function connectKline(interval,targetArr){
  const ws=new WebSocket(`wss://stream.binance.com:9443/ws/${SYMBOL.toLowerCase()}@kline_${interval}`);
  ws.on('open',()=>log(`เชื่อมต่อ kline ${interval}`));
  ws.on('message', raw=>{ const data=JSON.parse(raw.toString()); const c=klineToCandle(data.k); upsert(targetArr,c); if(phase>=2) decide(); });
  ws.on('close',()=>{ log(`kline ${interval} หลุด เชื่อมใหม่ใน 5 วิ`); setTimeout(()=>connectKline(interval,targetArr),5000); });
  ws.on('error',err=>log(`kline ${interval} error: ${err.message}`));
}
function connectTrade(){
  const ws=new WebSocket(`wss://stream.binance.com:9443/ws/${SYMBOL.toLowerCase()}@trade`);
  ws.on('open',()=>log('เชื่อมต่อ Live Tick @trade'));
  ws.on('message', raw=>{ const data=JSON.parse(raw.toString()); analyzeLivePrice(+data.p); });
  ws.on('close',()=>{ log('Live Tick หลุด เชื่อมใหม่ใน 5 วิ'); setTimeout(connectTrade,5000); });
  ws.on('error',err=>log('Live Tick error: '+err.message));
}
async function pollTelegram(){
  if(!TELEGRAM_BOT_TOKEN) return;
  try{
    const data=await getJson(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?timeout=0&offset=${telegramOffset}`);
    if(data.ok && Array.isArray(data.result)){
      for(const u of data.result){ telegramOffset=u.update_id+1; const msg=u.message||u.edited_message; if(!msg||!msg.chat) continue; TELEGRAM_CHAT_ID=String(msg.chat.id); const text=(msg.text||'').trim();
        if(text==='/start'||text==='start') telegramSend(`✅ Sneak Price เชื่อม Telegram แล้ว\n\nกำลังเฝ้า ${SYMBOL}\nTF หลัก: ${MAIN_TF}\nTF ยืนยัน: ${TF1}/${TF2}`, TELEGRAM_CHAT_ID);
        if(text==='/status'){ const b=bbCalc(main); telegramSend(`📊 สถานะ Sneak Price\nเหรียญ: ${SYMBOL}\nราคา: ${lastPrice ?? '-'}\nPhase: ${phase}\nBB: ${b ? `U ${b.upper.toFixed(2)} / M ${b.mid.toFixed(2)} / L ${b.lower.toFixed(2)}` : '-'}\nStatus: ${statusText}`, TELEGRAM_CHAT_ID); }
      }
    }
  }catch(e){ log('Telegram polling error: '+e.message); }
}
async function startTelegramPolling(){ if(!TELEGRAM_BOT_TOKEN){ log('ไม่มี TELEGRAM_BOT_TOKEN'); return; } setInterval(pollTelegram,5000); await pollTelegram(); }
app.get('/',(req,res)=>{ const b=bbCalc(main); res.send(`<html><head><meta charset="utf-8"><title>Sneak Price</title></head><body style="font-family:Arial;background:#0b1220;color:#e5e7eb;padding:24px"><h2>Sneak Price Server</h2><p>สถานะ: ${statusText}</p><p>เหรียญ: ${SYMBOL}</p><p>ราคา: ${lastPrice ?? '-'}</p><p>Phase: ${phase}</p><p>BB: ${b ? `Upper ${b.upper.toFixed(2)} / Mid ${b.mid.toFixed(2)} / Lower ${b.lower.toFixed(2)}` : '-'}</p><p>Telegram: ${TELEGRAM_CHAT_ID ? 'connected' : 'รอ /start ในบอท'}</p><p>เวลาไทย: ${nowTH()}</p></body></html>`); });
app.get('/health',(req,res)=>res.json({ok:true,symbol:SYMBOL,phase,lastPrice,statusText}));
async function bootstrap(){
  statusText='loading history'; log(`เริ่มระบบ ${SYMBOL} main=${MAIN_TF} confirm=${TF1}/${TF2}`);
  main=await loadHistory(SYMBOL,MAIN_TF,350); c1=await loadHistory(SYMBOL,TF1,250); c2=await loadHistory(SYMBOL,TF2,250);
  statusText='running'; log('โหลดประวัติสำเร็จ เริ่ม realtime'); connectKline(MAIN_TF,main); connectKline(TF1,c1); connectKline(TF2,c2); connectTrade(); startTelegramPolling(); telegramSend(`✅ Sneak Price เริ่มทำงานแล้ว\nเฝ้า ${SYMBOL}\nTF หลัก: ${MAIN_TF}`);
}
const PORT=process.env.PORT||3000;
app.listen(PORT,()=>{ log(`Dashboard: http://localhost:${PORT}`); bootstrap().catch(e=>{ statusText='error: '+e.message; log('Start error: '+e.message); startTelegramPolling(); }); });
