# การรันเว็บบนเครื่อง 203.154.185.48 (แทน Vercel)

ตั้งแต่ 30/10/2026 เว็บไม่ได้รันบน Vercel แล้ว — เข้าใช้งานที่ **https://branch.khanoykorshabu.com**
merge เข้า `main` แล้วจะ **ไม่ deploy เอง** ต้องอัปเดตบนเครื่องตามหัวข้อ "อัปเดตหลัง merge"

## มีอะไรรันอยู่บนเครื่องบ้าง

| ตัว | ที่อยู่ | พอร์ต | หน้าที่ |
|---|---|---|---|
| `serve-local.mjs` | `C:\narai-local\narai-branch` | 3102 | หน้าเว็บ (`dist/`) + `api/*.js` (แทน Vercel Functions) อ่าน env จาก `.env` ข้างไฟล์ |
| office-server (service `NaraiUsageAPI`) | `D:\Narai-branch-main\office-server` | 8787 | ตารางงาน, ยูนิฟอร์ม, สต๊อก, ยอดขาย/แดชบอร์ด |
| MySQL 5.0 (AppServ, service `mysql`) | `C:\AppServ\MySQL` | 3306 | ใบเบิก/ใบรับ (`myfbdata`, `myfbdata<สาขา>`) |
| SQL Server | — | 1433 | `narai_hr`, `InventoryNarai` (office-server ต่อผ่าน localhost) |

`serve-local.mjs` ไม่ได้อยู่ใน repo นี้ (อยู่บนเครื่องเท่านั้น ต้นฉบับที่ `C:\narai-local\setup\`)

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
2. **หน้าเว็บ + api/** — ใน `C:\narai-local\narai-branch`: ดึงโค้ดใหม่, `npm install`, `npm run build`
   แล้ว restart `serve-local.mjs`:

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
