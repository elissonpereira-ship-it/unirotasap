@echo off
title UniRotas - Ponte SAP (Debug)
echo.
echo ==========================================
echo   UniRotas - Verificacao de Ambiente
echo ==========================================
echo.

echo 1. Verificando Python...
python --version
if %errorlevel% neq 0 (
    echo [ERRO] Python nao encontrado! Por favor, instale o Python.
    pause
    exit /b
)

echo 2. Atualizando PIP e Instalando Dependencias...
python -m pip install --upgrade pip
python -m pip install flask flask-cors requests
if %errorlevel% neq 0 (
    echo [AVISO] Houve um problema ao instalar dependencias. 
    echo Tentando continuar mesmo assim...
)

echo.
echo ==========================================
echo   Iniciando Servidor...
echo   MANTENHA ESTA JANELA ABERTA!
echo ==========================================
echo.

python bridge.py
if %errorlevel% neq 0 (
    echo.
    echo [ERRO] O servidor parou inesperadamente.
    echo Verifique se outra janela ja nao esta aberta ou se o arquivo bridge.py existe.
)

pause
