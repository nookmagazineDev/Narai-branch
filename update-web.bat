@echo off
chcp 65001 >nul
rem ============================================================
rem  update-web.bat — อัปเดตหน้าเว็บ + api/ (serve-local.mjs) จาก GitHub คลิกเดียว
rem  ใช้บนเครื่อง 203.154.185.48 ที่โฟลเดอร์ C:\narai-local\narai-branch (ดู docs/hosting-local.md)
rem
rem  วิธีใช้: ดับเบิลคลิกไฟล์นี้
rem
rem  ทำให้ครบ 4 ขั้น:
rem    1) ดึงโค้ดล่าสุดจาก GitHub (git pull)
rem    2) ลงส่วนประกอบ (npm install) เฉพาะเมื่อ package.json เปลี่ยน
rem    3) build หน้าเว็บลงโฟลเดอร์ชั่วคราวก่อน ผ่านแล้วค่อยสลับเข้า dist
rem       build พัง = dist เดิมไม่ถูกแตะ เว็บตัวเดิมยังทำงานต่อ
rem    4) รีสตาร์ต serve-local.mjs แล้วเช็คว่าเว็บตอบ
rem  ขั้นไหนพัง หยุดก่อนรีสตาร์ต
rem
rem  ไม่แตะ .env, serve-local.mjs, *.log (ไม่อยู่ใน git)
rem  office-server เป็นคนละตัว อัปเดตด้วย D:\Narai-branch-main\office-server\update-office-server.bat
rem ============================================================
setlocal

rem git pull อาจเขียนทับไฟล์นี้ขณะที่กำลังรันอยู่ แล้ว cmd จะอ่านบรรทัดถัดไปผิดตำแหน่ง
rem จึงคัดลอกตัวเองไปรันจาก %TEMP% ก่อน แล้วส่งที่อยู่โฟลเดอร์จริงตามไปด้วย
if /i not "%~1"=="--from-temp" (
  copy /y "%~f0" "%TEMP%\narai-update-web.bat" >nul
  call "%TEMP%\narai-update-web.bat" --from-temp "%~dp0"
  exit /b %errorlevel%
)

set "ROOT=%~2"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "PORT=3102"
set "SVC=NaraiBranchWeb"
title Narai web - อัปเดตจาก GitHub
color 0B

echo =========================================
echo    อัปเดตหน้าเว็บ NARAI-BRANCH จาก GitHub
echo =========================================
echo    โฟลเดอร์: %ROOT%
echo.

pushd "%ROOT%"

if not exist "serve-local.mjs" (
  echo [ผิดพลาด] ไม่พบ serve-local.mjs ในโฟลเดอร์นี้ — ไฟล์นี้ต้องอยู่ใน C:\narai-local\narai-branch
  echo.
  popd
  pause
  exit /b 1
)

where git >nul 2>&1
if errorlevel 1 (
  echo [ผิดพลาด] ไม่พบ Git ในเครื่องนี้ — ติดตั้งก่อน: winget install --id Git.Git -e
  echo.
  popd
  pause
  exit /b 1
)

rem ติดตั้งเป็น service แล้ว (install-web-service.bat) — รีสตาร์ต service ต้องใช้สิทธิ์ผู้ดูแลระบบ
rem เช็คตั้งแต่ต้น ไม่ให้ build เสร็จแล้วค่อยมาติดตอนรีสตาร์ต
set "HASSVC="
sc query %SVC% >nul 2>&1
if not errorlevel 1 set "HASSVC=1"
if defined HASSVC (
  net session >nul 2>&1
  if errorlevel 1 (
    echo [ผิดพลาด] เว็บรันเป็น service %SVC% แล้ว ต้องเปิดไฟล์นี้ด้วยสิทธิ์ผู้ดูแลระบบ
    echo คลิกขวาที่ไฟล์ update-web.bat แล้วเลือก "Run as administrator"
    echo.
    popd
    pause
    exit /b 1
  )
)

for /f %%i in ('git rev-parse HEAD') do set "OLDREV=%%i"

echo [1/4] ดึงโค้ดล่าสุดจาก GitHub...
rem package-lock.json ในเครื่องถูก npm แก้ไว้ (ตอนลง express/dotenv ให้ serve-local.mjs)
rem คืนเป็นของ git ก่อน ไม่งั้น pull ชนทุกครั้งที่ GitHub แก้ไฟล์นี้ — ไม่กระทบ node_modules
git checkout -- package-lock.json >nul 2>&1
git pull --ff-only origin main
if errorlevel 1 (
  echo.
  echo [ผิดพลาด] ดึงโค้ดไม่สำเร็จ — ไม่มีอะไรถูกเปลี่ยน เว็บตัวเดิมยังทำงานอยู่
  echo  - ถ้าขึ้นว่ามีไฟล์ถูกแก้ในเครื่อง ^(local changes^): ดูด้วย git status
  echo    ส่งภาพหน้าจอนี้ให้คนดูแลระบบ ^(.env และ serve-local.mjs ไม่เกี่ยว^)
  echo.
  popd
  pause
  exit /b 1
)
for /f %%i in ('git rev-parse HEAD') do set "NEWREV=%%i"
echo.

echo [2/4] ตรวจส่วนประกอบ (node_modules)...
set "NEEDINSTALL="
if not exist "node_modules\vite" set "NEEDINSTALL=1"
git diff --quiet %OLDREV% %NEWREV% -- package.json package-lock.json
if errorlevel 1 set "NEEDINSTALL=1"
if defined NEEDINSTALL (
  echo    มีส่วนประกอบเปลี่ยน กำลังติดตั้ง ^(1-3 นาที^)...
  call npm install --no-audit --no-fund
  if errorlevel 1 goto :installfail
) else (
  echo    ไม่มีอะไรเปลี่ยน ข้าม
)
rem serve-local.mjs ใช้ express + dotenv ที่ไม่อยู่ใน package.json — npm install ธรรมดาจะลบทิ้ง
rem จึงเช็คทุกครั้ง ขาดเมื่อไหร่ลงให้ใหม่ (--no-save ไม่แก้ package.json)
set "NEEDEXTRA="
if not exist "node_modules\express" set "NEEDEXTRA=1"
if not exist "node_modules\dotenv" set "NEEDEXTRA=1"
if defined NEEDEXTRA (
  echo    ลง express + dotenv ให้ serve-local.mjs...
  call npm install express@4 dotenv --no-save --no-audit --no-fund
  if errorlevel 1 goto :installfail
)
echo.

echo [3/4] build หน้าเว็บ...
if exist "dist-new" rmdir /s /q "dist-new"
call npx vite build --outDir dist-new --emptyOutDir
if errorlevel 1 (
  echo.
  echo [ผิดพลาด] build ไม่สำเร็จ — dist เดิมไม่ถูกแตะ เว็บตัวเดิมยังทำงานอยู่ ยังไม่ได้รีสตาร์ต
  echo ส่งภาพหน้าจอนี้ให้คนดูแลระบบได้เลย
  echo.
  if exist "dist-new" rmdir /s /q "dist-new"
  popd
  pause
  exit /b 1
)
if exist "dist-old" rmdir /s /q "dist-old"
if exist "dist" move "dist" "dist-old" >nul
move "dist-new" "dist" >nul
if errorlevel 1 (
  echo [ผิดพลาด] สลับโฟลเดอร์ dist ไม่สำเร็จ — คืนของเดิม
  if exist "dist-old" move "dist-old" "dist" >nul
  popd
  pause
  exit /b 1
)
if exist "dist-old" rmdir /s /q "dist-old"
echo.

echo [4/4] รีสตาร์ต serve-local.mjs...
if defined HASSVC (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Restart-Service -Name '%SVC%' -Force -ErrorAction Stop"
  if errorlevel 1 (
    echo [ผิดพลาด] รีสตาร์ต service %SVC% ไม่สำเร็จ — ดู log: %ROOT%\local-err.log
    popd
    pause
    exit /b 1
  )
  goto :waitweb
)
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'serve-local' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force };" ^
  "Start-Sleep -Seconds 2;" ^
  "Start-Process node -ArgumentList 'serve-local.mjs' -WorkingDirectory '%ROOT%' -RedirectStandardOutput '%ROOT%\local-out.log' -RedirectStandardError '%ROOT%\local-err.log' -WindowStyle Hidden"
:waitweb
echo    รอให้เว็บพร้อม...
ping -n 6 127.0.0.1 >nul
powershell -NoProfile -Command ^
  "$ok = $false; foreach ($i in 1..10) { try { $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 'http://localhost:%PORT%/api/pending_orders?outletId=1'; if ($r.StatusCode -eq 200) { $ok = $true; break } } catch { $msg = $_.ErrorDetails.Message; if (-not $msg) { $msg = $_.Exception.Message } }; Start-Sleep -Seconds 2 };" ^
  "if ($ok) { Write-Host '    เว็บตอบปกติ (HTTP 200)' } else { Write-Host ('[!!] เว็บยังไม่ตอบ: ' + $msg); Write-Host '     ดู log: Get-Content %ROOT%\local-err.log -Tail 20' }"

popd
echo.
echo =========================================
echo    เสร็จสิ้น — อัปเดตเป็นรุ่น %NEWREV:~0,7%
echo =========================================
echo    ให้ผู้ใช้กด Ctrl+F5 ที่หน้าเว็บเพื่อโหลดรุ่นใหม่
echo.
pause
exit /b 0

:installfail
echo.
echo [ผิดพลาด] ติดตั้งส่วนประกอบไม่สำเร็จ — เว็บตัวเดิมยังทำงานอยู่ ยังไม่ได้รีสตาร์ต
echo.
popd
pause
exit /b 1
