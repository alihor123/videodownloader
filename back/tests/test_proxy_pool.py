import unittest
from unittest.mock import patch

from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from database import db_tools
from database.database import Base
from services import proxy_pool


class ProxyPoolTest(unittest.TestCase):
    def tearDown(self):
        proxy_pool.configure("")

    def test_main_and_env_proxies_are_configured_without_duplicate_objects(self):
        proxy_pool.configure("socks5://first,socks5://second")

        self.assertEqual(proxy_pool.proxy_urls, {
            "main": None,
            "proxy_1": "socks5://first",
            "proxy_2": "socks5://second",
        })

    def test_cooldown_removes_proxy_from_current_round(self):
        proxy_pool.configure("socks5://first")
        proxy_pool.available[:] = ["proxy_1", "main"]

        proxy_pool.put_on_cooldown("proxy_1")

        self.assertNotIn("proxy_1", proxy_pool.available)
        self.assertIn("proxy_1", proxy_pool.cooldown_until)

    def test_cooled_down_proxy_returns_in_next_round(self):
        proxy_pool.configure("socks5://first")
        with patch("services.proxy_pool.monotonic", return_value=100):
            proxy_pool.put_on_cooldown("proxy_1")
        with patch("services.proxy_pool.monotonic", return_value=100 + proxy_pool.settings.media_proxy_cooldown_sec):
            proxy_pool.start_new_round()

        self.assertIn("proxy_1", proxy_pool.available)

    def test_main_is_used_when_every_ip_is_in_cooldown(self):
        proxy_pool.configure("socks5://first")
        proxy_pool.put_on_cooldown("main")
        proxy_pool.put_on_cooldown("proxy_1")

        self.assertEqual(proxy_pool.get_proxy_key(), "main")


class ProxyStatsTest(unittest.IsolatedAsyncioTestCase):
    async def test_clean_database_creates_and_updates_proxy_statistics(self):
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        session_factory = async_sessionmaker(engine, expire_on_commit=False)
        try:
            async with engine.begin() as connection:
                await connection.run_sync(Base.metadata.create_all)
            with patch.object(db_tools, "new_session", session_factory), \
                 patch.object(db_tools, "get_proxy_endpoint", return_value="socks5://68.209.58.216:8000"):
                await db_tools.add_proxy_info_success("proxy_1", "youtube")
                await db_tools.add_proxy_download_success("proxy_1", "youtube")
                await db_tools.add_proxy_ip_error("proxy_1", "youtube", "download", "http_429")
            async with session_factory() as session:
                row = (await session.execute(text("""
                    SELECT info_success_count, download_success_count, download_ip_error_count, last_ip_error_kind
                    FROM proxy_platform_stats
                """))).one()
        finally:
            await engine.dispose()

        self.assertEqual(row, (1, 1, 1, "http_429"))


if __name__ == "__main__":
    unittest.main()
