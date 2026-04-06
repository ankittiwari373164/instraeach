@echo off
echo ============================================
echo  InstaReach v3 - Setup
echo ============================================
echo.

echo [1/3] Installing Node.js dependencies...
call npm install
if errorlevel 1 ( echo ERROR: npm install failed & pause & exit /b 1 )

echo.
echo [2/3] Installing Python dependencies...
pip install instagrapi Pillow
if errorlevel 1 ( echo ERROR: pip install failed. Make sure Python is installed. & pause & exit /b 1 )

echo.
echo [3/3] Setting up .env file...
if not exist .env (
    copy .env.example .env
    echo Created .env from example. Edit it to change admin password.
) else (
    echo .env already exists, skipping.
)

echo.
echo ============================================
echo  Setup complete!
echo  Run: npm start
echo  Open: http://localhost:3000
echo ============================================
pause
