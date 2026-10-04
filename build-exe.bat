@echo off
chcp 65001 >nul
title 打包 Roon 网易云歌词

cd /d "%~dp0desktop"

echo ==================================================
echo  正在打包成 exe（产物在 dist 目录）
echo ==================================================
echo.

if not exist node_modules (
  echo 未安装依赖，先执行 npm install ...
  call npm install --no-fund --no-audit || goto :fail
)

call npm run build || goto :fail

echo.
pause
exit /b 0

:fail
echo.
echo 打包失败，请查看上面的错误信息。
pause
exit /b 1
