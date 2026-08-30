@echo off
setlocal
cd /d "%~dp0"
set UDMC_HOST=0.0.0.0
if "%UDMC_ADMIN_TOKEN%"=="" set UDMC_ADMIN_TOKEN=change-this-token
npm run server
pause
