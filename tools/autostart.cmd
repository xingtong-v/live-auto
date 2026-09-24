@echo off
REM ===========================================================================
REM  live_auto autostart helper (double-click to install)
REM
REM  Installs a Task Scheduler job that starts the assistant at logon
REM  (hidden window, no browser). Re-run this file to update it.
REM
REM  Keep this file pure ASCII + CRLF: cmd.exe needs both.
REM
REM  Usage:
REM    autostart.cmd            install / update
REM    autostart.cmd -Status    show status
REM    autostart.cmd -Remove    uninstall
REM ===========================================================================

setlocal
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" set "PS=powershell.exe"

"%PS%" -NoProfile -NoLogo -ExecutionPolicy Bypass -File "%~dp0autostart.ps1" %*

if "%1"=="" (
  echo.
  echo Press any key to close...
  pause >nul
)

endlocal
