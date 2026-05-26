from pathlib import Path

from pydantic import model_validator
from pydantic_settings import BaseSettings


BASE_DIR = Path(__file__).resolve().parent


class Settings(BaseSettings):
    database_name: str = "stats.db"
    ffmpeg_path: Path = BASE_DIR / "bin" / "ffmpeg.exe"
    ytdlp_cookies_file: Path | None = None
    enable_docs: bool = False

    info_rate_limit_requests: int = 20
    info_rate_limit_period_sec: int = 60

    fast_download_rate_limit_requests: int = 10
    fast_download_rate_limit_period_sec: int = 60

    file_download_rate_limit_requests: int = 10
    file_download_rate_limit_period_sec: int = 10 * 60

    max_active_file_tasks: int = 5
    temp_file_max_age_sec: int = 90 * 60

    class Config:
        env_file = BASE_DIR / ".env"
        env_file_encoding = "utf-8"

    @model_validator(mode="after")
    def resolve_paths(self):
        if not self.ffmpeg_path.is_absolute():
            self.ffmpeg_path = (BASE_DIR / self.ffmpeg_path).resolve()
        if self.ytdlp_cookies_file and not self.ytdlp_cookies_file.is_absolute():
            self.ytdlp_cookies_file = (BASE_DIR / self.ytdlp_cookies_file).resolve()

        return self


settings = Settings()
