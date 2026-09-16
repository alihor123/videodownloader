"""Небольшие миграции SQLite без отдельной зависимости ради одной таблицы."""
from datetime import datetime, timezone

from sqlalchemy import text


MIGRATIONS = (
    (
        "20260916_proxy_platform_stats",
        """
        CREATE TABLE proxy_platform_stats (
            proxy_endpoint TEXT NOT NULL,
            platform TEXT NOT NULL,
            info_success_count INTEGER NOT NULL DEFAULT 0,
            download_success_count INTEGER NOT NULL DEFAULT 0,
            info_ip_error_count INTEGER NOT NULL DEFAULT 0,
            download_ip_error_count INTEGER NOT NULL DEFAULT 0,
            last_info_success_at TEXT,
            last_download_success_at TEXT,
            last_ip_error_at TEXT,
            last_ip_error_kind TEXT,
            PRIMARY KEY (proxy_endpoint, platform)
        )
        """,
    ),
)


async def run_migrations(connection) -> None:
    """Применяет каждую миграцию один раз в общей транзакции старта приложения."""
    await connection.execute(text("""
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version TEXT PRIMARY KEY,
            applied_at TEXT NOT NULL
        )
    """))
    applied = {
        row[0]
        for row in (await connection.execute(text("SELECT version FROM schema_migrations"))).all()
    }

    for version, statement in MIGRATIONS:
        if version in applied:
            continue
        await connection.execute(text(statement))
        await connection.execute(
            text("INSERT INTO schema_migrations (version, applied_at) VALUES (:version, :applied_at)"),
            {"version": version, "applied_at": datetime.now(timezone.utc).isoformat()},
        )
