import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from database import db_tools
from database.migrations import run_migrations
from services import proxy_pool


class ProxyStatsMigrationTest(unittest.IsolatedAsyncioTestCase):
    async def test_migration_creates_stats_table_once(self):
        with tempfile.TemporaryDirectory() as directory:
            database_path = Path(directory) / "stats.db"
            engine = create_async_engine(f"sqlite+aiosqlite:///{database_path}")
            try:
                async with engine.begin() as connection:
                    await run_migrations(connection)
                async with engine.begin() as connection:
                    await run_migrations(connection)
                    tables = (await connection.execute(text("""
                        SELECT name FROM sqlite_master
                        WHERE type = 'table' AND name IN ('schema_migrations', 'proxy_platform_stats')
                    """))).scalars().all()
                    migrations = (await connection.execute(text("SELECT version FROM schema_migrations"))).scalars().all()
            finally:
                await engine.dispose()

        self.assertEqual(set(tables), {"schema_migrations", "proxy_platform_stats"})
        self.assertEqual(migrations, ["20260916_proxy_platform_stats"])

    async def test_statistics_are_aggregated_by_proxy_and_platform(self):
        with tempfile.TemporaryDirectory() as directory:
            engine = create_async_engine(f"sqlite+aiosqlite:///{Path(directory) / 'stats.db'}")
            session_factory = async_sessionmaker(engine, expire_on_commit=False)
            try:
                async with engine.begin() as connection:
                    await run_migrations(connection)
                with patch.object(db_tools, "new_session", session_factory), \
                     patch.object(db_tools, "get_proxy_endpoint", return_value="socks5://68.209.58.216:8000"):
                    await db_tools.add_proxy_info_success("proxy_1", "youtube")
                    await db_tools.add_proxy_info_success("proxy_1", "youtube")
                    await db_tools.add_proxy_download_success("proxy_1", "youtube")
                    await db_tools.add_proxy_ip_error("proxy_1", "youtube", "download", "http_429")
                async with session_factory() as session:
                    row = (await session.execute(text("""
                        SELECT info_success_count, download_success_count,
                               info_ip_error_count, download_ip_error_count, last_ip_error_kind
                        FROM proxy_platform_stats
                    """))).one()
            finally:
                await engine.dispose()

        self.assertEqual(row, (2, 1, 0, 1, "http_429"))


class ProxyEndpointTest(unittest.TestCase):
    def tearDown(self):
        proxy_pool.configure("")

    def test_statistics_endpoint_hides_proxy_credentials(self):
        proxy_pool.configure("socks5://login:password@68.209.58.216:8000")

        self.assertEqual(proxy_pool.get_proxy_endpoint("proxy_1"), "socks5://68.209.58.216:8000")
        self.assertEqual(proxy_pool.get_proxy_endpoint("main"), "main")


if __name__ == "__main__":
    unittest.main()
