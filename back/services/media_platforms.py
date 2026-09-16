import re
from urllib.parse import urlsplit, urlunsplit


# Один список для проверки ссылок, worker и подсказок на фронте.
PLATFORMS = [
    {"id": "youtube", "name": "YouTube", "domains": ["youtube.com", "youtu.be"]},
    {"id": "rutube", "name": "Rutube", "domains": ["rutube.ru"]},
    {"id": "vk", "name": "VK Видео", "domains": ["vk.com", "vkvideo.ru", "vk.ru"]},
    {"id": "twitter", "name": "X / Twitter", "domains": ["x.com", "twitter.com", "t.co"]},
    {"id": "tiktok", "name": "TikTok", "domains": ["tiktok.com"]},
    {"id": "instagram", "name": "Instagram", "domains": ["instagram.com", "instagr.am"]},
]

# Платформы, которые направляем через IPv6 сервера.
IPV6_PLATFORMS = {"youtube", "instagram"}


def detect_platform(url):
    """Проверяем настоящий hostname: youtube.com.example.org не подходит."""
    try:
        parsed = urlsplit(url)
        host = (parsed.hostname or "").lower().rstrip(".")
        if parsed.scheme not in {"http", "https"} or parsed.username or parsed.password:
            raise ValueError()
        if parsed.port not in {None, 80, 443}:
            raise ValueError()
        for platform in PLATFORMS:
            if any(host == domain or host.endswith("." + domain) for domain in platform["domains"]):
                return platform
    except ValueError:
        pass
    raise ValueError("Вставьте ссылку на видео из поддерживаемой платформы")


def normalize_platform_url(url, platform):
    """Исправляет известные публичные варианты ссылок до передачи в yt-dlp."""
    if platform["id"] != "rutube":
        return url

    parsed = urlsplit(url)
    match = re.fullmatch(r"/shorts/([0-9a-f]{32})/?", parsed.path, flags=re.IGNORECASE)
    if not match:
        return url

    # RutubeIE не распознаёт /shorts/, хотя тот же ролик доступен по /video/<id>/.
    return urlunsplit(parsed._replace(path=f"/video/{match.group(1)}/"))
