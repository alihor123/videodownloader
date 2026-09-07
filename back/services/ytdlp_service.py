"""Настройки и запуск yt-dlp; форматирование ответа остаётся в media_formats."""
import urllib.parse

import yt_dlp

from config import settings
from services.media_formats import (
    get_audio_download_bitrate,
    get_download_format,
    is_audio_download,
)


YOUTUBE_EXTRACTOR_ARGS = {"youtube": {}}
if settings.ytdlp_po_token:
    YOUTUBE_EXTRACTOR_ARGS["youtube"]["po_token"] = [f"web+{settings.ytdlp_po_token}"]

YDL_COMMON_OPTS = {
    "quiet": True,
    "no_warnings": True,
    "source_address": "0.0.0.0",
    "socket_timeout": 20,
    "retries": 1,
    # Node нужен yt-dlp для YouTube JS challenge (sig/n), особенно с cookies.
    "js_runtimes": {"node": {}},
    "remote_components": ["ejs:github"],
}
if YOUTUBE_EXTRACTOR_ARGS["youtube"]:
    YDL_COMMON_OPTS["extractor_args"] = YOUTUBE_EXTRACTOR_ARGS


def get_info_ydl_opts():
    return YDL_COMMON_OPTS.copy()


def get_download_ydl_opts(height, file_ext, download_path, progress_hook):
    options = {
        **YDL_COMMON_OPTS,
        "quiet": False,
        "format": get_download_format(height),
        "outtmpl": download_path,
        "ffmpeg_location": str(settings.ffmpeg_path),
        "progress_hooks": [progress_hook],
        "postprocessor_hooks": [progress_hook],
    }
    if is_audio_download(height):
        options["postprocessors"] = [{
            "key": "FFmpegExtractAudio",
            "preferredcodec": file_ext,
            "preferredquality": get_audio_download_bitrate(height),
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
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        return ydl.extract_info(get_video_url(url), download=download)
