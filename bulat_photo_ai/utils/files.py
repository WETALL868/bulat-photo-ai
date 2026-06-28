"""File discovery helpers."""
from pathlib import Path
from bulat_photo_ai.config.constants import SUPPORTED_EXTENSIONS

def discover_images(root: Path) -> list[Path]:
    """Recursively discover supported images under root."""
    return sorted(path for path in root.rglob("*") if path.is_file() and path.suffix.lower() in SUPPORTED_EXTENSIONS)

def output_path(source: Path, source_root: Path, output_root: Path, suffix: str) -> Path:
    """Mirror source folder structure under output root and replace extension."""
    relative = source.relative_to(source_root)
    return (output_root / relative).with_suffix(suffix.lower())
