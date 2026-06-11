# Narai Usage API (รันในออฟฟิศ)

บริการเล็กๆ คำนวณ "ยอดใช้วัตถุดิบแยกตามเมนู" ให้หน้าเว็บ (ผ่าน Vercel)

**วิธีคำนวณ:** ยอดขายสด `ctranbetweendate` × สูตร (ชีท `CostMenu` + `RcpDtls`)
เส้นทาง: `sales.itemCode → CostMenu.A(BOT) → CostMenu.C(Kios) → RcpDtls.A(เมนู) → วัตถุดิบ × (G/I)`
> ตรวจสอบแล้วได้ผล**ตรงกับ trn_usg ของ POS เป๊ะ** และมีข้อมูล**เดือนปัจจุบัน** (ไม่ต้องรอ POS ปิดยอด)

ไม่ต้องต่อ MySQL — ใช้แค่ sales API + Google Sheets (public)

## จุดเด่น
- **Cache รายวัน**: ตอนสตาร์ทจะอุ่น cache ย้อนหลัง ~70 วัน (เบื้องหลัง ~3-4 นาที) หลังจากนั้น query เร็ว <10ms
- ข้อมูล "วันนี้" รีเฟรชอัตโนมัติทุก 20 นาที
- รีเฟรชสูตรทุก 6 ชม.
- เปิดพอร์ตออกเน็ตด้วย **UPnP อัตโนมัติ** (พอร์ต 8787)

## รัน / ดูแล (ติดตั้งแล้วบนเครื่อง IT-Narai ผ่าน pm2)
```bash
cd office-server
npm install
pm2 start server.js --name narai-usage-api
pm2 save
```
- ดู log: `pm2 logs narai-usage-api`
- เช็คสถานะ/จำนวนวันที่ cache: เปิด `http://localhost:8787/health`

## ตั้งค่า (ไม่บังคับ) — ไฟล์ .env
- `PORT` (ค่าเริ่มต้น 8787)
- `API_TOKEN` (ถ้าตั้ง ต้องส่ง header x-api-token ให้ตรง — ปัจจุบันเว้นว่าง)
- `WARM_DAYS` (จำนวนวันที่อุ่น cache, ค่าเริ่มต้น 70)
- `SALES_BASE` (URL ของ ctranbetweendate)
- `UPNP=off` ถ้าจะปิด UPnP (กรณี forward พอร์ตเองที่ router)

## ฝั่ง Vercel
`api/usagemenu.js` ชี้มาที่ `http://storenarai.dyndns.tv:8787` อยู่แล้ว (hardcode) — ไม่ต้องตั้ง env

## ข้อควรรู้
- เครื่องนี้ต้องเปิดตลอด (pm2 สตาร์ทเองหลังล็อกอิน Windows)
- ช่วงวันที่เก่ากว่า ~70 วัน (ที่ยังไม่ได้ cache) query ครั้งแรกจะช้าหน่อย (ดึงสดทีละวัน) แล้วค่อยเร็วในครั้งถัดไป
