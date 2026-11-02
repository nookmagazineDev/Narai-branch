@echo off
chcp 65001 >nul
rem ตั้งเว็บ (serve-local.mjs) เป็น Windows Service ให้เปิดเองหลังรีบูต — รันครั้งเดียว รันซ้ำได้
rem วิธีใช้: คลิกขวาที่ไฟล์นี้ -> Run as administrator   (รายละเอียดใน scripts\install-web-service.ps1)
net session >nul 2>&1
if errorlevel 1 (
  echo [ผิดพลาด] ต้องเปิดไฟล์นี้ด้วยสิทธิ์ผู้ดูแลระบบ
  echo คลิกขวาที่ไฟล์ install-web-service.bat แล้วเลือก "Run as administrator"
  echo.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-web-service.ps1"
echo.
pause
