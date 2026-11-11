@echo off
title 🦊 Foxy Network — Configurador de Dominios .fox y SSL
color 0B

echo ========================================================
echo    🦊 FOXY NETWORK — HOSTING DE DOMINIOS .FOX & SSL
echo ========================================================
echo.
echo  Dominios a configurar en el sistema:
echo    - https://www.foxyfianance.fox  (FOXY FINANCE SaaS)
echo    - https://www.foxyfinance.fox   (Alias Canonico)
echo    - https://www.foxynetwork.fox   (Foxy Network Portal)
echo.

cd /d "%~dp0"

:: Verificar si tiene privilegios de Administrador para editar C:\Windows\System32\drivers\etc\hosts
net session >nul 2>&1
if %errorLevel% == 0 (
    echo [*] Privilegios de Administrador detectados. Configurando DNS del sistema y SSL...
    node packages/foxy-cli/bin/foxy.js domains setup
) else (
    echo [!] Solicitando elevacion de Administrador para registrar dominios .fox en Windows...
    powershell -Command "Start-Process cmd -ArgumentList '/c cd /d \"%~dp0\" && node packages/foxy-cli/bin/foxy.js domains setup && pause' -Verb RunAs"
)

echo.
pause

