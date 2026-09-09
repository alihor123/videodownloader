# Отчёт по загрузке медиа и production-beta

Дата аудита: 2026-09-09.

## Архитектура

Backend использует три in-memory очереди в одном процессе: `info`, `fast` и `file`. `info` получает метаданные и форматы, `fast` — цельные потоки с аудио, `file` — обычную загрузку через yt-dlp с проверкой временного файла и, при необходимости, ffmpeg. По умолчанию работают 1 info-worker, 4 fast-worker и 3 file-worker. После подготовки fast worker освобождается, а передача проксируется без отдельного лимита.

Worker — asyncio-задача, забирающая элемент из очереди и управляющая медиа-задачей. Для обработки worker запускает отдельный subprocess `services.media_worker`; это не отдельный серверный процесс очереди. Дерево yt-dlp/ffmpeg/JS runtime завершается через Windows Job Object или POSIX process group.

Очереди ограничены по размеру, общий лимит и per-IP лимит проверяются до постановки задачи. После рестарта процесса in-memory задачи исчезают, а временные каталоги очищаются при старте. Это принятое поведение beta; Redis сейчас не требуется.

## Fast

`fast=true` направляет задачу в fast queue. Worker получает цельный формат и отдаёт его через `ManagedFastResponse`, проксирующий upstream через backend. CDN URL и upstream headers не выдаются браузеру и не попадают в serialization.

После подготовки fast-поток сразу проксируется через backend, как обычная передача готового файла. Отмена закрывает upstream, выставляет `cancelled`, сигнализирует `transfer_done` и не засчитывает частичный поток как completed.

Если fast extractor присылает fallback-событие, задача с тем же `task_id` переводится в file queue с `requested_fast=false`. Переход проверен отдельным queue-тестом, а на живом TikTok — реальным скачиванием через fallback.

## Отмена и очистка

Отмена queued-задачи не запускает subprocess. Отмена running-задачи останавливает всё дерево процессов. Отмена file/fast transfer закрывает поток, удаляет временную директорию и выставляет `transfer_done`. Reaper удаляет просроченные задачи, старые готовые файлы и задачи, превысившие disk budget.

## Тесты

Backend из каталога `back`:

```powershell
python -m unittest discover -s tests
```

Результат аудита: **44 теста, OK**. Покрыты queue startup, capacity/per-IP, queue position, queued cancel, info/fast dispatch, fast → file fallback с сохранением task ID, fast response cancellation, process-tree cancellation, cleanup, timeout, transfer disconnect, URL normalization и пользовательские ошибки.

Frontend из каталога `front`:

```powershell
npm.cmd run test:contract
npm.cmd run build
npm.cmd run lint
npm.cmd run test:ui
```

Все команды прошли. UI smoke на Chromium проверяет cancel до POST-ответа, metadata flow, download cancel, повторный поиск, clear, desktop/mobile/dark layout и отсутствие JS errors.

## Probe-команды

```powershell
python -m tests.probe_platforms
python -m tests.probe_platforms youtube
python -m tests.probe_platforms https://public.example/video
```

Probe печатает только platform/status/format counts/fast labels/error и не печатает URL, headers или cookies. Для скачивания есть безопасный live probe:

```powershell
python -m tests.live_download_probe https://public.example/video --mode file
python -m tests.live_download_probe https://public.example/video --mode fast
```

File mode проверяет полный непустой временный файл и cleanup. Fast mode читает максимум 256 KiB и затем отменяет задачу; частичный fast результат не считается completed.

## Live matrix

Проверено 2026-09-09 с текущего IP и текущей версией yt-dlp:

| Платформа | Реальная проверка | Результат |
| --- | --- | --- |
| YouTube | обычное видео fast и file, Shorts file | скачивание прошло |
| Rutube | обычное видео file, Shorts file | скачивание прошло |
| VK Видео | клип file | скачивание прошло |
| X/Twitter | пост с видео file | скачивание прошло |
| TikTok | пользовательская ссылка fast | fast-источник не прошёл probe, задача автоматически перешла в file и скачалась |
| Instagram | Reel file | скачивание прошло |
| Instagram | carousel из нескольких материалов | намеренно отклонён с понятным сообщением; carousel пока не поддерживается |

Без cookie-файлов получение метаданных прошло для репозиторных примеров YouTube, Rutube, VK, X/Twitter и Instagram. Старый TikTok-пример был заблокирован платформой по IP, а актуальная пользовательская TikTok-ссылка без TikTok cookies скачалась через file fallback. Это снимок, а не постоянная гарантия: платформы меняют защиту, и результат зависит от IP, cookies и версии yt-dlp. TikTok дополнительно использует `curl-cffi`; cookies не заменяют browser impersonation.

## Готовность к test production

Код готов к контролируемому beta-деплою с небольшой нагрузкой. Перед открытием трафика нужно:

1. Задеплоить текущий backend и frontend: опубликованный домен пока отвечает старой frontend-сборкой, а `/api/media/platforms` возвращает 404.
2. Применить production nginx/systemd из README: HTTPS, SPA fallback, API proxy timeouts, `proxy_buffering off`, один uvicorn process и process-group shutdown.
3. После деплоя повторить API/UI smoke непосредственно через публичный домен.
4. Не публиковать `.env` и cookie-файлы. Все cookies должны оставаться отдельными файлами вне Git.

Очереди in-memory требуют ровно один uvicorn process. При рестарте незавершённые задачи пропадут; frontend покажет понятное сообщение и предложит начать заново. Для beta это допустимо. Для нескольких backend-процессов или нескольких серверов понадобится общая очередь, например Redis.

## Индексация

В сборке есть русские title/description, canonical, Open Graph, Twitter metadata, `robots.txt` и `sitemap.xml`. Это делает главную страницу технически доступной для индексации, но не гарантирует попадание в выдачу. На 2026-09-09 публичные `/`, `/robots.txt` и `/sitemap.xml` отвечают 200, однако домен ещё отдаёт старые YouTube-only metadata. После деплоя нужно добавить sitemap в Google Search Console и Яндекс Вебмастер и запросить переобход главной.

Это SPA с одной индексируемой страницей. Отдельных SSR-страниц платформ сейчас нет; для test beta это нормально.

`npm audit` и `npm audit --omit=dev` после `npm audit fix` показывают 0 vulnerabilities.
