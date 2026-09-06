@echo off
setlocal
cd /d "%~dp0"
title Identra - Fingerprint Browser Console

echo ============================================
echo  Identra - one-click start
echo ============================================

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install Node 18+ first.
  pause
  exit /b 1
)

echo [1/4] Checking dependencies...
if not exist "node_modules" (
  echo   Installing server dependencies...
  call npm install
  if errorlevel 1 goto :err
)
if not exist "client\node_modules" (
  echo   Installing client dependencies...
  call npm --prefix client install
  if errorlevel 1 goto :err
)

echo [2/4] Building client if needed...
if not exist "client\dist\index.html" (
  call npm run build
  if errorlevel 1 goto :err
) else (
  echo   client\dist already built - skipping ^(run "npm run build" to rebuild^)
)

echo [3/4] Ensuring vault master key...
node -e "const fs=require('fs');const s=fs.existsSync('.env')?fs.readFileSync('.env','utf8'):'';const m=s.match(/^FPB_MASTER_KEY=(.+)\s*$/m);if(m&&m[1].trim()){console.log('  FPB_MASTER_KEY already set - ok');}else{const k=require('crypto').randomBytes(32).toString('base64');fs.writeFileSync('.env',s+(s.endsWith('\n')||!s?'':'\n')+'FPB_MASTER_KEY='+k+'\n');console.log('  generated new FPB_MASTER_KEY -> .env');}"
if errorlevel 1 goto :err

echo [4/4] Starting server on http://127.0.0.1:8787 ...
echo   (AI tasks: set DeepSeek API key in UI - System Settings tab)
start "Identra Server" cmd /k node server\index.js
timeout /t 3 /nobreak >nul
start "" http://127.0.0.1:8787
echo Server is running in the "Identra Server" window. Close that window to stop.

goto :eof
:err
echo.
echo [ERROR] Start failed - see messages above.
pause
exit /b 1
