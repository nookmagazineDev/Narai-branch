# กู้เครื่อง IT-Narai ให้หน้าเว็บดึงยอดขายได้อีกครั้ง
#
# ใช้เมื่อหน้าเว็บขึ้น "ติดต่อเซิร์ฟเวอร์ที่ออฟฟิศไม่ได้ — เครื่อง IT-Narai อาจปิดอยู่"
#
# วิธีใช้ (บนเครื่อง IT-Narai — คลิกขวาที่ PowerShell เลือก "Run as administrator"):
#   cd C:\narai\office-server\scripts          # หรือที่ที่วางโค้ดไว้
#   powershell -ExecutionPolicy Bypass -File .\fix-narai-api.ps1
#
# เพิ่ม -Harden เพื่อ "กันไม่ให้ดับซ้ำอีก" (ตั้งไม่ให้เครื่องหลับ + ติดตั้งตัวเฝ้าระวังทุก 5 นาที):
#   powershell -ExecutionPolicy Bypass -File .\fix-narai-api.ps1 -Harden
#
# สคริปนี้ตรวจทีละชั้นแล้วซ่อมให้เท่าที่ซ่อมได้ ชั้นไหนซ่อมไม่ได้จะบอกว่าต้องทำอะไรต่อ

param(
  [int]$Port = 8787,
  [string]$ServiceName = 'NaraiUsageAPI',
  [string]$PublicHost = 'storenarai.dyndns.tv',
  [switch]$Harden
)

$ErrorActionPreference = 'Continue'
# Windows รุ่นเก่าตั้งค่าเริ่มต้นเป็น TLS 1.0 ซึ่งเว็บส่วนใหญ่ไม่รับแล้ว (ทำให้ขั้นตอนเช็ค IP ล้มเหลวลอยๆ)
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$serverDir = Split-Path -Parent $PSScriptRoot
$problems = New-Object System.Collections.ArrayList
$fixed = New-Object System.Collections.ArrayList

function Say([string]$msg)  { Write-Host $msg }
function Ok([string]$msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Warn([string]$msg) { Write-Host "  [!!] $msg" -ForegroundColor Yellow }
function Bad([string]$msg)  { Write-Host "  [XX] $msg" -ForegroundColor Red }
function Fix([string]$msg)  { Write-Host "  [->] $msg" -ForegroundColor Cyan }

function Test-Health([int]$TimeoutSec = 15) {
  try {
    $h = Invoke-RestMethod -Uri "http://localhost:$Port/health" -TimeoutSec $TimeoutSec
    if ($h.ok) { return $h }
    return $null
  } catch { return $null }
}

Say ''
Say '=============================================='
Say '  ตรวจและกู้ Narai Usage API (เครื่อง IT-Narai)'
Say '=============================================='

# ---- 0) ต้องเป็น Administrator ----
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Bad 'ต้องเปิด PowerShell แบบ "Run as administrator" ก่อน (สคริปนี้ต้องสั่ง start/restart service)'
  Say ''
  exit 1
}

# ---- 1) Node.js ----
Say ''
Say '[1/6] Node.js'
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
  Ok "พบ Node.js $(& node -v)"
} else {
  Bad 'ไม่พบ Node.js — service รันไม่ได้แน่นอน ต้องติดตั้ง Node.js ใหม่จาก https://nodejs.org (เลือก LTS)'
  [void]$problems.Add('ไม่มี Node.js')
}

# ---- 2) Windows Service ----
Say ''
Say "[2/6] Windows Service '$ServiceName'"
$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if (-not $svc) {
  Bad "ไม่พบ service '$ServiceName' (อาจถูกถอนออก หรือเครื่องนี้ยังไม่เคยติดตั้ง)"
  $nssm = 'C:\tools\nssm.exe'
  if (Test-Path $nssm) {
    Fix 'พบ NSSM — ติดตั้ง service ใหม่ด้วยคำสั่งนี้ (แก้ path ให้ตรงกับที่วางโค้ดจริง):'
    Say ''
    Say "    & '$nssm' install $ServiceName `"$((Get-Command node).Source)`" `"$serverDir\server.js`""
    Say "    & '$nssm' set $ServiceName AppDirectory `"$serverDir`""
    Say "    & '$nssm' set $ServiceName Start SERVICE_AUTO_START"
    Say "    & '$nssm' set $ServiceName AppStdout `"$serverDir\logs\service-out.log`""
    Say "    & '$nssm' set $ServiceName AppStderr `"$serverDir\logs\service-err.log`""
    Say "    Start-Service $ServiceName"
    Say ''
  } else {
    Fix 'ไม่พบ NSSM ที่ C:\tools\nssm.exe — ดาวน์โหลดจาก https://nssm.cc แล้ววางไว้ที่ C:\tools\ ก่อน'
  }
  [void]$problems.Add("ไม่มี service $ServiceName")
} else {
  Ok "พบ service (สถานะ: $($svc.Status))"

  # ต้องตั้งเป็น Automatic ไม่งั้นเปิดเครื่องมาแล้วไม่ขึ้นเอง
  $startMode = (Get-CimInstance -ClassName Win32_Service -Filter "Name='$ServiceName'").StartMode
  if ($startMode -ne 'Auto') {
    Warn "service ตั้งเป็น '$startMode' — เปิดเครื่องมาจะไม่สตาร์ทเอง กำลังแก้เป็น Automatic"
    Set-Service -Name $ServiceName -StartupType Automatic
    [void]$fixed.Add('ตั้ง service ให้สตาร์ทเองตอนเปิดเครื่อง')
  } else {
    Ok 'ตั้งให้สตาร์ทเองตอนเปิดเครื่องแล้ว'
  }

  if ($svc.Status -ne 'Running') {
    Fix 'service ไม่ได้รันอยู่ — กำลังสตาร์ท'
    try {
      Start-Service -Name $ServiceName
      Start-Sleep -Seconds 5
      [void]$fixed.Add('สตาร์ท service')
      Ok 'สตาร์ทแล้ว'
    } catch {
      Bad "สตาร์ทไม่สำเร็จ: $($_.Exception.Message)"
      Fix "ดูสาเหตุได้ที่ $serverDir\logs\service-err.log"
      [void]$problems.Add('สตาร์ท service ไม่สำเร็จ')
    }
  }
}

# ---- 3) /health ----
Say ''
Say "[3/6] ตัวบริการตอบสนองไหม (http://localhost:$Port/health)"
$health = Test-Health
if ($health) {
  Ok "ตอบปกติ — cache $($health.days_cached) วัน, สูตร $($health.recipes) เมนู"
  if ([int]$health.recipes -eq 0) {
    Warn 'ยังโหลดสูตรไม่ได้ (แดชบอร์ดจะไม่มีต้นทุน) — มักเป็นเพราะเน็ตออกไม่ได้ตอนสตาร์ท เดี๋ยวระบบลองใหม่เองทุก 6 ชม.'
  }
} elseif ($svc) {
  Warn 'ไม่ตอบ — กำลังรีสตาร์ทแล้วรออีกครั้ง (ตอนสตาร์ทต้องอุ่น cache 3-4 นาที)'
  try {
    Restart-Service -Name $ServiceName -Force
    Start-Sleep -Seconds 25
    $health = Test-Health -TimeoutSec 30
    if ($health) {
      Ok "กลับมาตอบแล้ว — cache $($health.days_cached) วัน"
      [void]$fixed.Add('รีสตาร์ท service')
    } else {
      Bad 'รีสตาร์ทแล้วยังไม่ตอบ'
      Fix "เปิดดู log: $serverDir\logs\service-err.log"
      [void]$problems.Add('service ไม่ตอบ /health')
    }
  } catch {
    Bad "รีสตาร์ทไม่สำเร็จ: $($_.Exception.Message)"
    [void]$problems.Add('รีสตาร์ท service ไม่สำเร็จ')
  }
}

# ---- 4) Firewall ----
Say ''
Say "[4/6] Firewall (พอร์ต $Port ขาเข้า)"
$ruleName = "Narai Usage API $Port"
$rule = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
if ($rule) {
  if ($rule.Enabled -eq 'False') {
    Fix 'มีกฎอยู่แต่ถูกปิด — กำลังเปิด'
    Enable-NetFirewallRule -DisplayName $ruleName
    [void]$fixed.Add('เปิดกฎ firewall')
  } else {
    Ok 'มีกฎเปิดพอร์ตอยู่แล้ว'
  }
} else {
  Fix 'ยังไม่มีกฎเปิดพอร์ต — กำลังเพิ่มให้'
  try {
    New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Any | Out-Null
    Ok 'เพิ่มกฎแล้ว'
    [void]$fixed.Add('เพิ่มกฎ firewall เปิดพอร์ต')
  } catch {
    Bad "เพิ่มกฎไม่สำเร็จ: $($_.Exception.Message)"
    [void]$problems.Add('เพิ่มกฎ firewall ไม่สำเร็จ')
  }
}

# ---- 5) เข้าจากข้างนอกได้ไหม (dyndns ชี้ IP ถูกตัวหรือเปล่า) ----
Say ''
Say "[5/6] เส้นทางจากข้างนอก ($PublicHost)"
$dnsIp = $null
$wanIp = $null
try {
  $dnsIp = (Resolve-DnsName -Name $PublicHost -Type A -ErrorAction Stop | Where-Object { $_.IPAddress } | Select-Object -First 1).IPAddress
} catch { }
try {
  $wanIp = (Invoke-RestMethod -Uri 'https://api.ipify.org?format=json' -TimeoutSec 15).ip
} catch { }

if (-not $dnsIp) {
  Bad "หา IP ของ $PublicHost ไม่เจอ — dyndns อาจหมดอายุหรือชื่อโดเมนถูกลบ"
  [void]$problems.Add('dyndns หา IP ไม่เจอ')
} elseif (-not $wanIp) {
  Warn "ได้ IP ของ dyndns = $dnsIp แต่เช็ค IP จริงของเน็ตออฟฟิศไม่ได้ (เน็ตออกไม่ได้?)"
  [void]$problems.Add('เช็ค IP ขาออกไม่ได้')
} elseif ($dnsIp -eq $wanIp) {
  Ok "dyndns ชี้ถูกตัวแล้ว ($dnsIp)"
} else {
  Bad "dyndns ชี้ผิดตัว: $PublicHost = $dnsIp แต่ IP จริงของออฟฟิศคือ $wanIp"
  Fix 'ต้องสั่งอัปเดต dyndns (เปิดโปรแกรม DynDNS updater บนเครื่อง หรืออัปเดตที่หน้าเว็บ router) — ระหว่างนี้หน้าเว็บจะเข้าไม่ได้'
  Fix "ทางลัดชั่วคราว: ตั้ง env USAGE_API_BASE = http://${wanIp}:$Port บน Vercel แล้ว redeploy"
  [void]$problems.Add('dyndns ชี้ IP ผิด')
}

# พอร์ตเปิดออกเน็ตจริงไหม (UPnP ทำให้เองตอน service สตาร์ท แต่ router อาจรีเซ็ต mapping ทิ้ง)
if ($wanIp) {
  try {
    $probe = Invoke-RestMethod -Uri "http://${wanIp}:$Port/health" -TimeoutSec 15
    if ($probe.ok) { Ok "เข้าจากข้างนอกผ่าน IP จริงได้ (พอร์ต $Port เปิดอยู่)" }
  } catch {
    Warn "ทดสอบเข้าจากข้างนอกไม่ผ่าน — router อาจไม่ได้ forward พอร์ต $Port (UPnP ถูกรีเซ็ต)"
    Fix "แก้: รีสตาร์ท service อีกครั้งเพื่อให้สั่ง UPnP ใหม่ หรือตั้ง Port Forwarding $Port ที่ router ด้วยมือ"
    Fix '(บาง router บล็อกการวนกลับเข้าตัวเอง ผลทดสอบนี้อาจไม่แม่น ให้ลองจากมือถือที่ปิด wifi แทน)'
  }
}

# ---- 6) กันไม่ให้ดับซ้ำ ----
Say ''
Say '[6/6] กันไม่ให้ดับซ้ำ'
if (-not $Harden) {
  Say '  (ข้าม — ใส่ -Harden เพื่อตั้งไม่ให้เครื่องหลับ + ติดตั้งตัวเฝ้าระวังอัตโนมัติ)'
} else {
  # 6.1 ไม่ให้เครื่องหลับ/จำศีล ตอนเสียบไฟ
  Fix 'ตั้งไม่ให้เครื่องหลับ/จำศีลตอนเสียบไฟ'
  & powercfg /change standby-timeout-ac 0 2>&1 | Out-Null
  & powercfg /change hibernate-timeout-ac 0 2>&1 | Out-Null
  & powercfg /change disk-timeout-ac 0 2>&1 | Out-Null
  & powercfg /hibernate off 2>&1 | Out-Null
  [void]$fixed.Add('ตั้งไม่ให้เครื่องหลับ')

  # 6.2 ให้ Windows รีสตาร์ท service เองเมื่อโปรเซสตาย
  if ($svc) {
    Fix 'ตั้งให้ Windows รีสตาร์ท service เองเมื่อโปรเซสตาย'
    & sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/10000/restart/30000 | Out-Null
    [void]$fixed.Add('ตั้ง auto-restart เมื่อ service ตาย')
  }

  # 6.3 ตัวเฝ้าระวังทุก 5 นาที (เผื่อกรณีโปรเซสยังอยู่แต่ค้างไม่รับ request)
  $watchdog = Join-Path $PSScriptRoot 'narai-watchdog.ps1'
  if (Test-Path $watchdog) {
    Fix 'ติดตั้งตัวเฝ้าระวัง (Scheduled Task ทุก 5 นาที)'
    try {
      $action  = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$watchdog`" -Port $Port -ServiceName $ServiceName"
      # ระบุ RepetitionDuration ยาวๆ ด้วย — PowerShell 5.1 บางรุ่นไม่วนซ้ำถ้าไม่ใส่
      $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
      $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
      $settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
      Register-ScheduledTask -TaskName 'NaraiUsageAPI-Watchdog' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
      Ok "ติดตั้งแล้ว (log: $serverDir\logs\watchdog.log)"
      [void]$fixed.Add('ติดตั้งตัวเฝ้าระวังทุก 5 นาที')
    } catch {
      Bad "ติดตั้งตัวเฝ้าระวังไม่สำเร็จ: $($_.Exception.Message)"
    }
  } else {
    Warn "ไม่พบ $watchdog — ข้ามการติดตั้งตัวเฝ้าระวัง"
  }
}

# ---- สรุป ----
Say ''
Say '=============================================='
Say '  สรุป'
Say '=============================================='
if ($fixed.Count -gt 0) {
  Say ''
  Say 'แก้ให้แล้ว:'
  foreach ($f in $fixed) { Ok $f }
}
if ($problems.Count -gt 0) {
  Say ''
  Say 'ยังต้องจัดการต่อ:'
  foreach ($p in $problems) { Bad $p }
} else {
  Say ''
  $final = Test-Health -TimeoutSec 20
  if ($final) {
    Ok "เรียบร้อย — ตัวบริการทำงานปกติ (cache $($final.days_cached) วัน)"
    Say ''
    Say '  ให้รออีก 3-4 นาที (ระบบกำลังอุ่นข้อมูลย้อนหลัง) แล้วลองเปิดหน้า "ค้นหารายการขาย" ใหม่'
  } else {
    Warn 'ยังไม่ตอบ — ถ้าเพิ่งรีสตาร์ทไป ให้รอ 3-4 นาที (อุ่น cache) แล้วรันสคริปนี้ซ้ำอีกครั้ง'
  }
}
Say ''
if (-not $Harden) {
  Say 'อยากกันไม่ให้ดับซ้ำอีก ให้รันซ้ำแบบนี้:'
  Say "    powershell -ExecutionPolicy Bypass -File .\fix-narai-api.ps1 -Harden"
  Say ''
}
