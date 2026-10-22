@echo off
title Subir Foxy Network a GitHub
cd /d "%~dp0"
echo ========================================================
echo       SUBIR FOXY NETWORK A GITHUB
echo ========================================================
echo.
echo Repositorio: https://github.com/IAmMRPrince/Foxy-Network.git
echo.
echo Presiona cualquier tecla para iniciar. Si es la primera vez,
echo se abrira una ventana de tu navegador para autorizar con GitHub.
echo.
git push -u origin main
echo.
if %errorlevel% equ 0 (
    echo [EXITO] Foxy Network se ha subido correctamente a tu GitHub!
) else (
    echo [ERROR] No se pudo completar la subida.
)
echo.
pause
