# Narai Usage API (รันในออฟฟิศ)

บริการเล็กๆ คำนวณ "ยอดใช้วัตถุดิบแยกตามเมนู" ให้หน้าเว็บ (ผ่าน Vercel)

**วิธีคำนวณ:** ยอดขายสด `ctranbetweendate` × สูตร (ชีท `CostMenu` + `RcpDtls`)
เส้นทาง: `sales.itemCode → CostMenu.A(BOT) → CostMenu.C(Kios) → RcpDtls.A(เมนู) → วัตถุดิบ × (G/I)`
> ตรวจสอบแล้วได้ผล**ตรงกับ trn_usg ของ POS เป๊ะ** และมีข้อมูล**เดือนปัจจุบัน** (ไม่ต้องรอ POS ปิดยอด)

ไม่ต้องต่อ MySQL — ใช้แค่ sales API + Google Sheets (public)

## ให้บริการอะไรบ้าง

| เส้นทาง | ใช้ทำอะไร |
|---|---|
| `/usagebymenu`, `/usagebytable`, `/itemsales`, `/bills`, `/billdetail`, `/dashboard` | ยอดขาย/ยอดใช้วัตถุดิบ (คำนวณจาก POS + ชีทสูตร) |
| `/attendance` | ประวัติสแกนเข้า-ออกจาก ZKBio9 (SQL Server เครื่องเดียวกัน) |
| `POST /schedule` | **ตารางงาน** — ลงตารางสัปดาห์ / ประวัติ / อนุมัติ OT (ฐานข้อมูล `narai_hr` เครื่องเดียวกัน ดู `schedule.js`) |
| `/health` | เช็คว่าบริการยังอยู่ |

`/schedule` ย้ายมาอยู่ที่นี่เพราะไฟร์วอลล์เปิดพอร์ต 1433 ให้เฉพาะ IP ในไทย ฟังก์ชันบน Vercel
วิ่งมาจากต่างประเทศจึงต่อ SQL Server ตรงไม่ได้ — กดบันทึกตารางแล้วขึ้น error มาตลอด
เครื่องนี้ต่อผ่าน `localhost` ได้อยู่แล้ว และ Vercel ก็เรียกเครื่องนี้ที่พอร์ต 8787 ได้อยู่แล้ว จึงต่อกันสองทอด

```
เบราว์เซอร์ → /api/schedule (Vercel, เป็นแค่ตัวส่งต่อ) → :8787/schedule → SQL Server (localhost)
```

ต้องตั้ง `HR_DB_USER` / `HR_DB_PASSWORD` ใน `.env` ก่อนใช้งาน (ดู `.env.example`) แล้ว `Restart-Service NaraiUsageAPI`
ทดสอบว่าบันทึกลงฐานข้อมูลได้จริงด้วย `node scripts/test-schedule.mjs`

**หน้าล็อกอินก็มาทางนี้แล้ว** (action `login` → ตาราง `hr_user`) เป็น action เดียวที่เรียกได้โดยยังไม่มี `_user`
รหัสผ่านเก็บเป็นค่าที่ย้อนกลับไม่ได้ ไม่ใช่ข้อความล้วนแบบในชีท — ทดสอบด้วย `node scripts/test-login.mjs`
เพิ่มผู้ใช้/รีเซ็ตรหัสด้วยมือ: `node scripts/hash-password.mjs "รหัสที่ต้องการ"`
รายละเอียดทั้งหมดอยู่ใน [docs/hr-sql-migration.md](../docs/hr-sql-migration.md)

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

## ย้ายไปรันบนเครื่องคลาวด์ (แนะนำ)

รันบนเครื่องที่ออฟฟิศมีจุดอ่อนคือ **เครื่องปิด/เน็ตหลุด = ทุกสาขาดูยอดขายไม่ได้ทันที**
ทางแก้ถาวรคือย้ายไปรันบนเครื่องคลาวด์ `203.154.185.48` (`inventory.dyndns.tv`) ที่เปิดตลอดอยู่แล้ว
เครื่องนั้นยังเป็นที่อยู่ของ `api.khanoykorshabu.com` ด้วย จึงดึงข้อมูลขายได้ในเครื่องเอง ไม่ต้องออกเน็ต

```powershell
# บนเครื่องปลายทาง (Windows Server) — PowerShell แบบ Run as administrator
# ก๊อปโฟลเดอร์โค้ดไปวางก่อน แล้ว:
cd <โฟลเดอร์โค้ด>\office-server\scripts
powershell -ExecutionPolicy Bypass -File .\install-office-server.ps1
```

สคริปทำให้ครบ: `npm install` → สร้าง `.env` (ปิด UPnP เพราะเครื่องมี IP นิ่ง)
→ ติดตั้ง Windows Service ผ่าน NSSM (สตาร์ทเองตอนเปิดเครื่อง + รีสตาร์ทเองเมื่อโปรเซสตาย)
→ เปิดพอร์ต 8787 ใน firewall → ทดสอบ `/health` ให้เลย — **รันซ้ำได้ปลอดภัย**

ต้องมี Node.js กับ NSSM (`C:\tools\nssm.exe`) บนเครื่องนั้นก่อน ถ้าไม่มีสคริปจะบอกวิธีติดตั้ง

ฝั่ง Vercel ตั้ง env `USAGE_API_BASE = http://inventory.dyndns.tv:8787` ไว้แล้ว
พอ office-server ขึ้นที่เครื่องนั้น หน้าเว็บจะใช้ได้ทันที (อาจต้อง Redeploy หนึ่งครั้ง)

### ถ้าเข้าไปเปิดพอร์ตที่ router ไม่ได้ — ใช้ Cloudflare Tunnel แทน

เครื่องคลาวด์อยู่หลัง NAT (IP ภายใน `172.28.1.48`) ถ้าไม่มีสิทธิ์ forward พอร์ต 8787 ที่ router
ให้ใช้ Cloudflare Tunnel แทน — `cloudflared` ต่อ **ออก** ไปหา Cloudflare เอง แล้วเปิดทางกลับเข้ามา

```powershell
# สร้าง tunnel ที่ https://one.dash.cloudflare.com (Networks > Tunnels) เอา token มาก่อน แล้ว:
powershell -ExecutionPolicy Bypass -File .\install-cloudflare-tunnel.ps1 -Token "<token>"
```

ได้ `https://usage.khanoykorshabu.com` → `http://localhost:8787`
แล้วเปลี่ยน env บน Vercel เป็น `USAGE_API_BASE = https://usage.khanoykorshabu.com`

ดีกว่าการเปิดพอร์ตตรงๆ ตรงที่ได้ HTTPS ฟรี ไม่ต้องพึ่ง dyndns และไม่มีพอร์ตเปิดค้างให้สแกนเจอ

## ตั้งค่า (ไม่บังคับ) — ไฟล์ .env
- `PORT` (ค่าเริ่มต้น 8787)
- `API_TOKEN` (ถ้าตั้ง ต้องส่ง header x-api-token ให้ตรง — ปัจจุบันเว้นว่าง)
- `WARM_DAYS` (จำนวนวันที่อุ่น cache, ค่าเริ่มต้น 70)
- `SALES_BASE` (URL ของ ctranbetweendate)
- `UPNP=off` ถ้าจะปิด UPnP (กรณี forward พอร์ตเองที่ router)
- `SHEET_LOGIN_URL=off` ปิดการถามชีท User ตอนล็อกอิน (ตั้งเมื่อผู้ใช้ย้ายเข้า `hr_user` ครบแล้ว)

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

- `GET /attendance?branch&start&end[&emp]` — **ประวัติสแกนเข้า-ออก** (จาก ZKBio9 บน SQL Server เครื่องเดียวกัน)
  - คืน `{ status, branch, count, data:[{ empCode, name, time, date, state, stateLabel, area, terminal }] }`
  - `area_alias` ในตาราง `iclock_transaction` เก็บรหัสสาขาตรงกับที่เว็บใช้ (ตัวพิมพ์ใหญ่) จึงกรองด้วยสาขาได้เลย
  - ต่อ SQL Server ผ่าน `localhost` — ไม่ต้องเปิดพอร์ต 1433 ออกเน็ต (ตั้งค่า `ZK_DB_*` ใน `.env`)
  - ชื่อพนักงานดึงจาก `personnel_employee` แบบ best-effort (แคช 10 นาที) ถ้าอ่านไม่ได้จะแสดงเฉพาะรหัส
  - จำกัด 20,000 แถวต่อครั้ง

## ฝั่ง Vercel
`api/usagemenu.js` และ `api/dashboard.js` ชี้มาที่ `http://storenarai.dyndns.tv:8787` (ตั้ง env `USAGE_API_BASE` ทับได้)

> ⚠️ route `/dashboard` เป็นโค้ดใหม่ใน `server.js` — ต้อง **`Restart-Service NaraiUsageAPI`** บนเครื่องออฟฟิศก่อน หน้าเว็บถึงจะดึงได้

## ข้อควรรู้
- เครื่องนี้ต้องเปิดตลอด (pm2 สตาร์ทเองหลังล็อกอิน Windows)
- ช่วงวันที่เก่ากว่า ~70 วัน (ที่ยังไม่ได้ cache) query ครั้งแรกจะช้าหน่อย (ดึงสดทีละวัน) แล้วค่อยเร็วในครั้งถัดไป
