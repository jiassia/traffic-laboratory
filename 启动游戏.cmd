@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 20 or newer, then run this file again.
  pause
  exit /b 1
)
if not exist "node_modules\esbuild\package.json" (
  call npm ci
  if errorlevel 1 goto failed
)
if not exist "dist\index.html" (
  call npm run build
  if errorlevel 1 goto failed
)
node scripts\serve.mjs --open
pause
exit /b 0
:failed
echo Build failed. Check the output above.
pause
exit /b 1
