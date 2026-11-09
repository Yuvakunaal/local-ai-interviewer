@echo off
rem Checks that everything needed is installed. Changes nothing.
call "%~dp0scripts\run.bat" check %*
exit /b %errorlevel%
