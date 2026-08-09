# ติดตั้งตัวซิงก์รายการสินค้า (Google Sheets -> SQL Server) เป็น Scheduled Task
#
# รันบนเครื่อง SQL Server เอง (203.154.185.48 / NARAI-PIZZARIA) เพราะเครื่องนั้นเปิดตลอด
# และต่อฐานข้อมูลได้ในเครื่อง ไม่ต้องวิ่งออกเน็ต — ตัวสคริปต์ต้องการแค่ออกเน็ตไป Google
#
# ทำไมไม่ทำเป็น Vercel Cron: ตอนนี้ api/ มี 12 ไฟล์ = เพดาน Serverless Function พอดี
# และ Vercel Hobby ตั้ง cron ได้วันละครั้งเท่านั้น ซึ่งช้าไปสำหรับสินค้าที่เพิ่มระหว่างวัน
#
# วิธีใช้ (บนเครื่องปลายทาง — PowerShell แบบ Run as administrator):
#   1) ก๊อปโฟลเดอร์ db\sync ไปวางบนเครื่องนั้น
#   2) cd <โฟลเดอร์>\db\sync
#   3) powershell -ExecutionPolicy Bypass -File .\install-item-sync.ps1 -SqlUser narai_app -SqlPassword '<รหัส>'
#
# รันซ้ำได้ปลอดภัย — ถ้ามี task อยู่แล้วจะตั้งค่าทับให้ ไม่สร้างซ้ำ

param(
  [string]$TaskName = 'NaraiItemSync',
  [int]$EveryMinutes = 30,
  [string]$SqlHost = 'localhost',
  [int]$SqlPort = 14322,
  [string]$SqlDatabase = 'InventoryNarai',
  [Parameter(Mandatory = $true)][string]$SqlUser,
  [Parameter(Mandatory = $true)][string]$SqlPassword,
  # ตรวจอย่างเดียว ไม่ติดตั้ง task (ใช้ลองว่าซิงก์ผ่านไหมก่อนตั้งจริง)
  [switch]$TestOnly
)

$ErrorActionPreference = 'Continue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$syncDir = $PSScriptRoot
$logDir = Join-Path $syncDir 'logs'
$runCmd = Join-Path $syncDir 'run-item-sync.cmd'

function Say([string]$m)  { Write-Host $m }
function Ok([string]$m)   { Write-Host "  [OK] $m" -ForegroundColor Green }
function Warn([string]$m) { Write-Host "  [!!] $m" -ForegroundColor Yellow }
function Bad([string]$m)  { Write-Host "  [XX] $m" -ForegroundColor Red }
function Fix([string]$m)  { Write-Host "  [->] $m" -ForegroundColor Cyan }

Say ''
Say '=================================================='
Say '  ติดตั้งตัวซิงก์รายการสินค้า Sheets -> SQL Server'
Say '=================================================='
Say "  โฟลเดอร์  : $syncDir"
Say "  ฐานข้อมูล : $SqlHost,$SqlPort / $SqlDatabase"
Say "  ทุกๆ      : $EveryMinutes นาที"
Say ''

# --- 1) Node.js ---
Say '[1/5] ตรวจ Node.js'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Bad 'ไม่พบ Node.js บนเครื่องนี้'
  Fix 'ติดตั้งจาก https://nodejs.org (เลือก LTS) แล้วรันสคริปต์นี้ใหม่'
  exit 1
}
Ok "พบ Node.js $(node -v)"

# --- 2) ติดตั้ง dependency ---
Say '[2/5] ติดตั้งแพ็กเกจ (mssql)'
Push-Location $syncDir
if (Test-Path (Join-Path $syncDir 'node_modules\mssql')) {
  Ok 'มี node_modules อยู่แล้ว ข้ามขั้นนี้'
} else {
  npm install --omit=dev 2>&1 | Out-Null
  if (Test-Path (Join-Path $syncDir 'node_modules\mssql')) { Ok 'ติดตั้งแพ็กเกจเรียบร้อย' }
  else { Bad 'npm install ไม่สำเร็จ — ลองรัน npm install ในโฟลเดอร์นี้ด้วยมือเพื่อดู error'; Pop-Location; exit 1 }
}
Pop-Location

# --- 3) สร้างไฟล์ตัวรัน (เก็บรหัสผ่านไว้ในไฟล์นี้ไฟล์เดียว) ---
Say '[3/5] สร้างไฟล์ตัวรัน'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

# หมายเหตุ: รหัสผ่านอยู่ในไฟล์ .cmd นี้ ตั้งสิทธิ์ให้เฉพาะ Administrators/SYSTEM อ่านได้
# และไฟล์นี้ถูก .gitignore ไว้แล้ว จะไม่หลุดขึ้น git
$cmdBody = @"
@echo off
rem === สร้างอัตโนมัติโดย install-item-sync.ps1 อย่าแก้ด้วยมือ อย่า commit ขึ้น git ===
set "MSSQL_HOST=$SqlHost"
set "MSSQL_PORT=$SqlPort"
set "MSSQL_DATABASE=$SqlDatabase"
set "MSSQL_USER=$SqlUser"
set "MSSQL_PASSWORD=$SqlPassword"
cd /d "%~dp0"
node sync-items.mjs >> "logs\item-sync.log" 2>&1
exit /b %errorlevel%
"@
Set-Content -Path $runCmd -Value $cmdBody -Encoding ASCII

# ตัดสิทธิ์ผู้ใช้ทั่วไปออก เหลือแค่ SYSTEM กับ Administrators
icacls $runCmd /inheritance:r /grant:r "SYSTEM:(R,W)" "Administrators:(F)" 2>&1 | Out-Null
Ok "สร้าง $runCmd แล้ว (จำกัดสิทธิ์อ่านเฉพาะ SYSTEM/Administrators)"

# --- 4) ลองรันจริงหนึ่งครั้ง ---
Say '[4/5] ลองซิงก์หนึ่งรอบ'
& cmd /c "`"$runCmd`""
if ($LASTEXITCODE -eq 0) {
  Ok 'ซิงก์สำเร็จ'
  $tail = Get-Content (Join-Path $logDir 'item-sync.log') -Tail 1 -ErrorAction SilentlyContinue
  if ($tail) { Say "       $tail" }
} else {
  Bad 'ซิงก์ไม่สำเร็จ — ยังไม่ติดตั้ง task'
  Say ''
  Say '  --- 10 บรรทัดท้ายของ log ---'
  Get-Content (Join-Path $logDir 'item-sync.log') -Tail 10 -ErrorAction SilentlyContinue | ForEach-Object { Say "  $_" }
  Say ''
  Fix 'สาเหตุที่เจอบ่อย:'
  Fix '  - ยังไม่ได้รัน 001_stock_schema.sql กับ 002_item_schema.sql (ไม่มีตารางให้เขียน)'
  Fix '  - ยังไม่ได้เปิด Mixed Mode Authentication หรือ user/รหัสผ่านผิด'
  Fix '  - ชีท BOM ไม่ได้แชร์แบบ "ใครมีลิงก์ก็ดูได้" (Google ตอบหน้า HTML แทน JSON)'
  exit 1
}

if ($TestOnly) {
  Say ''
  Warn 'โหมด -TestOnly: ไม่ได้ติดตั้ง Scheduled Task'
  exit 0
}

# --- 5) ตั้ง Scheduled Task ---
Say "[5/5] ตั้ง Scheduled Task ทุก $EveryMinutes นาที"
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$runCmd`"" -WorkingDirectory $syncDir
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
  -RepetitionInterval (New-TimeSpan -Minutes $EveryMinutes) -RepetitionDuration ([TimeSpan]::MaxValue)
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 15)

try {
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Force | Out-Null
  Ok "ตั้ง task '$TaskName' เรียบร้อย (รันในชื่อ SYSTEM สตาร์ทเองแม้ไม่มีคนล็อกอิน)"
} catch {
  Bad "ตั้ง task ไม่สำเร็จ: $($_.Exception.Message)"
  Fix 'ต้องเปิด PowerShell แบบ Run as administrator'
  exit 1
}

Say ''
Say '=================================================='
Ok  'เสร็จเรียบร้อย'
Say '=================================================='
Say "  log        : $logDir\item-sync.log"
Say "  สั่งรันเอง : schtasks /run /tn `"$TaskName`""
Say "  ดูสถานะ    : schtasks /query /tn `"$TaskName`" /v /fo list"
Say "  ถอนออก     : schtasks /delete /tn `"$TaskName`" /f"
Say ''
