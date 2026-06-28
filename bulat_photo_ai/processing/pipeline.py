"""Single-image processing pipeline."""
from __future__ import annotations
from pathlib import Path
from PIL import Image
from bulat_photo_ai.ai.upscaler import Upscaler
from bulat_photo_ai.models.settings import OutputFormat, ProcessingSettings
from bulat_photo_ai.processing.enhancer import ImageEnhancer

class PhotoProcessor:
    """Coordinates image loading, AI upscale, enhancement, and export."""

    def __init__(self, settings: ProcessingSettings) -> None:
        self.settings = settings
        self.upscaler = Upscaler(settings)
        self.enhancer = ImageEnhancer()

    @property
    def extension(self) -> str:
        return {OutputFormat.JPEG: ".jpg", OutputFormat.PNG: ".png", OutputFormat.WEBP: ".webp"}[self.settings.output_format]

    def process(self, source: Path, destination: Path) -> None:
        destination.parent.mkdir(parents=True, exist_ok=True)
        with Image.open(source) as img:
            image = img.convert("RGB")
        image = self.enhancer.enhance(
            image,
            denoise=self.settings.denoise or self.settings.jpeg_artifact_removal,
            white_balance=self.settings.white_balance,
            auto_color=self.settings.auto_color,
            contrast=self.settings.contrast,
            microcontrast=self.settings.microcontrast,
            saturation=self.settings.saturation_boost,
            sharpen=self.settings.sharpen,
        )
        image = self.upscaler.upscale(image)
        save_kwargs = {}
        if self.settings.output_format in {OutputFormat.JPEG, OutputFormat.WEBP}:
            save_kwargs.update(quality=self.settings.jpeg_quality, optimize=True)
        if self.settings.output_format is OutputFormat.JPEG:
            save_kwargs["progressive"] = True
        image.save(destination, self.settings.output_format.value, **save_kwargs)
