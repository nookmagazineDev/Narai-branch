@echo off
chcp 65001 >nul 2>&1
rem ============================================================
rem  กู้เครื่อง IT-Narai ให้หน้าเว็บดึงยอดขายได้อีกครั้ง
rem  เวอร์ชันนี้ไม่ต้องใช้ PowerShell — ใช้แค่คำสั่งพื้นฐานของ Windows
rem
rem  วิธีใช้ (บนเครื่อง IT-Narai):
rem    คลิกขวาที่ไฟล์นี้ -> Run as administrator
rem    หรือเปิด Command Prompt แบบ admin แล้วพิมพ์:
rem      cd /d D:\naraiสาขา\Narai-branch\office-server\scripts
rem      fix-narai-api.cmd
rem
rem  กันไม่ให้ดับซ้ำอีก (ทำครั้งเดียวพอ):
rem      fix-narai-api.cmd harden
rem ============================================================

setlocal enabledelayedexpansion
set "PORT=8787"
set "SVC=NaraiUsageAPI"
set "PUBHOST=storenarai.dyndns.tv"
set "SRVDIR=%~dp0.."
set "HARDEN="
if /i "%~1"=="harden" set "HARDEN=1"

set "PROBLEMS=0"

echo.
echo ==============================================
echo   ตรวจและกู้ Narai Usage API
echo ==============================================

rem ---- 0) ต้องเป็น Administrator ----
net session >nul 2>&1
if errorlevel 1 (
  echo.
  echo   [XX] ต้องเปิดแบบ "Run as administrator" ก่อน
  echo        คลิกขวาที่ไฟล์นี้ แล้วเลือก Run as administrator
  echo.
  pause
  exit /b 1
)

rem ---- ต้องมี curl ----
where curl >nul 2>&1
if errorlevel 1 (
  echo.
  echo   [XX] เครื่องนี้ไม่มีคำสั่ง curl - Windows เก่ากว่า 10 build 1803
  echo        ให้เช็คด้วยการเปิดเบราว์เซอร์ไปที่ http://localhost:%PORT%/health แทน
  echo.
  set "PROBLEMS=1"
)

rem ---- 1) Node.js ----
echo.
echo [1/6] Node.js
where node >nul 2>&1
if errorlevel 1 (
  echo   [XX] ไม่พบ Node.js - service รันไม่ได้แน่นอน
  echo        ติดตั้งใหม่จาก https://nodejs.org เลือกตัว LTS
  set "PROBLEMS=1"
) else (
  for /f "delims=" %%v in ('node -v 2^>nul') do echo   [OK] พบ Node.js %%v
)

rem ---- 2) Windows Service ----
echo.
echo [2/6] Windows Service %SVC%
sc query %SVC% >nul 2>&1
if errorlevel 1 (
  echo   [XX] ไม่พบ service %SVC% - อาจถูกถอนออก หรือเครื่องนี้ไม่ใช่เครื่อง IT-Narai
  echo        ถ้าเป็นเครื่อง IT-Narai จริง ต้องติดตั้ง service ใหม่ผ่าน NSSM
  echo        ดูขั้นตอนที่ office-server\README.md
  set "PROBLEMS=1"
  goto :after_service
)

echo   [OK] พบ service แล้ว

rem ตั้งให้สตาร์ทเองตอนเปิดเครื่อง
sc qc %SVC% | find "AUTO_START" >nul 2>&1
if errorlevel 1 (
  echo   [--^>] ยังไม่ได้ตั้งให้สตาร์ทเองตอนเปิดเครื่อง - กำลังแก้
  sc config %SVC% start= auto >nul 2>&1
  if errorlevel 1 (
    echo   [XX] ตั้งไม่สำเร็จ
  ) else (
    echo   [OK] ตั้งให้สตาร์ทเองแล้ว
  )
) else (
  echo   [OK] ตั้งให้สตาร์ทเองตอนเปิดเครื่องอยู่แล้ว
)

rem สตาร์ทถ้ายังไม่ได้รัน
sc query %SVC% | find "RUNNING" >nul 2>&1
if errorlevel 1 (
  echo   [--^>] service ไม่ได้รันอยู่ - กำลังสตาร์ท
  sc start %SVC% >nul 2>&1
  if errorlevel 1 (
    echo   [XX] สตาร์ทไม่สำเร็จ - ดูสาเหตุที่ %SRVDIR%\logs\service-err.log
    set "PROBLEMS=1"
  ) else (
    echo   [OK] สตาร์ทแล้ว
    timeout /t 10 /nobreak >nul 2>&1
  )
) else (
  echo   [OK] service กำลังทำงานอยู่
)

:after_service

rem ---- 3) health ----
echo.
echo [3/6] ตัวบริการตอบสนองไหม  http://localhost:%PORT%/health
curl -s -m 15 -o nul "http://localhost:%PORT%/health"
if errorlevel 1 (
  echo   [!!] ไม่ตอบ - กำลังรีสตาร์ทแล้วรออีกครั้ง
  sc stop %SVC% >nul 2>&1
  timeout /t 8 /nobreak >nul 2>&1
  sc start %SVC% >nul 2>&1
  timeout /t 30 /nobreak >nul 2>&1
  curl -s -m 30 -o nul "http://localhost:%PORT%/health"
  if errorlevel 1 (
    echo   [XX] รีสตาร์ทแล้วยังไม่ตอบ
    echo        ถ้าเพิ่งรีสตาร์ทไป ให้รอ 3-4 นาที ระบบกำลังอุ่นข้อมูลย้อนหลัง แล้วรันสคริปนี้ซ้ำ
    echo        ถ้ายังไม่หาย เปิดดู %SRVDIR%\logs\service-err.log
    set "PROBLEMS=1"
  ) else (
    echo   [OK] กลับมาตอบแล้ว
  )
) else (
  echo   [OK] ตอบปกติ
)

rem ---- 4) Firewall ----
echo.
echo [4/6] Firewall พอร์ต %PORT% ขาเข้า
netsh advfirewall firewall show rule name="Narai Usage API %PORT%" >nul 2>&1
if errorlevel 1 (
  echo   [--^>] ยังไม่มีกฎเปิดพอร์ต - กำลังเพิ่มให้
  netsh advfirewall firewall add rule name="Narai Usage API %PORT%" dir=in action=allow protocol=TCP localport=%PORT% >nul 2>&1
  if errorlevel 1 (
    echo   [XX] เพิ่มกฎไม่สำเร็จ
    set "PROBLEMS=1"
  ) else (
    echo   [OK] เพิ่มกฎแล้ว
  )
) else (
  echo   [OK] มีกฎเปิดพอร์ตอยู่แล้ว
)

rem ---- 5) dyndns ชี้ IP ถูกตัวหรือเปล่า ----
echo.
echo [5/6] เส้นทางจากข้างนอก  %PUBHOST%
set "DNSIP="
set "WANIP="
for /f "tokens=2 delims=: " %%a in ('nslookup %PUBHOST% 2^>nul ^| find "Address"') do set "DNSIP=%%a"
for /f "delims=" %%b in ('curl -s -m 15 https://api.ipify.org 2^>nul') do set "WANIP=%%b"

if "!DNSIP!"=="" (
  echo   [XX] หา IP ของ %PUBHOST% ไม่เจอ - dyndns อาจหมดอายุหรือถูกลบ
  set "PROBLEMS=1"
  goto :after_dns
)
if "!WANIP!"=="" (
  echo   [!!] dyndns ชี้ไปที่ !DNSIP! แต่เช็ค IP จริงของเน็ตออฟฟิศไม่ได้ - เน็ตออกไม่ได้?
  set "PROBLEMS=1"
  goto :after_dns
)

echo        dyndns ชี้ไปที่ : !DNSIP!
echo        IP จริงของออฟฟิศ: !WANIP!
if "!DNSIP!"=="!WANIP!" (
  echo   [OK] ชี้ถูกตัวแล้ว
) else (
  echo   [XX] ชี้ผิดตัว - หน้าเว็บจึงเข้าไม่ได้แม้เครื่องจะเปิดอยู่
  echo        แก้: เปิดโปรแกรม DynDNS updater บนเครื่อง หรืออัปเดตที่หน้าเว็บ router
  echo        ทางลัดชั่วคราว: ตั้ง env USAGE_API_BASE = http://!WANIP!:%PORT% บน Vercel แล้ว redeploy
  set "PROBLEMS=1"
)

:after_dns

rem ---- 6) กันไม่ให้ดับซ้ำ ----
echo.
echo [6/6] กันไม่ให้ดับซ้ำ
if not defined HARDEN (
  echo        ข้าม - พิมพ์  fix-narai-api.cmd harden  เพื่อตั้งกันดับซ้ำ
  goto :summary
)

echo   [--^>] ตั้งไม่ให้เครื่องหลับ/จำศีลตอนเสียบไฟ
powercfg /change standby-timeout-ac 0 >nul 2>&1
powercfg /change hibernate-timeout-ac 0 >nul 2>&1
powercfg /change disk-timeout-ac 0 >nul 2>&1
powercfg /hibernate off >nul 2>&1
echo   [OK] ตั้งแล้ว

echo   [--^>] ให้ Windows รีสตาร์ท service เองเมื่อโปรเซสตาย
sc failure %SVC% reset= 86400 actions= restart/5000/restart/10000/restart/30000 >nul 2>&1
if errorlevel 1 (
  echo   [!!] ตั้งไม่สำเร็จ - ข้ามไป
) else (
  echo   [OK] ตั้งแล้ว
)

echo   [--^>] ติดตั้งตัวเฝ้าระวังทุก 5 นาที
if not exist "%~dp0narai-watchdog.cmd" (
  echo   [!!] ไม่พบ narai-watchdog.cmd - ข้ามไป
  goto :summary
)
schtasks /create /tn "NaraiUsageAPI-Watchdog" /tr "cmd /c \"%~dp0narai-watchdog.cmd\"" /sc minute /mo 5 /ru SYSTEM /rl HIGHEST /f >nul 2>&1
if errorlevel 1 (
  echo   [XX] ติดตั้งตัวเฝ้าระวังไม่สำเร็จ
  set "PROBLEMS=1"
) else (
  echo   [OK] ติดตั้งแล้ว - log อยู่ที่ %SRVDIR%\logs\watchdog.log
)

:summary
echo.
echo ==============================================
echo   สรุป
echo ==============================================
echo.
if "%PROBLEMS%"=="0" (
  echo   [OK] เรียบร้อย ไม่พบปัญหาค้างอยู่
  echo.
  echo   รออีก 3-4 นาที ระบบกำลังอุ่นข้อมูลย้อนหลัง
  echo   แล้วลองเปิดหน้า "ค้นหารายการขาย" ใหม่
) else (
  echo   [XX] ยังมีข้อที่ขึ้น XX ด้านบน ให้ทำตามที่บอกไว้ในบรรทัดนั้น
  echo        ถ้าติดตรงไหน ส่งภาพหน้าจอนี้ให้คนดูแลระบบได้เลย
)
echo.
if not defined HARDEN (
  echo   อยากกันไม่ให้ดับซ้ำอีก ให้รันซ้ำแบบนี้:
  echo       fix-narai-api.cmd harden
  echo.
)
pause
