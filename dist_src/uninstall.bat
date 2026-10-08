@echo off
rem Removes XR Animator Multi-Camera 3D and restores the original files.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" -Uninstall %*
pause
