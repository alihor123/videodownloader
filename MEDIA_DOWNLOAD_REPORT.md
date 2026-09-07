# Загрузка медиа: реализация и проверка

## Что поддерживается

URL определяется по настоящему hostname в [media_platforms.py](back/services/media_platforms.py): YouTube, Rutube, VK Видео, X/Twitter, TikTok и Instagram. Worker использует один общий `yt-dlp`-поток на операцию в [media_worker.py](back/services/media_worker.py); произвольные/generic URL запрещены. Telegram не входит в область этой реализации.

Поддержка адаптера не означает доступность каждого ролика: закрытые материалы, эфиры и изменения на стороне платформ могут быть недоступны. Для TikTok требуется установленный `curl-cffi`, потому что extractor использует имитацию браузера. Проверочный публичный ролик TikTok работает без cookies; вертикальные форматы сохраняют техническую высоту для yt-dlp, но показывают человеку корректные `540p`, `720p` и `1080p`.

## API и жизненный цикл

- `GET /api/media/platforms` — список платформ.
- `POST /api/media/info` — один ожидающий запрос метаданных с UUID клиента; сервер отменяет worker при disconnect.
- `POST /api/media/download-tasks` — создание фоновой download-задачи с UUID клиента.
- `GET /api/media/download-tasks/{task_id}` — статус; готовая download-задача возвращает адрес native browser download.
- `DELETE /api/media/download-tasks/{task_id}` — отмена.
- `/api/youtube` оставлен как совместимый alias этого же роутера в [app.py](back/app.py).

UUID download-задачи известен браузеру до POST. Поэтому DELETE, пришедший раньше POST, создаёт tombstone: последующий POST не сможет воскресить работу — это реализовано в [cancel_task](back/services/media_tasks.py) и [create_task](back/services/media_tasks.py). Метаданные получают одним `POST /info`, без status polling; его `finally` ждёт cleanup worker, а успешная info-задача очищается без tombstone. Фронтенд хранит одну текущую операцию с `AbortController`, подтверждает DELETE до очистки UI и отменяет её также при `pagehide`/unmount: [useMediaController.ts](front/src/pages/MainPage/useMediaController.ts), [yt.api.ts](front/src/services/yt.api.ts).

Все форматы подготавливаются в управляемом worker-файле, включая ранее «быстрые» цельные MP4 (`fast=false` в [media_worker.py](back/services/media_worker.py)). Это сознательный обмен прямой байтовой передачи на единый механизм отмены и очистки: готовый файл отдаётся нативной загрузкой браузера, а не обещанным direct/fast stream.

## Отмена, лимиты и очистка

`DELETE` ждёт окончания worker и его потомков, а при активной HTTP-передаче — ещё и `transfer_done`; это видно в [cancel_task](back/services/media_tasks.py) и [ManagedFileResponse](back/routers/media_router.py). На Windows worker закрепляется в Job Object с `KILL_ON_JOB_CLOSE`; закрытие handle убивает всё дерево. На POSIX создаётся отдельная session/process group, затем отправляются SIGTERM и SIGKILL: [process_tree.py](back/services/process_tree.py). Состояние `ready` публикуется лишь после teardown группы, поэтому передача не стартует одновременно с очисткой файла.

Файл задачи расположен строго в собственной UUID-папке. [cleanup_directory](back/services/media_tasks.py) проверяет её родителя перед `rmtree`; ошибки доступа оставляет для следующей попытки. Reaper выполняется каждые 2 секунды и не прекращается от `OSError` одной папки. Он отменяет пропавших клиентов после lease 90 секунд, готовый файл после 120 секунд и очищает старые записи через 90 минут. Отдельный worker ограничен 100 секундами для метаданных и 900 секундами для загрузки. Бюджет 2 GiB также проверяется раз в 2 секунды, поэтому это не жёсткий realtime-лимит.

Native browser download может уже получить буфер или завершённый файл до DELETE; сервер не может и не должен удалять пользовательский файл. Аналогично nginx/прокси могут буферизовать ответ. В [README.md](README.md) для production указаны `proxy_buffering off`, `KillMode=control-group`, `TimeoutStopSec=90` и `SendSIGKILL=yes`. Linux отмена проверена mock-протоколом; реальные дочерние процессы и ffmpeg проверялись на Windows. Запускать backend следует одним uvicorn worker: память задач процесс-локальная.

## Проверки

Backend (из `back`):

```powershell
python -m unittest discover -s tests -v
```

Результат: **30 тестов, OK** для media lifecycle, платформенных форматов и entrypoint. Набор [test_media.py](back/tests/test_media.py) включает реальную Windows-отмену child/ffmpeg, очистку partial-файлов, отмену до POST, независимость соседней задачи, timeout/lease/disk cleanup, HTTP transfer/disconnect, один POST метаданных без polling, cleanup при disconnect, portrait-форматы TikTok и понятную ошибку при отсутствии browser impersonation. [test_entrypoint.py](back/tests/test_entrypoint.py) фиксирует `reload=False` при `python app.py`: reload на Windows переключает uvicorn на Selector loop, который не поддерживает `asyncio.create_subprocess_exec`.

```powershell
python -m tests.probe_platforms
python -m tests.probe_platforms rutube --download
```

Frontend (из `front`):

```powershell
npm.cmd run build
$env:PLAYWRIGHT_MODULE='C:\Users\Egor\AppData\Local\npm-cache\_npx\e41f203b7505f1fb\node_modules\playwright'
node tests/media-ui.cjs
```

Фронтенд использует strict TypeScript. `npm.cmd run typecheck`, `npm.cmd run lint` и `npm.cmd run build` должны завершаться без ошибок. UI test проверяет отмену отложенного POST, отмену загрузки, отмену предыдущего поиска, очистку формы, desktop/mobile/dark layout и JavaScript errors. Скриншоты создаются только в игнорируемой `front/tmp/ui-checks/`.

Продакшен и удалённый сервер не менялись. Локальный backend перезапущен из `back/venv`, чтобы TikTok использовал установленный `curl-cffi`; основной Vite пользователя оставлен запущенным. Временные процессы, созданные для тестов, остановлены.
