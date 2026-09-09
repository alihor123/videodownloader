from pathlib import Path

from pydantic import model_validator
from pydantic_settings import BaseSettings


BASE_DIR = Path(__file__).resolve().parent


def resolve_optional_path(path):
    if path and not path.is_absolute():
        return (BASE_DIR / path).resolve()
    return path


class Settings(BaseSettings):
    # Имя файла статистики.
    database_name: str = "stats.db"
    # Путь к ffmpeg.
    ffmpeg_path: Path = BASE_DIR / "bin" / "ffmpeg.exe"
    # Cookie-файл YouTube.
    youtube_cookies_file: Path | None = BASE_DIR / "cookies" / "youtube.txt"
    # Cookie-файл Rutube.
    rutube_cookies_file: Path | None = BASE_DIR / "cookies" / "rutube.txt"
    # Cookie-файл VK.
    vk_cookies_file: Path | None = BASE_DIR / "cookies" / "vk.txt"
    # Cookie-файл X/Twitter.
    twitter_cookies_file: Path | None = BASE_DIR / "cookies" / "twitter.txt"
    # Cookie-файл TikTok.
    tiktok_cookies_file: Path | None = BASE_DIR / "cookies" / "tiktok.txt"
    # Cookie-файл Instagram.
    instagram_cookies_file: Path | None = BASE_DIR / "cookies" / "instagram.txt"
    # YouTube PO token, если настроен.
    ytdlp_po_token: str | None = None
    # Публиковать ли Swagger-документацию.
    enable_docs: bool = False
    # Доверять ли X-Forwarded-For/X-Real-IP от reverse proxy.
    trust_proxy_headers: bool = False

    # Лимит запросов информации на один IP.
    info_rate_limit_requests: int = 20
    # Окно лимита запросов информации в секундах.
    info_rate_limit_period_sec: int = 60
    # Лимит обычных запросов скачивания на один IP.
    file_download_rate_limit_requests: int = 10
    # Окно лимита обычного скачивания в секундах.
    file_download_rate_limit_period_sec: int = 60 * 60
    # Лимит fast-скачиваний на один IP.
    fast_download_rate_limit_requests: int = 10
    # Окно лимита fast-скачиваний в секундах.
    fast_download_rate_limit_period_sec: int = 60 * 60
    # Размер каждой очереди задач.
    info_queue_size: int = 20
    fast_queue_size: int = 20
    file_queue_size: int = 50
    # Число async-воркеров каждой очереди.
    info_worker_count: int = 1
    fast_worker_count: int = 4
    file_worker_count: int = 3
    # Общий предел задач в памяти и предел на один IP.
    max_queue_total: int = 100
    max_queue_per_ip: int = 10
    # Максимальный возраст временных файлов.
    temp_file_max_age_sec: int = 90 * 60
    # Таймаут ожидания клиента.
    media_client_timeout_sec: int = 90
    # Таймаут получения информации.
    media_info_timeout_sec: int = 100
    # Таймаут подготовки файла.
    media_task_timeout_sec: int = 15 * 60
    # Время хранения готового файла.
    media_ready_timeout_sec: int = 120
    # Максимальный размер результата.
    media_max_bytes: int = 2 * 1024 * 1024 * 1024
    # Максимум сохранённых записей задач.
    max_retained_media_tasks: int = 1000

    class Config:
        env_file = BASE_DIR / ".env"
        env_file_encoding = "utf-8"

    @model_validator(mode="after")
    def resolve_paths(self):
        if not self.ffmpeg_path.is_absolute():
            self.ffmpeg_path = (BASE_DIR / self.ffmpeg_path).resolve()
        self.youtube_cookies_file = resolve_optional_path(self.youtube_cookies_file)
        self.rutube_cookies_file = resolve_optional_path(self.rutube_cookies_file)
        self.vk_cookies_file = resolve_optional_path(self.vk_cookies_file)
        self.twitter_cookies_file = resolve_optional_path(self.twitter_cookies_file)
        self.tiktok_cookies_file = resolve_optional_path(self.tiktok_cookies_file)
        self.instagram_cookies_file = resolve_optional_path(self.instagram_cookies_file)

        return self


settings = Settings()
