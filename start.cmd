@echo off
title EasyTranslator
cd /d "%~dp0"

rem 本机环境里 ELECTRON_RUN_AS_NODE=1 会让 electron.exe 退化成纯 Node，必须清掉
set ELECTRON_RUN_AS_NODE=

set ELECTRON=%~dp0node_modules\electron\dist\electron.exe
if not exist "%ELECTRON%" (
  echo [ERROR] 找不到 Electron，请先在当前目录执行: npm install
  pause
  exit /b 1
)

start "" "%ELECTRON%" "%~dp0."
exit /b 0
