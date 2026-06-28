# Bulat Photo AI

Bulat Photo AI — профессиональное Windows-приложение на Python 3.12 и PySide6 для пакетного улучшения фотографий товаров.

## Возможности

- Рекурсивная обработка `jpg`, `jpeg`, `png`, `webp`, `bmp`, `tiff`, `tif`.
- AI upscale x2/x4 с приоритетом Real-ESRGAN и автоматическим fallback на качественный Lanczos upscale.
- Автоматический выбор CUDA GPU при наличии NVIDIA и переход на CPU без действий пользователя.
- Удаление шума и JPEG-артефактов, баланс белого, автоцвет, контраст, микроконтраст, естественная насыщенность и резкость без сильных ореолов.
- Темная современная PySide6-тема, карточки, адаптивная компоновка, лог, прогресс, ETA и скорость обработки.
- Профили: Universal, Maximum Quality, Marketplace, Ozon, Wildberries, Yandex Market.
- Многопоточная обработка через `ThreadPoolExecutor`.

## Установка Windows

```bat
install.bat
```

## Запуск

```bat
run.bat
```

## Сборка EXE

```bat
build.bat
```

Готовый EXE будет создан PyInstaller в папке `dist`.

## Структура

- `bulat_photo_ai/gui` — интерфейс PySide6.
- `bulat_photo_ai/workers` — фоновые batch worker'ы.
- `bulat_photo_ai/processing` — pipeline улучшения изображений.
- `bulat_photo_ai/ai` — выбор устройства и AI upscale.
- `bulat_photo_ai/models` — типизированные настройки и профили.
- `bulat_photo_ai/settings` — сохранение пользовательских настроек.
- `bulat_photo_ai/utils` — файловые утилиты.
- `bulat_photo_ai/logger` — логирование.

## Примечание о Real-ESRGAN

Проект автоматически пытается использовать Real-ESRGAN, если зависимости и веса модели доступны в окружении. Если модель недоступна, приложение продолжает работать и применяет стабильный CPU/GPU-независимый pipeline на Pillow.
