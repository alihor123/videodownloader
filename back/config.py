from pathlib import Path

from pydantic_settings import BaseSettings


BASE_DIR = Path(__file__).resolve().parent


class Settings(BaseSettings):
    database_name: str = "stats.db"
    info_rate_limit_requests: int = 20
    info_rate_limit_period_sec: int = 60
    fast_download_rate_limit_requests: int = 10
    fast_download_rate_limit_period_sec: int = 60
    file_download_rate_limit_requests: int = 5
    file_download_rate_limit_period_sec: int = 30 * 60
    temp_file_max_age_sec: int = 90 * 60

    class Config:
        env_file = BASE_DIR / ".env"
        env_file_encoding = "utf-8"


settings = Settings()
