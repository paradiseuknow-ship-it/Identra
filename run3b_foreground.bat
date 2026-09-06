@echo off
title FPB canonical240_run3b
cd /d "C://Users//YogaPC//WorkBuddy//2026-08-18-02-57-41//fingerprint-browser"
if errorlevel 1 goto cdfail
set PHASE12_TAG=canonical240_run3b
set FPB_SCENARIO_DIR=server/scenarios/real-world-v2
set FPB_POOL_FILE=phase12_pool_v2.json
for /f "usebackq eol=# tokens=1,* delims==" %a in (".env") do set "%a=%b"
echo ==== canonical240_run3b resume run (checkpoint 31/100) ====
echo ==== Close window or Ctrl+C to stop. Rerun to resume anytime. ====
:loop
node server\scripts\phase12Benchmark.js
node tools\bat_progress_check.js
if not errorlevel 1 goto done
echo.
echo runner exited before 100/100 - retrying in 5s...
timeout /t 5 /nobreak >nul
goto loop
:done
echo.
echo ============ RUN COMPLETE 100/100 ============
pause
goto :eof
:cdfail
echo ERROR: cannot cd to project directory
pause
