# a4loader

Сервис для скачивания публичных видео и аудио по ссылке. Веб-интерфейс показывает доступные форматы, ход загрузки и результат. Сервер обрабатывает скачивание через yt-dlp и FFmpeg.

**[Открыть сервис](https://videoloader.a4dev.ru/)**

## Что умеет сервис

- Получает информацию о ролике и предлагает доступные варианты качества.
- Скачивает видео в MP4 и аудио в MP3.
- Для подходящего формата передаёт видео сразу через сервер. Если это невозможно, готовит файл обычным способом.
- Показывает состояние, прогресс и место задачи в очереди. Скачивание можно отменить.
- Ограничивает число запросов и при необходимости повторяет операцию через другой настроенный прокси.

Поддерживаются публичные ссылки YouTube, Rutube, VK Видео, X/Twitter, TikTok и Instagram. Доступность конкретного ролика зависит от площадки, ссылки и доступа к контенту. Для некоторых ссылок могут понадобиться cookies.

## Структура проекта

В деревьях показаны файлы приложения и настройки. Локальные окружения, собранные файлы и зависимости опущены.

### Backend

```text
back/
├── app.py                 # Запуск FastAPI и подключение API
├── config.py              # Настройки из окружения и .env
├── database.py            # Подключение SQLite и жизненный цикл приложения
├── rate_limiter.py        # Ограничение частоты запросов
├── process_tree.py        # Остановка процессов скачивания и их потомков
├── media/
│   ├── router.py          # HTTP-маршруты получения данных и скачивания
│   ├── schemas.py         # Данные запросов и ответов API
│   ├── tasks.py           # Очереди, состояние, отмена и очистка задач
│   ├── worker.py          # Выполнение операций в отдельном процессе
│   ├── ytdlp.py           # Настройка и вызов yt-dlp
│   ├── formats.py         # Выбор и описание форматов
│   ├── platforms.py       # Определение площадки по ссылке
│   ├── messages.py        # Тексты этапов работы
│   ├── models.py          # Модель истории скачиваний
│   └── statistics.py      # Запись статистики скачиваний
├── proxies/
│   ├── pool.py            # Выбор исходящего IP и повторные попытки
│   ├── models.py          # Модель статистики прокси
│   └── statistics.py      # Учёт результатов работы прокси
├── deployment/            # Обработчик GitHub webhook для автодеплоя
├── deploy/                # Файл службы YouTube PO Token provider
├── cookies/               # Необязательные cookie-файлы
├── tests/                 # Проверки backend
├── .env.example           # Пример настроек
└── requirements.txt       # Зависимости Python
```

### Frontend

```text
front/
├── public/                # Статические файлы и значок сайта
├── src/
│   ├── main.tsx           # Точка входа React
│   ├── RootRouter.tsx     # Маршруты интерфейса
│   ├── pages/MainPage/    # Главная страница, выбор формата и прогресс
│   ├── services/          # Запросы к API и типы данных
│   ├── hooks/             # Общие хуки интерфейса
│   └── assets/            # Шрифты и иконки
├── tests/                 # Проверки интерфейса и контракта API
├── vite.config.js         # Сборка и локальный прокси /api
├── package.json           # Команды и зависимости
└── package-lock.json      # Зафиксированные версии зависимостей
```

Задачи и очереди хранятся в памяти backend. Незавершённые задачи не восстанавливаются после перезапуска процесса. История успешных скачиваний и статистика прокси сохраняются в SQLite.

## Локальный запуск на Windows

Нужны Python, Node.js и FFmpeg. Используйте Node.js 22.12 или новее, поскольку этого требует установленная версия Vite. Команды ниже выполняются в PowerShell из корня репозитория.

### 1. Запустить backend

```powershell
cd back
py -m venv venv
.\venv\Scripts\python.exe -m pip install -r requirements.txt
Copy-Item .env.example .env
```

Откройте `back/.env` и укажите путь к установленному FFmpeg, например `FFMPEG_PATH=C:/ffmpeg/bin/ffmpeg.exe`. Пример настроек рассчитан на Windows. При необходимости укажите пути к cookies и список прокси. Не добавляйте `.env` и cookie-файлы в Git.

```powershell
.\venv\Scripts\python.exe app.py
```

API запустится на `http://localhost:8000`. Документация API по умолчанию выключена. Чтобы открыть `/docs`, задайте в `.env` значение `ENABLE_DOCS=true` и перезапустите backend.

### 2. Запустить frontend

Откройте второй терминал в корне репозитория:

```powershell
cd front
npm.cmd ci
npm.cmd run dev
```

Откройте адрес, который покажет Vite. Во время разработки запросы `/api` перенаправляются на `http://localhost:8000`.

### YouTube PO Token provider

Для части ссылок YouTube нужен отдельный локальный provider. Python-плагин устанавливается вместе с `back/requirements.txt`. Сам provider запустите в третьем терминале:

```powershell
git clone --single-branch --branch 2.0.0 https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git "$env:USERPROFILE\bgutil-ytdlp-pot-provider"
cd "$env:USERPROFILE\bgutil-ytdlp-pot-provider\server"
npm.cmd ci
npx.cmd tsc
node build/main.js --host 127.0.0.1 --port 4416
```

## Развёртывание на Ubuntu/Debian

Ниже описан ручной запуск одного сервера с `systemd`, `nginx` и HTTPS. Встроенный GitHub webhook не нужен для этих шагов и остаётся выключенным. Команды рассчитаны на домен `videoloader.a4dev.ru`. Перед запуском направьте домен на сервер.

### 1. Подготовить систему и получить код

Установите Git, Python, FFmpeg, nginx, Certbot и Node.js 22.12 или новее. Проверьте версии командой `python3 --version`, `node --version` и `npm --version`.

```bash
sudo apt update
sudo apt install -y git python3 python3-venv python3-pip ffmpeg nginx rsync certbot python3-certbot-nginx
sudo mkdir -p /srv/apps/videodownloader
sudo chown "$USER:$USER" /srv/apps/videodownloader
cd /srv/apps/videodownloader
git clone https://github.com/alihor123/videodownloader.git repo
mkdir -p shared/cookies
```

### 2. Установить backend и настроить данные

```bash
cd /srv/apps/videodownloader/repo/back
python3 -m venv venv
venv/bin/python -m pip install -r requirements.txt
cp .env.example .env
```

В `back/.env` измените как минимум следующие значения:

```env
DATABASE_NAME=/srv/apps/videodownloader/shared/stats.db
FFMPEG_PATH=/usr/bin/ffmpeg
TRUST_PROXY_HEADERS=true
DEPLOY_ENABLED=false
```

В `.env.example` пути к cookies и Python для автодеплоя записаны для Windows. Если используете cookies, перенесите их в `/srv/apps/videodownloader/shared/cookies/` и укажите абсолютные пути в соответствующих переменных `*_COOKIES_FILE`. `MEDIA_PROXIES` можно оставить пустым. Файл `.env` храните только на сервере.

Подготовьте каталоги, куда backend будет записывать временные файлы и статистику:

```bash
mkdir -p /srv/apps/videodownloader/repo/back/tmp
sudo chown -R www-data:www-data /srv/apps/videodownloader/repo/back/tmp /srv/apps/videodownloader/shared
sudo chgrp www-data /srv/apps/videodownloader/repo/back/.env
sudo chmod 640 /srv/apps/videodownloader/repo/back/.env
```

### 3. Запустить YouTube PO Token provider

```bash
sudo git clone --single-branch --branch 2.0.0 https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git /opt/bgutil-ytdlp-pot-provider
cd /opt/bgutil-ytdlp-pot-provider/server
sudo npm ci
sudo npx tsc
sudo chown -R www-data:www-data /opt/bgutil-ytdlp-pot-provider
sudo install -m 0644 /srv/apps/videodownloader/repo/back/deploy/bgutil-pot-provider.service /etc/systemd/system/bgutil-pot-provider.service
sudo systemctl daemon-reload
sudo systemctl enable --now bgutil-pot-provider
```

Provider слушает только `127.0.0.1:4416`. Не открывайте этот порт наружу. Проверить запуск можно командой `systemctl status bgutil-pot-provider --no-pager`.

### 4. Запустить backend как службу

Создайте `/etc/systemd/system/videodownloader-backend.service`:

```ini
[Unit]
Description=a4loader backend
Wants=bgutil-pot-provider.service
After=network.target bgutil-pot-provider.service

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
KillMode=control-group

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now videodownloader-backend
systemctl status videodownloader-backend --no-pager
```

### 5. Собрать frontend и настроить nginx

```bash
cd /srv/apps/videodownloader/repo/front
npm ci
npm run build
sudo mkdir -p /var/www/videodownloader
sudo rsync -a --delete dist/ /var/www/videodownloader/
```

Создайте `/etc/nginx/sites-available/videodownloader`:

```nginx
server {
    listen 80;
    server_name videoloader.a4dev.ru;

    root /var/www/videodownloader;
    index index.html;

    location /api/ {
        proxy_pass http://127.0.0.1:8000/api/;
        proxy_http_version 1.1;
        proxy_connect_timeout 300s;
        proxy_send_timeout 300s;
        proxy_read_timeout 300s;
        proxy_buffering off;
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

```bash
sudo ln -sf /etc/nginx/sites-available/videodownloader /etc/nginx/sites-enabled/videodownloader
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d videoloader.a4dev.ru
```

Проверьте, что `https://videoloader.a4dev.ru/` открывается и запросы к `/api/media/` достигают backend. При ошибке `502` посмотрите `systemctl status videodownloader-backend` и `journalctl -u videodownloader-backend -n 100`.

### Обновление установленной версии

```bash
cd /srv/apps/videodownloader/repo
git pull --ff-only origin main
cd back
venv/bin/python -m pip install -r requirements.txt
sudo systemctl restart videodownloader-backend
cd ../front
npm ci
npm run build
sudo rsync -a --delete dist/ /var/www/videodownloader/
```

После обновления проверьте службу и сайт. Изменения `back/.env`, базы данных, cookies и временных файлов при таком обновлении сохраняются.
