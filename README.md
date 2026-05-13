# videodownloader

Продакшен-гайд для Linux-сервера (Ubuntu/Debian) с backend + frontend, `systemd`, `nginx`, HTTPS и нормальным повторным деплоем.

## Структура размещения

Проект не кладем в `/root`. Используем:

```text
/srv/apps/videodownloader/
  repo/                  # git-репозиторий (back/, front/)
  shared/                # постоянные данные (db, tmp)
```

После клона ожидаем:

```text
/srv/apps/videodownloader/repo/back
/srv/apps/videodownloader/repo/front
```

## 1) Подготовка сервера

```bash
sudo apt update
sudo apt upgrade -y
sudo apt install -y git python3 python3-venv python3-pip nginx ffmpeg curl rsync
```

Node.js (LTS):

```bash
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```

## 2) Клонирование

```bash
sudo mkdir -p /srv/apps/videodownloader
sudo chown -R $USER:$USER /srv/apps/videodownloader
cd /srv/apps/videodownloader
git clone <YOUR_REPO_URL> repo
```

## 3) Backend setup

```bash
cd /srv/apps/videodownloader/repo/back
python3 -m venv venv
source venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
```

## 4) Backend `.env`

```bash
cd /srv/apps/videodownloader/repo/back
cp .env.example .env 2>/dev/null || true
```

Заполни `back/.env`:

```env
DATABASE_NAME=/srv/apps/videodownloader/shared/stats.db
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

Создай директорию под данные:

```bash
mkdir -p /srv/apps/videodownloader/shared
```

## 5) Проверка backend вручную

```bash
cd /srv/apps/videodownloader/repo/back
source venv/bin/activate
uvicorn app:app --host 127.0.0.1 --port 8000
```

Проверь:

```text
http://127.0.0.1:8000/docs
http://127.0.0.1:8000/api/youtube/info?url=<youtube_url>
```

## 6) `systemd` сервис backend

`/etc/systemd/system/videodownloader-backend.service`:

```ini
[Unit]
Description=videodownloader backend
After=network.target

[Service]
Type=simple
User=www-data
Group=www-data
WorkingDirectory=/srv/apps/videodownloader/repo/back
EnvironmentFile=/srv/apps/videodownloader/repo/back/.env
ExecStart=/srv/apps/videodownloader/repo/back/venv/bin/uvicorn app:app --host 127.0.0.1 --port 8000
Restart=always
RestartSec=3
TimeoutStopSec=90

[Install]
WantedBy=multi-user.target
```

Запуск:

```bash
sudo chown -R www-data:www-data /srv/apps/videodownloader/repo/back /srv/apps/videodownloader/shared
sudo systemctl daemon-reload
sudo systemctl enable videodownloader-backend
sudo systemctl restart videodownloader-backend
sudo systemctl status videodownloader-backend --no-pager
```

Логи:

```bash
journalctl -u videodownloader-backend -f
```

## 7) Frontend build

```bash
cd /srv/apps/videodownloader/repo/front
npm ci
npm run build
```

Публикация статики:

```bash
sudo mkdir -p /var/www/videodownloader
sudo rsync -a --delete /srv/apps/videodownloader/repo/front/dist/ /var/www/videodownloader/
```

## 8) `nginx` конфиг

`/etc/nginx/sites-available/videodownloader`:

```nginx
server {
    listen 80;
    server_name example.com;

    root /var/www/videodownloader;
    index index.html;

    location /api/ {
        proxy_pass http://127.0.0.1:8000/api/;
        proxy_http_version 1.1;
        proxy_connect_timeout 300s;
        proxy_send_timeout 300s;
        proxy_read_timeout 300s;
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

Включение:

```bash
sudo ln -sf /etc/nginx/sites-available/videodownloader /etc/nginx/sites-enabled/videodownloader
sudo nginx -t
sudo systemctl reload nginx
```

Рекомендация: фронтовый `REQUEST_TIMEOUT_MS` должен быть меньше, чем `proxy_read_timeout` в `nginx`.

## 9) HTTPS (обязательно)

Без HTTPS браузер будет ругаться на insecure download.

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d example.com
```

Проверь, что:

```text
https://example.com
https://example.com/api/youtube/info?url=<youtube_url>
```

## 10) Повторный деплой (обновление)

```bash
cd /srv/apps/videodownloader/repo
git fetch --all
git pull --ff-only

cd /srv/apps/videodownloader/repo/back
source venv/bin/activate
pip install -r requirements.txt
sudo systemctl restart videodownloader-backend

cd /srv/apps/videodownloader/repo/front
npm ci
npm run build
sudo rsync -a --delete dist/ /var/www/videodownloader/
sudo systemctl reload nginx
```

Пост-проверка:

```bash
systemctl is-active videodownloader-backend
curl -sS "http://127.0.0.1:8000/api/youtube/info?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ" | head -c 300
```

## 11) Быстрый troubleshooting

- `Не удалось подготовить скачивание` для non-fast:
  Проверь `FFMPEG_PATH` и наличие `/usr/bin/ffmpeg`.
- `HTTP 502` от nginx:
  Проверь `systemctl status videodownloader-backend` и `journalctl -u videodownloader-backend -f`.
- Только один формат в `/info`:
  Проверь `player_client` в `back/services/youtube_service.py`.
- Зависания на YouTube:
  Используй IPv4 в `yt-dlp` (`source_address: "0.0.0.0"` в Python API).
