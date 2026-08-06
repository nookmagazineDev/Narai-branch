# เปิดทางให้ Vercel เข้าถึง office-server ผ่าน Cloudflare Tunnel — ไม่ต้อง forward พอร์ตที่ router
#
# ใช้เมื่อเครื่องอยู่หลัง NAT แล้วเข้าไปตั้งค่า router ไม่ได้
# cloudflared จะต่อ "ออก" ไปหา Cloudflare เอง (outbound) แล้วเปิดทางกลับเข้ามา
# จึงไม่ต้องมีพอร์ตเปิดค้างไว้ให้ใครสแกนเจอ และได้ HTTPS ฟรีด้วย
#
# ---------------------------------------------------------------------------
# ก่อนรันสคริปนี้ ต้องสร้าง tunnel ในหน้าเว็บ Cloudflare ก่อน เพื่อเอา token มา:
#
#   1) เปิด https://one.dash.cloudflare.com  ->  เลือกบัญชี
#   2) เมนู Networks  ->  Tunnels  ->  Create a tunnel
#   3) เลือก "Cloudflared"  ->  ตั้งชื่อ เช่น narai-usage  ->  Save
#   4) หน้าถัดไปเลือก Windows / 64-bit จะเห็นคำสั่งยาวๆ ที่มี token อยู่ท้ายสุด
#      ก๊อปเฉพาะ "ตัว token" (สายอักษรยาวๆ ท้ายคำสั่ง ไม่ต้องเอาคำสั่งมาด้วย)
#
# แล้วรันสคริปนี้ (PowerShell แบบ Run as administrator):
#   powershell -ExecutionPolicy Bypass -File .\install-cloudflare-tunnel.ps1 -Token "<วาง token ตรงนี้>"
#
# ถ้าเครื่องมี cloudflared รันอยู่แล้ว สคริปจะหยุดและบอกให้ไปเพิ่ม hostname ใน tunnel เดิมแทน
# (ห้ามติดตั้งทับ ของเดิมอาจกำลังให้บริการโดเมนอื่นอยู่)
#
# หลังรันเสร็จ กลับไปตั้ง Public Hostname ในหน้าเว็บ Cloudflare (สคริปจะบอกขั้นตอนอีกที)
# ---------------------------------------------------------------------------

param(
  [Parameter(Mandatory = $true)][string]$Token,
  [string]$InstallDir = 'C:\tools',
  [int]$Port = 8787
)

$ErrorActionPreference = 'Continue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

function Say([string]$m)  { Write-Host $m }
function Ok([string]$m)   { Write-Host "  [OK] $m" -ForegroundColor Green }
function Warn([string]$m) { Write-Host "  [!!] $m" -ForegroundColor Yellow }
function Bad([string]$m)  { Write-Host "  [XX] $m" -ForegroundColor Red }
function Fix([string]$m)  { Write-Host "  [->] $m" -ForegroundColor Cyan }

Say ''
Say '=================================================='
Say '  ติดตั้ง Cloudflare Tunnel ให้ office-server'
Say '=================================================='

# ---- 0) Administrator ----
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Bad 'ต้องเปิด PowerShell แบบ "Run as administrator" ก่อน'
  Say ''
  exit 1
}

# ---- 1) office-server ต้องทำงานอยู่ก่อน ----
Say ''
Say "[1/4] เช็คว่า office-server ทำงานอยู่ (localhost:$Port)"
try {
  $h = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 20
  if ($h.ok) {
    Ok "ทำงานปกติ — cache $($h.days_cached) วัน, สูตร $($h.recipes) เมนู"
  } else {
    Warn 'ตอบกลับมาแต่สถานะไม่ ok'
  }
} catch {
  Bad "ต่อ http://127.0.0.1:$Port/health ไม่ได้ — office-server ยังไม่ทำงาน"
  Fix 'ติดตั้ง/สตาร์ทด้วย install-office-server.ps1 ให้เรียบร้อยก่อน แล้วค่อยรันสคริปนี้'
  Say ''
  exit 1
}

# ---- 2) โหลด cloudflared ----
Say ''
Say '[2/4] โปรแกรม cloudflared'
if (-not (Test-Path $InstallDir)) { New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null }
$exe = Join-Path $InstallDir 'cloudflared.exe'

if (Test-Path $exe) {
  Ok "มีอยู่แล้วที่ $exe"
} else {
  Fix 'กำลังดาวน์โหลด (ประมาณ 20 MB)'
  $url = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'
  try {
    $ProgressPreference = 'SilentlyContinue'  # ไม่ใส่จะช้ามากเวลาโหลดไฟล์ใหญ่
    Invoke-WebRequest -Uri $url -OutFile $exe -UseBasicParsing
    Ok "ดาวน์โหลดแล้ว: $exe"
  } catch {
    Bad "ดาวน์โหลดไม่สำเร็จ: $($_.Exception.Message)"
    Fix "โหลดเองจาก $url แล้วเอาไปวางที่ $exe จากนั้นรันสคริปนี้ใหม่"
    Say ''
    exit 1
  }
}

# ---- 3) ติดตั้งเป็น Windows Service ----
Say ''
Say '[3/4] ติดตั้ง cloudflared เป็น Windows Service'
# เครื่องหนึ่งรัน cloudflared ได้ service เดียว แต่ tunnel หนึ่งตัวมีได้หลาย hostname
# ถ้ามีของเดิมอยู่ ห้ามถอนทิ้งเด็ดขาด — ของเดิมอาจกำลังให้บริการโดเมนอื่นอยู่
# (เคยพลาดมาแล้ว: ถอนทิ้งไปทำให้ api.khanoykorshabu.com ล่มทันที เพราะมันวิ่งผ่าน tunnel ตัวนั้น)
# ทางที่ถูกคือไปเพิ่ม Public Hostname เข้าไปใน tunnel เดิม ไม่ใช่สร้างตัวใหม่มาแทน
$existing = Get-Service -Name 'cloudflared' -ErrorAction SilentlyContinue
if ($existing) {
  Bad 'เครื่องนี้มี Cloudflare Tunnel ตัวเดิมรันอยู่แล้ว — หยุดก่อน ห้ามติดตั้งทับ'
  Say ''
  Say '  ถ้าติดตั้งทับ tunnel เดิมจะถูกแทนที่ และโดเมนที่วิ่งผ่านมันจะล่มทันที'
  Say ''
  Fix 'ทางที่ถูก: เพิ่ม hostname เข้าไปใน tunnel เดิมแทน (tunnel เดียวมีได้หลาย hostname)'
  Say ''
  Say '    1) เปิด https://one.dash.cloudflare.com -> Networks -> Tunnels'
  Say '    2) กดที่ tunnel ตัวที่มีอยู่ -> Configure -> แท็บ Public Hostname'
  Say '    3) Add a public hostname:'
  Say '         Subdomain : usage'
  Say '         Domain    : khanoykorshabu.com'
  Say '         Type      : HTTP'
  Say "         URL       : localhost:$Port"
  Say '    4) Save — เสร็จแล้ว ไม่ต้องรันสคริปนี้เลย'
  Say ''
  Say '  ดู tunnel ที่เครื่องนี้รันอยู่ตอนนี้:'
  Say '    Get-Content "C:\Windows\System32\config\systemprofile\.cloudflared\*.json"'
  Say ''
  exit 1
}

& $exe service install $Token 2>&1 | ForEach-Object { Say "      $_" }
Start-Sleep -Seconds 5

$svc = Get-Service -Name 'cloudflared' -ErrorAction SilentlyContinue
if (-not $svc) {
  Bad 'ติดตั้ง service ไม่สำเร็จ — token ถูกต้องหรือเปล่า?'
  Fix 'ก๊อป token มาใหม่จากหน้า Cloudflare (เอาเฉพาะสายอักษรยาวๆ ไม่ต้องเอาคำสั่งมาด้วย)'
  Say ''
  exit 1
}
if ($svc.Status -ne 'Running') {
  Fix 'กำลังสตาร์ท service'
  Start-Service -Name 'cloudflared' -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 5
  $svc = Get-Service -Name 'cloudflared' -ErrorAction SilentlyContinue
}
if ($svc.Status -eq 'Running') {
  Ok 'cloudflared ทำงานแล้ว (สตาร์ทเองตอนเปิดเครื่องด้วย)'
} else {
  Bad "สตาร์ทไม่สำเร็จ (สถานะ: $($svc.Status))"
}

# ให้ Windows รีสตาร์ทเองเมื่อโปรเซสตาย
& sc.exe failure cloudflared reset= 86400 actions= restart/5000/restart/10000/restart/30000 | Out-Null

# ---- 4) ขั้นตอนที่เหลือ (ทำในหน้าเว็บ) ----
Say ''
Say '[4/4] ขั้นตอนที่เหลือ — ทำในหน้าเว็บ Cloudflare'
Say ''
Say '  A) กลับไปที่ https://one.dash.cloudflare.com -> Networks -> Tunnels'
Say '     ควรเห็น tunnel ของคุณขึ้นสถานะ HEALTHY แล้ว'
Say ''
Say '  B) กดที่ tunnel -> Configure -> แท็บ "Public Hostname" -> Add a public hostname'
Say '       Subdomain : usage'
Say '       Domain    : khanoykorshabu.com'
Say '       Type      : HTTP'
Say "       URL       : localhost:$Port"
Say '     -> Save hostname'
Say ''
Say '  C) ตั้งค่าที่ Vercel (Settings -> Environment Variables)'
Say '       USAGE_API_BASE = https://usage.khanoykorshabu.com'
Say '     แล้วไปที่แท็บ Deployments กด Redeploy หนึ่งครั้ง'
Say ''
Say '  D) ทดสอบจากที่ไหนก็ได้ (มือถือ/เครื่องอื่น) เปิด:'
Say '       https://usage.khanoykorshabu.com/health'
Say '     ได้ {"ok":true,...} = เสร็จสมบูรณ์ เปิดหน้าเว็บดูยอดขายได้เลย'
Say ''
Say '=================================================='
Say ''
