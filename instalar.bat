@echo off
rem Instala as dependencias do Loop-AI (Electron). Rode uma vez em cada PC novo.
rem Se node_modules ja foi copiado junto (pendrive), nao precisa instalar: use iniciar.bat.
cd /d "%~dp0"
title Loop-AI - instalacao

where npm >nul 2>nul
if errorlevel 1 if exist "%ProgramFiles%\nodejs\npm.cmd" set "PATH=%ProgramFiles%\nodejs;%PATH%"
where npm >nul 2>nul
if errorlevel 1 (
  echo Node.js nao encontrado neste PC.
  where winget >nul 2>nul
  if errorlevel 1 (
    echo Instale o Node.js LTS em https://nodejs.org e execute este arquivo de novo.
    pause
    exit /b 1
  )
  echo Instalando Node.js LTS com o winget...
  winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
  if exist "%ProgramFiles%\nodejs\npm.cmd" set "PATH=%ProgramFiles%\nodejs;%PATH%"
  where npm >nul 2>nul
  if errorlevel 1 (
    echo Node.js foi instalado, mas o terminal ainda nao o enxerga.
    echo Feche esta janela e execute instalar.bat novamente.
    pause
    exit /b 1
  )
)

echo Instalando dependencias do Loop-AI (pode levar alguns minutos)...
call npm install --no-audit --no-fund
if errorlevel 1 (
  echo.
  echo Falha na instalacao. Verifique a internet e tente de novo.
  pause
  exit /b 1
)
if not exist "%~dp0node_modules\electron\dist\electron.exe" (
  echo O Electron nao foi baixado corretamente. Tente executar instalar.bat de novo.
  pause
  exit /b 1
)
echo.
echo Instalacao concluida. Use iniciar.bat para abrir o Loop-AI.
if "%~1"=="" pause
exit /b 0
