@echo off
rem Inicia o Loop-AI. Usa o Loop-AI.exe se ele estiver nesta pasta (versao empacotada); senao usa o Electron de node_modules.
rem Na primeira vez em um PC sem dependencias, chama instalar.bat sozinho.
rem Se a pasta node_modules veio junto (pendrive), abre direto, sem precisar de Node.js.
cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE="

if exist "%~dp0Loop-AI.exe" (
  start "" "%~dp0Loop-AI.exe"
  exit /b 0
)

set "EXE=%~dp0node_modules\electron\dist\electron.exe"
if not exist "%EXE%" (
  echo Primeira execucao neste PC: preparando o Loop-AI...
  call "%~dp0instalar.bat" auto
  if errorlevel 1 exit /b 1
)

start "" "%EXE%" "%~dp0."
exit /b 0
