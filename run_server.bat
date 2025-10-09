@echo off
REM ==== Фоновый (скрытый) запуск npm start без PM2 ====
REM Запускает сервер как отдельный процесс, окно не показывается

setlocal enabledelayedexpansion
set "SCRIPT_DIR=%~dp0"

REM Проверяем наличие npm.cmd (Windows-обёртка для npm)
where npm.cmd >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
  echo npm.cmd не найден в PATH. Установите Node.js: https://nodejs.org
  exit /b 1
)

echo Запуск npm start в фоне (скрытое окно)...
set "ARG=/c \"npm.cmd start\""
powershell -NoProfile -Command "Start-Process -FilePath 'cmd.exe' -ArgumentList '%ARG%' -WorkingDirectory '%SCRIPT_DIR%' -WindowStyle Hidden"

if %ERRORLEVEL% EQU 0 (
  echo Готово. Приложение запущено в фоне через npm start.
  echo Откройте http://localhost:3000/
) else (
  echo Ошибка запуска. Попробуйте вручную: npm start
)

exit /b 0


