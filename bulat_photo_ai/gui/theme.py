"""Modern dark Qt stylesheet."""
DARK_QSS = """
QMainWindow, QDialog { background: #111318; color: #E6EAF2; }
QWidget { font-family: 'Segoe UI'; font-size: 10.5pt; color: #E6EAF2; }
QFrame#card { background: #191D26; border: 1px solid #2B3240; border-radius: 16px; }
QPushButton { background: #2F6BFF; border: 0; border-radius: 10px; padding: 10px 16px; font-weight: 600; }
QPushButton:hover { background: #4A7DFF; } QPushButton:disabled { background: #303642; color: #858B98; }
QLineEdit, QTextEdit, QComboBox, QSpinBox { background: #0D0F14; border: 1px solid #303847; border-radius: 9px; padding: 8px; }
QProgressBar { background: #0D0F14; border-radius: 8px; height: 14px; text-align: center; }
QProgressBar::chunk { background: qlineargradient(x1:0,y1:0,x2:1,y2:0, stop:0 #2F6BFF, stop:1 #8B5CFF); border-radius: 8px; }
QCheckBox { spacing: 8px; } QLabel#title { font-size: 24pt; font-weight: 800; }
"""
