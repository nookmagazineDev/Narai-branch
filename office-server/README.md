# Endpoint ยอดใช้แยกเมนู (เพิ่มในเซิร์ฟเวอร์ express เดิม)

เพิ่ม endpoint เข้าไปใน **เซิร์ฟเวอร์ express เดิมที่รันพอร์ต 14365**
(ตัวที่มี `/express/ctranbetweendate`) เพราะพอร์ตนั้นเปิดออกเน็ตอยู่แล้ว — ไม่ต้องแตะ router

snippet `usagebymenu.route.js` **สร้าง MySQL connection ของตัวเอง** จึงไม่ต้องรู้/แก้ connection เดิมของเซิร์ฟเวอร์

## ขั้นตอน (ที่เครื่องซึ่งรันเซิร์ฟเวอร์ 14365)
1. ติดตั้ง driver: `npm install mysql2`
2. ก๊อปโค้ดทั้งหมดใน `usagebymenu.route.js` ไปวางในไฟล์เดียวกับ `/express/ctranbetweendate` (ไฟล์ที่มีตัวแปร `app`)
   - ถ้าไฟล์ใช้ `import` (ESM) เปลี่ยนบรรทัด `const mysql = require('mysql2/promise')` เป็น `import mysql from 'mysql2/promise'`
3. restart เซิร์ฟเวอร์
4. ทดสอบ: `http://storenarai.dyndns.tv:14365/express/usagebymenu?branch=zjp&start=2026-05-01&end=2026-05-31`

## ตั้งค่า Vercel
- `USAGE_API_BASE` = `http://storenarai.dyndns.tv:14365/express`
- `USAGE_API_TOKEN` = ลบทิ้งได้ (ไม่ใช้)
- Redeploy

## ข้อควรรู้
- ข้อมูล `trn_usg` อาจช้ากว่าปัจจุบันไม่กี่วัน (ขึ้นกับรอบ sync ของ POS)
- ถ้าอยากเปลี่ยน user MySQL ให้เป็นแบบอ่านอย่างเดียว แก้ค่าในส่วน `usagePool` ของ snippet
