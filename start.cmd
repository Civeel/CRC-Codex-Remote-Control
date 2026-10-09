@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto missing_node
node scripts\start.mjs
pause
exit /b
:missing_node
echo Node.js 22 or newer is required. Install it and reopen this window.
pause
exit /b 1
