
const express = require("express");
const WebSocket = require("ws");
const https = require("https");

const app = express();

const SYMBOL = (process.env.SYMBOL || "ETHUSDT").toUpperCase();
const MAIN_TF = process.env.MAIN_TF || "8h";
const TF1 = process.env.TF1 || "1h";
const TF2 = process.env.TF2 || "2h";

const BB_LEN = Number(process.env.BB_LEN || 20);
const BB_MULT = Number(process.env.BB_MULT || 2);
const RSI_MAX = Number(process.env.RSI_MAX || 50);
const VOL_MULT = Number(process.env.VOL_MULT || 1.15);
const SIDE_LOOKBACK = Number(process.env.SIDE_LOOKBACK || 6);
const SIDE_RANGE_PCT = Number(process.env.SIDE_RANGE_PCT || 1.2);

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

let main = [];
let c1 = [];
let c2 = [];
let phase = 0;
// 0 รอแตะ BB Upper
// 1 แตะ Upper แล้ว รอแตะ Lower
// 2 แตะ Lower + Rebound แล้ว อ่าน 1H/2H
// 3 สัญญาณซื้อครบ รอ Sideway
// 4 จุดตัดสิน

let lastPrice = null;
let lastAlert = {};
let instantUpperAlerted = false;
let instantLowerAlerted = false;

function nowTH() {
  return new Date().toLocaleString("th-TH", { timeZone: "Asia/Bangkok" });
}
function log(msg) {
  console.log(`[${nowTH()}] ${msg}`);
}
function sma(a) {
  return a.reduce((x, y) => x + y, 0) / a.length;
}
function std(a, m) {
  return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / a.length);
}
function ema(values, period) {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  let out = [];
  let prev = sma(values.slice(0, period));
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}
function bbCalc(arr) {
  if (arr.length < BB_LEN) return null;
  const closes = arr.slice(-BB_LEN).map(x => x.close);
  const mid = sma(closes);
  const sd = std(closes, mid);
  return { upper: mid + BB_MULT * sd, mid, lower: mid - BB_MULT * sd };
}
function rsi(arr, period = 14) {
  if (arr.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = arr.length - period; i < arr.length; i++) {
    const diff = arr[i].close - arr[i - 1].close;
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}
function macd(arr) {
  if (arr.length < 35) return null;
  const closes = arr.map(x => x.close);
  const e12 = ema(closes, 12);
  const e26 = ema(closes, 26);
  let macdLine = [];
  for (let i = 0; i < closes.length; i++) {
    if (e12[i] !== undefined && e26[i] !== undefined) macdLine[i] = e12[i] - e26[i];
  }
  const valid = macdLine.filter(x => x !== undefined);
  if (valid.length < 10) return null;
  const sig = ema(valid, 9);
  const signal = sig[sig.length - 1];
  const prevSignal = sig[sig.length - 2];
  const m = valid[valid.length - 1];
  const pm = valid[valid.length - 2];
  const hist = m - signal;
  const prevHist = pm - prevSignal;
  return { macd: m, signal, hist, prevHist };
}
function upsert(arr, c) {
  const last = arr[arr.length - 1];
  if (last && last.time === c.time) arr[arr.length - 1] = c;
  else arr.push(c);
  if (arr.length > 800) arr.shift();
}
function canAlert(key, sec = 60) {
  const t = Date.now();
  if (!lastAlert[key] || t - lastAlert[key] > sec * 1000) {
    lastAlert[key] = t;
    return true;
  }
  return false;
}
function telegramSend(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    log("ยังไม่ได้ตั้ง TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID จึงส่ง Telegram ไม่ได้");
    return;
  }
  const payload = JSON.stringify({
    chat_id: TELEGRAM_CHAT_ID,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true
  });
  const options = {
    hostname: "api.telegram.org",
    path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload)
    }
  };
  const req = https.request(options, res => {
    res.on("data", () => {});
  });
  req.on("error", e => log("Telegram error: " + e.message));
  req.write(payload);
  req.end();
}
function alert(key, title, message, important = true) {
  if (!canAlert(key, key.includes("decision") ? 120 : 60)) return;
  const text = `🔔 <b>${title}</b>\n\n${message}\n\nเหรียญ: <b>${SYMBOL}</b>\nราคา: <b>${lastPrice ?? "-"}</b>\nเวลา: ${nowTH()}`;
  log(text.replace(/<[^>]+>/g, ""));
  telegramSend(text);
}
function candlePower(arr) {
  if (arr.length < 10) return { buy: 0, sell: 0, reasons: [], volBuy: false, volSell: false };
  const c = arr[arr.length - 1], p = arr[arr.length - 2];
  const range = Math.max(c.high - c.low, 1e-9);
  const body = Math.abs(c.close - c.open);
  const closePos = (c.close - c.low) / range * 100;
  const lowerWick = (Math.min(c.open, c.close) - c.low) / range * 100;
  const upperWick = (c.high - Math.max(c.open, c.close)) / range * 100;
  const avgVol = sma(arr.slice(-10, -1).map(x => x.volume));
  const volStrong = c.volume >= avgVol * VOL_MULT;

  let buy = 0, sell = 0, volBuy = false, volSell = false, reasons = [];

  if (c.close > c.open) { buy += 2; reasons.push("แท่งเขียว"); }
  else { sell += 2; reasons.push("แท่งแดง"); }

  if (closePos >= 65) { buy += 2; reasons.push("ปิดใกล้ High"); }
  if (lowerWick >= 45) { buy += 2; reasons.push("ไส้ล่างยาว"); }
  if (p.close < p.open && c.close > c.open && c.close > p.open && c.open < p.close) {
    buy += 3; reasons.push("Bullish Engulfing");
  }
  if (body / range >= 0.55 && c.close > c.open) { buy += 2; reasons.push("บอดี้เขียวเต็ม"); }
  if (volStrong && c.close > c.open) { buy += 3; volBuy = true; reasons.push("Volume ซื้อเข้าจริง"); }

  if (upperWick >= 50 && c.close < c.open) { sell += 3; reasons.push("ไส้บนยาว + แดง"); }
  if (c.close < p.low) { sell += 2; reasons.push("ปิดต่ำกว่า Low ก่อนหน้า"); }
  if (volStrong && c.close < c.open) { sell += 3; volSell = true; reasons.push("Volume ขายเข้าจริง"); }

  return { buy, sell, reasons, volBuy, volSell };
}
function combinedPower() {
  const a = candlePower(c1);
  const b = candlePower(c2);
  return {
    buy: a.buy + b.buy,
    sell: a.sell + b.sell,
    volBuy: a.volBuy || b.volBuy,
    volSell: a.volSell || b.volSell,
    reasons: [
      ...a.reasons.map(x => `${TF1}: ${x}`),
      ...b.reasons.map(x => `${TF2}: ${x}`)
    ]
  };
}
function indicatorConfirm() {
  const arr = c1.length >= c2.length ? c1 : c2;
  const rv = rsi(arr);
  const mv = macd(arr);
  const rsiOk = rv !== null && rv < RSI_MAX;
  let macdOk = false;
  let reasons = [];

  if (rsiOk) reasons.push(`RSI ${rv.toFixed(1)} ต่ำกว่า ${RSI_MAX}`);
  if (mv) {
    const sellWeak = mv.hist < 0 && mv.hist > mv.prevHist;
    const crossUp = mv.hist > 0 && mv.prevHist <= 0;
    const nearCross = Math.abs(mv.macd - mv.signal) <= Math.max(Math.abs(mv.macd) * 0.25, 0.000001);
    macdOk = sellWeak || crossUp || nearCross;
    if (macdOk) reasons.push("MACD Histogram แรงขายลด/ใกล้ตัดขึ้น");
  }
  return { rsiOk, macdOk, reasons };
}
function isSideway(arr) {
  if (arr.length < SIDE_LOOKBACK) return { hit: false, pct: null };
  const s = arr.slice(-SIDE_LOOKBACK);
  const hi = Math.max(...s.map(x => x.high));
  const lo = Math.min(...s.map(x => x.low));
  const mid = (hi + lo) / 2;
  const pct = (hi - lo) / mid * 100;
  return { hit: pct <= SIDE_RANGE_PCT, pct };
}
function decide() {
  if (phase < 2) return;
  const p = combinedPower();
  const ind = indicatorConfirm();
  const buyComplete = p.buy >= p.sell + 3 && p.volBuy && ind.rsiOk && ind.macdOk;

  if (buyComplete && phase === 2) {
    phase = 3;
    alert(
      "completeBuy",
      "สัญญาณซื้อเริ่มครบ",
      `หลังแตะ BB Lower และ Rebound\n✅ แท่ง ${TF1}/${TF2} บอกซื้อชนะ\n✅ Volume เข้าจริง\n✅ ${ind.reasons.join("\n✅ ")}\n\nเหตุผลแท่ง: ${p.reasons.join(" + ")}`
    );
  }

  if (phase >= 3) {
    const side1 = isSideway(c1);
    const side2 = isSideway(c2);
    const sideHit = side1.hit || side2.hit;
    if (sideHit) {
      phase = 4;
      const latest = combinedPower();
      if (latest.buy >= latest.sell + 3 && latest.volBuy) {
        alert(
          "decisionBuy",
          "จุดตัดสิน: ฝั่งซื้อชนะ",
          `ราคาเริ่มย่ำ Sideway หลัง Rebound จาก BB Lower\n✅ เด้งขึ้นพร้อม Volume เข้า\n✅ Buy Score ${latest.buy} > Sell Score ${latest.sell}\n\nโซนนี้คือจุดพิจารณาเข้า/รอแท่งยืนยัน`,
          true
        );
      } else if (latest.sell >= latest.buy + 3 || latest.volSell) {
        alert(
          "decisionSell",
          "จุดตัดสิน: ฝั่งขายยังชนะ",
          `ราคาเริ่ม Sideway แล้ว แต่แรงขายยังเด่น\nSell Score ${latest.sell} / Buy Score ${latest.buy}\n\nยังไม่ควรรีบเข้า`,
          true
        );
      } else {
        alert(
          "decisionNeutral",
          "จุดตัดสิน: ยังสูสี",
          `เริ่ม Sideway แล้ว แต่ซื้อขายยังไม่ขาด\nBuy Score ${latest.buy} / Sell Score ${latest.sell}\n\nรอแท่งถัดไป`,
          true
        );
      }
    }
  }
}
function analyzeLivePrice(price) {
  lastPrice = price;
  const b = bbCalc(main);
  if (!b) return;

  if (phase === 0 && !instantUpperAlerted && price >= b.upper) {
    instantUpperAlerted = true;
    phase = 1;
    alert(
      "instantUpper",
      "แตะ BB Upper TF 8H แล้ว",
      `ราคาแตะ BB Upper แบบ Live Tick แล้ว\nเริ่มเฝ้ารอร่วงลงหา BB Lower\nBB Upper: ${b.upper.toFixed(2)}`
    );
  }

  if (phase === 1 && !instantLowerAlerted && price <= b.lower) {
    instantLowerAlerted = true;
    alert(
      "instantLower",
      "แตะ BB Lower TF 8H แล้ว",
      `ราคาแตะ BB Lower แบบ Live Tick แล้ว\nเตรียมดู Rebound + แท่ง ${TF1}/${TF2} + Volume + RSI + MACD\nBB Lower: ${b.lower.toFixed(2)}`,
      true
    );
  }

  if (phase === 1 && instantLowerAlerted && price > b.lower) {
    const reboundPct = ((price - b.lower) / b.lower) * 100;
    if (reboundPct >= 0.03) {
      phase = 2;
      alert(
        "instantRebound",
        "เริ่ม Rebound จาก BB Lower",
        `ราคาดีดกลับขึ้นจาก BB Lower แล้ว\nเริ่มอ่านแท่ง ${TF1}/${TF2} ทันที\nRebound: ${reboundPct.toFixed(3)}%`,
        true
      );
      decide();
    }
  }
}
function klineToCandle(k) {
  return {
    time: Math.floor(k.t / 1000),
    open: Number(k.o),
    high: Number(k.h),
    low: Number(k.l),
    close: Number(k.c),
    volume: Number(k.v)
  };
}
async function loadHistory(symbol, interval, limit = 350) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`โหลดประวัติไม่ได้ ${symbol} ${interval}`);
  const data = await res.json();
  return data.map(k => ({
    time: Math.floor(k[0] / 1000),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5])
  }));
}
function connectKline(interval, targetArr) {
  const url = `wss://stream.binance.com:9443/ws/${SYMBOL.toLowerCase()}@kline_${interval}`;
  const ws = new WebSocket(url);
  ws.on("open", () => log(`เชื่อมต่อ kline ${interval}`));
  ws.on("message", raw => {
    const data = JSON.parse(raw.toString());
    const c = klineToCandle(data.k);
    upsert(targetArr, c);
    if (phase >= 2) decide();
  });
  ws.on("close", () => {
    log(`kline ${interval} หลุด กำลังเชื่อมใหม่ใน 5 วิ`);
    setTimeout(() => connectKline(interval, targetArr), 5000);
  });
  ws.on("error", err => log(`kline ${interval} error: ${err.message}`));
}
function connectTrade() {
  const url = `wss://stream.binance.com:9443/ws/${SYMBOL.toLowerCase()}@trade`;
  const ws = new WebSocket(url);
  ws.on("open", () => log("เชื่อมต่อ Live Tick @trade"));
  ws.on("message", raw => {
    const data = JSON.parse(raw.toString());
    analyzeLivePrice(Number(data.p));
  });
  ws.on("close", () => {
    log("Live Tick หลุด กำลังเชื่อมใหม่ใน 5 วิ");
    setTimeout(connectTrade, 5000);
  });
  ws.on("error", err => log("Live Tick error: " + err.message));
}
app.get("/", (req, res) => {
  const b = bbCalc(main);
  res.send(`
    <html><head><meta charset="utf-8"><title>Sneak Price Server</title></head>
    <body style="font-family:Arial;background:#0b1220;color:#e5e7eb;padding:24px">
      <h2>Sneak Price Server Alert</h2>
      <p>สถานะ: ทำงานอยู่</p>
      <p>เหรียญ: ${SYMBOL}</p>
      <p>ราคา: ${lastPrice ?? "-"}</p>
      <p>Phase: ${phase}</p>
      <p>BB: ${b ? `Upper ${b.upper.toFixed(2)} / Mid ${b.mid.toFixed(2)} / Lower ${b.lower.toFixed(2)}` : "-"}</p>
      <p>เวลาไทย: ${nowTH()}</p>
    </body></html>
  `);
});
app.get("/health", (req, res) => res.json({ ok: true, symbol: SYMBOL, phase, lastPrice }));

async function mainStart() {
  log("กำลังโหลดประวัติราคา...");
  main = await loadHistory(SYMBOL, MAIN_TF, 350);
  c1 = await loadHistory(SYMBOL, TF1, 250);
  c2 = await loadHistory(SYMBOL, TF2, 250);
  log("โหลดประวัติสำเร็จ เริ่มเชื่อมต่อ realtime");
  connectKline(MAIN_TF, main);
  connectKline(TF1, c1);
  connectKline(TF2, c2);
  connectTrade();
  alert("serverStart", "Sneak Price เริ่มทำงานแล้ว", `ระบบเฝ้าราคา ${SYMBOL} ทำงานบน Server แล้ว\nไม่ต้องเปิดแอปค้างไว้`, true);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log(`Dashboard: http://localhost:${PORT}`);
  mainStart().catch(e => {
    log("Start error: " + e.message);
    process.exit(1);
  });
});
