@echo off
rem Copies files changed since a git ref from this checkout to the bridge server over scp,
rem then optionally rebuilds the containers there.
rem
rem   scripts\win\deploy-scp.cmd                 changed since HEAD~1 (+ uncommitted and new files)
rem   scripts\win\deploy-scp.cmd HEAD~3          changed since HEAD~3
rem   scripts\win\deploy-scp.cmd 203c342 build   ...and run docker compose up -d --build
rem
rem Override the target with PB_DEPLOY_SERVER (user@host) and PB_DEPLOY_DIR.
rem All files go in one archive, so ssh asks for the password at most twice.
setlocal EnableDelayedExpansion
chcp 65001 >nul

if not defined PB_DEPLOY_SERVER set "PB_DEPLOY_SERVER=root@2.28.196.184"
if not defined PB_DEPLOY_DIR set "PB_DEPLOY_DIR=/opt/pin-bridge"

set "BASE=%~1"
if "%BASE%"=="" set "BASE=HEAD~1"
set "BUILD="
if /i "%~2"=="build" set "BUILD=1"

cd /d "%~dp0..\.." || exit /b 1
git rev-parse --verify --quiet "%BASE%" >nul || (echo Unknown git ref: %BASE% & exit /b 1)

set "WORK=%TEMP%\pb-deploy-%RANDOM%"
mkdir "%WORK%" || exit /b 1
set "LIST=%WORK%\files.txt"
set "DELETED=%WORK%\deleted.txt"
set "ARCHIVE=%WORK%\pb-deploy.tar"

rem Changed against the working tree, so uncommitted edits are included too.
git diff --name-only --diff-filter=ACMRT "%BASE%" > "%LIST%"
git ls-files --others --exclude-standard >> "%LIST%"
git diff --name-only --diff-filter=D "%BASE%" > "%DELETED%"

set /a COUNT=0
for /f "usebackq delims=" %%f in ("%LIST%") do set /a COUNT+=1
set /a DCOUNT=0
for /f "usebackq delims=" %%f in ("%DELETED%") do set /a DCOUNT+=1
if %COUNT%==0 if %DCOUNT%==0 (echo Nothing changed since %BASE%. & goto :cleanup)

echo Target: %PB_DEPLOY_SERVER%:%PB_DEPLOY_DIR%
echo Changed since %BASE%: %COUNT% file(s)
for /f "usebackq delims=" %%f in ("%LIST%") do echo   + %%f
for /f "usebackq delims=" %%f in ("%DELETED%") do echo   - %%f
echo.
choice /m "Send these files"
if errorlevel 2 goto :cleanup

set "REMOTE_TAR=/tmp/pb-deploy-%RANDOM%.tar"
set "REMOTE_CMD=cd '%PB_DEPLOY_DIR%'"

if %COUNT% gtr 0 (
  tar -cf "%ARCHIVE%" -T "%LIST%" || (echo tar failed. & goto :fail)
  scp "%ARCHIVE%" "%PB_DEPLOY_SERVER%:!REMOTE_TAR!" || (echo scp failed. & goto :fail)
  set "REMOTE_CMD=!REMOTE_CMD! && tar -xf !REMOTE_TAR! && rm -f !REMOTE_TAR!"
)
for /f "usebackq delims=" %%f in ("%DELETED%") do set "REMOTE_CMD=!REMOTE_CMD! && rm -f '%%f'"
if defined BUILD set "REMOTE_CMD=!REMOTE_CMD! && docker compose up -d --build"

ssh "%PB_DEPLOY_SERVER%" "!REMOTE_CMD!" || (echo Remote step failed. & goto :fail)
echo Done.
goto :cleanup

:fail
rmdir /s /q "%WORK%" 2>nul
exit /b 1

:cleanup
rmdir /s /q "%WORK%" 2>nul
exit /b 0
