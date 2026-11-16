@echo off
chcp 65001 >nul
title O'yin server
cd /d "%~dp0"

if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo [!] .env fayli yaratildi. Uni oching va OWNER_LOGIN, OWNER_PASSWORD, GEMINI_API_KEY ni yozing.
)

where python >nul 2>nul
if errorlevel 1 (
  echo [!] Python topilmadi. python.org saytidan o'rnating va "Add python.exe to PATH" belgisini qo'ying.
  pause
  exit /b 1
)

echo Kutubxonalar tekshirilmoqda...
python -m pip install -q --disable-pip-version-check -r py\requirements.txt
if errorlevel 1 echo [!] Kutubxonalarni o'rnatib bo'lmadi - internetni tekshiring. Davom etamiz...

set OYIN_OPEN_BROWSER=1
echo.
echo Server ishga tushmoqda, brauzer o'zi ochiladi: http://127.0.0.1:5000
echo To'xtatish uchun shu oynani yoping yoki Ctrl+C bosing.
echo.
python py\app.py
pause
