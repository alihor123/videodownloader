import os
import re
import tempfile
import time
import urllib.parse
from pathlib import Path

import yt_dlp


# Общие настройки YouTube / yt-dlp
YOUTUBE_EXTRACTOR_ARGS = {"youtube": ["player_client=android,ios,web"]}
STANDARD_HEIGHTS = (144, 240, 360, 480, 720, 1080, 1440, 2160)
MAX_AUDIO_BITRATE = 512
TEMP_FILE_MAX_AGE_SEC = 90 * 60


# Локальные пути проекта
BACK_DIR = Path(__file__).resolve().parent.parent
FFMPEG_PATH = BACK_DIR / "bin" / "ffmpeg.exe"
TEMP_DIR = BACK_DIR / "tmp"


# Проверки и простые значения форматов
def get_filesize(format_data):
    """Возвращает точный или примерный размер формата в байтах."""
    return format_data.get("filesize") or format_data.get("filesize_approx") or 0


def has_video_stream(format_data):
    """Проверяет, что формат содержит видеопоток."""
    return format_data.get("vcodec") and format_data.get("vcodec") != "none"


def has_audio_stream(format_data):
    """Проверяет, что формат содержит аудиопоток."""
    return format_data.get("acodec") and format_data.get("acodec") != "none"


def get_audio_score(format_data):
    """Оценивает качество аудио: сначала bitrate, потом размер."""
    return format_data.get("abr") or get_filesize(format_data)


def get_audio_bitrate(format_data):
    """Возвращает реальный audio bitrate формата целым числом."""
    bitrate = format_data.get("abr")
    if not bitrate:
        return None

    return round(bitrate)


def round_height(raw_height):
    """Округляет высоту видео до ближайшего стандартного качества."""
    for height in STANDARD_HEIGHTS:
        if raw_height <= height:
            return height

    return raw_height


# Подписи для интерфейса
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
    """Форматирует количество просмотров."""
    if view_count is None:
        return "нет данных о просмотрах"

    if view_count == 0:
        return "0 просмотров"

    return f"{view_count:,}".replace(",", " ") + " просмотров"


def format_audio_quality(bitrate):
    """Превращает bitrate в понятную подпись качества аудио."""
    if bitrate <= 96:
        return "Audio Low"

    if bitrate <= 160:
        return "Audio Medium"

    return "Audio High"


def get_safe_title(info):
    """Очищает название видео от символов, опасных для имени файла."""
    return re.sub(r"[^\w ._\-()]", "", info.get("title", "video")) or "video"


# Выбор форматов для скачивания
def is_audio_download(height):
    """Проверяет, что выбран audio bitrate, а не video height."""
    try:
        value = int(height)
    except (TypeError, ValueError):
        return False

    return value not in STANDARD_HEIGHTS and value <= MAX_AUDIO_BITRATE


def get_audio_download_bitrate(height):
    """Возвращает bitrate из выбранного аудио-ключа."""
    if not is_audio_download(height):
        return None

    return str(height)


def get_output_ext(height):
    """Возвращает расширение итогового файла."""
    if is_audio_download(height):
        return "mp3"

    return "mp4"


def get_media_type(height):
    """Возвращает MIME-тип итогового файла."""
    if is_audio_download(height):
        return "audio/mpeg"

    return "video/mp4"


def get_video_height_range_filter(height):
    """Собирает фильтр диапазона для цельного видео выбранного качества."""
    height = int(height)
    lower_heights = [standard for standard in STANDARD_HEIGHTS if standard < height]

    if not lower_heights:
        return f"[height<={height}]"

    return f"[height>{max(lower_heights)}][height<={height}]"


def get_download_format(height):
    """Собирает правило выбора формата для yt-dlp."""
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
    """Готовит список видео- и аудио-качеств для фронта."""
    formats_video_by_height = {}
    formats_audio_by_quality = {}
    max_audio_size = 0

    for format_data in info.get("formats", []):
        if has_video_stream(format_data):
            raw_height = format_data.get("height")
            if not raw_height:
                continue

            height = round_height(raw_height)
            existing = formats_video_by_height.get(height)

            if existing is None or get_filesize(format_data) > get_filesize(existing):
                formats_video_by_height[height] = format_data

        elif has_audio_stream(format_data) and not has_video_stream(format_data):
            if max_audio_size is None or get_filesize(format_data) > max_audio_size:
                max_audio_size = get_filesize(format_data)

            bitrate = get_audio_bitrate(format_data)
            if bitrate is None:
                continue

            quality = format_audio_quality(bitrate)
            existing = formats_audio_by_quality.get(quality)

            if existing is None or get_audio_score(format_data) > get_audio_score(existing):
                formats_audio_by_quality[quality] = format_data

    formats = []
    for height in sorted(formats_video_by_height):
        size = format_filesize(get_filesize(formats_video_by_height[height]))
        fast = True
        if not has_audio_stream(formats_video_by_height[height]):
            size = format_filesize(get_filesize(formats_video_by_height[height]) + max_audio_size)
            fast = False
        formats.append(
            {
                "height": height,
                "label": f"{height}p",
                "size": size,
                "ext": "mp4",
                "fast": fast
            }
            
        )

    for quality, audio_format in sorted(
        formats_audio_by_quality.items(),
        key=lambda item: get_audio_bitrate(item[1]),
    ):
        bitrate = get_audio_bitrate(audio_format)
        formats.append({
            "height": bitrate,
            "label": quality,
            "size": format_filesize(get_filesize(audio_format)),
            "ext": "mp3",
            "fast": False
        })

    return formats


# Настройки и запуск yt-dlp
def get_info_ydl_opts():
    """Собирает настройки yt-dlp для получения информации без скачивания."""
    return {
        "quiet": True,
        "no_warnings": True,
        "extractor_args": YOUTUBE_EXTRACTOR_ARGS,
    }


def get_download_ydl_opts(height, output_ext, download_path, progress_hook):
    """Собирает настройки yt-dlp для скачивания видео или аудио."""
    ydl_opts = {
        "format": get_download_format(height),
        "outtmpl": download_path,
        "ffmpeg_location": str(FFMPEG_PATH),
        "progress_hooks": [progress_hook],
        "quiet": False,
        "no_warnings": True,
        "extractor_args": YOUTUBE_EXTRACTOR_ARGS,
    }

    if is_audio_download(height):
        bitrate = get_audio_download_bitrate(height)
        ydl_opts["postprocessors"] = [{
            "key": "FFmpegExtractAudio",
            "preferredcodec": output_ext,
            "preferredquality": bitrate,
        }]
        return ydl_opts

    ydl_opts["merge_output_format"] = "mp4"
    ydl_opts["postprocessor_args"] = {
        "ffmpeg": ["-c:v", "copy", "-c:a", "aac"],
    }
    return ydl_opts


def extract_info(url, ydl_opts, download=False):
    """Запускает yt-dlp и возвращает информацию о видео."""
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        return ydl.extract_info(url, download=download)


# Временные файлы и HTTP-ответ
def cleanup_old_temp_files(max_age_sec=TEMP_FILE_MAX_AGE_SEC):
    """Удаляет временные файлы, которые явно остались от старых скачиваний."""
    if not TEMP_DIR.exists():
        return

    now = time.time()

    for path in TEMP_DIR.iterdir():
        if not path.is_file():
            continue

        try:
            if now - path.stat().st_mtime > max_age_sec:
                os.unlink(path)
        except OSError:
            pass


def create_temp_file_path(ext):
    """Создаёт уникальный временный путь с расширением."""
    TEMP_DIR.mkdir(parents=True, exist_ok=True)
    cleanup_old_temp_files()

    tmp_fd, tmp_path = tempfile.mkstemp(suffix=f".{ext}", dir=TEMP_DIR)
    os.close(tmp_fd)
    os.unlink(tmp_path)
    return tmp_path


def create_temp_base_path():
    """Создаёт уникальный временный путь без расширения."""
    TEMP_DIR.mkdir(parents=True, exist_ok=True)
    cleanup_old_temp_files()

    tmp_fd, tmp_path = tempfile.mkstemp(dir=TEMP_DIR)
    os.close(tmp_fd)
    os.unlink(tmp_path)
    return tmp_path


def create_download_paths(height, output_ext):
    """Возвращает путь для yt-dlp и путь итогового файла."""
    if is_audio_download(height):
        download_path = create_temp_base_path()
        return download_path, f"{download_path}.{output_ext}"

    tmp_path = create_temp_file_path(output_ext)
    return tmp_path, tmp_path


def remove_if_exists(path):
    """Удаляет файл, если он существует."""
    if os.path.exists(path):
        os.unlink(path)


def build_content_disposition(safe_title, ext):
    """Готовит Content-Disposition с ASCII fallback и UTF-8 filename*."""
    safe_ascii = re.sub(r"[^\x00-\x7F]", "_", safe_title) or "video"
    filename_utf8 = urllib.parse.quote(f"{safe_title}.{ext}", safe=".")
    return (
        f'attachment; filename="{safe_ascii}.{ext}"; '
        f"filename*=utf-8''{filename_utf8}"
    )
