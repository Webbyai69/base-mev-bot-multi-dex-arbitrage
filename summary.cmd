@echo off
rem Double-click me, or run me from any folder: runs the bot's "summary" command from its own directory.
cd /d "%~dp0"
if not exist dist\main.js (
  echo dist\main.js not found - run "npm install" and "npm run build" in this folder first.
  goto :end
)
node dist\main.js summary %*
:end
echo %cmdcmdline% | findstr /i /c:"/c" >nul && pause
