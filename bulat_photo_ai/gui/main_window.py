"""Main application window."""
from pathlib import Path
from PySide6.QtCore import QThread
from PySide6.QtWidgets import QFileDialog, QFrame, QGridLayout, QHBoxLayout, QLabel, QLineEdit, QMainWindow, QMessageBox, QProgressBar, QPushButton, QComboBox, QTextEdit, QVBoxLayout, QWidget
from bulat_photo_ai.config.constants import APP_NAME
from bulat_photo_ai.gui.settings_dialog import SettingsDialog
from bulat_photo_ai.models.settings import PROFILES
from bulat_photo_ai.settings.store import SettingsStore
from bulat_photo_ai.utils.files import discover_images
from bulat_photo_ai.workers.batch_worker import BatchWorker

class MainWindow(QMainWindow):
    """Commercial-style GUI for batch product photo enhancement."""
    def __init__(self) -> None:
        super().__init__(); self.setWindowTitle(APP_NAME); self.resize(1180, 760)
        self.store = SettingsStore(); self.settings = self.store.load(); self.thread = None; self.worker = None; self.paused = False
        root = QWidget(); self.setCentralWidget(root); layout = QVBoxLayout(root)
        title = QLabel(APP_NAME); title.setObjectName("title"); layout.addWidget(title)
        card = QFrame(); card.setObjectName("card"); grid = QGridLayout(card); layout.addWidget(card)
        self.source = QLineEdit(); self.output = QLineEdit(); grid.addWidget(QLabel("Исходная папка"),0,0); grid.addWidget(self.source,0,1); b1=QPushButton("Выбрать"); b1.clicked.connect(lambda:self.pick(self.source)); grid.addWidget(b1,0,2)
        grid.addWidget(QLabel("Папка сохранения"),1,0); grid.addWidget(self.output,1,1); b2=QPushButton("Выбрать"); b2.clicked.connect(lambda:self.pick(self.output)); grid.addWidget(b2,1,2)
        self.profile = QComboBox(); self.profile.addItems(PROFILES.keys()); self.profile.currentTextChanged.connect(self.apply_profile); grid.addWidget(QLabel("Профиль"),2,0); grid.addWidget(self.profile,2,1)
        stats = QHBoxLayout(); self.found=QLabel("Найдено: 0"); self.done=QLabel("Обработано: 0"); self.eta=QLabel("Осталось: —"); self.speed=QLabel("Скорость: —"); [stats.addWidget(w) for w in (self.found,self.done,self.eta,self.speed)]; layout.addLayout(stats)
        self.progress=QProgressBar(); layout.addWidget(self.progress); self.log=QTextEdit(); self.log.setReadOnly(True); layout.addWidget(self.log,1)
        buttons=QHBoxLayout(); self.start=QPushButton("Старт"); self.stop=QPushButton("Стоп"); self.pause=QPushButton("Пауза"); settings=QPushButton("Настройки"); about=QPushButton("О программе")
        for b in (self.start,self.pause,self.stop,settings,about): buttons.addWidget(b)
        layout.addLayout(buttons); self.start.clicked.connect(self.start_batch); self.stop.clicked.connect(self.stop_batch); self.pause.clicked.connect(self.pause_batch); settings.clicked.connect(self.show_settings); about.clicked.connect(self.about)
    def pick(self, target):
        folder = QFileDialog.getExistingDirectory(self, "Выберите папку")
        if folder: target.setText(folder); self.refresh_count()
    def refresh_count(self):
        if self.source.text(): self.found.setText(f"Найдено: {len(discover_images(Path(self.source.text())))}")
    def apply_profile(self, name): self.settings = PROFILES[name]
    def show_settings(self):
        dlg=SettingsDialog(self.settings,self)
        if dlg.exec(): self.settings=dlg.values(); self.store.save(self.settings)
    def start_batch(self):
        if not self.source.text() or not self.output.text(): QMessageBox.warning(self,"Папки","Выберите исходную папку и папку сохранения"); return
        self.thread=QThread(); self.worker=BatchWorker(Path(self.source.text()),Path(self.output.text()),self.settings); self.worker.moveToThread(self.thread); self.thread.started.connect(self.worker.run); self.worker.progress.connect(self.on_progress); self.worker.log.connect(self.log.append); self.worker.finished.connect(self.on_finished); self.thread.start(); self.start.setEnabled(False)
    def on_progress(self, done,total,eta,speed): self.progress.setMaximum(total); self.progress.setValue(done); self.done.setText(f"Обработано: {done}"); self.eta.setText(f"Осталось: {eta/60:.1f} мин"); self.speed.setText(f"Скорость: {speed:.2f} фото/с")
    def pause_batch(self):
        self.paused=not self.paused
        if self.worker: self.worker.pause(self.paused)
        self.pause.setText("Продолжить" if self.paused else "Пауза")
    def stop_batch(self):
        if self.worker: self.worker.stop()
    def on_finished(self, ok):
        self.log.append("Готово" if ok else "Остановлено/ошибка"); self.start.setEnabled(True)
        if self.thread: self.thread.quit(); self.thread.wait()
    def about(self): QMessageBox.about(self, APP_NAME, "Профессиональная пакетная AI-обработка фотографий товаров.")
