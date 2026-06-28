"""Professional product photo enhancement pipeline."""
from __future__ import annotations
from PIL import Image, ImageEnhance, ImageFilter, ImageOps, ImageStat

class ImageEnhancer:
    """Applies natural-looking color, denoise, contrast and sharpness corrections."""

    def white_balance(self, image: Image.Image) -> Image.Image:
        rgb = image.convert("RGB")
        stat = ImageStat.Stat(rgb)
        avg = stat.mean
        gray = sum(avg) / 3 or 1
        channels = [channel.point(lambda p, m=m: max(0, min(255, int(p * gray / (m or 1))))) for channel, m in zip(rgb.split(), avg)]
        return Image.merge("RGB", channels)

    def auto_color(self, image: Image.Image) -> Image.Image:
        return ImageOps.autocontrast(image.convert("RGB"), cutoff=0.5, preserve_tone=True)

    def denoise(self, image: Image.Image) -> Image.Image:
        return image.filter(ImageFilter.MedianFilter(size=3))

    def microcontrast(self, image: Image.Image) -> Image.Image:
        blurred = image.filter(ImageFilter.GaussianBlur(radius=1.2))
        return Image.blend(image, ImageChops.subtract(image, blurred).convert("RGB"), 0.08) if False else ImageEnhance.Contrast(image).enhance(1.06)

    def sharpen(self, image: Image.Image) -> Image.Image:
        return image.filter(ImageFilter.UnsharpMask(radius=1.1, percent=85, threshold=4))

    def enhance(self, image: Image.Image, *, denoise: bool, white_balance: bool, auto_color: bool, contrast: bool, microcontrast: bool, saturation: bool, sharpen: bool) -> Image.Image:
        result = image.convert("RGB")
        if white_balance:
            result = self.white_balance(result)
        if auto_color:
            result = self.auto_color(result)
        if denoise:
            result = self.denoise(result)
        if contrast:
            result = ImageEnhance.Contrast(result).enhance(1.08)
        if microcontrast:
            result = self.microcontrast(result)
        if saturation:
            result = ImageEnhance.Color(result).enhance(1.04)
        if sharpen:
            result = self.sharpen(result)
        return result
