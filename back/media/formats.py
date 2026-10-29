"""Чистые функции для отображения и выбора медиаформатов."""
import re
import urllib.parse


STANDARD_HEIGHTS = (144, 240, 360, 480, 720, 1080, 1440, 2160)
MAX_AUDIO_BITRATE = 512
QUALITY_MARKER_RE = re.compile(r"(?:^|_)(\d{3,4})p(?:_|$)")


def get_filesize(format_data):
    """Возвращает известный или приблизительный размер формата в байтах."""
    return format_data.get("filesize") or format_data.get("filesize_approx") or 0


def has_video_stream(format_data):
    """Проверяет наличие видеодорожки в формате."""
    return format_data.get("vcodec") not in {None, "none"}


def has_audio_stream(format_data):
    """Проверяет наличие аудиодорожки в формате."""
    return format_data.get("acodec") not in {None, "none"}


def is_muxed_format(format_data):
    """Проверяет, что формат содержит одновременно видео и звук."""
    return has_video_stream(format_data) and has_audio_stream(format_data)


def is_fast_direct_format(format_data):
    """Проверяет возможность передать формат с видео и звуком одним HTTP-потоком."""
    return (is_muxed_format(format_data) and format_data.get("url") and
            format_data.get("protocol") in {None, "http", "https"})


def get_fast_format_heights(info):
    """Высоты форматов, которые можно передать браузеру без ffmpeg."""
    return {item["height"] for item in info.get("formats", [])
            if item.get("height") and is_fast_direct_format(item)}


def select_fast_format(info, height):
    """Выбирает цельный формат с точной запрошенной высотой для быстрой передачи.

    Раздельные дорожки не подходят: быстрая передача их не объединяет.
    Если точной высоты нет, возвращает None для обычного скачивания.
    При совпадении высоты предпочитает MP4, затем больший битрейт и размер.
    """
    try:
        requested = int(height)
    except (TypeError, ValueError):
        requested = 720
    candidates = [item for item in info.get("formats", [])
                  if is_fast_direct_format(item) and item.get("height") == requested]
    if not candidates:
        return None

    def preference(item):
        """Задаёт порядок предпочтения по контейнеру, битрейту и размеру файла."""
        # MP4 — наиболее предсказуемый контейнер для скачивания в браузере.
        mp4_penalty = 0 if item.get("ext") == "mp4" else 1
        return (mp4_penalty,
                -(item.get("tbr") or 0), -(get_filesize(item) or 0))

    return min(candidates, key=preference)


def get_audio_bitrate(format_data):
    """Возвращает округлённый битрейт аудио или None, если он неизвестен."""
    bitrate = format_data.get("abr")
    return round(bitrate) if bitrate else None


def get_display_height(format_data):
    """У вертикального ролика качество задаёт короткая сторона, а не высота кадра."""
    for value in (format_data.get("format_note"), format_data.get("format_id")):
        match = QUALITY_MARKER_RE.search(value or "")
        if match:
            return int(match.group(1))
    width = format_data.get("width")
    height = format_data.get("height")
    if width and height:
        return min(width, height)
    return height


def format_filesize(filesize):
    """Формирует приблизительный размер файла с единицами измерения."""
    if not filesize:
        return None
    if filesize > 1024 ** 3:
        return f"~{filesize / 1024 ** 3:.1f} GB"
    if filesize > 1024 ** 2:
        return f"~{filesize / 1024 ** 2:.0f} MB"
    if filesize > 1024:
        return f"~{filesize / 1024:.0f} KB"
    return f"~{filesize} B"


def format_duration(duration_sec):
    """Форматирует длительность как минуты:секунды или часы:минуты:секунды."""
    if not duration_sec:
        return "0:00"
    minutes, seconds = divmod(max(0, int(duration_sec)), 60)
    if minutes >= 60:
        hours, minutes = divmod(minutes, 60)
        return f"{hours}:{minutes:02d}:{seconds:02d}"
    return f"{minutes}:{seconds:02d}"


def format_views(view_count):
    """Форматирует число просмотров с пробелами между разрядами."""
    if view_count is None:
        return "Нет данных"
    return f"{view_count:,}".replace(",", " ")


def format_audio_quality(bitrate):
    """Выбирает подпись качества аудио по его битрейту."""
    if bitrate <= 96:
        return "Audio Low"
    if bitrate <= 160:
        return "Audio Medium"
    return "Audio High"


def get_safe_title(info):
    """Удаляет из названия символы, которые не используются в имени скачиваемого файла."""
    return re.sub(r"[^\w ._\-()]", "", info.get("title", "video")) or "video"


def is_audio_download(height):
    """Распознаёт значение битрейта аудио среди числовых параметров качества."""
    try:
        value = int(height)
    except (TypeError, ValueError):
        return False
    return value not in STANDARD_HEIGHTS and value <= MAX_AUDIO_BITRATE


def get_audio_download_bitrate(height):
    """Возвращает битрейт строкой, если значение соответствует аудиоформату."""
    return str(height) if is_audio_download(height) else None


def get_output_ext(height, kind="video"):
    """Выбирает расширение результата: MP3 для аудио и MP4 для видео."""
    return "mp3" if kind == "audio" else "mp4"


def get_video_height_range_filter(height):
    """Строит фильтр высоты между предыдущим стандартным качеством и выбранным."""
    height = int(height)
    lower_heights = [item for item in STANDARD_HEIGHTS if item < height]
    if not lower_heights:
        return f"[height<={height}]"
    return f"[height>{max(lower_heights)}][height<={height}]"


def get_download_format(height, kind="video"):
    """Формирует селектор yt-dlp с запасными вариантами для выбранного качества."""
    if kind == "audio":
        return f"bestaudio[abr<={height}]/bestaudio"
    height_filter = get_video_height_range_filter(height)
    return (
        f"best{height_filter}[ext=mp4]/"
        f"bestvideo[height<={height}][ext=mp4]+bestaudio[ext=m4a]/"
        f"bestvideo[height<={height}]+bestaudio/"
        f"best[height<={height}]"
    )


def build_format_list(info, extra_fast_heights=()):
    """Собирает варианты видео и аудио для клиента, объединяя одинаковое отображаемое качество."""
    video_by_quality = {}
    fast_by_height = get_fast_format_heights(info) | set(extra_fast_heights)
    audio_by_quality = {}
    max_audio_size = 0

    for format_data in info.get("formats", []):
        if has_video_stream(format_data):
            selector_height = format_data.get("height")
            display_height = get_display_height(format_data)
            if not selector_height or not display_height:
                continue
            # Выбираем один лучший поток на видимое качество: 540p не должен стать вторым 720p.
            previous = video_by_quality.get(display_height)
            if previous is None or (get_filesize(format_data), format_data.get("tbr") or 0) > (
                get_filesize(previous), previous.get("tbr") or 0
            ):
                video_by_quality[display_height] = format_data
        elif has_audio_stream(format_data):
            max_audio_size = max(max_audio_size, get_filesize(format_data))
            bitrate = get_audio_bitrate(format_data)
            if bitrate is None:
                continue
            quality = format_audio_quality(bitrate)
            previous = audio_by_quality.get(quality)
            if previous is None or (format_data.get("abr") or 0, get_filesize(format_data)) > (previous.get("abr") or 0, get_filesize(previous)):
                audio_by_quality[quality] = format_data

    formats = []
    for display_height in sorted(video_by_quality):
        media_format = video_by_quality[display_height]
        selector_height = media_format["height"]
        has_audio = has_audio_stream(media_format)
        size = get_filesize(media_format) + (0 if has_audio else max_audio_size)
        formats.append({"height": selector_height, "kind": "video", "label": f"{display_height}p", "ext": "mp4",
                        "size": format_filesize(size), "fast": selector_height in fast_by_height})

    for quality, media_format in sorted(audio_by_quality.items(), key=lambda item: get_audio_bitrate(item[1])):
        formats.append({"height": get_audio_bitrate(media_format), "kind": "audio", "label": quality, "ext": "mp3",
                        "size": format_filesize(get_filesize(media_format)), "fast": False})
    return formats


def build_content_disposition(safe_title, file_ext):
    """Формирует заголовок скачивания с обычным и UTF-8 именем файла."""
    safe_ascii = re.sub(r"[^\x00-\x7F]", "_", safe_title) or "video"
    filename_utf8 = urllib.parse.quote(f"{safe_title}.{file_ext}", safe=".")
    return f'attachment; filename="{safe_ascii}.{file_ext}"; filename*=utf-8\'\'{filename_utf8}'
