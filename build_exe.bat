@echo off
REM Build pdf_toc.exe (onefile, windowed) using a clean venv
setlocal
cd /d "%~dp0"

set PY=python
set BUILD=build_env

echo [1/4] Creating clean venv...
if exist "%BUILD%" rmdir /s /q "%BUILD%"
%PY% -m venv "%BUILD%"
if errorlevel 1 goto :err

echo [2/4] Installing dependencies...
"%BUILD%\Scripts\python.exe" -m pip install --upgrade pip
"%BUILD%\Scripts\python.exe" -m pip install pymupdf rapidocr-onnxruntime pyinstaller
if errorlevel 1 goto :err

echo [3/4] Swap opencv-python -> headless (save ~100MB)...
"%BUILD%\Scripts\python.exe" -m pip uninstall -y opencv-python opencv-contrib-python
"%BUILD%\Scripts\python.exe" -m pip install opencv-python-headless
if errorlevel 1 goto :err

echo [4/4] Building exe...
"%BUILD%\Scripts\pyinstaller.exe" build.spec --noconfirm
if errorlevel 1 goto :err

echo.
echo Done. Output: dist\pdf_toc.exe
goto :eof

:err
echo Build failed. See errors above.
exit /b 1
