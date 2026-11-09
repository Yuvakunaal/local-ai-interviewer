@echo off
rem Downloads the AI model(s) this app needs (asks first).  Add --stt for offline microphone answers.
call "%~dp0scripts\run.bat" setup-models %*
exit /b %errorlevel%
