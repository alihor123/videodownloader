# О проекте

`videodownloader` - это сервис для получения информации о YouTube-видео и скачивания выбранного формата.

## Из чего состоит проект

- `front/` - React + Vite интерфейс
- `back/` - FastAPI API, очереди задач скачивания, `yt-dlp`, SQLite-статистика

## Как работает

1. Пользователь вставляет ссылку на YouTube-видео.
2. Фронт запрашивает у backend метаданные и список доступных форматов.
3. Пользователь выбирает качество.
4. Фронт создаёт задачу скачивания.
5. Backend запускает задачу в фоне.
6. Фронт опрашивает статус задачи.
7. Когда файл готов, фронт получает `download_url` и запускает скачивание.

## Backend в двух словах

- FastAPI стартует из `back/app.py`
- маршруты YouTube лежат в `back/routers/youtube_router.py`
- логика `yt-dlp` лежит в `back/services/youtube_service.py`
- задачи скачивания лежат в `back/services/youtube_download_task_service.py`
- SQLite-модель и сессии лежат в `back/database/`

## Frontend в двух словах

- главная страница: `front/src/pages/MainPage/MainPage.jsx`
- API-обёртка: `front/src/services/api.js`
- YouTube-вызовы: `front/src/services/yt.api.js`

## Что хранится в SQLite

В базе хранится статистика скачиваний:

- время
- IP
- user-agent
- URL видео
- формат
- расширение файла

## Что важно при развёртывании

- frontend и backend лучше держать на одном домене
- проект использует относительный путь `/api`
- backend использует `yt-dlp`
- для скачивания и конвертации нужен `ffmpeg`

