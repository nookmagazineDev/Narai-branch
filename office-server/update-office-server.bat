@echo off
chcp 65001 >nul
rem ============================================================
rem  update-office-server.bat — อัปเดต office-server จาก GitHub คลิกเดียว (แบบเดียวกับ HumLai-pos)
rem
rem  วิธีใช้: คลิกขวาที่ไฟล์นี้ -> Run as administrator
rem
rem  ทำให้ครบ 4 ขั้น:
rem    1) ดึงโค้ดล่าสุดจาก GitHub (git pull)
rem    2) ลงส่วนประกอบ (npm install) ถ้ามีเปลี่ยน
rem    3) อัปเดตโครงสร้างฐานข้อมูล — รันไฟล์ใน office-server\sql\ ด้วย login จาก .env
rem       (ไม่ต้องพิมพ์รหัส sa · ทุกไฟล์รันซ้ำได้ ไม่มีข้อมูลหาย)
rem    4) รีสตาร์ต service NaraiUsageAPI แล้วเช็ค /health
rem  ขั้นไหนพัง หยุดก่อนรีสตาร์ต — service ตัวเดิมยังทำงานต่อ
rem
rem  ไม่แตะ .env, logs, node_modules (อยู่ใน .gitignore)
rem  โฟลเดอร์ต้องเป็น git repo — ถ้าได้โค้ดมาจาก ZIP ให้รัน scripts\link-to-git.ps1 ก่อนครั้งเดียว
rem ============================================================
setlocal

rem git pull อาจเขียนทับไฟล์นี้ขณะที่กำลังรันอยู่ แล้ว cmd จะอ่านบรรทัดถัดไปผิดตำแหน่ง
rem จึงคัดลอกตัวเองไปรันจาก %TEMP% ก่อน แล้วส่งที่อยู่โฟลเดอร์จริงตามไปด้วย
if /i not "%~1"=="--from-temp" (
  copy /y "%~f0" "%TEMP%\narai-update-office-server.bat" >nul
  call "%TEMP%\narai-update-office-server.bat" --from-temp "%~dp0"
  exit /b %errorlevel%
)

set "SRVDIR=%~2"
if "%SRVDIR:~-1%"=="\" set "SRVDIR=%SRVDIR:~0,-1%"
set "SVC=NaraiUsageAPI"
set "PORT=8787"
title Narai office-server - อัปเดตจาก GitHub
color 0B

echo =========================================
echo    อัปเดต OFFICE-SERVER จาก GitHub
echo =========================================
echo    โฟลเดอร์: %SRVDIR%
echo.

net session >nul 2>&1
if errorlevel 1 (
  echo [ผิดพลาด] ต้องเปิดไฟล์นี้ด้วยสิทธิ์ผู้ดูแลระบบ
  echo คลิกขวาที่ไฟล์ update-office-server.bat แล้วเลือก "Run as administrator"
  echo.
  pause
  exit /b 1
)

where git >nul 2>&1
if errorlevel 1 (
  echo [ผิดพลาด] ไม่พบ Git ในเครื่องนี้ — ติดตั้งก่อน: winget install --id Git.Git -e
  echo แล้วปิดหน้าต่างนี้ เปิดไฟล์นี้ใหม่
  echo.
  pause
  exit /b 1
)

pushd "%SRVDIR%\.."
set "ROOT=%CD%"
git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 (
  echo [ผิดพลาด] โฟลเดอร์ %ROOT% ยังไม่ได้เชื่อมกับ GitHub ^(ได้โค้ดมาจาก ZIP^)
  echo เชื่อมครั้งเดียวก่อน — เปิด PowerShell แบบ Run as administrator แล้วรัน:
  echo    powershell -ExecutionPolicy Bypass -File "%SRVDIR%\scripts\link-to-git.ps1"
  echo แล้วค่อยรันไฟล์นี้อีกครั้ง
  echo.
  popd
  pause
  exit /b 1
)

rem เครื่องที่รัน service ในนาม SYSTEM มักติด "dubious ownership" — อนุญาตโฟลเดอร์นี้ไว้ก่อน
git config --global --get-all safe.directory | findstr /i /x /c:"%ROOT:\=/%" >nul 2>&1
if errorlevel 1 git config --global --add safe.directory "%ROOT:\=/%"

for /f %%i in ('git rev-parse HEAD') do set "OLDREV=%%i"

echo [1/4] ดึงโค้ดล่าสุดจาก GitHub...
git pull --ff-only origin main
if errorlevel 1 (
  echo.
  echo [ผิดพลาด] ดึงโค้ดไม่สำเร็จ — ไม่มีอะไรถูกเปลี่ยน service ตัวเดิมยังทำงานอยู่
  echo  - ถ้าขึ้นว่ามีไฟล์ถูกแก้ในเครื่อง ^(local changes^): ดูด้วย git status
  echo    ถ้าไม่ต้องเก็บ รัน git reset --hard origin/main แล้วรันไฟล์นี้ใหม่ ^(.env ไม่ถูกแตะ^)
  echo.
  popd
  pause
  exit /b 1
)
for /f %%i in ('git rev-parse HEAD') do set "NEWREV=%%i"
echo.

echo [2/4] ตรวจส่วนประกอบ (node_modules)...
set "NEEDINSTALL="
if not exist "%SRVDIR%\node_modules\mssql" set "NEEDINSTALL=1"
if not exist "%SRVDIR%\node_modules\dotenv" set "NEEDINSTALL=1"
git diff --quiet %OLDREV% %NEWREV% -- office-server/package.json office-server/package-lock.json
if errorlevel 1 set "NEEDINSTALL=1"
if defined NEEDINSTALL (
  echo    มีส่วนประกอบเปลี่ยน กำลังติดตั้ง ^(1-3 นาที^)...
  pushd "%SRVDIR%"
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    popd
    echo.
    echo [ผิดพลาด] ติดตั้งส่วนประกอบไม่สำเร็จ — service ตัวเดิมยังทำงานอยู่ ยังไม่ได้รีสตาร์ต
    echo.
    popd
    pause
    exit /b 1
  )
  popd
) else (
  echo    ไม่มีอะไรเปลี่ยน ข้าม
)
echo.

echo [3/4] อัปเดตโครงสร้างฐานข้อมูล (รันซ้ำได้ ไม่มีข้อมูลหาย)...
pushd "%SRVDIR%"
node scripts\run-migrations.mjs
if errorlevel 1 (
  popd
  echo.
  echo [ผิดพลาด] อัปเดตโครงสร้างฐานข้อมูลไม่สำเร็จ — service ตัวเดิมยังทำงานอยู่ ยังไม่ได้รีสตาร์ต
  echo ส่งภาพหน้าจอนี้ให้คนดูแลระบบได้เลย
  echo.
  popd
  pause
  exit /b 1
)
popd
echo.

echo [4/4] รีสตาร์ต service %SVC%...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Restart-Service -Name '%SVC%' -Force -ErrorAction Stop" 
if errorlevel 1 (
  echo.
  echo [ผิดพลาด] รีสตาร์ต service %SVC% ไม่สำเร็จ — ลองรัน scripts\fix-narai-api.cmd
  echo.
  popd
  pause
  exit /b 1
)
echo    รอให้เซิร์ฟเวอร์พร้อม...
ping -n 16 127.0.0.1 >nul
powershell -NoProfile -Command "try { $h = Invoke-RestMethod -TimeoutSec 20 'http://localhost:%PORT%/health'; Write-Host ('    ok=' + $h.ok + '  code_sha=' + $h.code_sha + '  started_at=' + $h.started_at) } catch { Write-Host ('[!!] ยังไม่ตอบ: ' + $_.Exception.Message + ' — ถ้าเพิ่งรีสตาร์ต รอ 3-4 นาทีแล้วเปิด http://localhost:%PORT%/health ดูอีกครั้ง') }"

popd
echo.
echo =========================================
echo    เสร็จสิ้น — อัปเดตเป็นรุ่น %NEWREV:~0,7%
echo =========================================
echo    code_sha ด้านบนต้องตรงกับ %NEWREV:~0,7%
echo.
pause
