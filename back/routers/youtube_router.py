import asyncio
import os
import re
import tempfile
import urllib.parse
from pathlib import Path

import yt_dlp
from fastapi import APIRouter, BackgroundTasks, HTTPException, Query
from fastapi.responses import StreamingResponse


# Роутер для эндпоинтов, связанных с YouTube
youtube_router = APIRouter(prefix="/youtube", tags=["youtube"])

YOUTUBE_EXTRACTOR_ARGS = {"youtube": ["player_client=android,ios,web"]}
STANDARD_HEIGHTS = (144, 240, 360, 480, 720, 1080, 1440, 2160)
MAX_AUDIO_BITRATE = 512
FFMPEG_PATH = Path(__file__).resolve().parent.parent / "bin" / "ffmpeg.exe"
TEMP_DIR = Path(__file__).resolve().parent.parent / "tmp"


def get_filesize(format_data):
    """Возвращает точный или примерный размер формата в байтах."""
    return format_data.get("filesize") or format_data.get("filesize_approx") or 0


def has_video_stream(format_data):
    """Проверяет, что формат содержит видеопоток, а не только аудио."""
    return format_data.get("vcodec") and format_data.get("vcodec") != "none"

def has_audio_stream(format_data):
    """Проверяет, что формат содержит аудиопоток."""
    return format_data.get("acodec") and format_data.get("acodec") != "none"


def get_format_ext(format_data):
    """Возвращает реальное расширение формата."""
    return format_data.get("ext") or "unknown"


def get_audio_score(format_data):
    """Возвращает оценку качества аудио: сначала bitrate, потом размер."""
    return format_data.get("abr") or get_filesize(format_data)


def get_audio_bitrate(format_data):
    """Возвращает реальный audio bitrate формата целым числом."""
    bitrate = format_data.get("abr")
    if not bitrate:
        return None

    return round(bitrate)


def format_audio_quality(bitrate):
    """Превращает bitrate в понятную подпись качества аудио."""
    if bitrate <= 96:
        return "Audio Low"

    if bitrate <= 160:
        return "Audio Medium"

    return "Audio High"


def is_audio_download(height):
    """Проверяет, что пользователь выбрал скачивание только аудио."""
    try:
        value = int(height)
    except (TypeError, ValueError):
        return False

    return value not in STANDARD_HEIGHTS and value <= MAX_AUDIO_BITRATE


def get_audio_download_bitrate(height):
    """Достаёт bitrate из ключа аудио-формата."""
    if not is_audio_download(height):
        return None

    return str(height)


def get_output_ext(height):
    """Возвращает расширение файла после нашей обработки."""
    if is_audio_download(height):
        return "mp3"

    return "mp4"


def get_media_type(height):
    """Возвращает MIME-тип ответа после нашей обработки."""
    if is_audio_download(height):
        return "audio/mpeg"

    return "video/mp4"


def round_height(raw_height):
    """Округляет высоту видео до ближайшего стандартного качества."""
    for height in STANDARD_HEIGHTS:
        if raw_height <= height:
            return height

    return raw_height


def format_filesize(filesize):
    """Превращает размер в байтах в понятную строку для интерфейса."""
    if filesize > 1073741824:
        return f"~{filesize / 1073741824:.1f} GB"
    if filesize > 1048576:
        return f"~{filesize / 1048576:.0f} MB"
    if filesize > 1024:
        return f"~{filesize / 1024:.0f} KB"

    return "~ MB"


def format_duration(duration_sec):
    """Форматирует длительность видео в MM:SS или H:MM:SS."""
    if not duration_sec:
        return "0:00"

    minutes, seconds = divmod(duration_sec, 60)

    if minutes >= 60:
        hours, minutes = divmod(minutes, 60)
        return f"{hours}:{minutes:02d}:{seconds:02d}"

    return f"{minutes}:{seconds:02d}"


def format_views(view_count):
    """Форматирует количество просмотров с пробелами между разрядами."""
    if view_count is None:
        return "нет данных о просмотрах"

    if view_count == 0:
        return "0 просмотров"

    return f"{view_count:,}".replace(",", " ") + " просмотров"


def get_safe_title(info):
    """Очищает название видео от символов, опасных для имени файла."""
    return re.sub(r"[^\w ._\-()]", "", info.get("title", "video")) or "video"


def get_info_ydl_opts():
    """Собирает настройки yt-dlp для получения информации без скачивания."""
    return {
        "quiet": True,
        "no_warnings": True,
        "extractor_args": YOUTUBE_EXTRACTOR_ARGS,
    }


def extract_info(url, ydl_opts, download=False):
    """Запускает yt-dlp и возвращает информацию о видео."""
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        return ydl.extract_info(url, download=download)


def get_video_height_range_filter(height):
    """Собирает фильтр диапазона для цельного видео выбранного качества."""
    height = int(height)
    lower_heights = [standard for standard in STANDARD_HEIGHTS if standard < height]

    if not lower_heights:
        return f"[height<={height}]"

    return f"[height>{max(lower_heights)}][height<={height}]"


def get_download_format(height):
    """Собирает правило выбора формата для скачивания выбранного качества."""
    if is_audio_download(height):
        bitrate = get_audio_download_bitrate(height)
        return f"bestaudio[abr<={bitrate}]/bestaudio"

    height_range_filter = get_video_height_range_filter(height)

    return (
        f"best{height_range_filter}[ext=mp4]/"
        f"bestvideo[height<={height}][ext=mp4]+bestaudio[ext=m4a]/"
        f"bestvideo[height<={height}]+bestaudio/"
        f"best[height<={height}]"
    )


def build_format_list(info):
    """Готовит список качеств, который фронт показывает пользователю."""
    formats_video_by_height = {}
    formats_audio_by_quality = {}

    for format_data in info.get("formats", []):

        if has_video_stream(format_data):
            raw_height = format_data.get("height")
            if not raw_height:
                continue

            height = round_height(raw_height)
            existing = formats_video_by_height.get(height)

            if existing is None or get_filesize(format_data) > get_filesize(existing):
                formats_video_by_height[height] = format_data

        elif has_audio_stream(format_data):
            bitrate = get_audio_bitrate(format_data)
            if bitrate is None:
                continue

            quality = format_audio_quality(bitrate)
            existing = formats_audio_by_quality.get(quality)

            if existing is None or get_audio_score(format_data) > get_audio_score(existing):
                formats_audio_by_quality[quality] = format_data


    res = [
        {
            "height": height,
            "label": f"{height}p",
            "size": format_filesize(get_filesize(formats_video_by_height[height])),
            "ext": get_output_ext(height),
        }
        for height in sorted(formats_video_by_height)
    ]

    for quality, audio_format in sorted(
        formats_audio_by_quality.items(),
        key=lambda item: get_audio_bitrate(item[1]),
    ):
        bitrate = get_audio_bitrate(audio_format)
        res.append({
            "height": bitrate,
            "label": quality,
            "size": format_filesize(get_filesize(audio_format)),
            "ext": "mp3",
        })

    return res


def create_temp_file_path(ext):
    """Создаёт уникальный путь под временный mp4 и освобождает его для yt-dlp."""
    TEMP_DIR.mkdir(parents=True, exist_ok=True)

    tmp_fd, tmp_path = tempfile.mkstemp(suffix=f".{ext}", dir=TEMP_DIR)
    os.close(tmp_fd)
    os.unlink(tmp_path)
    return tmp_path


def create_temp_base_path():
    """Создаёт уникальный временный путь без расширения."""
    TEMP_DIR.mkdir(parents=True, exist_ok=True)

    tmp_fd, tmp_path = tempfile.mkstemp(dir=TEMP_DIR)
    os.close(tmp_fd)
    os.unlink(tmp_path)
    return tmp_path


def remove_if_exists(path):
    """Удаляет файл, если он существует."""
    if os.path.exists(path):
        os.unlink(path)


def build_content_disposition(safe_title, ext):
    """Готовит заголовок Content-Disposition для скачивания файла."""
    safe_ascii = re.sub(r"[^\x00-\x7F]", "_", safe_title) or "video"
    filename_utf8 = urllib.parse.quote(f"{safe_title}.{ext}", safe=".")
    return (
        f'attachment; filename="{safe_ascii}.{ext}"; '
        f"filename*=utf-8''{filename_utf8}"
    )


def iter_file(path):
    """Потоково читает файл для StreamingResponse."""
    with open(path, "rb") as file:
        yield from file


@youtube_router.get("/info")
async def get_video_info(
    url: str = Query(..., description="Ссылка на видео YouTube"),
):
    """
    Получаем информацию о видео:
    название, автор, превью и список готовых форматов (где есть и картинка, и звук!).
    """

    # 1. Настройки нашего помощника yt-dlp
    ydl_opts = get_info_ydl_opts()

    # 2. Аккуратно запрашиваем данные
    try:
        info = await asyncio.to_thread(extract_info, url, ydl_opts)
    except Exception:
        raise HTTPException(
            status_code=400,
            detail="Ой! Не удалось получить данные видео. Проверьте ссылку.",
        )

    # 3. Перебираем все доступные варианты видео
    # 4. Красиво упаковываем результаты для ответа
    formats = build_format_list(info)

    # 5. Конвертируем длительность из секунд в "MM:SS" или "H:MM:SS"
    duration_str = format_duration(info.get("duration", 0))

    # 6. Готовим просмотры с пробелами (1 234 567 просмотров)
    views_str = format_views(info.get("view_count", 0))

    return {
        "title": info.get("title", "Без названия"),
        "duration": duration_str,
        "views": views_str,
        "uploader": info.get("uploader", "Неизвестный автор"),
        "formats": formats,
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

    # 1. Готовим строку формата (сначала готовый mp4, потом склейка видео + аудио)
    format_string = get_download_format(height)
    output_ext = get_output_ext(height)

    # 2. Создаем уникальный временный путь (без создания файла!)
    # mkstemp гарантирует уникальность, но создает пустой файл из коробки.
    # Нам нужно только имя — пустой файл удаляем, чтобы yt-dlp не подумал,
    # что видео уже скачано (он проверяет наличие файла и пропускает загрузку).
    if is_audio_download(height):
        download_path = create_temp_base_path()
        tmp_path = f"{download_path}.{output_ext}"
    else:
        tmp_path = create_temp_file_path(output_ext)
        download_path = tmp_path

    # 3. Функция логирования завершения скачивания в консоль сервера
    # Сам прогресс-бар рисует yt-dlp (quiet=False включает родной компактный индикатор)
    def progress_hook(data):
        if data["status"] == "finished":
            print("  Скачивание завершено, запуск ffmpeg...", flush=True)

    ydl_opts = {
        "format": format_string,
        "outtmpl": download_path,  # Сохраняем прямо в наш временный файл
        "merge_output_format": "mp4",  # Жестко просим сделать mp4
        "ffmpeg_location": str(FFMPEG_PATH),  # Указываем путь к ffmpeg
        # Конвертируем opus звук в aac, чтобы любой плеер воспроизвёл
        "postprocessor_args": {
            "ffmpeg": ["-c:v", "copy", "-c:a", "aac"],
        },
        "progress_hooks": [progress_hook],  # Вывод прогресса в консоль сервера
        "quiet": False,  # False = показывать родной аккуратный прогресс-бар yt-dlp
        "no_warnings": True,
        "extractor_args": YOUTUBE_EXTRACTOR_ARGS,  # Наша "шапка-невидимка"
    }

    # 4. Функция для скачивания, которая за один раз скачает и отдаст информацию
    def fetch_video():
        print(f"Скачивание видео... (качество: {height}p)", flush=True)
        # download=True скачает файл по пути tmp_path и заодно вернёт всю инфу
        if is_audio_download(height):
            bitrate = get_audio_download_bitrate(height)
            ydl_opts.pop("merge_output_format", None)
            ydl_opts.pop("postprocessor_args", None)
            ydl_opts["postprocessors"] = [{
                "key": "FFmpegExtractAudio",
                "preferredcodec": output_ext,
                "preferredquality": bitrate,
            }]

        return extract_info(url, ydl_opts, download=True)

    # 5. Запускаем скачивание в соседнем потоке (чтобы сервер не "зависал" для других)
    try:
        info = await asyncio.to_thread(fetch_video)
    except Exception as error:
        # Если Ютуб выдал ошибку или видео удалено, удаляем пустой файл и жалуемся
        remove_if_exists(tmp_path)
        remove_if_exists(download_path)
        raise HTTPException(
            status_code=400,
            detail=f"Ой! Ошибка загрузки видео: {str(error)}",
        )

    # 6. Планируем уборку (Удаление файла после того, как юзер его скачает)
    # BackgroundTasks сработает ТОЛЬКО после того, как FileResponse полностью отдаст файл
    background_tasks.add_task(remove_if_exists, tmp_path)

    # 7. Получаем название видео для имени файла (извлечено в fetch_video)
    safe_title = get_safe_title(info)

    # 8. Проверяем что файл реально скачался
    if not os.path.exists(tmp_path):
        print(f"  ОШИБКА: файл {tmp_path} не найден!", flush=True)
        raise HTTPException(
            status_code=500,
            detail="Файл не найден после скачивания",
        )

    file_size = os.path.getsize(tmp_path)
    print(f"  Файл готов: {file_size} байт", flush=True)

    # 9. Читаем файл в память и возвращаем как StreamingResponse
    # FileResponse глючит с content-length: 0 на Windows в этой версии
    # Браузер сам покажет прогресс-бар загрузки.
    # Content-Disposition: в filename — только ASCII (latin-1-safe),
    # в filename*= — UTF-8 для кириллицы и других символов (RFC 5987)
    return StreamingResponse(
        iter_file(tmp_path),
        media_type=get_media_type(height),
        headers={"Content-Disposition": build_content_disposition(safe_title, output_ext)},
    )
