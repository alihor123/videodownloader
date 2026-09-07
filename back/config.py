from pathlib import Path

from pydantic import model_validator
from pydantic_settings import BaseSettings


BASE_DIR = Path(__file__).resolve().parent


def resolve_optional_path(path):
    if path and not path.is_absolute():
        return (BASE_DIR / path).resolve()
    return path


class Settings(BaseSettings):
    database_name: str = "stats.db"
    ffmpeg_path: Path = BASE_DIR / "bin" / "ffmpeg.exe"
    youtube_cookies_file: Path | None = BASE_DIR / "youtube_cookies.txt"
    rutube_cookies_file: Path | None = None
    vk_cookies_file: Path | None = None
    twitter_cookies_file: Path | None = None
    tiktok_cookies_file: Path | None = None
    instagram_cookies_file: Path | None = None
    ytdlp_po_token: str | None = None
    enable_docs: bool = False

    info_rate_limit_requests: int = 20
    info_rate_limit_period_sec: int = 60

    fast_download_rate_limit_requests: int = 10
    fast_download_rate_limit_period_sec: int = 60

    file_download_rate_limit_requests: int = 10
    file_download_rate_limit_period_sec: int = 10 * 60

    max_active_file_tasks: int = 5
    temp_file_max_age_sec: int = 90 * 60
    media_client_timeout_sec: int = 90
    media_info_timeout_sec: int = 100
    media_task_timeout_sec: int = 15 * 60
    media_ready_timeout_sec: int = 120
    media_max_bytes: int = 2 * 1024 * 1024 * 1024
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
