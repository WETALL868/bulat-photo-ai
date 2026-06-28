"""Persistent settings storage."""
import json
from bulat_photo_ai.config.constants import CONFIG_DIR, CONFIG_FILE
from bulat_photo_ai.models.settings import ProcessingSettings

class SettingsStore:
    """Loads and saves user processing settings as JSON."""

    def load(self) -> ProcessingSettings:
        if not CONFIG_FILE.exists():
            return ProcessingSettings()
        try:
            return ProcessingSettings.from_dict(json.loads(CONFIG_FILE.read_text(encoding="utf-8")))
        except Exception:
            return ProcessingSettings()

    def save(self, settings: ProcessingSettings) -> None:
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        CONFIG_FILE.write_text(json.dumps(settings.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8")
