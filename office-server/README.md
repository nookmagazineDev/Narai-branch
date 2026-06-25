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

## รัน / ดูแล (ติดตั้งแล้วบนเครื่อง IT-Narai เป็น **Windows Service**)
รันเป็น Windows Service ชื่อ `NaraiUsageAPI` (ผ่าน NSSM ที่ `C:\tools\nssm.exe`)
→ สตาร์ทเองเมื่อเปิดเครื่อง **แม้ไม่ล็อกอิน** + รีสตาร์ทเองถ้าแครช

คำสั่งดูแล (PowerShell, ต้อง Run as Administrator):
```powershell
Get-Service NaraiUsageAPI            # ดูสถานะ
Restart-Service NaraiUsageAPI        # รีสตาร์ท (หลังแก้โค้ด/แก้ .env)
Stop-Service NaraiUsageAPI           # หยุด
```
- log: `office-server\logs\service-out.log` และ `service-err.log`
- เช็คสถานะ/จำนวนวันที่ cache: เปิด `http://localhost:8787/health`

> เดิมรันผ่าน pm2 (สตาร์ทเฉพาะตอนล็อกอิน) เปลี่ยนมาเป็น Windows Service แล้วเพื่อให้ทนรีบูตโดยไม่ต้องล็อกอิน

## ตั้งค่า (ไม่บังคับ) — ไฟล์ .env
- `PORT` (ค่าเริ่มต้น 8787)
- `API_TOKEN` (ถ้าตั้ง ต้องส่ง header x-api-token ให้ตรง — ปัจจุบันเว้นว่าง)
- `WARM_DAYS` (จำนวนวันที่อุ่น cache, ค่าเริ่มต้น 70)
- `SALES_BASE` (URL ของ ctranbetweendate)
- `UPNP=off` ถ้าจะปิด UPnP (กรณี forward พอร์ตเองที่ router)

## Routes
- `GET /usagebymenu?branch&start&end` — ยอดใช้วัตถุดิบแยกตามเมนู
- `GET /usagebytable?branch&start&end&menu` — เมนูที่เลือกขายโต๊ะไหนบ้าง
- `GET /dashboard?branch&start&end` — **แดชบอร์ดสาขา** (ใหม่)
  - คืน `{ status, branch, outletId, data:{ sales, cost, profit, bills, covers, avgPerBill, costIsEstimate, daily:[{date,sales}] } }`
  - ใช้ cache รายวันชุดเดียวกับ usage จึงเร็ว และ payload เล็ก (เลี่ยงดึงดิบ ~300MB/เดือนมาที่เบราว์เซอร์)
  - **ยอดขาย** = Σ `grossPrice` (ไม่ void), **บิล** = ออเดอร์ที่ยอด>0, **ลูกค้า** = Σ cover/ออเดอร์, **เฉลี่ย/บิล** = ยอด×1.07/บิล
    (ตรวจกับหน้า NARAI OFFICE แล้ว: ยอดขาย/บิล ต่าง <0.5%, ลูกค้า ตรงเป๊ะ)
  - ⚠️ **ต้นทุน/กำไรเป็นประมาณการ** (`costIsEstimate:true`): คิดจากต้นทุนต่อเมนูใน `CostMenu` คอลัมน์ H
    ยังไม่หักกรณีบุฟเฟ่ต์ที่นับเนื้อ (กก)/(ที่) ซ้ำ จึง**สูงกว่า**ระบบ NARAI OFFICE — จะปรับให้ตรงเมื่อได้กติกาหักลบที่แน่นอน
    (ปรับคอลัมน์ต้นทุนได้ด้วย env `COST_MENU_COL`, ค่าเริ่มต้น 7 = H)

## ฝั่ง Vercel
`api/usagemenu.js` และ `api/dashboard.js` ชี้มาที่ `http://storenarai.dyndns.tv:8787` (ตั้ง env `USAGE_API_BASE` ทับได้)

> ⚠️ route `/dashboard` เป็นโค้ดใหม่ใน `server.js` — ต้อง **`Restart-Service NaraiUsageAPI`** บนเครื่องออฟฟิศก่อน หน้าเว็บถึงจะดึงได้

## ข้อควรรู้
- เครื่องนี้ต้องเปิดตลอด (pm2 สตาร์ทเองหลังล็อกอิน Windows)
- ช่วงวันที่เก่ากว่า ~70 วัน (ที่ยังไม่ได้ cache) query ครั้งแรกจะช้าหน่อย (ดึงสดทีละวัน) แล้วค่อยเร็วในครั้งถัดไป
