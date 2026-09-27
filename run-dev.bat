@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo =============================================
echo   币安合约保护助手 V11.2.1 开发版
echo ====================================
echo.
if not exist node_modules (
  echo [1/2] 首次运行，正在安装依赖...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo 依赖安装失败，请检查 Node.js 与网络。
    pause
    exit /b 1
  )
)
echo [2/2] 正在启动 Electron...
call npm start
