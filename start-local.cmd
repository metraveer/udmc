@echo off
setlocal
cd /d "%~dp0"
set UDMC_HOST=127.0.0.1
if "%UDMC_ADMIN_TOKEN%"=="" set UDMC_ADMIN_TOKEN=dev-token
npm run server
pause
