@echo off
title Jaanan - Romantic Music Sanctuary
cd /d "%~dp0"

echo ========================================================
echo        Jaanan - Romantic Music Sanctuary
echo ========================================================
echo.
echo Starting local server and opening your browser...
echo Website URL: http://localhost:3000
echo.

:: Launch default browser after 1.5 seconds so server has time to bind if not already running
start "" powershell -NoProfile -Command "Start-Sleep -Milliseconds 1500; Start-Process 'http://localhost:3000'"

:: Start the app dev server
npm run dev
pause
