@echo off
REM ===========================================================================
REM  live_auto startup script (backend only, no browser)
REM
REM  For the all-in-one experience (start backend + open UI) use run.cmd,
REM  or just double-click the desktop shortcut.
REM
REM  All arguments are passed through to launcher.ps1, e.g.
REM    start.bat -DryRun
REM    start.bat -NoBrowser
REM    start.bat -Port 3100
REM
REM  Keep this file pure ASCII + CRLF: cmd.exe reads .bat files using the ANSI
REM  code page and requires CRLF line endings. Non-ASCII text or LF-only
REM  endings make cmd.exe mis-parse the file (comments get cut in half and
REM  fragments get executed as commands).
REM ===========================================================================

setlocal
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" set "PS=powershell.exe"

"%PS%" -NoProfile -NoLogo -ExecutionPolicy Bypass -File "%~dp0launcher.ps1" %*
set "RC=%ERRORLEVEL%"

if not "%RC%"=="0" (
  echo.
  echo [ERROR] exited with code %RC%
  echo.
  pause
)

endlocal
