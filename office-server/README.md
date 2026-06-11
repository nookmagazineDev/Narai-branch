# Narai Usage API (รันในออฟฟิศ)

บริการเล็กๆ แยกต่างหาก ทำหน้าที่อ่านยอดใช้วัตถุดิบแยกตามเมนูจาก MySQL POS
(ตาราง `myfbdata<สาขา>.trn_usg`) แล้วส่งให้หน้าเว็บ (ผ่าน Vercel) — **ไม่ยุ่งกับเซิร์ฟเวอร์ express เดิม**

## ติดตั้ง / รัน

```bash
cd office-server
copy .env.example .env       # Windows (หรือ cp บน mac/linux)
# แก้ .env ใส่รหัสผ่าน DB + ตั้ง API_TOKEN
npm install
npm start
```

ขึ้นว่า `Narai Usage API running on port 8787` = ใช้ได้

ทดสอบในเครื่อง:
```
http://localhost:8787/health                 -> {"ok":true}
http://localhost:8787/usagebymenu?branch=zjp&start=2026-05-01&end=2026-05-31
```

## ทำให้ Vercel เรียกได้ (เปิดออกเน็ต)

1. **Port forward** ที่ router: เปิด port `8787` (หรือพอร์ตที่ตั้ง) ชี้มาเครื่องที่รันบริการนี้
2. ใช้ชื่อ dyndns ที่มีอยู่ เช่น `http://inventory.dyndns.tv:8787`
3. ตั้ง Environment Variables บน **Vercel**:
   - `USAGE_API_BASE` = `http://inventory.dyndns.tv:8787`
   - `USAGE_API_TOKEN` = (ค่าเดียวกับ API_TOKEN ใน .env)
   แล้ว Redeploy

> เปิดออกเน็ตเฉพาะพอร์ตของบริการนี้ (ไม่ใช่ port MySQL 3306) — ปลอดภัยกว่า และมี token กันไว้อีกชั้น

## ให้รันค้างตลอด (แนะนำ)

ใช้ pm2:
```bash
npm install -g pm2
pm2 start server.js --name narai-usage-api
pm2 save
pm2 startup
```

## สิทธิ์ MySQL

user ที่ตั้งใน .env ต้องอ่าน database `myfbdata*` ทุกสาขาได้ (SELECT)
แนะนำสร้าง user อ่านอย่างเดียว แทนการใช้ root
