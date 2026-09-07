"""Один процесс на операцию. Общение с backend — JSON-строки через stdin/stdout."""
import json
import sys
import time
from pathlib import Path

from config import settings
from services.media_platforms import detect_platform, normalize_platform_url
from services.youtube_service import (
    build_format_list, extract_info, format_duration, format_views,
    get_download_ydl_opts, get_info_ydl_opts, get_output_ext, get_safe_title,
)

platform_id = None


def emit(kind, **values):
    print(json.dumps({"event": kind, **values}, ensure_ascii=True), flush=True)


class Logger:
    # Не передаём в браузер подписанные CDN-ссылки и содержимое cookies.
    def debug(self, message):
        pass

    def warning(self, message):
        pass

    def error(self, message):
        pass


def get_user_error(error, platform_id):
    """Не отдаём пользователю технические тексты yt-dlp и платформ."""
    reason = str(error).lower()
    if "ip address is blocked" in reason:
        return "Платформа временно заблокировала доступ с IP сервера. Попробуйте позже"
    if platform_id == "instagram" and any(word in reason for word in (
        "isn't available to everyone", "not available to everyone", "certain audiences", "csrf token",
    )):
        return ("Instagram не отдаёт это видео всем зрителям. Оно может быть ограничено "
                "по возрасту или настройкам публикации — сервис скачивает только публично доступные видео")
    if any(word in reason for word in ("login", "sign in", "log in", "authentication")):
        return ("Платформа не отдаёт это видео как публичное. Проверьте, что оно открывается "
                "без ограничений, и попробуйте другую ссылку")
    if "прямые эфиры" in reason:
        return "Прямые эфиры не поддерживаются"
    if "нет доступных форматов" in reason:
        return "Нет доступных форматов для скачивания"
    return "Источник не отдал видео. Попробуйте другую публичную ссылку"


def get_platform_cookie_file(platform_id):
    """Возвращает cookie-файл только той платформы, которую обрабатывает worker."""
    cookie_files = {
        "youtube": settings.youtube_cookies_file,
        "rutube": settings.rutube_cookies_file,
        "vk": settings.vk_cookies_file,
        "twitter": settings.twitter_cookies_file,
        "tiktok": settings.tiktok_cookies_file,
        "instagram": settings.instagram_cookies_file,
    }
    cookie_file = cookie_files.get(platform_id)
    return cookie_file if cookie_file and cookie_file.is_file() else None


def main():
    # Backend сначала закрепляет процесс в группе/Job, затем разрешает работу.
    global platform_id
    payload = json.loads(sys.stdin.readline())
    platform = detect_platform(payload["url"])
    platform_id = platform["id"]
    source_url = normalize_platform_url(payload["url"], platform)
    last_progress = 0

    def progress_hook(data):
        nonlocal last_progress
        status = data.get("status")
        if status == "started":
            emit("progress", stage="decoding_audio" if data.get("postprocessor") == "ExtractAudio" else "merging", progress=99)
        elif status == "downloading" and time.monotonic() - last_progress > 0.3:
            last_progress = time.monotonic()
            total = data.get("total_bytes") or data.get("total_bytes_estimate")
            progress = min(98, round(98 * data.get("downloaded_bytes", 0) / total)) if total else None
            emit("progress", stage="downloading_file", progress=progress)

    if payload["mode"] == "info":
        opts = get_info_ydl_opts()
    else:
        ext = get_output_ext(payload["height"])
        opts = get_download_ydl_opts(payload["height"], ext,
                                     str(Path(payload["directory"]) / "output.%(ext)s"), progress_hook)
        if ext == "mp4":
            # При fallback на WebM UI всё равно обещает MP4: меняем контейнер.
            opts.setdefault("postprocessors", []).append({"key": "FFmpegVideoRemuxer", "preferedformat": "mp4"})
    opts.update({"logger": Logger(), "quiet": True, "noprogress": True,
                 "noplaylist": True, "cachedir": False, "playlistend": 1,
                 "max_filesize": payload["max_bytes"]})
    # YouTube-специфичные настройки не переносим автоматически на другие сайты.
    if platform["id"] != "youtube":
        for key in ("cookiefile", "extractor_args", "remote_components", "js_runtimes"):
            opts.pop(key, None)
    cookie_file = get_platform_cookie_file(platform["id"])
    if cookie_file:
        # CookieJar сохраняет файл при закрытии: используем копию задачи для любой платформы.
        import shutil
        cookie_copy = Path(payload["directory"]) / "cookies.txt"
        shutil.copyfile(cookie_file, cookie_copy)
        opts["cookiefile"] = str(cookie_copy)

    # Отключаем generic extractor и загрузку произвольных URL.
    opts["allowed_extractors"] = ["youtube", "rutube", "rutube:embed", "rutube:movie", "vk",
                                  "twitter", "twitter:shortener", "twitter:card", "twitter:amplify",
                                  "tiktok", "vm\\.tiktok", "instagram"]

    def reject_live(info, *, incomplete=False):
        if info.get("is_live") or info.get("live_status") in {"is_live", "is_upcoming"}:
            from yt_dlp.utils import DownloadCancelled
            raise DownloadCancelled("Прямые эфиры не поддерживаются")

    opts["match_filter"] = reject_live
    from yt_dlp.utils import DownloadError
    try:
        info = extract_info(source_url, opts, download=payload["mode"] == "download")
    except DownloadError:
        if platform["id"] != "twitter":
            raise
        # Публичные посты иногда недоступны гостевому GraphQL, но доступны через embed API.
        opts["extractor_args"] = {"twitter": {"api": ["syndication"]}}
        info = extract_info(source_url, opts, download=payload["mode"] == "download")
    if not info or info.get("_type") in {"playlist", "multi_video"} or info.get("is_live"):
        raise ValueError("Нужна ссылка на отдельное опубликованное видео")
    if payload["mode"] == "info":
        formats = build_format_list(info)
        if not formats:
            raise ValueError("Нет доступных форматов для скачивания")
        # Все загрузки проходят через управляемый worker, включая цельные MP4.
        for item in formats:
            item["fast"] = False
        emit("result", data={"title": info.get("title", "Видео"), "thumbnail": info.get("thumbnail"),
                             "uploader": info.get("uploader") or "Неизвестный автор",
                             "duration": format_duration(info.get("duration", 0)), "views": format_views(info.get("view_count")),
                             "formats": formats, "platform": platform["id"], "platform_name": platform["name"], "url": payload["url"]})
    else:
        directory = Path(payload["directory"])
        candidates = list(directory.glob("output.*"))
        files = [path for path in candidates if path.suffix in {".mp4", ".mp3", ".webm", ".mkv", ".m4a"} and ".f" not in path.stem]
        if len(files) != 1:
            raise ValueError("Готовый файл не найден после обработки")
        emit("result", data={"filename": files[0].name, "title": get_safe_title(info)})


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        emit("error", message=get_user_error(error, platform_id))
        sys.exit(1)
