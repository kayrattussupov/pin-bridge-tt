@echo off
rem Signed request to Pin Bridge from cmd. See pb.ps1 and docs/testing-from-windows-cmd.md.
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0pb.ps1" %*
