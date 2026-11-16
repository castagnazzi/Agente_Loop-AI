@echo off
rem Autoteste do Loop-AI: confere neste PC se Word/Excel/PowerPoint/PDF, OCR, SQLite e PowerShell funcionam.
rem Leva de 1 a 2 minutos. O resultado fica em selftest.txt (nesta pasta).
cd /d "%~dp0"
title Loop-AI - autoteste
set "ELECTRON_RUN_AS_NODE="
del "%~dp0selftest.txt" >nul 2>nul

if exist "%~dp0Loop-AI.exe" (
  echo Executando o autoteste, aguarde...
  start /wait "" "%~dp0Loop-AI.exe" --selftest=full
) else if exist "%~dp0node_modules\electron\dist\electron.exe" (
  echo Executando o autoteste, aguarde...
  start /wait "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0." --selftest=full
) else (
  echo Loop-AI ainda nao instalado neste PC. Execute instalar.bat primeiro.
  pause
  exit /b 1
)

echo.
if exist "%~dp0selftest.txt" (type "%~dp0selftest.txt") else (echo Nao foi possivel gerar o resultado.)
echo.
pause
