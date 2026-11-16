@echo off
rem Abre o Loop-AI como Administrador (necessario para diagnosticos: eventos de seguranca, discos, BAM/DAM etc.).
rem Obs.: com o app elevado, arrastar arquivos do Explorer para o chat nao funciona (limitacao do Windows);
rem use o botao de anexar.
cd /d "%~dp0"
net session >nul 2>&1
if %errorlevel%==0 (
  call "%~dp0iniciar.bat"
  exit /b 0
)
echo Solicitando permissao de administrador...
powershell -NoProfile -Command "Start-Process -FilePath '%~dp0iniciar.bat' -Verb RunAs"
exit /b 0
