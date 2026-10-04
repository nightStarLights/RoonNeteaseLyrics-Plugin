@echo off
chcp 65001 >nul
title Roon 网易云歌词 - 启动
cd /d "%~dp0"

rem ============================================================
rem  只会弹出桌面歌词窗口。
rem  Roon 扩展以隐藏窗口在后台运行，日志在 logs\ 目录。
rem
rem  歌词默认走官方直连（不依赖任何额外依赖包），不需要另外跑网易云 API 服务；
rem  如果本机装了可选的内置库（npm install NeteaseCloudMusicApi）会优先用它。
rem ============================================================

node launcher.js start

if errorlevel 1 (
    echo.
    echo 启动过程中出现问题，上面有详细说明。
    pause
)
