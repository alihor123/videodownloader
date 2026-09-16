import unittest
from unittest.mock import patch

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


if __name__ == "__main__":
    unittest.main()
