@echo off
rem Double-click to open Cortex Council in your browser. Close this window to stop it.
title Cortex Council
where node >nul 2>nul || (
  echo Cortex Council needs Node.js 22 or newer: https://nodejs.org
  pause
  exit /b 1
)
node "%~dp0..\bin\cortex-council.mjs" %*
if errorlevel 1 pause
