@echo off
chcp 65001 >nul
title 智慧保安考勤系统（本地服务）
cd /d %~dp0
echo.
echo   ============================================
echo    智慧保安考勤系统 - 人脸定位双校验打卡
echo   ============================================
echo.
echo   摄像头与人脸/定位功能需要通过 localhost 访问。
echo   服务启动后将自动打开 http://localhost:8765
echo   关闭本窗口即可停止服务。
echo.
start "" http://localhost:8765
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1"
pause
