@echo off
REM add-blob-dependency.bat
REM Drop this file in your repo root (next to package.json) and DOUBLE-CLICK it.
REM It adds the @vercel/blob library and updates package-lock.json so Vercel can
REM install it on the next deploy. Then commit BOTH files in GitHub Desktop.

cd /d "%~dp0"
echo Installing @vercel/blob into %cd% ...
echo.
call npm install @vercel/blob --save
echo.
if %errorlevel%==0 (
  echo ---------------------------------------------------------------
  echo Done. Now open GitHub Desktop and commit these two changed files:
  echo    package.json
  echo    package-lock.json
  echo ---------------------------------------------------------------
) else (
  echo Something went wrong ^(error %errorlevel%^). Copy the text above and send it to me.
)
echo.
pause
