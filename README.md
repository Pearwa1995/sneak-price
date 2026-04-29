# Sneak Price Fixed

เวอร์ชันแก้ปัญหา Render ขึ้น 502 / โหลด Binance ไม่ผ่าน

เพิ่ม:
- ไม่ crash เวลา Binance historical endpoint โหลดไม่ผ่าน
- มี fallback endpoint หลายตัว
- Telegram รับ /start และ /status ได้
- ไม่ต้องใส่ TELEGRAM_CHAT_ID ก่อน ส่ง /start แล้วระบบจำเอง

Environment:
- SYMBOL=BTCUSDT
- TELEGRAM_BOT_TOKEN=token จาก BotFather
- MAIN_TF=8h
- TF1=1h
- TF2=2h
