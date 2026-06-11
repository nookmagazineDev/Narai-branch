# Endpoint ยอดใช้แยกเมนู (เพิ่มในเซิร์ฟเวอร์ express เดิม)

เราเลือกเพิ่ม endpoint เข้าไปใน **เซิร์ฟเวอร์ express เดิมที่รันพอร์ต 14365**
(ตัวที่มี `/express/ctranbetweendate`) เพราะพอร์ตนั้นเปิดออกเน็ตอยู่แล้ว — ไม่ต้องแตะ router

## ขั้นตอน
1. เปิดโค้ดเซิร์ฟเวอร์ express (เครื่องที่รัน 14365)
2. ก๊อป route จาก `usagebymenu.route.js` ไปวางในไฟล์เดียวกับ `/express/ctranbetweendate`
3. เปลี่ยน `pool` ในโค้ด ให้ตรงกับตัวแปร MySQL connection/pool ที่เซิร์ฟเวอร์ใช้อยู่
4. restart เซิร์ฟเวอร์
5. ทดสอบ: `http://storenarai.dyndns.tv:14365/express/usagebymenu?branch=zjp&start=2026-05-01&end=2026-05-31`

## ตั้งค่า Vercel
- `USAGE_API_BASE` = `http://storenarai.dyndns.tv:14365/express`
- `USAGE_API_TOKEN` = ไม่ต้องใช้กับ endpoint นี้ (จะลบทิ้งหรือเก็บไว้ก็ได้ เซิร์ฟเวอร์ไม่ตรวจ)
- Redeploy

## ข้อควรรู้
- MySQL user ของเซิร์ฟเวอร์ต้องมีสิทธิ์ SELECT บน database `myfbdata*` ทุกสาขา
- ข้อมูล `trn_usg` อาจช้ากว่าปัจจุบันไม่กี่วัน (ขึ้นกับรอบ sync ของ POS)
