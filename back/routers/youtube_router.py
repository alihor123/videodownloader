from fastapi import APIRouter, Query, HTTPException
from fastapi.responses import StreamingResponse
import yt_dlp
import subprocess
import asyncio
import re
import os


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

    # 6. Возвращаем всё самое нужное
    return {
        'title': info.get('title', 'Без названия'),
        'duration': duration_str,      
        'view_count': info.get('view_count', 0),
        'uploader': info.get('uploader', 'Неизвестный автор'),
        'formats': formats,
    }


@youtube_router.get("/download")
async def download_video(
    url: str = Query(..., description="Ссылка на YouTube видео"),
    height: str = Query(..., description="Высота из списка /info (360, 720, 1080 и т.д.)"),
):
    """
    Скачать видео в выбранном качестве без сохранения на диск.
    yt-dlp выводит данные в stdout, FastAPI читает поток и отправляет на фронт.
    """

    COOKIES_PATH = "cookies.txt"

    # Формируем форматную строку для yt-dlp:
    #   bestvideo[height<=<height>]+bestaudio/best[height<=<height>]
    # Это означает: лучший видео-формат с высотой <= запрошенной
    #                + лучшая аудиодорожка
    #                или лучшее комбинированное видео (если не найдет раздельные)
    format_string = f"bestvideo[height<={height}]+bestaudio/best[height<={height}]"

    # Формируем команду:
    cmd = [
        "yt-dlp",
        "-f", format_string,
        "-o", "-",
        "--no-part",
        "--merge-output-format", "mp4",
    ]

    if os.path.exists(COOKIES_PATH):
        cmd.extend(["--cookies", COOKIES_PATH])

    cmd.append(url)

    try:
        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError:
        raise HTTPException(status_code=500, detail="yt-dlp не найден. Установите: pip install yt-dlp")

    ext = "mp4"
    media_type = "video/mp4"

    # async-генератор: читает stdout процесса по кускам и отдаёт наружу
    async def generate():
        while True:
            chunk = await process.stdout.read(65536)
            if not chunk:
                break
            yield chunk

        await process.wait()

        if process.returncode != 0:
            stderr_data = await process.stderr.read()
            error_text = stderr_data.decode("utf-8", errors="ignore")
            print(f"yt-dlp error: {error_text}")

    return StreamingResponse(
        generate(),
        media_type=media_type,
        headers={
            "Content-Disposition": f'attachment; filename="video.{ext}"',
        },
    )
