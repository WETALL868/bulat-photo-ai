"""Application-wide constants."""
from pathlib import Path

APP_NAME = "Bulat Photo AI"
SUPPORTED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tiff", ".tif"}
DEFAULT_OUTPUT_DIRNAME = "BulatPhotoAI_Output"
CONFIG_DIR = Path.home() / ".bulat_photo_ai"
CONFIG_FILE = CONFIG_DIR / "settings.json"
