@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo === Portal wróżbiarski (test) ===
echo Katalog: %CD%
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo [BŁĄD] Nie widzę "node" w PATH.
  echo Otwórz terminal z menu Start: "Node.js command prompt" lub zainstaluj Node z opcją "Add to PATH".
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\" goto do_install
if not exist "node_modules\bcryptjs\package.json" goto do_install
goto after_install

:do_install
echo Instalacja / uzupełnienie zależności: npm install ...
call npm install
if errorlevel 1 (
  echo npm install się nie udał.
  pause
  exit /b 1
)
echo.

:after_install

if not exist ".env" (
  copy /Y ".env.example" ".env" >nul
  echo Utworzono plik .env z .env.example — możesz go edytować później.
  echo.
)

echo Serwer startuje. TO OKNO MUSI ZOSTAĆ OTWARTE podczas testów.
echo Portal klienta:  http://localhost:3000/
echo Panel pracy:     http://localhost:3000/operator/
echo Strona rekrut.:  http://localhost:3000/rekrutacja.html
echo Zatrzymanie: Ctrl+C
echo.
call npm start
echo.
pause
