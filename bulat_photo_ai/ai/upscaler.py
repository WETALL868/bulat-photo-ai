"""AI upscaling abstraction with Real-ESRGAN when installed and Pillow fallback."""
from __future__ import annotations
from PIL import Image
from bulat_photo_ai.ai.device import detect_device
from bulat_photo_ai.models.settings import ProcessingSettings

class Upscaler:
    """Upscales images using Real-ESRGAN if available, with safe deterministic fallback."""

    def __init__(self, settings: ProcessingSettings) -> None:
        self.settings = settings
        self.device = detect_device(settings.force_cpu or not settings.use_gpu)
        self._model = None
        self._load_model()

    def _load_model(self) -> None:
        from importlib import import_module, util
        if util.find_spec("realesrgan") is None or util.find_spec("basicsr") is None:
            self._model = None
            return
        realesrgan_module = import_module("realesrgan")
        rrdb_module = import_module("basicsr.archs.rrdbnet_arch")
        model = rrdb_module.RRDBNet(num_in_ch=3, num_out_ch=3, num_feat=64, num_block=23, num_grow_ch=32, scale=self.settings.upscale_factor)
        self._model = realesrgan_module.RealESRGANer(
            scale=self.settings.upscale_factor,
            model_path=None,
            model=model,
            tile=384,
            tile_pad=16,
            pre_pad=0,
            half=self.device.cuda_available,
            device=self.device.name,
        )

    def upscale(self, image: Image.Image) -> Image.Image:
        factor = self.settings.upscale_factor
        if not self.settings.ai_upscale or factor == 1:
            return image
        if self._model is not None:
            try:
                import numpy as np
                output, _ = self._model.enhance(np.array(image.convert("RGB")), outscale=factor)
                return Image.fromarray(output)
            except Exception:
                pass
        width, height = image.size
        return image.resize((width * factor, height * factor), Image.Resampling.LANCZOS)
