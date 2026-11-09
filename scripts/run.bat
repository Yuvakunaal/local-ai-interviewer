@echo off
rem Finds Python 3.10+ and runs the cross-platform launcher:  scripts\run.bat <start|stop|check|setup-models> [options]
setlocal
set "ROOT=%~dp0.."
set "PY="
where py >nul 2>nul && (
  py -3 -c "import sys; sys.exit(sys.version_info < (3, 10))" >nul 2>nul && set "PY=py -3"
)
if not defined PY (
  where python >nul 2>nul && (
    python -c "import sys; sys.exit(sys.version_info < (3, 10))" >nul 2>nul && set "PY=python"
  )
)
if not defined PY (
  echo Python 3.10 or newer is required. Install it with:  winget install Python.Python.3.12
  echo or download it from https://python.org  ^(tick "Add python.exe to PATH"^)
  echo.
  echo Opening a page with install steps for your computer...
  if not defined LAI_NO_BROWSER start "" "file:///%~dp0setup-required.html?need=python"
  echo %cmdcmdline% | find /i "/c" >nul && pause
  exit /b 1
)
%PY% "%ROOT%\scripts\manage.py" %*
set "RC=%errorlevel%"
rem Opened by double-click? Keep the window open so the messages can be read.
echo %cmdcmdline% | find /i "/c" >nul && pause
exit /b %RC%
