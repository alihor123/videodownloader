# videodownloader

Пошаговая инструкция по развёртыванию проекта на пустом сервере.

Описание самого проекта вынесено отдельно: [PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md).

## Что разворачиваем

Проект состоит из двух частей:

- `back/` - FastAPI backend, `yt-dlp`, SQLite, временные файлы скачивания
- `front/` - React + Vite frontend

Основной сценарий для продакшена:

```text
Пользователь -> nginx -> frontend static files
                      -> /api -> backend на 127.0.0.1:8000
```

## Полная последовательность

Идём именно в таком порядке:

1. Подготовить сервер.
2. Скачать проект через `git clone`.
3. Настроить backend.
4. Настроить `.env`.
5. Проверить `ffmpeg`.
6. Запустить backend вручную.
7. Оформить backend как `systemd`-сервис.
8. Собрать frontend.
9. Настроить `nginx`.
10. Проверить сайт.

---

## 1. Подготовить сервер

Пример ниже для Ubuntu/Debian.

```bash
sudo apt update
sudo apt upgrade -y
sudo apt install -y git python3 python3-venv python3-pip nginx ffmpeg
```

Node.js нужен для сборки frontend:

```bash
sudo apt install -y nodejs npm
node -v
npm -v
```

Если версия Node.js слишком старая, поставь LTS через NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt install -y nodejs
```

---

## 2. Скачать проект

Выбери папку, где будет лежать проект. В инструкции используется `/opt/videodownloader`.

```bash
sudo mkdir -p /opt/videodownloader
sudo chown -R $USER:$USER /opt/videodownloader
cd /opt/videodownloader
git clone <URL_ТВОЕГО_РЕПОЗИТОРИЯ> .
```

После клонирования должны появиться:

```text
/opt/videodownloader/back
/opt/videodownloader/front
```

Дальше `git clone` больше не повторяем. Все действия идут внутри уже скачанного проекта.

---

## 3. Настроить backend

Перейди в backend:

```bash
cd /opt/videodownloader/back
```

Создай виртуальное окружение:

```bash
python3 -m venv venv
```

Активируй его:

```bash
source venv/bin/activate
```

Поставь зависимости:

```bash
pip install --upgrade pip
pip install -r requirements.txt
```

---

## 4. Настроить `.env`

Создай рабочий `.env` из примера:

```bash
cd /opt/videodownloader/back
cp .env.example .env
```

Открой `.env` любым редактором:

```bash
nano .env
```

Пример нормального `.env` для Linux-сервера:

```env
DATABASE_NAME=stats.db
FFMPEG_PATH=/usr/bin/ffmpeg
INFO_RATE_LIMIT_REQUESTS=20
INFO_RATE_LIMIT_PERIOD_SEC=60
FAST_DOWNLOAD_RATE_LIMIT_REQUESTS=10
FAST_DOWNLOAD_RATE_LIMIT_PERIOD_SEC=60
FILE_DOWNLOAD_RATE_LIMIT_REQUESTS=5
FILE_DOWNLOAD_RATE_LIMIT_PERIOD_SEC=1800
MAX_ACTIVE_FILE_TASKS=5
TEMP_FILE_MAX_AGE_SEC=5400
```

### Параметры `.env`

| Параметр | За что отвечает | Обычно ставить |
|---|---|---|
| `DATABASE_NAME` | SQLite-файл статистики. Если путь относительный, файл будет рядом с запуском backend | `stats.db` |
| `FFMPEG_PATH` | Путь к бинарнику `ffmpeg`, который нужен `yt-dlp` для склейки и конвертации | `/usr/bin/ffmpeg` на Linux |
| `INFO_RATE_LIMIT_REQUESTS` | Сколько раз один IP может запросить информацию о видео за период | `20` |
| `INFO_RATE_LIMIT_PERIOD_SEC` | Период лимита для информации о видео в секундах | `60` |
| `FAST_DOWNLOAD_RATE_LIMIT_REQUESTS` | Сколько fast-задач скачивания разрешено за период | `10` |
| `FAST_DOWNLOAD_RATE_LIMIT_PERIOD_SEC` | Период fast-лимита в секундах | `60` |
| `FILE_DOWNLOAD_RATE_LIMIT_REQUESTS` | Сколько обычных file-задач разрешено за период | `5` |
| `FILE_DOWNLOAD_RATE_LIMIT_PERIOD_SEC` | Период file-лимита в секундах | `1800` |
| `MAX_ACTIVE_FILE_TASKS` | Сколько file-задач backend может готовить одновременно | `5` |
| `TEMP_FILE_MAX_AGE_SEC` | Через сколько секунд старые временные файлы и задачи считаются мусором | `5400` |

Если `.env` не создать, backend возьмёт дефолты из [config.py](back/config.py).

---

## 5. Проверить `ffmpeg`

На Linux после установки через `apt` обычно путь такой:

```text
/usr/bin/ffmpeg
```

Проверить можно так:

```bash
which ffmpeg
which ffprobe
ffmpeg -version
ffprobe -version
```

Если `which ffmpeg` показал не `/usr/bin/ffmpeg`, впиши в `.env` тот путь, который он показал:

```env
FFMPEG_PATH=/путь/к/ffmpeg
```

### Если `ffmpeg` лежит внутри проекта

Можно хранить бинарники прямо в проекте:

```text
back/bin/ffmpeg.exe
back/bin/ffprobe.exe
```

Тогда в `.env`:

```env
FFMPEG_PATH=bin/ffmpeg.exe
```

Относительный путь считается от папки `back/`, поэтому `bin/ffmpeg.exe` превратится в:

```text
/opt/videodownloader/back/bin/ffmpeg.exe
```

На Linux расширение `.exe` не имеет магического значения. Это просто имя файла. Главное, чтобы файл был исполняемым:

```bash
chmod +x /opt/videodownloader/back/bin/ffmpeg.exe
```

### Windows-вариант

Если разворачиваешь на Windows и `ffmpeg` лежит внутри проекта:

```text
back\bin\ffmpeg.exe
back\bin\ffprobe.exe
```

В `.env`:

```env
FFMPEG_PATH=bin/ffmpeg.exe
```

Если `ffmpeg` установлен глобально, путь можно найти так:

```powershell
where ffmpeg
where ffprobe
```

И указать полный путь:

```env
FFMPEG_PATH=C:\ffmpeg\bin\ffmpeg.exe
```

---

## 6. Запустить backend вручную

Сначала проверяем backend без `systemd` и без `nginx`.

```bash
cd /opt/videodownloader/back
source venv/bin/activate
uvicorn app:app --host 127.0.0.1 --port 8000
```

Проверка на сервере:

```text
http://127.0.0.1:8000/docs
```

Можно проверить API:

```text
http://127.0.0.1:8000/api/youtube/info?url=<youtube_url>
```

Если это не работает, дальше не идём. Сначала исправляем backend, `.env`, зависимости или `ffmpeg`.

---

## 7. Запустить backend через `systemd`

Создай unit-файл:

```bash
sudo nano /etc/systemd/system/videodownloader-backend.service
```

Содержимое:

```ini
[Unit]
Description=videodownloader backend
After=network.target

[Service]
Type=simple
User=www-data
Group=www-data
WorkingDirectory=/opt/videodownloader/back
EnvironmentFile=/opt/videodownloader/back/.env
ExecStart=/opt/videodownloader/back/venv/bin/uvicorn app:app --host 127.0.0.1 --port 8000
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

Дай backend права на запись в `back/`, потому что там создаются `stats.db` и временные файлы:

```bash
sudo chown -R www-data:www-data /opt/videodownloader/back
```

Запусти сервис:

```bash
sudo systemctl daemon-reload
sudo systemctl enable videodownloader-backend
sudo systemctl start videodownloader-backend
sudo systemctl status videodownloader-backend
```

Логи:

```bash
journalctl -u videodownloader-backend -f
```

---

## 8. Собрать frontend

```bash
cd /opt/videodownloader/front
npm ci
npm run build
```

После сборки появится:

```text
/opt/videodownloader/front/dist
```

Скопируй собранную статику в папку для `nginx`:

```bash
sudo mkdir -p /var/www/videodownloader
sudo rsync -a --delete /opt/videodownloader/front/dist/ /var/www/videodownloader/
```

---

## 9. Настроить `nginx`

Создай конфиг:

```bash
sudo nano /etc/nginx/sites-available/videodownloader
```

Пример конфига:

```nginx
server {
    listen 80;
    server_name example.com;

    root /var/www/videodownloader;
    index index.html;

    location /api/ {
        proxy_pass http://127.0.0.1:8000/api/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

Замени `example.com` на свой домен или IP.

Включи конфиг:

```bash
sudo ln -s /etc/nginx/sites-available/videodownloader /etc/nginx/sites-enabled/videodownloader
sudo nginx -t
sudo systemctl reload nginx
```

---

## 10. Проверить результат

Проверь backend:

```bash
systemctl status videodownloader-backend
```

Проверь сайт:

```text
http://example.com
```

Проверь API через nginx:

```text
http://example.com/api/youtube/info?url=<youtube_url>
```

Потом открой сайт, вставь YouTube-ссылку и попробуй получить список форматов.

---

## 11. Что где хранится

```text
back/.env          настройки backend
back/stats.db     SQLite-статистика, если DATABASE_NAME=stats.db
back/tmp/         временные файлы скачивания
back/bin/         локальные бинарники ffmpeg, если используешь проектный ffmpeg
front/dist/       собранный frontend
```

Папку `back/tmp` вручную создавать обычно не нужно. Backend создаёт её сам, когда готовит file-загрузку.

---

## 12. Частые ошибки

### `502 Bad Gateway`

`nginx` не может достучаться до backend.

Проверь:

```bash
systemctl status videodownloader-backend
journalctl -u videodownloader-backend -f
```

### `ffmpeg` не найден

Проверь:

```bash
which ffmpeg
cat /opt/videodownloader/back/.env
```

В `.env` должен быть реальный путь:

```env
FFMPEG_PATH=/usr/bin/ffmpeg
```

### `stats.db` не создаётся

Скорее всего, нет прав на запись в `back/`.

```bash
sudo chown -R www-data:www-data /opt/videodownloader/back
sudo systemctl restart videodownloader-backend
```

### Фронт открылся, но API не работает

Проверь, что `nginx` проксирует `/api/` на `127.0.0.1:8000`.

```bash
sudo nginx -t
sudo systemctl reload nginx
```

### Нужно обновить проект

```bash
cd /opt/videodownloader
git pull
cd back
source venv/bin/activate
pip install -r requirements.txt
sudo systemctl restart videodownloader-backend
cd ../front
npm ci
npm run build
sudo rsync -a --delete dist/ /var/www/videodownloader/
sudo systemctl reload nginx
```

