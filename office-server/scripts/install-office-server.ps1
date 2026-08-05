# ติดตั้ง Narai Usage API (office-server) ลงเครื่องใหม่ แล้วตั้งเป็น Windows Service
#
# ใช้ตอนย้ายมารันบนเครื่องคลาวด์ 203.154.185.48 (inventory.dyndns.tv) แทนเครื่อง IT-Narai
# ข้อดีของการรันบนเครื่องนั้น: เปิดตลอด ไม่ต้องพึ่งเครื่องที่ออฟฟิศอีก
# และ api.khanoykorshabu.com อยู่บนเครื่องเดียวกัน จึงดึงข้อมูลขายได้ในเครื่องเอง ไม่ต้องออกเน็ต
#
# วิธีใช้ (บนเครื่องปลายทาง — PowerShell แบบ Run as administrator):
#   1) ก๊อปโฟลเดอร์โค้ดทั้งชุดไปวางบนเครื่องนั้นก่อน (หรือ git clone)
#   2) cd <โฟลเดอร์โค้ด>\office-server\scripts
#   3) powershell -ExecutionPolicy Bypass -File .\install-office-server.ps1
#
# รันซ้ำได้ปลอดภัย — ถ้ามี service อยู่แล้วจะตั้งค่าใหม่แล้วรีสตาร์ทให้ ไม่สร้างซ้ำ

param(
  [int]$Port = 8787,
  [string]$ServiceName = 'NaraiUsageAPI',
  [string]$NssmPath = 'C:\tools\nssm.exe',
  # เครื่องคลาวด์มี IP นิ่งและเปิดพอร์ตไว้ที่ router/firewall อยู่แล้ว จึงไม่ต้องใช้ UPnP
  # (UPnP บนเครื่องแบบนี้จะ error ทิ้งไว้ใน log เปล่าๆ)
  [switch]$EnableUpnp
)

$ErrorActionPreference = 'Continue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$serverDir = Split-Path -Parent $PSScriptRoot
$problems = New-Object System.Collections.ArrayList

function Say([string]$m)  { Write-Host $m }
function Ok([string]$m)   { Write-Host "  [OK] $m" -ForegroundColor Green }
function Warn([string]$m) { Write-Host "  [!!] $m" -ForegroundColor Yellow }
function Bad([string]$m)  { Write-Host "  [XX] $m" -ForegroundColor Red }
function Fix([string]$m)  { Write-Host "  [->] $m" -ForegroundColor Cyan }

Say ''
Say '=================================================='
Say '  ติดตั้ง Narai Usage API เป็น Windows Service'
Say '=================================================='
Say "  โฟลเดอร์โค้ด: $serverDir"
Say "  พอร์ต       : $Port"

# ---- 0) Administrator ----
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Bad 'ต้องเปิด PowerShell แบบ "Run as administrator" ก่อน'
  Say ''
  exit 1
}

# ---- 1) ไฟล์โค้ดครบไหม ----
Say ''
Say '[1/7] ไฟล์โค้ด'
if (-not (Test-Path (Join-Path $serverDir 'server.js'))) {
  Bad "ไม่พบ server.js ใน $serverDir"
  Fix 'ต้องก๊อปโฟลเดอร์โค้ดทั้งชุดมาวางบนเครื่องนี้ก่อน แล้วรันสคริปจากใน office-server\scripts'
  Say ''
  exit 1
}
Ok 'พบ server.js แล้ว'

# ---- 2) Node.js ----
Say ''
Say '[2/7] Node.js'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Bad 'ไม่พบ Node.js บนเครื่องนี้'
  Fix 'ติดตั้งจาก https://nodejs.org (เลือก LTS) แล้วเปิด PowerShell ใหม่ และรันสคริปนี้อีกครั้ง'
  Say ''
  exit 1
}
Ok "พบ Node.js $(& node -v) ที่ $($node.Source)"

# ---- 3) ติดตั้ง dependency ----
Say ''
Say '[3/7] ติดตั้ง dependency (npm install)'
Push-Location $serverDir
try {
  & npm install --omit=dev --no-audit --no-fund 2>&1 | Select-Object -Last 5 | ForEach-Object { Say "      $_" }
  if (Test-Path (Join-Path $serverDir 'node_modules')) {
    Ok 'ติดตั้ง dependency แล้ว'
  } else {
    Bad 'npm install ไม่สำเร็จ — เครื่องนี้ออกเน็ตได้ไหม?'
    [void]$problems.Add('npm install ไม่สำเร็จ')
  }
} finally {
  Pop-Location
}

# ---- 4) ไฟล์ .env ----
Say ''
Say '[4/7] ไฟล์ตั้งค่า (.env)'
$envPath = Join-Path $serverDir '.env'
if (Test-Path $envPath) {
  Ok '.env มีอยู่แล้ว — ไม่แตะต้อง'
} else {
  $upnpLine = if ($EnableUpnp) { '# UPNP=off' } else { 'UPNP=off' }
  $envBody = @"
PORT=$Port
# เครื่องนี้มี IP นิ่งและเปิดพอร์ตไว้แล้ว จึงไม่ต้องให้โปรแกรมสั่งเปิดพอร์ตเองผ่าน UPnP
$upnpLine
# จำนวนวันที่อุ่น cache ตอนสตาร์ท (ค่าเริ่มต้น 70)
# WARM_DAYS=70
# แหล่งข้อมูลยอดขาย POS — เว้นว่างไว้ใช้ค่าเริ่มต้นในโค้ด
# SALES_BASE=https://api.khanoykorshabu.com/ctranbetweendate
"@
  Set-Content -Path $envPath -Value $envBody -Encoding UTF8
  Ok "สร้าง .env แล้ว (PORT=$Port, UPnP ปิด)"
}

# ---- 5) Windows Service ----
Say ''
Say "[5/7] Windows Service '$ServiceName'"
$nssm = $null
if (Test-Path $NssmPath) {
  $nssm = $NssmPath
} else {
  $cmd = Get-Command nssm -ErrorAction SilentlyContinue
  if ($cmd) { $nssm = $cmd.Source }
}

if (-not $nssm) {
  Bad "ไม่พบ NSSM (หาที่ $NssmPath และใน PATH แล้ว)"
  Fix 'ดาวน์โหลดจาก https://nssm.cc/download แตกไฟล์ เอา nssm.exe (โฟลเดอร์ win64) ไปวางที่ C:\tools\'
  Fix 'แล้วรันสคริปนี้ใหม่อีกครั้ง'
  [void]$problems.Add('ไม่มี NSSM')
} else {
  Ok "พบ NSSM ที่ $nssm"
  $logDir = Join-Path $serverDir 'logs'
  if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

  $existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  if ($existing) {
    Warn 'มี service อยู่แล้ว — จะตั้งค่าใหม่ทับแล้วรีสตาร์ท (ไม่สร้างซ้ำ)'
    & $nssm stop $ServiceName 2>&1 | Out-Null
  } else {
    Fix 'สร้าง service ใหม่'
    & $nssm install $ServiceName $node.Source (Join-Path $serverDir 'server.js') 2>&1 | Out-Null
  }

  & $nssm set $ServiceName AppDirectory $serverDir 2>&1 | Out-Null
  & $nssm set $ServiceName AppParameters (Join-Path $serverDir 'server.js') 2>&1 | Out-Null
  & $nssm set $ServiceName Start SERVICE_AUTO_START 2>&1 | Out-Null
  & $nssm set $ServiceName AppStdout (Join-Path $logDir 'service-out.log') 2>&1 | Out-Null
  & $nssm set $ServiceName AppStderr (Join-Path $logDir 'service-err.log') 2>&1 | Out-Null
  & $nssm set $ServiceName AppRotateFiles 1 2>&1 | Out-Null
  & $nssm set $ServiceName AppRotateBytes 10485760 2>&1 | Out-Null
  & $nssm set $ServiceName DisplayName 'Narai Usage API' 2>&1 | Out-Null
  Ok 'ตั้งค่า service แล้ว (สตาร์ทเองตอนเปิดเครื่อง + เขียน log)'

  # ให้ Windows รีสตาร์ทเองเมื่อโปรเซสตาย
  & sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/10000/restart/30000 | Out-Null

  Fix 'กำลังสตาร์ท service'
  & $nssm start $ServiceName 2>&1 | Out-Null
  Start-Sleep -Seconds 8
  $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  if ($svc -and $svc.Status -eq 'Running') {
    Ok 'service กำลังทำงาน'
  } else {
    Bad "สตาร์ทไม่สำเร็จ — ดู $logDir\service-err.log"
    [void]$problems.Add('สตาร์ท service ไม่สำเร็จ')
  }
}

# ---- 6) Firewall ----
Say ''
Say "[6/7] Firewall (เปิดพอร์ต $Port ขาเข้า)"
$ruleName = "Narai Usage API $Port"
if (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue) {
  Ok 'มีกฎเปิดพอร์ตอยู่แล้ว'
} else {
  try {
    New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Any | Out-Null
    Ok 'เพิ่มกฎเปิดพอร์ตแล้ว'
  } catch {
    Bad "เพิ่มกฎไม่สำเร็จ: $($_.Exception.Message)"
    [void]$problems.Add('เปิดพอร์ตใน firewall ไม่สำเร็จ')
  }
}

# ---- 7) ทดสอบ ----
Say ''
Say '[7/7] ทดสอบ (ตอนสตาร์ทต้องอุ่น cache ~3-4 นาที ช่วงแรกจึงยังไม่ตอบ)'
$health = $null
foreach ($wait in 5, 15, 30, 60) {
  Start-Sleep -Seconds $wait
  try {
    $h = Invoke-RestMethod -Uri "http://localhost:$Port/health" -TimeoutSec 20
    if ($h.ok) { $health = $h; break }
  } catch { }
  Say "      ยังไม่ตอบ รออีกสักครู่..."
}
if ($health) {
  Ok "ตอบแล้ว — cache $($health.days_cached) วัน, สูตร $($health.recipes) เมนู"
  if ([int]$health.recipes -eq 0) {
    Warn 'ยังโหลดสูตรไม่ได้ — เครื่องนี้ต้องเข้า docs.google.com ได้ด้วย (แดชบอร์ดจะไม่มีต้นทุนถ้าโหลดไม่ได้)'
  }
} else {
  Warn 'ยังไม่ตอบภายในเวลาที่รอ — ปกติถ้าเพิ่งสตาร์ทและกำลังอุ่น cache'
  Fix "รออีก 3-4 นาที แล้วเปิด http://localhost:$Port/health ดูอีกครั้ง"
}

# ---- สรุป ----
Say ''
Say '=================================================='
Say '  สรุป'
Say '=================================================='
Say ''
if ($problems.Count -gt 0) {
  foreach ($p in $problems) { Bad $p }
  Say ''
  Say '  แก้ตามที่บอกด้านบนแล้วรันสคริปนี้ซ้ำได้เลย (รันซ้ำปลอดภัย)'
} else {
  Ok 'ติดตั้งเรียบร้อย'
  Say ''
  Say '  ขั้นต่อไป — ตรวจว่าเข้าจากข้างนอกได้ไหม:'
  Say "    เปิดจากเครื่องอื่น: http://inventory.dyndns.tv:$Port/health"
  Say '    ถ้าเข้าไม่ได้ ให้เปิด Port Forwarding / Security Group ที่ปลายทางด้วย'
  Say ''
  Say '  ฝั่ง Vercel ตั้ง USAGE_API_BASE ไว้ถูกแล้ว:'
  Say "    USAGE_API_BASE = http://inventory.dyndns.tv:$Port"
  Say '    ถ้ายังไม่ขึ้น ให้ Redeploy ที่ Vercel หนึ่งครั้ง'
}
Say ''
