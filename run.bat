@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

REM ============================================================
REM  SIMRS-Flow runner - local dev, build, test, and pilot
REM  Double-click, or run:  run.bat <command>
REM  Commands: install dev ui api build start test typecheck
REM            lint livetest clean free-port  (see menu below)
REM ============================================================

set "DEFAULT_ORCHESTRATOR_PORT=4500"
call :load_env
if "%ORCHESTRATOR_PORT%"=="" set "ORCHESTRATOR_PORT=%DEFAULT_ORCHESTRATOR_PORT%"
set "UI_PORT=5173"

set "CMD=%~1"
if not "%CMD%"=="" goto :dispatch

:menu
cls
echo ============================================================
echo   SIMRS-Flow
echo ============================================================
echo.
echo   DEVELOP (runs from TypeScript source, no build needed)
echo     [1]  Install dependencies (npm install)
echo     [2]  Dev: orchestrator + UI (two windows)
echo     [3]  Dev: UI only          (http://localhost:5173)
echo     [4]  Dev: orchestrator only (http://localhost:4500)
echo.
echo   VERIFY
echo     [5]  Typecheck
echo     [6]  Lint
echo     [7]  Test (vitest run)
echo     [8]  Test (watch)
echo     [9]  Live smoke test (scripts/livetest.sh, needs bash)
echo.
echo   PRODUCTION
echo     [10] Build (UI bundle -^> apps/ui/dist) + clean emitted output
echo     [11] Start production: API + UI on port %ORCHESTRATOR_PORT% (LAN)
echo.
echo     [12] Clean emitted .js/.d.ts next to source + UI dist
echo.
echo   TROUBLESHOOT
echo     [13] Free orchestrator port (%ORCHESTRATOR_PORT%)
echo     [0]  Exit
echo.
set "PICK="
set /p "PICK=Choose: "

if "%PICK%"=="1"  (set "CMD=install"      & goto :dispatch)
if "%PICK%"=="2"  (set "CMD=dev"          & goto :dispatch)
if "%PICK%"=="3"  (set "CMD=ui"           & goto :dispatch)
if "%PICK%"=="4"  (set "CMD=api"          & goto :dispatch)
if "%PICK%"=="5"  (set "CMD=typecheck"    & goto :dispatch)
if "%PICK%"=="6"  (set "CMD=lint"         & goto :dispatch)
if "%PICK%"=="7"  (set "CMD=test"         & goto :dispatch)
if "%PICK%"=="8"  (set "CMD=test:watch"   & goto :dispatch)
if "%PICK%"=="9"  (set "CMD=livetest"     & goto :dispatch)
if "%PICK%"=="10" (set "CMD=build"        & goto :dispatch)
if "%PICK%"=="11" (set "CMD=start"        & goto :dispatch)
if "%PICK%"=="12" (set "CMD=clean"        & goto :dispatch)
if "%PICK%"=="13" (set "CMD=free-port"    & goto :dispatch)
if "%PICK%"=="0"  goto :eof
echo Invalid choice.
timeout /t 1 >nul
goto :menu

:dispatch
call :ensure_deps

if /i "%CMD%"=="install"    goto :do_install
if /i "%CMD%"=="dev"        goto :do_dev
if /i "%CMD%"=="ui"         goto :do_ui
if /i "%CMD%"=="api"        goto :do_api
if /i "%CMD%"=="typecheck"  goto :do_typecheck
if /i "%CMD%"=="lint"       goto :do_lint
if /i "%CMD%"=="test"       goto :do_test
if /i "%CMD%"=="test:watch" goto :do_testwatch
if /i "%CMD%"=="livetest"   goto :do_livetest
if /i "%CMD%"=="build"      goto :do_build
if /i "%CMD%"=="start"      goto :do_start
if /i "%CMD%"=="clean"      goto :do_clean
if /i "%CMD%"=="free-port"  goto :do_free_port

echo Unknown command: %CMD%
echo Usage: run.bat [install^|dev^|ui^|api^|typecheck^|lint^|test^|test:watch^|livetest^|build^|start^|clean^|free-port]
exit /b 1

REM ------------------------------------------------------------
:load_env
REM Load simple KEY=VALUE pairs from .env so run.bat dev matches documented config.
REM Comments and blank lines are ignored; existing shell env still wins.
if not exist "%~dp0.env" exit /b 0
for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%~dp0.env") do (
  if not "%%A"=="" if "!%%A!"=="" set "%%A=%%B"
)
exit /b 0

REM ------------------------------------------------------------
:ensure_deps
REM Auto-install if node_modules is missing (skip for the install cmd itself).
if /i "%CMD%"=="install" exit /b 0
if not exist "node_modules" (
  echo [setup] node_modules missing - running npm install first...
  call npm install || exit /b 1
)
exit /b 0

REM ------------------------------------------------------------
:do_install
echo [install] npm install
call npm install
goto :done

:do_dev
call :clear_port %ORCHESTRATOR_PORT% orchestrator || goto :done
call :clear_port %UI_PORT% UI || goto :done
echo [dev] launching orchestrator + UI in separate windows...
start "SIMRS-Flow orchestrator" cmd /k "npm run dev:orchestrator"
start "SIMRS-Flow UI" cmd /k "npm run dev:ui"
echo.
echo   orchestrator: http://localhost:%ORCHESTRATOR_PORT%
echo   UI:           http://localhost:%UI_PORT%
echo   UI from other PCs on the LAN:
call :lan_urls %UI_PORT%
echo.
echo Two windows opened. Close them to stop the servers.
goto :done

:do_ui
call :clear_port %UI_PORT% UI || goto :done
echo [ui] Vite dev server at http://localhost:%UI_PORT%
call npm run dev:ui
goto :done

:do_api
call :ensure_orchestrator_port || goto :done
echo [api] orchestrator (watch) at http://localhost:%ORCHESTRATOR_PORT%
call npm run dev:orchestrator
goto :done

:do_typecheck
echo [typecheck] tsc -p tsconfig.json
call npm run typecheck
goto :done

:do_lint
echo [lint] eslint
call npm run lint
goto :done

:do_test
echo [test] vitest run
call npm test
goto :done

:do_testwatch
echo [test:watch] vitest
call npm run test:watch
goto :done

:do_livetest
where bash >nul 2>&1
if errorlevel 1 (
  echo [livetest] ERROR: bash not found. Install Git Bash, or run from a Git Bash shell:
  echo            bash scripts/livetest.sh
  goto :done
)
echo [livetest] booting orchestrator and running live smoke checks...
bash scripts/livetest.sh
goto :done

:do_build
echo [build] building all workspaces (UI bundle into apps/ui/dist)...
call npm run build || goto :done
echo.
echo [build] cleaning compiled .js/.d.ts emitted next to source
echo         (so vitest/tsx keep resolving .ts, not stale output)...
call :clean_emitted
echo.
echo [build] done. Static UI bundle is in apps/ui/dist
echo         run.bat start serves it together with the API on port %ORCHESTRATOR_PORT%.
goto :done

:do_start
echo [start] orchestrator (production) reads .env / environment
echo         Make sure AUDIT_LEDGER_DIR is set for any write pilot.
echo         Write actions use per-user EvoMedis login; EVOMEDIS_SESSION_COOKIE
echo         is only an optional service-account fallback (see docs/deployment.md).
if not exist "apps\ui\dist\index.html" (
  echo [start] apps\ui\dist is missing - building first...
  call npm run build || goto :done
  call :clean_emitted
)
call :ensure_orchestrator_port || goto :done
echo         API + UI on one port, reachable from other PCs (ORCHESTRATOR_HOST
echo         defaults to 0.0.0.0; set 127.0.0.1 in .env for this PC only):
echo           this PC: http://localhost:%ORCHESTRATOR_PORT%/
if /i not "%ORCHESTRATOR_HOST%"=="127.0.0.1" call :lan_urls %ORCHESTRATOR_PORT%
echo         Allow TCP %ORCHESTRATOR_PORT% in Windows Firewall (LAN profile) if other PCs cannot connect.
call npm run start --workspace @simrs-flow/orchestrator
goto :done

:do_clean
echo [clean] removing emitted output...
call :clean_emitted
echo [clean] done.
goto :done

:do_free_port
call :free_orchestrator_port
call :clear_port %UI_PORT% UI
goto :done

REM ------------------------------------------------------------
:lan_urls
REM Print http://<IPv4>:<port>/ for each IPv4 address of this PC.
for /f "tokens=2 delims=:" %%I in ('ipconfig ^| findstr /c:"IPv4"') do (
  for /f "tokens=* delims= " %%J in ("%%I") do echo           http://%%J:%~1/
)
exit /b 0

:clear_port
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\free-port.ps1" -Port %~1 -Name %~2
exit /b %ERRORLEVEL%

:ensure_orchestrator_port
call :find_orchestrator_port_processes
if not defined PORT_PIDS exit /b 0
call :show_orchestrator_port_processes
echo.
echo [port] Port %ORCHESTRATOR_PORT% is already in use. Starting the orchestrator now would fail.
set "KILL_PORT="
set /p "KILL_PORT=Stop the process(es) using port %ORCHESTRATOR_PORT%? [y/N]: "
if /i not "%KILL_PORT%"=="Y" exit /b 1
call :kill_orchestrator_port_processes
exit /b %ERRORLEVEL%

:free_orchestrator_port
call :find_orchestrator_port_processes
if not defined PORT_PIDS (
  echo [port] No process is listening on 127.0.0.1:%ORCHESTRATOR_PORT%.
  exit /b 0
)
call :show_orchestrator_port_processes
echo.
set "KILL_PORT="
set /p "KILL_PORT=Stop the process(es) using port %ORCHESTRATOR_PORT%? [y/N]: "
if /i not "%KILL_PORT%"=="Y" (
  echo [port] Nothing stopped.
  exit /b 1
)
call :kill_orchestrator_port_processes
exit /b %ERRORLEVEL%

:find_orchestrator_port_processes
set "PORT_PIDS="
for /f "tokens=5" %%P in ('netstat -ano -p tcp ^| findstr /r /c:":%ORCHESTRATOR_PORT% .*LISTENING"') do (
  echo !PORT_PIDS!| findstr /c:" %%P " >nul || set "PORT_PIDS=!PORT_PIDS! %%P "
)
exit /b 0

:show_orchestrator_port_processes
echo [port] 127.0.0.1:%ORCHESTRATOR_PORT% is used by:
for %%P in (%PORT_PIDS%) do (
  for /f "skip=1 tokens=1,*" %%A in ('wmic process where "ProcessId=%%P" get Name^,CommandLine 2^>nul') do (
    if not "%%A"=="" echo   PID %%P  %%A %%B
  )
)
exit /b 0

:kill_orchestrator_port_processes
for %%P in (%PORT_PIDS%) do (
  echo [port] stopping PID %%P...
  taskkill /PID %%P /T /F >nul || exit /b 1
)
echo [port] Port %ORCHESTRATOR_PORT% is free.
exit /b 0

REM ------------------------------------------------------------
:clean_emitted
REM Delete tsc output emitted next to source (gitignored, but trips vitest).
REM Keeps *.test.* files. Checks each file: must be under a \src\ folder and
REM must not be a test file before deleting.
for /r "%~dp0packages" %%F in (*.js *.js.map *.d.ts *.d.ts.map) do call :maybe_del "%%F"
for /r "%~dp0apps"     %%F in (*.js *.js.map *.d.ts *.d.ts.map) do call :maybe_del "%%F"
if exist "%~dp0tsconfig.tsbuildinfo" del /q "%~dp0tsconfig.tsbuildinfo" 2>nul
for /r "%~dp0packages" %%F in (tsconfig.tsbuildinfo) do del /q "%%F" 2>nul
for /r "%~dp0apps"     %%F in (tsconfig.tsbuildinfo) do del /q "%%F" 2>nul
exit /b 0

:maybe_del
REM %1 = full path. Skip if not under \src\, or if it is a .test. file.
echo %~1| findstr /i "\\src\\" >nul || exit /b 0
echo %~1| findstr /i "\.test\." >nul && exit /b 0
del /q "%~1" 2>nul
exit /b 0

REM ------------------------------------------------------------
:done
echo.
if "%~1"=="" pause
exit /b 0


