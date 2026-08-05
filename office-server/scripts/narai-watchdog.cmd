@echo off
chcp 65001 >nul 2>&1
rem ตัวเฝ้าระวัง Narai Usage API (เวอร์ชันไม่ต้องใช้ PowerShell)
rem ติดตั้งด้วย fix-narai-api.cmd harden — ไม่ต้องรันไฟล์นี้เองด้วยมือ
rem
rem หน้าที่: ถ้า /health ไม่ตอบ ให้รีสตาร์ท service ให้อัตโนมัติ แล้วจดลง log
rem ทำไมต้องมี: Windows รีสตาร์ท service เองเฉพาะตอน "โปรเซสตาย" เท่านั้น
rem   แต่มีอาการที่โปรเซสยังอยู่แต่ค้างไม่รับ request (เน็ตออฟฟิศหลุดยาวจนค้างคาที่การดึงข้อมูล)
rem   กรณีนั้น Windows ไม่ถือว่าแครช จึงไม่รีสตาร์ทให้ ต้องมีตัวเช็คจากภายนอกแบบนี้

setlocal
set "PORT=8787"
set "SVC=NaraiUsageAPI"
set "LOGDIR=%~dp0..\logs"
set "LOG=%LOGDIR%\watchdog.log"

if not exist "%LOGDIR%" mkdir "%LOGDIR%" >nul 2>&1

curl -s -m 20 -o nul "http://localhost:%PORT%/health"
if not errorlevel 1 exit /b 0

echo %date% %time%  health ไม่ตอบ - กำลังรีสตาร์ท %SVC%>>"%LOG%"

sc stop %SVC% >nul 2>&1
timeout /t 8 /nobreak >nul 2>&1
sc start %SVC% >nul 2>&1
if errorlevel 1 (
  echo %date% %time%  สตาร์ทไม่สำเร็จ - ดู logs\service-err.log>>"%LOG%"
  exit /b 1
)

rem ตอนสตาร์ทต้องอุ่น cache 3-4 นาที ช่วงนั้น health อาจยังไม่ตอบ ถือว่าปกติ
timeout /t 30 /nobreak >nul 2>&1
curl -s -m 30 -o nul "http://localhost:%PORT%/health"
if errorlevel 1 (
  echo %date% %time%  รีสตาร์ทแล้ว รอ health อีกสักครู่ ^(ปกติใช้เวลาอุ่น cache 3-4 นาที^)>>"%LOG%"
) else (
  echo %date% %time%  รีสตาร์ทสำเร็จ health กลับมาตอบแล้ว>>"%LOG%"
)
exit /b 0
