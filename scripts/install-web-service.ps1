# ติดตั้งเว็บ narai-branch (serve-local.mjs: หน้าเว็บ dist/ + api/) เป็น Windows Service
# ให้เปิดเองหลังรีบูตเครื่อง และ Windows สตาร์ทใหม่ให้เมื่อโปรเซสตาย — แทนการเปิดมือด้วย Start-Process
#
# วิธีใช้: คลิกขวาที่ install-web-service.bat (โฟลเดอร์หลักของโปรเจกต์) -> Run as administrator
# รันซ้ำได้ปลอดภัย — มี service อยู่แล้วจะตั้งค่าใหม่ทับแล้วรีสตาร์ท ไม่สร้างซ้ำ
#
# log ยังเขียนที่ local-out.log / local-err.log ในโฟลเดอร์โปรเจกต์เหมือนเดิม (ดู docs/hosting-local.md)

param(
  [int]$Port = 3102,
  [string]$ServiceName = 'NaraiBranchWeb',
  [string]$NssmPath = 'C:\tools\nssm.exe'
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot

function Say([string]$m)  { Write-Host $m }
function Ok([string]$m)   { Write-Host "  [OK] $m" -ForegroundColor Green }
function Warn([string]$m) { Write-Host "  [!!] $m" -ForegroundColor Yellow }
function Bad([string]$m)  { Write-Host "  [XX] $m" -ForegroundColor Red }
function Fix([string]$m)  { Write-Host "  [->] $m" -ForegroundColor Cyan }

Say ''
Say '=================================================='
Say '  ติดตั้งเว็บ narai-branch เป็น Windows Service'
Say '=================================================='
Say "  โฟลเดอร์โค้ด: $root"
Say "  service     : $ServiceName (พอร์ต $Port)"

# ---- 0) Administrator ----
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Bad 'ต้องเปิดด้วยสิทธิ์ผู้ดูแลระบบ — คลิกขวาที่ install-web-service.bat แล้วเลือก "Run as administrator"'
  exit 1
}

# ---- 1) ไฟล์ที่ต้องมี ----
Say ''
Say '[1/4] ตรวจไฟล์'
$missing = $false
foreach ($f in @('serve-local.mjs', '.env', 'dist\index.html', 'node_modules\express', 'node_modules\dotenv')) {
  if (Test-Path (Join-Path $root $f)) { Ok "พบ $f" } else { Bad "ไม่พบ $f"; $missing = $true }
}
if ($missing) {
  Fix 'รัน update-web.bat ให้ผ่านก่อน (สร้าง dist + ลง express/dotenv) แล้วค่อยรันไฟล์นี้ใหม่'
  exit 1
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Bad 'ไม่พบ Node.js'; exit 1 }
Ok "Node.js: $($node.Source)"

$nssm = $null
if (Test-Path $NssmPath) { $nssm = $NssmPath }
else { $cmd = Get-Command nssm -ErrorAction SilentlyContinue; if ($cmd) { $nssm = $cmd.Source } }
if (-not $nssm) {
  Bad "ไม่พบ NSSM (หาที่ $NssmPath และใน PATH แล้ว)"
  Fix 'ดาวน์โหลดจาก https://nssm.cc/download เอา nssm.exe (win64) ไปวางที่ C:\tools\'
  exit 1
}
Ok "NSSM: $nssm"

# ---- 2) ปิดตัวที่เปิดมือไว้ (Start-Process) ไม่งั้นพอร์ต $Port ชนกับ service ----
Say ''
Say '[2/4] ปิด serve-local.mjs ที่เปิดมือไว้'
$manual = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'serve-local' }
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
  Warn 'มี service อยู่แล้ว — จะตั้งค่าใหม่ทับแล้วรีสตาร์ท'
  & $nssm stop $ServiceName 2>&1 | Out-Null
  Start-Sleep -Seconds 2
  $manual = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'serve-local' }
}
if ($manual) {
  $manual | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Ok "ปิดแล้ว $(@($manual).Count) โปรเซส"
} else {
  Ok 'ไม่มีตัวที่เปิดค้าง'
}

# ---- 3) ตั้ง service ----
Say ''
Say '[3/4] ตั้งค่า service'
if (-not $existing) {
  & $nssm install $ServiceName $node.Source 'serve-local.mjs' 2>&1 | Out-Null
  Ok 'สร้าง service ใหม่'
}
& $nssm set $ServiceName Application $node.Source 2>&1 | Out-Null
& $nssm set $ServiceName AppParameters 'serve-local.mjs' 2>&1 | Out-Null
# dotenv อ่าน .env จากโฟลเดอร์ปัจจุบัน — ต้องตั้ง AppDirectory เป็นโฟลเดอร์โปรเจกต์
& $nssm set $ServiceName AppDirectory $root 2>&1 | Out-Null
& $nssm set $ServiceName AppEnvironmentExtra "PORT=$Port" 2>&1 | Out-Null
& $nssm set $ServiceName Start SERVICE_AUTO_START 2>&1 | Out-Null
& $nssm set $ServiceName AppStdout (Join-Path $root 'local-out.log') 2>&1 | Out-Null
& $nssm set $ServiceName AppStderr (Join-Path $root 'local-err.log') 2>&1 | Out-Null
& $nssm set $ServiceName AppRotateFiles 1 2>&1 | Out-Null
& $nssm set $ServiceName AppRotateBytes 10485760 2>&1 | Out-Null
& $nssm set $ServiceName DisplayName 'Narai Branch Web' 2>&1 | Out-Null
& $nssm set $ServiceName Description 'หน้าเว็บ + api ของ narai-branch (serve-local.mjs) — https://branch.khanoykorshabu.com' 2>&1 | Out-Null
# ให้ Windows สตาร์ทใหม่เองเมื่อโปรเซสตาย
& sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/10000/restart/30000 | Out-Null
Ok 'สตาร์ทเองตอนเปิดเครื่อง + สตาร์ทใหม่เมื่อตาย + เขียน log ที่ local-out.log / local-err.log'

# ---- 4) สตาร์ทและเช็ค ----
Say ''
Say '[4/4] สตาร์ท service แล้วเช็คว่าเว็บตอบ'
& $nssm start $ServiceName 2>&1 | Out-Null
$ok = $false; $msg = ''
foreach ($i in 1..15) {
  Start-Sleep -Seconds 2
  try {
    $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 "http://localhost:$Port/api/pending_orders?outletId=1"
    if ($r.StatusCode -eq 200) { $ok = $true; break }
  } catch {
    $msg = $_.ErrorDetails.Message
    if (-not $msg) { $msg = $_.Exception.Message }
  }
}
$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
Say ''
if ($ok) {
  Ok "service $ServiceName ทำงานแล้ว เว็บตอบ HTTP 200"
  Say '  ต่อไปรีบูตเครื่องแล้วเว็บจะเปิดเอง — อัปเดตด้วย update-web.bat (Run as administrator)'
  exit 0
}
Bad "เว็บยังไม่ตอบ (สถานะ service: $($svc.Status)) $msg"
Fix "ดู log: Get-Content $root\local-err.log -Tail 20"
exit 1
