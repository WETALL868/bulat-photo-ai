"""Application entry point."""
import sys
from PySide6.QtWidgets import QApplication
from bulat_photo_ai.gui.main_window import MainWindow
from bulat_photo_ai.gui.theme import DARK_QSS
from bulat_photo_ai.logger.app_logger import configure_logging

def main() -> int:
    configure_logging()
    app = QApplication(sys.argv); app.setStyleSheet(DARK_QSS)
    window = MainWindow(); window.show()
    return app.exec()

if __name__ == "__main__":
    raise SystemExit(main())
