@echo off
cd /d "%~dp0"
if not exist .venv (
  echo Creating Python environment...
  py -m venv .venv
)
call .venv\Scripts\activate
echo Installing or updating requirements...
py -m pip install -r requirements.txt
echo.
echo Starting SONI DOWNLOADER...
py app.py
pause
