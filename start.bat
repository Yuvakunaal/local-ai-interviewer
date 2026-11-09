@echo off
rem Starts AI Interviewer (Ollama + the app) and opens http://localhost:3000.   Stop it with stop.bat
call "%~dp0scripts\run.bat" start --open %*
exit /b %errorlevel%
