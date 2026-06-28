@echo off
call .venv\Scripts\activate.bat
pyinstaller --noconfirm --windowed --name "Bulat Photo AI" --add-data "bulat_photo_ai\resources;bulat_photo_ai\resources" -m bulat_photo_ai.main
pause
