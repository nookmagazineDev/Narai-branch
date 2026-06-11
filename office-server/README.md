# Narai Usage API (รันในออฟฟิศ)

บริการเล็กๆ ต่อ MySQL POS แล้วส่งยอดใช้วัตถุดิบแยกตามเมนู (ตาราง `myfbdata<สาขา>.trn_usg`)
ให้หน้าเว็บ (ผ่าน Vercel) — แยกต่างหาก ไม่ยุ่งกับเซิร์ฟเวอร์ express เดิม

ปัจจุบัน**ติดตั้งและรันอยู่แล้ว**บนเครื่อง IT-Narai (192.168.2.143) ผ่าน pm2
เปิดพอร์ตออกเน็ตด้วย **UPnP อัตโนมัติ** (พอร์ต 8787) — เข้าถึงได้ที่ `http://storenarai.dyndns.tv:8787`

## โครงสร้าง
- `server.js` — ตัวบริการ (Express + mysql2). เปิดพอร์ต UPnP เองตอนสตาร์ท + รีเฟรชทุก 30 นาที
- `.env` — ค่าเชื่อมต่อ DB (ไม่ถูก commit). ดูตัวอย่างใน `.env.example`

## รัน / ดูแล
```bash
cd office-server
npm install
npm start            # ทดสอบรันครั้งเดียว
# โปรดักชันใช้ pm2:
pm2 start server.js --name narai-usage-api
pm2 save
```
- ดู log: `pm2 logs narai-usage-api`
- รีสตาร์ท: `pm2 restart narai-usage-api`
- หยุด: `pm2 stop narai-usage-api`

## ตั้งค่า Vercel
- `USAGE_API_BASE` = `http://storenarai.dyndns.tv:8787`
- Redeploy

## ข้อควรรู้
- **เครื่องนี้ต้องเปิดตลอด** (และล็อกอิน Windows ค้างไว้ เพื่อให้ pm2 สตาร์ทเองหลังรีบูต)
  ถ้าต้องการให้รันแม้ไม่ล็อกอิน ควรติดตั้ง pm2 เป็น Windows Service
- ถ้า router ปิด UPnP: ต้อง forward พอร์ต 8787 → 192.168.2.143 เองที่ router
- ข้อมูล `trn_usg` อาจช้ากว่าปัจจุบันไม่กี่วัน (ขึ้นกับรอบ sync ของ POS)
