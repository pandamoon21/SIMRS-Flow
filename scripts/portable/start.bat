@echo off
REM SIMRS-Flow portable: runs the bundled node.exe, no Node.js install or admin needed.
REM Settings live in config.env next to this file. Close this window to stop the app.
setlocal
title SIMRS-Flow
cd /d "%~dp0app"
if not exist "%~dp0node\node.exe" (
  echo [start] node\node.exe tidak ditemukan. Ekstrak ulang seluruh isi zip.
  pause
  exit /b 1
)
echo [start] SIMRS-Flow berjalan. Buka alamat "open:" di bawah dari browser PC mana pun di LAN.
echo [start] Tutup jendela ini untuk menghentikan aplikasi.
echo.
"%~dp0node\node.exe" --env-file-if-exists="%~dp0config.env" apps\orchestrator\dist\main.js
echo.
echo [start] aplikasi berhenti (kode %errorlevel%).
pause
