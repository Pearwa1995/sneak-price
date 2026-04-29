# Sneak Price Server Alert

เวอร์ชันนี้ทำงานบน Server 24 ชม. ไม่ต้องเปิดแอปค้างไว้  
เมื่อเข้าเงื่อนไข จะส่งแจ้งเตือนเข้า Telegram

## ต้องตั้งค่า Environment Variables

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

ตั้งค่าเสริมได้:
- `SYMBOL` ค่าเริ่มต้น `ETHUSDT`
- `MAIN_TF` ค่าเริ่มต้น `8h`
- `TF1` ค่าเริ่มต้น `1h`
- `TF2` ค่าเริ่มต้น `2h`
- `RSI_MAX` ค่าเริ่มต้น `50`
- `VOL_MULT` ค่าเริ่มต้น `1.15`

## ใช้บน Render / Railway / Replit

คำสั่งเริ่ม:
```bash
npm install
npm start
```

## หมายเหตุ
Netlify ไม่เหมาะกับระบบเฝ้าราคาแบบ realtime 24 ชม. เพราะ serverless function ไม่รันค้างตลอดเวลา
แนะนำ Render / Railway / Replit / VPS
