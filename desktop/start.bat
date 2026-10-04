@echo off
chcp 65001 >nul
title Roon 网易云歌词桌面窗口
cd /d "%~dp0"

if not exist "node_modules\electron\dist\electron.exe" (
    echo 正在安装依赖 ^(首次运行需要下载 Electron^)...
    call npm install
)

node_modules\.bin\electron.cmd .
