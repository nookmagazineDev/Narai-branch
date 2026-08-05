# ตัวเฝ้าระวัง Narai Usage API — ติดตั้งเป็น Scheduled Task ให้รันทุก 5 นาที
# (ติดตั้งด้วย fix-narai-api.ps1 -Harden ไม่ต้องรันไฟล์นี้เองด้วยมือ)
#
# หน้าที่: ถ้า /health ไม่ตอบ ให้รีสตาร์ท service ให้อัตโนมัติ แล้วจดลง log
# ทำไมต้องมี: Windows Service รีสตาร์ทเองเฉพาะตอน "โปรเซสตาย" เท่านั้น
#   แต่มีอาการที่โปรเซสยังอยู่แต่ค้างไม่รับ request (เน็ตออฟฟิศหลุดยาวจนค้างคาที่การดึงข้อมูล)
#   กรณีนั้น Windows ไม่ถือว่าแครช จึงไม่รีสตาร์ทให้ ต้องมีตัวเช็คจากภายนอกแบบนี้

param(
  [int]$Port = 8787,
  [string]$ServiceName = 'NaraiUsageAPI'
)

$ErrorActionPreference = 'Stop'
$logDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'logs'
$logFile = Join-Path $logDir 'watchdog.log'

function Write-Log([string]$msg) {
  if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
  $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Add-Content -Path $logFile -Value $line -Encoding UTF8
  # ตัด log ไม่ให้โตไม่จำกัด (เก็บ 2000 บรรทัดล่าสุด)
  $lines = @(Get-Content -Path $logFile -Encoding UTF8)
  if ($lines.Count -gt 2000) { $lines[-2000..-1] | Set-Content -Path $logFile -Encoding UTF8 }
}

$healthy = $false
try {
  $h = Invoke-RestMethod -Uri "http://localhost:$Port/health" -TimeoutSec 20
  if ($h.ok) { $healthy = $true }
} catch {
  $healthy = $false
}

if ($healthy) { exit 0 }

Write-Log "health ไม่ตอบ — กำลังรีสตาร์ท service $ServiceName"
try {
  Restart-Service -Name $ServiceName -Force
  Start-Sleep -Seconds 20
  try {
    $h2 = Invoke-RestMethod -Uri "http://localhost:$Port/health" -TimeoutSec 30
    if ($h2.ok) {
      Write-Log "รีสตาร์ทสำเร็จ (cache $($h2.days_cached) วัน — กำลังอุ่น cache ต่อเบื้องหลัง)"
    } else {
      Write-Log 'รีสตาร์ทแล้วแต่ health ยังไม่ ok'
    }
  } catch {
    # อุ่น cache ตอนสตาร์ทใช้เวลา 3-4 นาที ช่วงนั้น health อาจยังไม่ตอบ ถือว่าปกติ
    Write-Log 'รีสตาร์ทแล้ว รอ health อีกสักครู่ (ปกติใช้เวลาอุ่น cache 3-4 นาที)'
  }
} catch {
  Write-Log "รีสตาร์ทไม่สำเร็จ: $($_.Exception.Message)"
  exit 1
}
