from pathlib import Path
from PIL import Image
from bulat_photo_ai.models.settings import ProcessingSettings
from bulat_photo_ai.processing.pipeline import PhotoProcessor
from bulat_photo_ai.utils.files import discover_images

def test_discover_and_process(tmp_path: Path):
    src = tmp_path / "src"; out = tmp_path / "out"; src.mkdir()
    image_path = src / "item.jpg"
    Image.new("RGB", (8, 8), "white").save(image_path)
    assert discover_images(src) == [image_path]
    settings = ProcessingSettings(ai_upscale=False, denoise=False)
    processor = PhotoProcessor(settings)
    dest = out / "item.jpg"
    processor.process(image_path, dest)
    assert dest.exists()
