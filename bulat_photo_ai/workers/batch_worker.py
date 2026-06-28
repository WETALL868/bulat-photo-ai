"""Qt worker for scalable batch processing."""
from __future__ import annotations
import os, time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from PySide6.QtCore import QObject, Signal
from bulat_photo_ai.models.settings import ProcessingSettings
from bulat_photo_ai.processing.pipeline import PhotoProcessor
from bulat_photo_ai.utils.files import discover_images, output_path

class BatchWorker(QObject):
    """Processes image folders on a background Qt thread."""
    progress = Signal(int, int, float, float)
    log = Signal(str)
    finished = Signal(bool)

    def __init__(self, source: Path, output: Path, settings: ProcessingSettings) -> None:
        super().__init__()
        self.source, self.output, self.settings = source, output, settings
        self._stop = False
        self._pause = False

    def stop(self) -> None:
        self._stop = True

    def pause(self, paused: bool) -> None:
        self._pause = paused

    def run(self) -> None:
        files = discover_images(self.source)
        total = len(files)
        done = 0
        start = time.monotonic()
        self.log.emit(f"Найдено файлов: {total}")
        workers = self.settings.max_workers or max(1, min(32, (os.cpu_count() or 4)))
        processor = PhotoProcessor(self.settings)
        def job(path: Path) -> Path:
            while self._pause and not self._stop:
                time.sleep(0.2)
            if self._stop:
                return path
            dest = output_path(path, self.source, self.output, processor.extension)
            processor.process(path, dest)
            return path
        try:
            with ThreadPoolExecutor(max_workers=workers) as pool:
                futures = [pool.submit(job, path) for path in files]
                for future in as_completed(futures):
                    if self._stop:
                        break
                    path = future.result()
                    done += 1
                    elapsed = max(0.001, time.monotonic() - start)
                    speed = done / elapsed
                    eta = (total - done) / speed if speed else 0
                    self.progress.emit(done, total, eta, speed)
                    self.log.emit(f"Готово: {path.name}")
            self.finished.emit(not self._stop)
        except Exception as exc:
            self.log.emit(f"Ошибка: {exc}")
            self.finished.emit(False)
