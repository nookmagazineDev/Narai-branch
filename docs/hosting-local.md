# การรันเว็บบนเครื่อง 203.154.185.48 (แทน Vercel)

ตั้งแต่ 30/10/2026 เว็บไม่ได้รันบน Vercel แล้ว — เข้าใช้งานที่ **https://branch.khanoykorshabu.com**
merge เข้า `main` แล้วจะ **ไม่ deploy เอง** ต้องอัปเดตบนเครื่องตามหัวข้อ "อัปเดตหลัง merge"

## มีอะไรรันอยู่บนเครื่องบ้าง

| ตัว | ที่อยู่ | พอร์ต | หน้าที่ |
|---|---|---|---|
| `serve-local.mjs` (service `NaraiBranchWeb`) | `C:\narai-local\narai-branch` | 3102 | หน้าเว็บ (`dist/`) + `api/*.js` (แทน Vercel Functions) อ่าน env จาก `.env` ข้างไฟล์ |
| office-server (service `NaraiUsageAPI`) | `D:\Narai-branch-main\office-server` | 8787 | ตารางงาน, ยูนิฟอร์ม, สต๊อก, ยอดขาย/แดชบอร์ด |
| MySQL 5.0 (AppServ, service `mysql`) | `C:\AppServ\MySQL` | 3306 | ใบเบิก/ใบรับ (`myfbdata`, `myfbdata<สาขา>`) |
| SQL Server | — | 1433 | `narai_hr`, `InventoryNarai` (office-server ต่อผ่าน localhost) |

`serve-local.mjs` ไม่ได้อยู่ใน repo นี้ (อยู่บนเครื่องเท่านั้น ต้นฉบับที่ `C:\narai-local\setup\`)

## ให้เว็บเปิดเองหลังรีบูต (ทำครั้งเดียว)

คลิกขวา `C:\narai-local\narai-branch\install-web-service.bat` → Run as administrator
ตั้ง `serve-local.mjs` เป็น Windows Service `NaraiBranchWeb` ผ่าน NSSM (`C:\tools\nssm.exe`) แบบเดียวกับ office-server:
สตาร์ทเองตอนเปิดเครื่อง, สตาร์ทใหม่เมื่อโปรเซสตาย, log ยังอยู่ที่ `local-out.log` / `local-err.log` — รันซ้ำได้

หลังตั้ง service แล้ว `update-web.bat` ต้องเปิดแบบ **Run as administrator** (ต้องใช้สิทธิ์รีสตาร์ต service)
และห้ามเปิด `serve-local.mjs` ด้วย `Start-Process` ซ้อนอีกตัว — พอร์ต 3102 จะชนกับ service

## `.env` ของเว็บ (`C:\narai-local\narai-branch\.env`)

ไฟล์ตั้งต้นดึงมาจาก Vercel (`vercel env pull`) ค่าที่ต้องแก้ให้เหมาะกับการรันในเครื่อง:

```
MYSQL_HOST="127.0.0.1"
MYSQL_DATABASE="myfbdata"
MYSQL_USER="narai_web"          # user เฉพาะเว็บ สิทธิ์เฉพาะ myfbdata% ต่อได้จาก localhost/127.0.0.1 เท่านั้น
MYSQL_PASSWORD="..."
USAGE_API_BASE="http://localhost:8787"
```

ห้ามใช้ `inventory.dyndns.tv` หรือ IP สาธารณะของเครื่องเอง — จากในเครื่องชื่อ dyndns resolve ไม่ได้
(`getaddrinfo ENOTFOUND`) และเราเตอร์ไม่วนกลับเข้าหาตัวเอง (timeout)

ค่าเริ่มต้นในโค้ด (`lib/mysql.js`, `lib/upstream.js`) เป็น localhost แล้ว ถ้า `.env` ไม่ได้ตั้งไว้ก็ใช้ได้

## อัปเดตหลัง merge

1. **office-server** — คลิกขวา `D:\Narai-branch-main\office-server\update-office-server.bat` → Run as administrator
   (git pull + npm install + อัปเดตตาราง + restart service แล้วเช็ค `code_sha` ให้)
2. **หน้าเว็บ + api/** — คลิกขวา `C:\narai-local\narai-branch\update-web.bat` → Run as administrator
   (git pull + npm install เมื่อจำเป็น + build ลงโฟลเดอร์ชั่วคราวก่อนสลับเข้า `dist` + restart `serve-local.mjs` แล้วเช็คว่าตอบ 200)
   ห้ามรัน `npm install` เองโดยไม่ลงต่อ `npm install express@4 dotenv --no-save` — `serve-local.mjs` จะหา express ไม่เจอ
   ถ้าต้องทำมือ: ตั้ง service แล้วใช้ `Restart-Service NaraiBranchWeb` · ยังไม่ตั้ง service ใช้:

```powershell
Get-Process node | Where-Object { (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)").CommandLine -match "serve-local" } | Stop-Process -Force
cd C:\narai-local\narai-branch; Start-Process node -ArgumentList "serve-local.mjs" -RedirectStandardOutput local-out.log -RedirectStandardError local-err.log -WindowStyle Hidden
```

## เช็คว่าใช้งานได้

```powershell
Invoke-WebRequest "http://localhost:3102/api/pending_orders?outletId=1" -UseBasicParsing | Select-Object StatusCode,Content
(Invoke-WebRequest http://localhost:8787/health -UseBasicParsing).Content
Get-Content C:\narai-local\narai-branch\local-err.log -Tail 15
```

## กรอกรายจ่ายย้ายเข้า SQL (พ.ย. 2026)

เดิมหน้ากรอกรายจ่ายบันทึกลงชีท "ต้นทุนจากsup" ผ่าน Apps Script ตอนนี้อยู่ที่ `InventoryNarai.dbo.stock_sup_cost`
(`office-server/supcost.js`) ทั้งหน้ากรอกรายจ่าย สรุปกำไร และยอดรับในหน้านับสต๊อก (`/api/stockcount`)

ขั้นตอนย้าย (ทำครั้งเดียว ตามลำดับ):

1. `update-office-server.bat` (Run as administrator) — สร้างตารางจาก `office-server/sql/supcost-001-table.sql` + เพิ่ม action
2. `update-web.bat` (Run as administrator) — หน้าเว็บเปลี่ยนไปบันทึก/อ่าน SQL
3. ย้ายข้อมูลเก่า (PowerShell ในโฟลเดอร์ `D:\Narai-branch-main\office-server`):

```powershell
node scripts/import-sup-cost.mjs            # รายงานอย่างเดียว ตรวจจำนวน/ยอดเงินรายสาขาก่อน
node scripts/import-sup-cost.mjs --apply    # เขียนจริง
```

รันซ้ำได้ — เติมเฉพาะ (วันที่+สาขา+สินค้า) ที่ยังไม่มี ไม่แตะแถวที่สาขากรอกผ่านเว็บหลังย้าย
ถ้ามีเครื่องที่ยังถือหน้าเว็บรุ่นเก่าบันทึกลงชีทตามมาอีก รันซ้ำก็เก็บตกให้

ไม่บังคับ: deploy `apps-script.js` ใหม่ (มี `saveSupCost`/`getSupCost` ใน `MOVED_TO_SQL`) ให้เครื่องที่ถือหน้าเว็บรุ่นเก่า
ได้ข้อความให้รีเฟรช แทนที่จะบันทึกลงชีทเงียบ ๆ

## ค่าใช้จ่ายอื่น ๆ ในตารางสรุปกำไร บันทึกลง SQL (พ.ย. 2026)

ช่องกรอกเองในตารางสรุปกำไร/ขาดทุนบน Dashboard (Petty Cash, ค่าเช่าพื้นที่, ค่าน้ำ, ค่าไฟ, ค่าน้ำแข็ง, ค่าโทรศัพท์,
ค่าแก๊ส, ค่าประกันภัย + ยอดขาย Member / Delivery) เดิมไม่ได้บันทึกที่ไหนเลย รีเฟรชแล้วหาย ตอนนี้เก็บที่
`InventoryNarai.dbo.profit_expense` ต่อเดือนต่อสาขา (`office-server/profitexpense.js`) ทุกสาขากรอกของตัวเองได้
บันทึกให้เองทันทีที่ออกจากช่อง/กด Enter · ช่วงวันที่ต้องอยู่ในเดือนเดียวถึงแก้ได้ (คร่อมหลายเดือนแสดงยอดรวม)

ขั้นตอน (ตามลำดับ):

1. `update-office-server.bat` (Run as administrator) — สร้างตารางจาก `office-server/sql/profitexp-001-table.sql` + เพิ่ม action
2. `update-web.bat` (Run as administrator) — หน้าเว็บโหลด/บันทึกค่าใช้จ่ายผ่าน SQL
3. ย้ายข้อมูลเดิมจาก Google Sheet (PowerShell ในโฟลเดอร์ `D:\Narai-branch-main\office-server`)
   ตั้งแชร์ชีทเป็น "ทุกคนที่มีลิงก์ • ผู้อ่าน" ก่อน แล้วก๊อป URL ของแท็บนั้นมาวาง:

```powershell
node scripts/import-profit-expense.mjs --url="https://docs.google.com/spreadsheets/d/.../edit#gid=..."            # รายงานอย่างเดียว
node scripts/import-profit-expense.mjs --url="https://docs.google.com/spreadsheets/d/.../edit#gid=..." --apply    # เขียนจริง
```

สคริปต์อ่านหัวตารางแล้วเดารูปแบบให้เอง (แถวละเดือน / รายการเป็นแถว-เดือนเป็นคอลัมน์ / แถวละรายจ่าย) ดูบรรทัด
"รูปแบบชีท" กับตารางตัวเลขที่พิมพ์ออกมาให้ตรงกับชีทก่อนใส่ `--apply` · แท็บที่เป็นของสาขาเดียวใส่ `--branch=crm`
แท็บที่เป็นของเดือนเดียวใส่ `--month=2026-10` · รันซ้ำได้ ไม่แตะค่าที่สาขากรอกผ่านเว็บ
