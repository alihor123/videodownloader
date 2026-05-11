STAGE_MESSAGES = {
    "queued": "Задача создана",
    "preparing": "Подготавливаем скачивание",
    "resolving_fast_url": "Пробуем подготовить быструю загрузку",
    "fallback_to_file": "Быстрая загрузка недоступна, готовим файл на сервере",
    "downloading": "Скачиваем файл",
    "merging": "Склеиваем видео и аудио",
    "decoding_audio": "Конвертируем аудио",
    "ready": "Файл готов к скачиванию",
    "failed": "Не удалось подготовить скачивание",
}


def get_stage_message(stage):
    """Возвращает понятный пользователю текст для внутреннего stage-кода."""
    return STAGE_MESSAGES.get(stage, stage)
