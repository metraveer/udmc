@echo off
setlocal
cd /d "%~dp0"

if "%JAVA%"=="" set "JAVA=java"
if "%SERVER_JAR%"=="" set "SERVER_JAR=fabric-server-launch.jar"
if "%MAX_MEMORY%"=="" set "MAX_MEMORY=4G"

:run
if exist "udmc-sync\restart-requested" del /q "udmc-sync\restart-requested"
"%JAVA%" -Xms1G -Xmx%MAX_MEMORY% -jar "%SERVER_JAR%" nogui

if exist "udmc-sync\agent-update\task.properties" (
  "%JAVA%" -Xmx48m -cp "udmc-sync\agent-update\helper.jar" dev.udmc.sync.update.AgentUpdateHelper --finish "udmc-sync\agent-update\task.properties"
  if errorlevel 1 exit /b 1
)

if exist "udmc-sync\restart-requested" goto run
endlocal
