@echo off
chcp 65001 >nul
title Roon 网易云歌词扩展 (端口 8687)
cd /d "%~dp0"

echo ==========================================
echo   Roon 网易云歌词扩展
echo   HTTP / WebSocket: http://127.0.0.1:8687
echo ==========================================
echo.

node index.js

echo.
echo 扩展已退出。
pause
