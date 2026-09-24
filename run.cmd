@echo off
REM ===========================================================================
REM  live_auto launcher (double-click to run)
REM
REM  Does three things:
REM    1. check environment (Node / deps / config / biliLive-tools online)
REM    2. start the backend service
REM    3. open the web UI once it is ready
REM
REM  All logic lives in launcher.ps1 -- this file only boots PowerShell with
REM  the right execution policy. Keep this file pure ASCII + CRLF: cmd.exe
REM  reads .cmd files using the ANSI code page and requires CRLF line endings,
REM  so non-ASCII text or LF-only endings break it.
REM
REM  Usage:  run.cmd [-DryRun] [-AllowPaid] [-NoBrowser] [-Port 3100] [-Room 12345678]
REM ===========================================================================

setlocal
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" set "PS=powershell.exe"

"%PS%" -NoProfile -NoLogo -ExecutionPolicy Bypass -File "%~dp0launcher.ps1" %*
set "RC=%ERRORLEVEL%"

if not "%RC%"=="0" (
  echo.
  echo [ERROR] launcher exited with code %RC%
  echo Try running it directly to see the reason:
  echo   powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0launcher.ps1"
  echo.
  pause
)

endlocal
