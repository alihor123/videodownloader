import asyncio
import ctypes
import os
import signal
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import httpx
from fastapi import HTTPException

from app import app
from config import BASE_DIR, settings
from routers.media_router import InfoRequest, ManagedFileResponse, get_info
from services import media_download_task_service as manager
from services.media_platforms import detect_platform, normalize_platform_url
from services.youtube_service import format_duration, format_filesize
from services import process_tree
from services.media_worker import get_platform_cookie_file, get_user_error


async def wait_for_condition(condition, timeout):
    """Совместимо с Python 3.10, где ещё нет asyncio.timeout."""
    deadline = asyncio.get_running_loop().time() + timeout
    while not condition():
        if asyncio.get_running_loop().time() >= deadline:
            raise TimeoutError("Condition was not met in time")
        await asyncio.sleep(0.05)


def process_alive(pid):
    if os.name == "nt":
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.restype = ctypes.c_void_p
        kernel.GetExitCodeProcess.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        kernel.CloseHandle.argtypes = [ctypes.c_void_p]
        handle = kernel.OpenProcess(0x1000, False, pid)
        if not handle:
            return False
        code = ctypes.c_ulong()
        kernel.GetExitCodeProcess(handle, ctypes.byref(code))
        kernel.CloseHandle(handle)
        return code.value == 259
    try:
        # В Linux zombie уже не работает, но PID ждёт reap родителем/init.
        stat = Path(f"/proc/{pid}/stat")
        if stat.exists() and stat.read_text().split()[2] == "Z":
            return False
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


class PlatformsTest(unittest.TestCase):
    def test_fractional_duration_from_twitter(self):
        self.assertEqual(format_duration(12.85), "0:12")
        self.assertEqual(format_duration(3661.5), "1:01:01")

    def test_unknown_filesize_is_not_shown_as_a_fake_size(self):
        self.assertIsNone(format_filesize(0))

    def test_rutube_shorts_is_normalized_for_rutube_extractor(self):
        url = "https://rutube.ru/shorts/2f18c8153e2b589a2f895e81b400137e/"
        self.assertEqual(
            normalize_platform_url(url, detect_platform(url)),
            "https://rutube.ru/video/2f18c8153e2b589a2f895e81b400137e/",
        )

    def test_instagram_audience_restriction_has_a_clear_message(self):
        message = get_user_error(
            Exception("This content isn't available to everyone: It can't be seen by certain audiences."),
            "instagram",
        )
        self.assertIn("ограничено по возрасту", message)

    def test_each_platform_uses_only_its_own_cookie_file(self):
        with tempfile.TemporaryDirectory() as directory:
            instagram_cookie = Path(directory) / "instagram.txt"
            instagram_cookie.write_text("cookie", encoding="utf-8")
            with patch.object(settings, "instagram_cookies_file", instagram_cookie), \
                 patch.object(settings, "youtube_cookies_file", Path(directory) / "youtube.txt"):
                self.assertEqual(get_platform_cookie_file("instagram"), instagram_cookie)
                self.assertIsNone(get_platform_cookie_file("youtube"))

    def test_domains_and_short_links(self):
        examples = {"https://youtu.be/a": "youtube", "https://www.youtube.com/shorts/a": "youtube",
                    "https://rutube.ru/video/a": "rutube", "https://vkvideo.ru/video-1_2": "vk",
                    "https://m.vk.com/clip-1_2": "vk", "https://x.com/a/status/1": "twitter",
                    "https://t.co/abc": "twitter", "https://vm.tiktok.com/abc": "tiktok",
                    "https://www.instagram.com/reel/a/": "instagram"}
        for url, platform in examples.items():
            with self.subTest(url=url):
                self.assertEqual(detect_platform(url)["id"], platform)

    def test_rejects_unsupported_hosts_and_credentials(self):
        for url in ["file:///etc/passwd", "http://127.0.0.1", "https://youtube.com.evil.test/a",
                    "https://youtube.com@localhost/a", "https://youtube.com:8000/a", "not a url"]:
            with self.subTest(url=url), self.assertRaises(ValueError):
                detect_platform(url)


class CancellationTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="media-tests-")
        self.root_patch = patch.object(manager, "TASK_ROOT", Path(self.temp.name) / "tasks")
        self.root_patch.start()
        original = asyncio.create_subprocess_exec

        async def fixture_process(*args, **kwargs):
            return await original(args[0], "-u", "-m", "tests.worker_fixture", **kwargs)

        self.process_patch = patch.object(manager.asyncio, "create_subprocess_exec", fixture_process)
        self.process_patch.start()
        self.child_pids = []

    async def asyncTearDown(self):
        await asyncio.gather(*(manager.cancel_task(task.id) for task in list(manager.TASKS.values())))
        manager.TASKS.clear()
        self.process_patch.stop()
        self.root_patch.stop()
        self.temp.cleanup()
        for pid in self.child_pids:
            self.assertFalse(process_alive(pid), f"Child {pid} survived cleanup")

    async def running_task(self, name="download", mode="download"):
        task = manager.create_task(f"https://youtube.com/watch?v={name}", mode=mode)
        await wait_for_condition(lambda: (task.directory / "child.pid").exists() or task.runner.done(), 15)
        if task.runner.done():
            self.fail(task.error)
        # Ждём запись PID целиком.
        await wait_for_condition(lambda: bool((task.directory / "child.pid").read_text()), 15)
        content = (task.directory / "child.pid").read_text()
        pid = int(content)
        self.child_pids.append(pid)
        return task, pid

    async def test_cancel_download_kills_child_and_removes_partial_files(self):
        task, child = await self.running_task()
        self.assertTrue(process_alive(child))
        await asyncio.wait_for(manager.cancel_task(task.id), 5)
        self.assertEqual(task.status, "cancelled")
        self.assertFalse(process_alive(child))
        self.assertFalse(task.directory.exists())

    async def test_cancel_real_ffmpeg(self):
        if not settings.ffmpeg_path.exists():
            self.skipTest("ffmpeg binary unavailable")
        task, child = await self.running_task("conversion")
        self.assertTrue(process_alive(child))
        await asyncio.wait_for(manager.cancel_task(task.id), 5)
        self.assertFalse(process_alive(child))
        self.assertFalse(task.directory.exists())

    async def test_info_worker_is_also_cancelled(self):
        task, child = await self.running_task(mode="info")
        await manager.cancel_task(task.id)
        self.assertFalse(process_alive(child))

    async def test_info_post_returns_result_once_and_cleans_task(self):
        task_id = str(uuid4())
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            result = await client.post("/api/media/info", json={"url": "https://youtu.be/ready", "task_id": task_id})
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json()["filename"], "output.mp4")
        self.assertNotIn(task_id.replace("-", ""), manager.TASKS)

    async def test_info_disconnect_cancels_worker_tree(self):
        class DisconnectingRequest:
            disconnected = False

            async def is_disconnected(self):
                return self.disconnected

        request = DisconnectingRequest()
        task_id = str(uuid4())
        response = asyncio.create_task(get_info(
            InfoRequest(url="https://youtu.be/disconnect", task_id=task_id), request, "test",
        ))
        normalized_id = task_id.replace("-", "")
        await wait_for_condition(lambda: normalized_id in manager.TASKS and
                                 (manager.TASKS[normalized_id].directory / "child.pid").exists(), 15)
        task = manager.TASKS[normalized_id]
        child = int((task.directory / "child.pid").read_text())
        self.child_pids.append(child)
        request.disconnected = True
        with self.assertRaises(HTTPException) as error:
            await response
        self.assertEqual(error.exception.status_code, 499)
        self.assertFalse(process_alive(child))
        self.assertFalse(task.directory.exists())

    async def test_cancel_before_create_cannot_resurrect_task(self):
        task_id = str(uuid4())
        await manager.cancel_task(task_id)
        task = manager.create_task("https://youtu.be/a", task_id=task_id)
        self.assertEqual(task.status, "cancelled")
        self.assertIsNone(task.runner)
        self.assertFalse(task.directory.exists())

    async def test_cancel_immediately_after_create(self):
        task = manager.create_task("https://youtu.be/a")
        await manager.cancel_task(task.id)
        self.assertTrue(task.runner.done())
        self.assertFalse(task.directory.exists())

    async def test_cancel_one_task_keeps_other_running(self):
        first, first_pid = await self.running_task()
        second, second_pid = await self.running_task()
        await manager.cancel_task(first.id)
        self.assertFalse(process_alive(first_pid))
        self.assertTrue(process_alive(second_pid))
        self.assertEqual(second.status, "running")

    async def test_timeout_stops_entire_tree(self):
        with patch.object(settings, "media_task_timeout_sec", 1):
            task, child = await self.running_task()
            await asyncio.wait_for(task.runner, 5)
        self.assertEqual(task.status, "failed")
        self.assertFalse(process_alive(child))
        self.assertFalse(task.directory.exists())

    async def test_missing_heartbeat_stops_task(self):
        task, child = await self.running_task()
        task.touched -= settings.media_client_timeout_sec + 1
        reaper = asyncio.create_task(manager.reap_tasks())
        try:
            await wait_for_condition(lambda: task.status == "cancelled", 6)
            self.assertFalse(process_alive(child))
        finally:
            reaper.cancel()
            await asyncio.gather(reaper, return_exceptions=True)

    async def test_ready_also_reaps_descendants(self):
        task, child = await self.running_task("ready")
        await asyncio.wait_for(task.runner, 5)
        self.assertEqual(task.status, "ready")
        self.assertFalse(process_alive(child))
        self.assertTrue((task.directory / "output.mp4").exists())

    async def test_cancel_blocked_http_transfer_closes_file(self):
        task, _ = await self.running_task("ready")
        await task.runner
        response = ManagedFileResponse(task, task.directory / "output.mp4")
        started = asyncio.Event()

        async def send(message):
            if message["type"] == "http.response.body":
                started.set()
                await asyncio.Event().wait()  # Медленный/отключившийся клиент.

        sending = asyncio.create_task(response({"type": "http", "asgi": {"spec_version": "2.4"}}, AsyncMock(), send))
        await asyncio.wait_for(started.wait(), 5)
        await asyncio.wait_for(manager.cancel_task(task.id), 5)
        await sending
        self.assertEqual(task.status, "cancelled")
        self.assertTrue(task.transfer_done.is_set())
        self.assertFalse(task.directory.exists())

    async def test_limits_apply_before_spawn(self):
        task, _ = await self.running_task()
        with patch.object(settings, "max_active_file_tasks", 1):
            with self.assertRaises(Exception) as error:
                manager.create_task("https://youtu.be/other")
        self.assertEqual(error.exception.status_code, 503)
        self.assertEqual(task.status, "running")

    async def test_successful_transfer_cleans_file_and_records_stat(self):
        task, _ = await self.running_task("ready")
        await task.runner
        response = ManagedFileResponse(task, task.directory / "output.mp4")
        body = bytearray()

        async def send(message):
            body.extend(message.get("body", b""))

        with patch("routers.media_router.add_download_stat", new_callable=AsyncMock) as stats:
            await response({"type": "http", "asgi": {"spec_version": "2.4"}}, AsyncMock(), send)
            stats.assert_awaited_once()
        self.assertEqual(len(body), 500000)
        self.assertEqual(task.status, "completed")
        self.assertFalse(task.directory.exists())

    async def test_browser_disconnect_cleans_file(self):
        from starlette.requests import ClientDisconnect
        task, _ = await self.running_task("ready")
        await task.runner
        response = ManagedFileResponse(task, task.directory / "output.mp4")

        async def send(message):
            if message["type"] == "http.response.body":
                raise OSError("Client disconnected")

        with self.assertRaises(ClientDisconnect):
            await response({"type": "http", "asgi": {"spec_version": "2.4"}}, AsyncMock(), send)
        self.assertEqual(task.status, "cancelled")
        self.assertFalse(task.directory.exists())

    async def test_shutdown_stops_active_conversion(self):
        task, child = await self.running_task("conversion")
        reaper = asyncio.create_task(manager.reap_tasks())
        await manager.shutdown_tasks(reaper)
        self.assertFalse(process_alive(child))
        self.assertFalse(task.directory.exists())
        self.assertEqual(manager.TASKS, {})

    async def test_disk_budget_stops_task(self):
        task, child = await self.running_task()
        with patch.object(settings, "media_max_bytes", 1):
            reaper = asyncio.create_task(manager.reap_tasks())
            try:
                await wait_for_condition(lambda: task.status == "cancelled", 6)
            finally:
                reaper.cancel()
                await asyncio.gather(reaper, return_exceptions=True)
        self.assertFalse(process_alive(child))

    async def test_posix_signals_target_group_even_after_parent_exit(self):
        process = AsyncMock()
        process.pid = 123456
        process.returncode = 0
        with patch.object(process_tree.os, "name", "posix"), patch.object(process_tree.os, "killpg", create=True) as killpg, \
                patch.object(process_tree.signal, "SIGKILL", 9, create=True):
            await process_tree.stop_process_tree(process)
        self.assertEqual([call.args for call in killpg.call_args_list],
                         [(123456, signal.SIGTERM), (123456, 9)])
        process.wait.assert_awaited_once()

    async def test_task_is_not_ready_until_process_tree_has_stopped(self):
        entered = asyncio.Event()
        release = asyncio.Event()
        original_stop = manager.stop_process_tree

        async def delayed_stop(process, job):
            entered.set()
            await release.wait()
            await original_stop(process, job)

        with patch.object(manager, "stop_process_tree", delayed_stop):
            task = manager.create_task("https://youtu.be/ready", mode="info")
            await asyncio.wait_for(entered.wait(), 5)
            self.assertEqual(task.status, "running")
            release.set()
            await asyncio.wait_for(task.runner, 5)
        self.assertEqual(task.status, "ready")

    async def test_api_cancel_before_post_and_platforms(self):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            platforms = await client.get("/api/media/platforms")
            self.assertEqual(len(platforms.json()), 6)
            task_id = str(uuid4())
            result = await client.delete(f"/api/media/download-tasks/{task_id}")
            self.assertEqual(result.json()["status"], "cancelled")
            result = await client.post("/api/media/download-tasks", json={"url": "https://youtu.be/a", "task_id": task_id, "format": {"height": 720}})
            self.assertEqual(result.json()["status"], "cancelled")
            invalid = await client.post("/api/media/info", json={"url": "http://localhost:8000"})
            self.assertEqual(invalid.status_code, 400)


if __name__ == "__main__":
    unittest.main()
