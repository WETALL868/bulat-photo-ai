"""Settings dialog."""
from PySide6.QtWidgets import QCheckBox, QComboBox, QDialog, QFormLayout, QHBoxLayout, QPushButton, QSpinBox, QVBoxLayout
from bulat_photo_ai.models.settings import OutputFormat, ProcessingSettings

class SettingsDialog(QDialog):
    """Allows editing processing settings."""
    def __init__(self, settings: ProcessingSettings, parent=None) -> None:
        super().__init__(parent)
        self.setWindowTitle("Настройки")
        self.settings = settings
        layout = QFormLayout(self)
        self.gpu = QCheckBox(); self.gpu.setChecked(settings.use_gpu); layout.addRow("Использовать GPU", self.gpu)
        self.cpu = QCheckBox(); self.cpu.setChecked(settings.force_cpu); layout.addRow("Принудительно CPU", self.cpu)
        self.scale = QComboBox(); self.scale.addItems(["2", "4"]); self.scale.setCurrentText(str(settings.upscale_factor)); layout.addRow("Увеличение x", self.scale)
        self.quality = QSpinBox(); self.quality.setRange(90, 100); self.quality.setValue(settings.jpeg_quality); layout.addRow("Качество", self.quality)
        self.fmt = QComboBox(); self.fmt.addItems([f.value for f in OutputFormat]); self.fmt.setCurrentText(settings.output_format.value); layout.addRow("Формат", self.fmt)
        self.options = {}
        for label, attr in [("Удаление шума","denoise"),("JPEG артефакты","jpeg_artifact_removal"),("AI Upscale","ai_upscale"),("Автоцвет","auto_color"),("Контраст","contrast"),("Резкость","sharpen"),("Баланс белого","white_balance")]:
            box = QCheckBox(); box.setChecked(getattr(settings, attr)); self.options[attr] = box; layout.addRow(label, box)
        buttons = QHBoxLayout(); ok = QPushButton("Сохранить"); cancel = QPushButton("Отмена"); ok.clicked.connect(self.accept); cancel.clicked.connect(self.reject); buttons.addWidget(ok); buttons.addWidget(cancel); layout.addRow(buttons)

    def values(self) -> ProcessingSettings:
        data = self.settings.to_dict(); data.update(use_gpu=self.gpu.isChecked(), force_cpu=self.cpu.isChecked(), upscale_factor=int(self.scale.currentText()), jpeg_quality=self.quality.value(), output_format=self.fmt.currentText())
        for attr, box in self.options.items(): data[attr] = box.isChecked()
        return ProcessingSettings.from_dict(data)
