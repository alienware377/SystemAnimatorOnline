@echo off
rem XR Animator Multi-Camera 3D installer. Add -Uninstall to remove it again.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
pause
