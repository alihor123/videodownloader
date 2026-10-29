from datetime import datetime, timezone

from sqlalchemy import text

from database import new_session
from proxies.pool import get_proxy_endpoint


async def add_proxy_info_success(proxy_key, platform):
    """Учитывает успешное получение информации через выбранный исходящий IP."""
    await update_proxy_stat(proxy_key, platform, "info_success_count", "last_info_success_at")


async def add_proxy_download_success(proxy_key, platform):
    """Учитывает успешную передачу файла через выбранный исходящий IP."""
    await update_proxy_stat(proxy_key, platform, "download_success_count", "last_download_success_at")


async def add_proxy_ip_error(proxy_key, platform, operation, error_kind):
    """Учитывает IP-ошибку получения информации или скачивания и её причину."""
    if operation == "info":
        await update_proxy_stat(proxy_key, platform, "info_ip_error_count", "last_ip_error_at", error_kind)
    else:
        await update_proxy_stat(proxy_key, platform, "download_ip_error_count", "last_ip_error_at", error_kind)


async def update_proxy_stat(proxy_key, platform, count_column, timestamp_column, error_kind=None):
    """Атомарно обновляет одну строку «прокси + платформа» без логина и пароля."""
    endpoint = get_proxy_endpoint(proxy_key)
    now = datetime.now(timezone.utc).isoformat()
    error_column = ", last_ip_error_kind" if error_kind else ""
    error_value = ", :error_kind" if error_kind else ""
    error_update = ", last_ip_error_kind = excluded.last_ip_error_kind" if error_kind else ""

    statement = text(f"""
        INSERT INTO proxy_platform_stats (
            proxy_endpoint, platform, {count_column}, {timestamp_column}{error_column}
        ) VALUES (
            :endpoint, :platform, 1, :now{error_value}
        ) ON CONFLICT (proxy_endpoint, platform) DO UPDATE SET
            {count_column} = proxy_platform_stats.{count_column} + 1,
            {timestamp_column} = excluded.{timestamp_column}{error_update}
    """)
    async with new_session() as session:
        await session.execute(statement, {
            "endpoint": endpoint,
            "platform": platform,
            "now": now,
            "error_kind": error_kind,
        })
        await session.commit()
