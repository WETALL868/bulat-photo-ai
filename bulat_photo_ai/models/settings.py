"""Typed settings and processing profiles."""
from dataclasses import asdict, dataclass
from enum import Enum

class OutputFormat(str, Enum):
    JPEG = "JPEG"
    PNG = "PNG"
    WEBP = "WEBP"

@dataclass(slots=True)
class ProcessingSettings:
    use_gpu: bool = True
    force_cpu: bool = False
    upscale_factor: int = 2
    jpeg_quality: int = 95
    output_format: OutputFormat = OutputFormat.JPEG
    denoise: bool = True
    jpeg_artifact_removal: bool = True
    ai_upscale: bool = True
    auto_color: bool = True
    contrast: bool = True
    sharpen: bool = True
    white_balance: bool = True
    microcontrast: bool = True
    saturation_boost: bool = True
    max_workers: int = 0

    def to_dict(self) -> dict:
        data = asdict(self)
        data["output_format"] = self.output_format.value
        return data

    @classmethod
    def from_dict(cls, data: dict) -> "ProcessingSettings":
        clean = dict(data)
        if "output_format" in clean:
            clean["output_format"] = OutputFormat(clean["output_format"])
        return cls(**clean)

PROFILES: dict[str, ProcessingSettings] = {
    "Universal": ProcessingSettings(upscale_factor=2, jpeg_quality=95),
    "Maximum Quality": ProcessingSettings(upscale_factor=4, jpeg_quality=100, output_format=OutputFormat.PNG),
    "Marketplace": ProcessingSettings(upscale_factor=2, jpeg_quality=95, contrast=True, sharpen=True),
    "Ozon": ProcessingSettings(upscale_factor=2, jpeg_quality=95, white_balance=True, saturation_boost=True),
    "Wildberries": ProcessingSettings(upscale_factor=2, jpeg_quality=95, denoise=True, contrast=True),
    "Yandex Market": ProcessingSettings(upscale_factor=2, jpeg_quality=95, auto_color=True, microcontrast=True),
}
