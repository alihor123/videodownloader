"""Настройки и запуск yt-dlp; форматирование ответа остаётся в media.formats."""
import urllib.parse

import yt_dlp

from config import settings
from media.formats import (
    get_download_format,
)


YDL_COMMON_OPTS = {
    "quiet": True,
    "no_warnings": True,
    "socket_timeout": 20,
    "retries": 1,
    # Node запускает EJS из зависимости yt-dlp[default].
    "js_runtimes": {"node": {}},
    "extractor_args": {"youtube": {"player_client": ["mweb"]}},
}


def get_info_ydl_opts():
    """Возвращает копию общих настроек yt-dlp для получения информации о видео."""
    return YDL_COMMON_OPTS.copy()


def get_download_ydl_opts(height, file_ext, download_path, progress_hook, kind="video"):
    """Собирает настройки скачивания, обработки файла и уведомлений о прогрессе."""
    options = {
        **YDL_COMMON_OPTS,
        "quiet": False,
        "format": get_download_format(height, kind),
        "outtmpl": download_path,
        "ffmpeg_location": str(settings.ffmpeg_path),
        "progress_hooks": [progress_hook],
        "postprocessor_hooks": [progress_hook],
    }
    if kind == "audio":
        options["postprocessors"] = [{
            "key": "FFmpegExtractAudio",
            "preferredcodec": file_ext,
            "preferredquality": str(height),
        }]
    else:
        options["merge_output_format"] = "mp4"
        options["postprocessor_args"] = {"ffmpeg": ["-c:v", "copy", "-c:a", "aac"]}
    return options


def get_video_url(url):
    """Убирает playlist из YouTube-ссылки, когда в ней уже указан ролик."""
    parsed_url = urllib.parse.urlsplit(url)
    query = urllib.parse.parse_qsl(parsed_url.query, keep_blank_values=True)
    if not any(key == "v" and value for key, value in query):
        return url
    query = [(key, value) for key, value in query if key != "list"]
    return urllib.parse.urlunsplit(parsed_url._replace(query=urllib.parse.urlencode(query)))


def extract_info(url, ydl_opts, download=False):
    """Запускает yt-dlp для одного видео с выбранными настройками и режимом скачивания."""
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        return ydl.extract_info(get_video_url(url), download=download)
