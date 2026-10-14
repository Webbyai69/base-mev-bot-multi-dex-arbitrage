@echo off
rem First-time setup of this folder: install, build, and carry over your settings,
rem bot wallet and the bot's memory from your old bot folder.
rem   setup.cmd                                          install and build only
rem   setup.cmd "C:\Users\you\source\base-arb-bot"       also carry over .env and data\ from there
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get Node.js 22 LTS from https://nodejs.org and run this again.
  goto :end
)
echo Installing dependencies...
call npm ci
if errorlevel 1 (
  echo npm ci failed: see the messages above.
  goto :end
)
echo Building...
call npm run build
if errorlevel 1 (
  echo The build failed: see the messages above.
  goto :end
)
if not "%~1"=="" (
  node scripts\carry-over.mjs --from "%~1"
)
if not exist .env (
  echo.
  echo No .env here yet. Either carry over your old one:
  echo   node scripts\carry-over.mjs --from "C:\path\to\your\old\base-arb-bot"
  echo or start from the template: copy .env.example .env, then fill it in.
)
echo.
echo Next: stop the old bot if it's running, then start this one from PowerShell in this folder:
echo   powershell -ExecutionPolicy Bypass -File run-24h.ps1
echo and open http://localhost:8787
:end
echo %cmdcmdline% | findstr /i /c:"/c" >nul && pause
