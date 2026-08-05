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

**เวลาหน้าเว็บขึ้น "เครื่อง IT-Narai อาจปิดอยู่"** ให้เปิดเครื่องก่อน แล้วรันสคริปตรวจ+ซ่อม:
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\fix-narai-api.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\fix-narai-api.ps1 -Harden   # + กันดับซ้ำ (ทำครั้งเดียวพอ)
```
ไล่ตรวจให้ทีละชั้น (Node → service → /health → firewall → dyndns ชี้ IP ถูกไหม) แล้วซ่อมเท่าที่ซ่อมได้
`-Harden` เพิ่ม: ไม่ให้เครื่องหลับ + auto-restart เมื่อโปรเซสตาย + ตัวเฝ้าระวังทุก 5 นาที
รายละเอียดที่ [`docs/troubleshooting-server.md`](../docs/troubleshooting-server.md)
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
  - คืน `{ status, branch, outletId, data:{ sales, cost, prepCost, prepQty, profit, excludedCost, excludedQty, bills, covers, avgPerBill, daily:[{date,sales}] } }`
  - ใช้ cache รายวันชุดเดียวกับ usage จึงเร็ว และ payload เล็ก (เลี่ยงดึงดิบ ~300MB/เดือนมาที่เบราว์เซอร์)
  - **สูตรตรงกับ NARAI OFFICE (ตรวจแล้วตรงทุกการ์ดถึงทศนิยม):**
    - **ยอดขาย** = Σ `billTotal` − Σ `vat` จาก `cpaidbetweendate` (ตัดโต๊ะ 600)
    - **บิล** = จำนวนบิลที่จ่ายแล้ว, **เฉลี่ย/บิล** = Σ`billTotal`/บิล (รวม VAT)
    - **ลูกค้า** = Σ qty ไอเทมบุฟเฟ่ `[101001-101004,101107,101108]`
    - **ต้นทุนรวม** = Σ `CostMenu`[itemCode]×qty (ตัดโต๊ะ 600 + ไอเทม `206001`/`500002-500026`, แยกวัตถุดิบ "โต๊ะเตรียม(กก)" ออก)
    - **ต้นทุนโต๊ะเตรียม(กก)** = วัตถุดิบ `PREP_KG_ITEMS` (12 รหัส), **รายการไม่นับคำนวณ** = มูลค่าไอเทมที่ตัดออก
    - **กำไร** = ยอดขาย(ก่อน VAT) − ต้นทุนรวม
  - กติกา exclude/prep/cover ตั้งเป็นค่าคงที่ในไฟล์ (`DASH_EXCLUDE_*`, `DASH_PREP_KG_ITEMS`, `DASH_COVER_ITEMS`) — ตรงกับ NARAI OFFICE
  - ต้องเข้าถึง `cpaidbetweendate` ได้ (ตั้ง env `PAID_BASE` ทับได้ ค่าเริ่มต้น = `SALES_BASE` แทน `ctranbetweendate`→`cpaidbetweendate`)

## ฝั่ง Vercel
`api/usagemenu.js` และ `api/dashboard.js` ชี้มาที่ `http://storenarai.dyndns.tv:8787` (ตั้ง env `USAGE_API_BASE` ทับได้)

> ⚠️ route `/dashboard` เป็นโค้ดใหม่ใน `server.js` — ต้อง **`Restart-Service NaraiUsageAPI`** บนเครื่องออฟฟิศก่อน หน้าเว็บถึงจะดึงได้

## ข้อควรรู้
- เครื่องนี้ต้องเปิดตลอด (pm2 สตาร์ทเองหลังล็อกอิน Windows)
- ช่วงวันที่เก่ากว่า ~70 วัน (ที่ยังไม่ได้ cache) query ครั้งแรกจะช้าหน่อย (ดึงสดทีละวัน) แล้วค่อยเร็วในครั้งถัดไป
