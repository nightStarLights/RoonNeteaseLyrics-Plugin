@echo off
chcp 65001 >nul
title Roon 网易云歌词 - 停止
cd /d "%~dp0"

node launcher.js stop
pause
