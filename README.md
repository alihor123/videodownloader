# videodownloader

Сервис для получения информации о YouTube-видео и скачивания выбранного формата.

Проект состоит из:

- `front/` — React + Vite интерфейс.
- `back/` — FastAPI API, `yt-dlp`, `ffmpeg`, SQLite-статистика.

## Основная идея

Пользователь вставляет ссылку на YouTube-видео. Фронт запрашивает у бэка метаданные и список доступных вариантов скачивания. Пользователь выбирает формат, после чего фронт запускает один из двух путей:

- быстрый путь для готового mp4 с видео и аудио;
- универсальный путь через серверный файл и ffmpeg.

## Фронт

Главная страница: `front/src/pages/MainPage/MainPage.jsx`.

API-обертка YouTube: `front/src/services/yt.api.js`.

На фронте выбранный формат хранится целиком:

```js
const [selectedFormat, setSelectedFormat] = useState(null)
```

Это важно: `height` не всегда достаточно описывает вариант скачивания. У формата есть `height`, `ext`, `fast`, `label`, `size`.

Скачивание запускается через:

```js
downloadVideo(url, selectedFormat)
```

Текущая рабочая логика:

- `format.fast === true` -> `/api/youtube/download-stream`;
- иначе -> `/api/youtube/download-file`.

В `yt.api.js` также оставлена альтернативная старая механика:

```js
downloadVideoInNewWindow(url, format)
```

Она получает direct URL через `/download-url` и открывает его в новой вкладке. Сейчас она не используется, но оставлена, чтобы можно было быстро вернуться к этой схеме.

## Бэк

Главный файл приложения: `back/app.py`.

YouTube router: `back/routers/youtube_router.py`.

YouTube service/helpers: `back/services/youtube_service.py`.

### Роуты

Все YouTube-роуты находятся под `/api/youtube`.

`GET /info`

Получает метаданные видео и список форматов.

Возвращает примерно:

```json
{
  "title": "Видео",
  "duration": "10:24",
  "views": "1 000 просмотров",
  "uploader": "Channel",
  "formats": [
    {
      "height": 720,
      "label": "720p",
      "size": "~50 MB",
      "ext": "mp4",
      "fast": true
    }
  ]
}
```

`GET /download-stream`

Fast-путь. Для готового mp4-формата с видео и аудио:

- получает direct URL через `yt-dlp`;
- читает его через `httpx`;
- отдает пользователю через `StreamingResponse`;
- не пишет файл в `tmp`;
- не запускает ffmpeg.

Это компромиссный вариант: сервер все еще гонит трафик через себя, но не хранит файл и не склеивает потоки.

`GET /download-file`

Универсальный путь. Работает для всех вариантов:

- скачивает через `yt-dlp`;
- при необходимости склеивает видео+аудио через ffmpeg;
- для аудио делает mp3 через postprocessor;
- сохраняет временный файл в `back/tmp`;
- отдает файл через `FileResponse`;
- после ответа удаляет временный файл.

`GET /download-url`

Старый fast-путь, оставлен на будущее. Возвращает JSON с direct URL:

```json
{ "url": "https://..." }
```

Сейчас основная фронтовая функция его не использует.

### Как определяется fast

`build_format_list(info)` в `youtube_service.py` собирает форматы для фронта.

Для видео:

- если выбранный формат уже содержит видео и аудио, `fast: true`;
- если формат video-only и требует склейки с audio, `fast: false`.

Для аудио сейчас:

- список отдается как mp3;
- `fast: false`, потому что YouTube не отдает mp3 напрямую, нужна конвертация.

Потенциальное расширение: можно добавить fast-audio m4a отдельными элементами списка, но тогда нужно внимательно обработать `ext`, React key и media type.

### Важные функции `youtube_service.py`

`get_info_ydl_opts()`

Настройки `yt-dlp` для получения информации без скачивания.

`build_format_list(info)`

Готовит список форматов для фронта.

`get_fast_format_url(info, height)`

Ищет готовый mp4 с видео и аудио нужной высоты. Используется в `/download-stream` и `/download-url`.

`get_download_ydl_opts(...)`

Готовит настройки `yt-dlp` для серверного скачивания.

`create_download_paths(...)`

Создает безопасный временный путь для `yt-dlp`.

`cleanup_old_temp_files(...)`

Удаляет временные файлы старше 90 минут из `back/tmp`.

`build_content_disposition(...)`

Готовит имя файла для скачивания с UTF-8 filename.

## Временные файлы

Для `/download-file` временный путь создается через `tempfile.mkstemp()`.

`mkstemp()` возвращает:

- `tmp_fd` — открытый file descriptor;
- `tmp_path` — путь к временному файлу.

Код закрывает и удаляет пустой файл, оставляя только уникальный путь. Потом `yt-dlp` сам создает итоговый файл по этому пути.

Файл считается готовым после успешного завершения:

```python
extract_info(url, ydl_opts, download=True)
```

Этот вызов не возвращается, пока `yt-dlp` не закончил скачивание и postprocessing.

## Статистика

SQLite + SQLAlchemy async.

Файлы:

- `back/database/database.py`
- `back/database/db_tools.py`
- `back/config.py`

Конфиг читается через `pydantic-settings`.

`.env.example`:

```env
DATABASE_NAME=stats.db
```

Таблица `downloads` хранит:

- `id`
- `created_at`
- `ip`
- `user_agent`
- `video_url`
- `format_value`
- `file_ext`

Запись статистики происходит при успешном получении direct URL/stream и при успешной подготовке файла.

## Rate limit

Файл: `back/services/rate_limiter.py`.

Лимит по IP, без авторизации.

IP берется из:

- `x-forwarded-for`;
- `x-real-ip`;
- `request.client.host`.

Текущие лимиты:

- `/info`: 20 запросов в минуту на IP;
- download-роуты: 5 запросов в минуту на IP.

IP не является надежной идентификацией пользователя: VPN, NAT и мобильные сети могут менять поведение. Это простая защита от частого кликанья и случайного спама.

## Зависимости и запуск

Бэкенд:

```bash
cd back
.\venv\Scripts\python.exe -m pip install -r requirements.txt
.\venv\Scripts\python.exe app.py
```

Фронт:

```bash
cd front
npm install
npm run dev
```

Vite проксирует `/api` на `http://localhost:8000`.

## Важные нюансы

- `ffmpeg.exe` ожидается в `back/bin/ffmpeg.exe`.
- `back/tmp` используется только для `/download-file`.
- `back/*.db`, `back/database/*.sqlite3`, `back/tmp`, `back/bin` игнорируются git.
- Cookies сейчас не подключаются к `yt-dlp`. Если YouTube начинает отвечать `Sign in to confirm you're not a bot`, часто помогает смена IP/VPN. Cookies можно вернуть позже, но старые cookies могут мешать.
- `download-stream` проще для UX, чем открытие direct URL в новой вкладке, но трафик все равно идет через сервер.
- Самый быстрый и легкий для сервера вариант — direct URL в браузер, но он хуже контролируется: браузер может открыть медиа вместо скачивания.

