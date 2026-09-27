# 中文说明：VSCode/Windows PowerShell 一键启动开发版，不包含安装器。
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
Write-Host '============================================='
Write-Host ' 币安合约保护助手 V11.2.1 开发版'
Write-Host '============================================='
if (-not (Test-Path 'node_modules')) {
  Write-Host '[1/2] 首次运行，安装依赖...'
  npm install --no-audit --no-fund
}
Write-Host '[2/2] 启动 Electron...'
npm start
