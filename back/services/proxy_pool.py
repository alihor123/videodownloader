"""Выбор исходящего IP для задач медиа без хранения секретов в самих задачах."""
from random import shuffle
from time import monotonic

from config import settings


# main означает прямое подключение с IP сервера: у него нет URL прокси.
proxy_urls: dict[str, str | None] = {}
available: list[str] = []
used: list[str] = []
cooldown_until: dict[str, float] = {}


def configure(raw_proxies: str | None = None) -> None:
    """Загружает список из MEDIA_PROXIES и начинает новый перемешанный круг."""
    if raw_proxies is None:
        raw_proxies = settings.media_proxies.get_secret_value() if settings.media_proxies else ""

    proxy_urls.clear()
    proxy_urls["main"] = None

    # В .env прокси разделены запятыми. Пустые элементы и пробелы игнорируем.
    for raw_proxy in raw_proxies.split(","):
        proxy_url = raw_proxy.strip()
        if proxy_url:
            proxy_urls[f"proxy_{len(proxy_urls)}"] = proxy_url

    available.clear()
    used.clear()
    cooldown_until.clear()
    start_new_round()


def restore_cooled_down() -> None:
    """Возвращает IP, у которых закончилось время отдыха."""
    now = monotonic()
    for key, cooldown_end in list(cooldown_until.items()):
        if cooldown_end <= now:
            del cooldown_until[key]


def start_new_round() -> None:
    """Перемешивает все IP, кроме временно заблокированных."""
    restore_cooled_down()
    available[:] = [key for key in proxy_urls if key not in cooldown_until]
    shuffle(available)
    used.clear()


def get_proxy_key() -> str:
    """Берёт следующий IP; после конца списка начинает новый круг."""
    restore_cooled_down()
    if not available:
        start_new_round()

    # Если все IP на cooldown, запасным вариантом остаётся серверный IP.
    if not available:
        return "main"

    key = available.pop()
    used.append(key)
    return key


def get_proxy_url(key: str | None) -> str | None:
    """None для main означает прямой выход с сервера."""
    if key is None:
        return None
    return proxy_urls[key]


def put_on_cooldown(key: str) -> None:
    """Временно исключает IP после сетевой ошибки или антибот-блокировки."""
    cooldown_until[key] = monotonic() + settings.media_proxy_cooldown_sec
    available[:] = [available_key for available_key in available if available_key != key]
    used[:] = [used_key for used_key in used if used_key != key]


def max_proxy_attempts() -> int:
    """Одна задача пробует каждый доступный выход не больше одного раза."""
    return len(proxy_urls)


configure()
