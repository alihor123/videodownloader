from fastapi import APIRouter, Query, HTTPException, BackgroundTasks
from fastapi.responses import FileResponse
import yt_dlp
import os
import tempfile
import asyncio
import re


# Роутер для эндпоинтов, связанных с YouTube
youtube_router = APIRouter(prefix="/youtube", tags=["youtube"])


@youtube_router.get("/info")
async def get_video_info(url: str = Query(..., description="Ссылка на видео YouTube")):
    """
    Получаем информацию о видео:
    название, автор, превью и список готовых форматов (где есть и картинка, и звук!).
    """
    
    # 1. Настройки нашего помощника yt-dlp
    ydl_opts = {
        'quiet': True,
        'no_warnings': True,
        'extractor_args': {
            # Притворяемся мобильным приложением, чтобы YouTube пустил нас без ошибок
            'youtube':['player_client=android,ios,web'] 
        }
    }

    # 2. Аккуратно запрашиваем данные
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception as e:
        raise HTTPException(status_code=400, detail="Ой! Не удалось получить данные видео. Проверьте ссылку.")

    formats_dict = {}

    # 3. Перебираем все доступные варианты видео
    for f in info.get('formats',[]):
        
        # Проверяем наличие картинки. Звук может быть отдельным потоком — его игнорируем
        has_video = f.get('vcodec') and f.get('vcodec') != 'none'
        
        # Если картинки нет — пропускаем (аудиодорожки нам не нужны)
        if not has_video:
            continue

        # Берем высоту видео (например, 720). Это намного проще, чем резать строку "1920x1080"
        raw_height = f.get('height')
        if not raw_height:
            continue

        # Округляем до ближайшего стандартного разрешения
        if raw_height <= 144:
            rounded = 144
        elif raw_height <= 240:
            rounded = 240
        elif raw_height <= 360:
            rounded = 360
        elif raw_height <= 480:
            rounded = 480
        elif raw_height <= 720:
            rounded = 720
        elif raw_height <= 1080:
            rounded = 1080
        elif raw_height <= 1440:
            rounded = 1440
        else:
            rounded = 2160

        # Узнаём примерный или точный вес файла
        size = f.get('filesize') or f.get('filesize_approx') or 0

        # Для каждого качества храним лучший по размеру
        existing = formats_dict.get(rounded)
        if existing is None or size > (existing.get('filesize') or existing.get('filesize_approx') or 0):
            formats_dict[rounded] = f

    # 4. Красиво упаковываем результаты для ответа
    formats =[]
    
    # Сортируем качества по возрастанию (сначала 360p, потом 720p)
    for height in sorted(formats_dict.keys()):
        f = formats_dict[height]
        
        # Превращаем байты в понятные мегабайты
        filesize = f.get('filesize') or f.get('filesize_approx') or 0
        if filesize > 1073741824:
            size_str = f"{filesize / 1073741824:.1f} GB"
        elif filesize > 1048576:
            size_str = f"{filesize / 1048576:.0f} MB"
        elif filesize > 1024:
            size_str = f"{filesize / 1024:.0f} KB"
        else:
            size_str = "~ MB" # На случай, если размер спрятан

        formats.append({
            'height': height,          # Число (360, 720, 1080) — отправляется в /download
            'label': f"{height}p",     # Красивая надпись для пользователя (например, "720p")
            'size': size_str,          # Удобный размер (например, "45 MB")
            'ext': 'mp4',               # Всегда mp4 — merge-output-format принудительно конвертирует
        })

    # 5. Конвертируем длительность из секунд в "MM:SS" или "H:MM:SS"
    duration_sec = info.get('duration', 0)
    if duration_sec:
        minutes = duration_sec // 60
        seconds = duration_sec % 60
        if minutes >= 60:
            hours = minutes // 60
            minutes = minutes % 60
            duration_str = f"{hours}:{minutes:02d}:{seconds:02d}"
        else:
            duration_str = f"{minutes}:{seconds:02d}"
    else:
        duration_str = "0:00"

    # 6. Готовим просмотры с пробелами (1 234 567 просмотров)
    raw_views = info.get('view_count', 0)
    if raw_views:
        views_str = f"{raw_views:,}".replace(',', ' ') + " просмотров"
    else:
        views_str = ""

    # 7. Возвращаем всё самое нужное
    return {
        'title': info.get('title', 'Без названия'),
        'duration': duration_str,
        'views': views_str,
        'uploader': info.get('uploader', 'Неизвестный автор'),
        'formats': formats,
    }


@youtube_router.get("/download")
async def download_video(
    background_tasks: BackgroundTasks,
    url: str = Query(..., description="Ссылка на YouTube видео"),
    height: str = Query(..., description="Высота из списка /info (360, 720, 1080)"),
):
    """
    Скачивает видео на сервер, аккуратно склеивает в идеальный .mp4
    и отдаёт пользователю. После этого сервер сам убирает за собой мусор!
    """

    # 1. Готовим строку формата (лучшее видео <= height + лучший звук)
    format_string = f"bestvideo[height<={height}]+bestaudio/best[height<={height}]"

    # 2. Создаем уникальный временный файл. 
    # mkstemp гарантирует, что имена файлов не совпадут, даже если 100 человек качают одновременно!
    tmp_fd, tmp_path = tempfile.mkstemp(suffix=".mp4")
    os.close(tmp_fd)  # Закрываем системный замок, чтобы yt-dlp мог писать в этот файл

    # 3. Настройки yt-dlp
    ydl_opts = {
        'format': format_string,
        'outtmpl': tmp_path,             # Сохраняем прямо в наш временный файл
        'merge_output_format': 'mp4',    # Жестко просим сделать mp4
        'quiet': True,
        'no_warnings': True,
        'extractor_args': {
            'youtube': ['player_client=android,ios,web'] # Наша "шапка-невидимка"
        },
    }

    # 4. Функция для скачивания, которая за один раз скачает и отдаст информацию
    def fetch_video():
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            # download=True скачает файл по пути tmp_path и заодно вернёт всю инфу
            return ydl.extract_info(url, download=True)

    # 5. Запускаем скачивание в соседнем потоке (чтобы сервер не "зависал" для других)
    try:
        info = await asyncio.to_thread(fetch_video)
    except Exception as e:
        # Если Ютуб выдал ошибку или видео удалено, удаляем пустой файл и жалуемся
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)
        raise HTTPException(status_code=400, detail=f"Ой! Ошибка загрузки видео: {str(e)}")

    # 6. Планируем уборку (Удаление файла после того, как юзер его скачает)
    def cleanup(path: str):
        if os.path.exists(path):
            os.unlink(path)

    # BackgroundTasks сработает ТОЛЬКО после того, как FileResponse полностью отдаст файл
    background_tasks.add_task(cleanup, tmp_path)

    # 7. Достаем название видео из полученной информации (больше не делаем второй запрос!)
    raw_title = info.get('title', 'video')
    # Убираем все запрещённые символы, чтобы файловая система не ругалась
    safe_title = re.sub(r'[^a-zA-Zа-яА-ЯёЁ0-9 ._\-()]', '_', raw_title)

    # 8. Отдаем готовый файл юзеру!
    return FileResponse(
        path=tmp_path,
        media_type="video/mp4",
        filename=f"{safe_title}.mp4",
    )
