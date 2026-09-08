# เชื่อมโฟลเดอร์โค้ดที่ก๊อป/แตกจาก ZIP มา ให้กลายเป็น git repo จริง (โดยไม่ต้องย้ายโฟลเดอร์)
# และดึงโค้ดล่าสุดจาก main มาให้ตรงกัน
#
# ใช้ตอนเครื่องที่รัน office-server ได้โค้ดมาจากการโหลด ZIP (โฟลเดอร์ชื่อลงท้าย -main)
# ทำให้คราวหน้าอัปเดตแค่ `git pull` ไม่ต้องก๊อปไฟล์ทีละไฟล์
#
# วิธีใช้ (PowerShell แบบ Run as administrator):
#   powershell -ExecutionPolicy Bypass -File .\link-to-git.ps1
#   powershell -ExecutionPolicy Bypass -File .\link-to-git.ps1 -Root D:\Narai-branch-main
#
# ทำอะไรบ้าง: สำรองโค้ดเดิมไว้ก่อน -> ผูก remote (ถ้ายังไม่ได้ผูก) -> ดึง main มาทับไฟล์โค้ด
#             -> npm install -> รีสตาร์ท service -> เช็ค /health
# ไม่แตะ .env, logs, node_modules (อยู่ใน .gitignore ทั้งหมด ของเดิมอยู่ครบ)
# รันซ้ำได้ปลอดภัย และถ้าดึงโค้ดไม่สำเร็จจะหยุดก่อนรีสตาร์ท service (ไม่ปล่อยให้รันโค้ดเก่าต่อโดยไม่รู้ตัว)

param(
  [string]$Root = '',
  [string]$RepoUrl = 'https://github.com/nookmagazineDev/Narai-branch.git',
  [string]$Branch = 'main',
  [string]$ServiceName = 'NaraiUsageAPI',
  [int]$Port = 8787,
  [switch]$NoRestart
)

$ErrorActionPreference = 'Continue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

function Say([string]$m)  { Write-Host $m }
function Ok([string]$m)   { Write-Host "  [OK] $m" -ForegroundColor Green }
function Warn([string]$m) { Write-Host "  [!!] $m" -ForegroundColor Yellow }
function Bad([string]$m)  { Write-Host "  [XX] $m" -ForegroundColor Red }
function Fix([string]$m)  { Write-Host "  [->] $m" -ForegroundColor Cyan }

# ---- หาโฟลเดอร์รากของโปรเจกต์ ----
# ปกติสคริปอยู่ที่ <ราก>\office-server\scripts จึงถอยขึ้นสองชั้น
if (-not $Root) { $Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot) }
$serverDir = Join-Path $Root 'office-server'

Say ''
Say '=================================================='
Say '  เชื่อมโฟลเดอร์โค้ดเข้ากับ git + ดึงโค้ดล่าสุด'
Say '=================================================='
Say "  โฟลเดอร์ราก : $Root"
Say "  repo        : $RepoUrl ($Branch)"

if (-not (Test-Path (Join-Path $serverDir 'server.js'))) {
  Bad "ไม่พบ $serverDir\server.js — โฟลเดอร์รากไม่ถูกต้อง"
  Fix 'ระบุเอง เช่น  .\link-to-git.ps1 -Root D:\Narai-branch-main'
  Say ''
  exit 1
}

# สำรองไฟล์โค้ด (ไม่เอา node_modules/logs/dist/.git ที่ใหญ่และสร้างใหม่ได้) — คืนค่าที่อยู่โฟลเดอร์สำรอง
function Backup-Code {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $dest = Join-Path (Split-Path -Parent $Root) ("narai-backup-$stamp")
  & robocopy $Root $dest /E /XD node_modules logs dist .git /NFL /NDL /NJH /NJS /NP | Out-Null
  if (Test-Path (Join-Path $dest 'office-server\server.js')) {
    Ok "สำรองโค้ดเดิมไว้ที่ $dest"
    return $dest
  }
  Bad 'สำรองโค้ดไม่สำเร็จ — หยุดไว้ก่อนเพื่อความปลอดภัย'
  Say ''
  exit 1
}

# ---- 1) git ----
Say ''
Say '[1/6] git'
$git = Get-Command git -ErrorAction SilentlyContinue
if (-not $git) {
  Bad 'ไม่พบ git บนเครื่องนี้'
  Fix 'ติดตั้งจาก https://git-scm.com/download/win แล้วเปิด PowerShell ใหม่ และรันสคริปนี้อีกครั้ง'
  Say ''
  exit 1
}
Ok "พบ $(& git --version)"

# ---- 2) ผูกกับ repo ----
Say ''
Say '[2/6] ผูกกับ repo'
if (Test-Path (Join-Path $Root '.git')) {
  $remote = (& git -C $Root remote get-url origin 2>$null)
  if (-not $remote) {
    Warn 'เป็น git repo แต่ยังไม่มี remote origin — จะผูกให้'
    & git -C $Root remote add origin $RepoUrl 2>&1 | Out-Null
    Ok "ผูก origin = $RepoUrl"
  } else {
    Ok "เป็น git repo อยู่แล้ว (origin = $remote)"
  }
} else {
  Warn 'ยังไม่ใช่ git repo (น่าจะได้มาจากไฟล์ ZIP) — จะเชื่อมให้'
  [void](Backup-Code)
  & git -C $Root init 2>&1 | Out-Null
  & git -C $Root remote add origin $RepoUrl 2>&1 | Out-Null
  Ok "git init + ผูก origin = $RepoUrl"
}

# ---- 3) ดึงโค้ดล่าสุด ----
Say ''
Say "[3/6] ดึงโค้ดล่าสุดจาก origin/$Branch"
$fetchOut = & git -C $Root fetch origin $Branch 2>&1
$fetchCode = $LASTEXITCODE
$fetchOut | ForEach-Object { Say "      $_" }
if ($fetchCode -ne 0) {
  Bad 'ดึงจาก GitHub ไม่สำเร็จ — เครื่องนี้ออกเน็ตได้ไหม / ติด proxy / repo เป็น private หรือเปล่า'
  Fix 'โค้ดบนเครื่องยังเป็นของเดิมทุกอย่าง ยังไม่มีอะไรถูกเปลี่ยน'
  Say ''
  exit 1
}

$target = (& git -C $Root rev-parse FETCH_HEAD).Trim()
$current = (& git -C $Root rev-parse HEAD 2>$null)
if ($current) { $current = $current.Trim() }

if ($current -eq $target) {
  Ok 'โค้ดบนเครื่องตรงกับ GitHub อยู่แล้ว'
} else {
  # ชี้ branch ปัจจุบันไปที่คอมมิตล่าสุดก่อน (ยังไม่แตะไฟล์) เพื่อดูว่าไฟล์ไหนบนเครื่องต่างจากบน GitHub
  # (.env / logs / node_modules ไม่ขึ้นเพราะอยู่ใน .gitignore อยู่แล้ว)
  & git -C $Root reset FETCH_HEAD 2>&1 | Out-Null
  $changed = & git -C $Root status --porcelain --untracked-files=no
  if ($changed) {
    Warn 'ไฟล์เหล่านี้บนเครื่องต่างจากบน GitHub และกำลังจะถูกทับ:'
    $changed | ForEach-Object { Say "      $_" }
    [void](Backup-Code)
  }
  & git -C $Root branch -M $Branch 2>&1 | Out-Null
  & git -C $Root reset --hard FETCH_HEAD 2>&1 | ForEach-Object { Say "      $_" }
  & git -C $Root branch --set-upstream-to="origin/$Branch" $Branch 2>&1 | Out-Null
}

# ยืนยันว่าไฟล์บนเครื่องเป็นคอมมิตล่าสุดจริง ไม่งั้นหยุด — กันรีสตาร์ทแล้วยังรันโค้ดเก่าโดยไม่รู้ตัว
$current = (& git -C $Root rev-parse HEAD).Trim()
if ($current -ne $target) {
  Bad "อัปเดตโค้ดไม่สำเร็จ — เครื่องยังอยู่ที่ $($current.Substring(0,7)) แต่ GitHub อยู่ที่ $($target.Substring(0,7))"
  Fix "ลองสั่งเองทีละคำสั่ง:  git -C $Root fetch origin $Branch  แล้ว  git -C $Root reset --hard origin/$Branch"
  Say ''
  exit 1
}
Ok "คอมมิตล่าสุด: $(& git -C $Root log --oneline -1)"

# ---- 4) dependency ----
Say ''
Say '[4/6] dependency (npm install)'
Push-Location $serverDir
try {
  & npm install --omit=dev --no-audit --no-fund 2>&1 | Select-Object -Last 3 | ForEach-Object { Say "      $_" }
} finally {
  Pop-Location
}

# ---- 5) รีสตาร์ท service ----
Say ''
Say "[5/6] service '$ServiceName'"
if ($NoRestart) {
  Warn "ข้ามการรีสตาร์ทตามที่สั่ง — ต้องรัน  Restart-Service $ServiceName  เองถึงจะมีผล"
} else {
  $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  if (-not $svc) {
    Warn "ไม่พบ service '$ServiceName' — ถ้ารันด้วยวิธีอื่น (pm2/หน้าต่าง cmd) ให้รีสตาร์ทเอง"
  } elseif (-not $isAdmin) {
    Warn 'ไม่ได้เปิดแบบ Run as administrator จึงรีสตาร์ท service ไม่ได้'
    Fix "เปิด PowerShell แบบ administrator แล้วสั่ง  Restart-Service $ServiceName"
  } else {
    Fix 'รีสตาร์ท service'
    Restart-Service -Name $ServiceName -Force
    Ok 'สั่งรีสตาร์ทแล้ว (ตอนสตาร์ทจะอุ่น cache ~3-4 นาที)'
  }
}

# ---- 6) เช็ค /health ----
Say ''
Say '[6/6] ทดสอบ'
$health = $null
foreach ($wait in 5, 15, 30, 60) {
  Start-Sleep -Seconds $wait
  try {
    $h = Invoke-RestMethod -Uri "http://localhost:$Port/health" -TimeoutSec 20
    if ($h.ok) { $health = $h; break }
  } catch { }
  Say '      ยังไม่ตอบ รออีกสักครู่...'
}
if ($health) {
  Ok "ตอบแล้ว — cache $($health.days_cached) วัน, สูตร $($health.recipes) เมนู"
  # ฟิลด์นี้มีเฉพาะโค้ดใหม่ ถ้าไม่มีแปลว่ายังรันไฟล์เก่าอยู่ (service ชี้คนละโฟลเดอร์?)
  if ($null -eq $health.PSObject.Properties['incomplete_days']) {
    Warn 'ตัวที่ตอบพอร์ตนี้ยังเป็นโค้ดเก่า — เช็คว่า service ชี้มาที่โฟลเดอร์นี้จริงไหม:'
    Fix "  nssm get $ServiceName AppDirectory   (ควรได้ $serverDir)"
  } elseif ($health.incomplete_days -and $health.incomplete_days.Count -gt 0) {
    Warn "วันที่ข้อมูลยังไม่ครบ: $($health.incomplete_days -join ', ') (ระบบจะดึงซ้ำเองทุก 20 นาที)"
  }
} else {
  Warn 'ยังไม่ตอบภายในเวลาที่รอ — ปกติถ้าเพิ่งสตาร์ทและกำลังอุ่น cache'
  Fix "รออีก 3-4 นาที แล้วเปิด http://localhost:$Port/health ดูอีกครั้ง"
}

Say ''
Say '=================================================='
Say '  เสร็จแล้ว'
Say "  อัปเดตครั้งต่อไป:  git -C $Root pull origin $Branch  แล้ว  Restart-Service $ServiceName"
Say '=================================================='
Say ''
