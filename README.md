# videodownloader

Сервис для получения информации о YouTube-видео и скачивания выбранного формата.

Проект состоит из:

- `front/` - React + Vite интерфейс.
- `back/` - FastAPI API, `yt-dlp`, `ffmpeg`, SQLite-статистика.

## Основная идея

Пользователь вставляет ссылку на YouTube-видео. Фронт запрашивает у бэка информацию о ролике и список доступных форматов. После выбора формата скачивание идет через задачу:

1. Фронт создает задачу скачивания.
2. Бэк сразу возвращает `task_id`.
3. Скачивание идет в фоне.
4. Фронт polling-запросами получает `status`, `stage`, `message`, `progress`.
5. Когда задача готова, фронт запускает скачивание через готовый `download_url`.

Так ошибки не открываются отдельным JSON-файлом в браузере, а остаются в API задачи и могут быть показаны на основной странице.

## Фронт

Главная страница: `front/src/pages/MainPage/MainPage.jsx`.

API-обертка YouTube: `front/src/services/yt.api.js`.

На фронте выбранный формат хранится целиком:

```js
const [selectedFormat, setSelectedFormat] = useState(null)
```

Формат из `/info` содержит:

```json
{
  "height": 720,
  "label": "720p",
  "ext": "mp4",
  "size": "~50 MB",
  "fast": true
}
```

`ext` нужен фронту для отображения. Для скачивания фронт передает только `height` и `fast`, а итоговый тип файла бэк определяет сам.

Скачивание сейчас устроено так:

- `createDownloadTask(url, selectedFormat)` создает задачу.
- `getDownloadTask(taskId)` используется для polling.
- `triggerDownload(downloadUrl)` запускает нативное скачивание готового результата.

Polling находится в `MainPage.jsx`, потому что именно там живет React-состояние:

```js
const [downloadTask, setDownloadTask] = useState(null)
```

`yt.api.js` остается простым API-слоем и не хранит состояние интерфейса.

## Бэк

Главный файл приложения: `back/app.py`.

YouTube router: `back/routers/youtube_router.py`.

Низкоуровневая работа с YouTube / `yt-dlp`: `back/services/youtube_service.py`.

Жизненный цикл задачи скачивания: `back/services/youtube_download_task_service.py`.

Константы скачивания и stage-сообщения: `back/services/youtube_download_constants.py`.

## Роуты

Все YouTube-роуты находятся под `/api/youtube`.

### `GET /info`

Получает метаданные видео и список форматов.

Параметры:

```text
url: string
```

Ответ примерно:

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
      "ext": "mp4",
      "size": "~50 MB",
      "fast": true
    }
  ]
}
```

### `POST /download-tasks`

Создает задачу скачивания и сразу возвращает ее текущее состояние.

Тело запроса:

```json
{
  "url": "https://www.youtube.com/watch?v=...",
  "format": {
    "height": 720,
    "fast": true
  }
}
```

Ответ:

```json
{
  "task_id": "abc123",
  "status": "queued",
  "stage": "queued",
  "message": "Задача создана",
  "progress": null,
  "error": null,
  "download_url": null
}
```

После создания задачи router запускает ее в фоне:

```python
asyncio.create_task(run_download_task(task.id))
```

Тяжелые вызовы `yt-dlp` выполняются через `asyncio.to_thread(...)`, чтобы не блокировать event loop FastAPI.

### `GET /download-tasks/{task_id}`

Возвращает текущее состояние задачи для polling.

Когда задача готова, в ответе появляется `download_url`:

```json
{
  "task_id": "abc123",
  "status": "ready",
  "stage": "ready",
  "message": "Файл готов к скачиванию",
  "progress": 100,
  "error": null,
  "download_url": "/api/youtube/download-tasks/abc123/download"
}
```

### `GET /download-tasks/{task_id}/download`

Отдает готовый результат задачи.

Если задача `fast`, бэк стримит direct URL YouTube через `StreamingResponse`.

Если задача `file`, бэк отдает временный файл из `back/tmp` через `FileResponse`.

После отдачи результата задача удаляется из памяти. Для `file`-режима также удаляется временный файл.

## Задачи скачивания

Задачи хранятся в памяти процесса:

```python
TASKS = {}
TASKS_LOCK = RLock()
```

`TASKS_LOCK` нужен, потому что задачу одновременно могут читать polling-запросы и обновлять фоновая задача скачивания.

Основные поля задачи:

- `id` - идентификатор задачи.
- `url` - ссылка на видео.
- `height` - выбранная высота видео или audio bitrate.
- `requested_fast` - хотел ли фронт fast-режим.
- `status` - общее состояние задачи.
- `stage` - конкретный этап работы.
- `message` - текст для пользователя.
- `progress` - общий прогресс подготовки файла.
- `mode` - `fast` или `file`.
- `direct_url` - direct URL для fast-режима.
- `file_path` - путь к готовому временному файлу для file-режима.

## Status и stage

`status` отвечает на вопрос: что с задачей в целом.

Текущие значения:

- `queued` - задача создана.
- `running` - задача выполняется.
- `ready` - результат готов.
- `failed` - задача завершилась ошибкой.

`stage` отвечает на вопрос: что сервер делает прямо сейчас.

Текущие значения:

- `queued`
- `preparing`
- `resolving_fast_url`
- `fallback_to_file`
- `downloading_file`
- `downloading_video`
- `downloading_audio`
- `merging`
- `decoding_audio`
- `ready`
- `failed`

Русские тексты для `stage` лежат в `STAGE_MESSAGES` в `youtube_download_constants.py`.

## Progress

`progress` отдается одним числом, чтобы фронт мог сразу рисовать одну полоску.

Для `mp3`:

```text
0..99  - скачивание аудио
100    - файл готов
```

Для `mp4` в file-режиме:

```text
0..50   - скачивание видео
50..99  - скачивание аудио
100     - файл готов
```

Этап `merging` не имеет честного процента от `yt-dlp`, поэтому во время склейки меняется `stage/message`, а `progress` не пытается изображать точную скорость ffmpeg.

Fast-режим обычно не требует progress bar: задача быстро готовит direct URL, а сам файл дальше скачивает браузер через `/download`.

## Fast и fallback

`fast: true` означает, что формат уже содержит видео и аудио в одном mp4 и его можно попробовать отдать без серверной склейки.

При создании задачи:

1. Если пользователь выбрал fast-формат, бэк пробует найти direct URL.
2. Если direct URL найден, задача становится `ready` с `mode="fast"`.
3. Если fast не сработал, задача автоматически переходит в обычный file-режим.

Для audio/mp3 fast не используется, потому что YouTube не отдает готовый mp3 напрямую. Нужно скачать аудио и конвертировать через ffmpeg.

## Временные файлы

File-режим использует `back/tmp`.

Для временных путей используется `tempfile.mkstemp()`. Код закрывает и удаляет пустой файл, оставляя уникальный путь, по которому `yt-dlp` потом создает настоящий файл.

Старые временные файлы удаляются функцией `cleanup_old_temp_files(...)`. Текущий лимит возраста: 90 минут.

После успешной отдачи файла через `/download-tasks/{task_id}/download` временный файл удаляется через background task Starlette.

## Статистика

SQLite + SQLAlchemy async.

Файлы:

- `back/database/database.py`
- `back/database/db_tools.py`
- `back/config.py`

Таблица `downloads` хранит:

- `id`
- `created_at`
- `ip`
- `user_agent`
- `video_url`
- `format_value`
- `file_ext`

Статистика пишется после успешной подготовки fast-ссылки или успешной подготовки файла.

## Rate limit

Файл: `back/services/rate_limiter.py`.

Лимиты:

- `/info`: 20 запросов в минуту на IP.
- `/download-tasks` для fast-форматов: 10 запросов в минуту на IP.
- `/download-tasks` для file-режима: 5 запросов за 30 минут на IP.

IP берется из:

- `x-forwarded-for`
- `x-real-ip`
- `request.client.host`

Это простая защита от частого клика и случайного спама. IP не является надежной идентификацией пользователя.

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

Основные настройки в `back/.env`:

```env
DATABASE_NAME=stats.db
INFO_RATE_LIMIT_REQUESTS=20
INFO_RATE_LIMIT_PERIOD_SEC=60
FAST_DOWNLOAD_RATE_LIMIT_REQUESTS=10
FAST_DOWNLOAD_RATE_LIMIT_PERIOD_SEC=60
FILE_DOWNLOAD_RATE_LIMIT_REQUESTS=5
FILE_DOWNLOAD_RATE_LIMIT_PERIOD_SEC=1800
TEMP_FILE_MAX_AGE_SEC=5400
```

## Важные нюансы

- `ffmpeg.exe` ожидается в `back/bin/ffmpeg.exe`.
- `back/tmp` используется только для file-режима.
- Старые прямые download-ручки удалены. Актуальная схема скачивания идет через `download-tasks`.
- Задачи хранятся в памяти процесса. После перезапуска бэка они исчезают.
- Cookies сейчас не подключаются к `yt-dlp`. Если YouTube отвечает `Sign in to confirm you're not a bot`, часто помогает смена IP/VPN. Cookies можно вернуть позже, но старые cookies могут мешать.
