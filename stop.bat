@echo off
rem Stops AI Interviewer. Use "stop.bat --unload" to also free the model's memory.
call "%~dp0scripts\run.bat" stop %*
exit /b %errorlevel%
