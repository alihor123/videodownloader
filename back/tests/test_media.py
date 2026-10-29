import asyncio
import ctypes
import os
import signal
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch
from uuid import uuid4

import httpx
from fastapi import HTTPException

from app import app
from config import BASE_DIR, settings
from media.router import InfoRequest, ManagedFileResponse, get_info
from media import tasks as manager
from media.platforms import detect_platform, normalize_platform_url
from media.formats import build_format_list, format_duration, format_filesize, select_fast_format
import process_tree
from media.worker import (
    get_download_progress, get_platform_cookie_file, get_proxy_error_kind, get_user_error,
    is_proxy_or_ip_error, probe_fast_source, should_retry_without_youtube_cookies,
)
from media.ytdlp import get_info_ydl_opts


async def wait_for_condition(condition, timeout):
    """Ожидает условие до таймаута; совместимо с Python 3.10 без asyncio.timeout."""
    deadline = asyncio.get_running_loop().time() + timeout
    while not condition():
        if asyncio.get_running_loop().time() >= deadline:
            raise TimeoutError("Condition was not met in time")
        await asyncio.sleep(0.05)


def process_alive(pid):
    """Проверяет, продолжает ли процесс с указанным PID работать на Windows или Linux."""
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
    """Проверки ссылок платформ, форматов, прогресса и обработки ошибок источника."""
    def test_separate_video_and_audio_progress_never_resets(self):
        """Проверяет непрерывный прогресс при последовательном скачивании видео и звука."""
        requested_formats = [
            {"format_id": "137", "vcodec": "avc1", "acodec": "none"},
            {"format_id": "140", "vcodec": "none", "acodec": "mp4a"},
        ]
        video = {"filename": "output.f137.mp4", "downloaded_bytes": 50,
                 "total_bytes": 100, "info_dict": {"requested_formats": requested_formats}}
        stage, progress, file_name, track = get_download_progress(video, "", "file")
        self.assertEqual((stage, progress), ("downloading_video", 25))

        audio = {"filename": "output.f140.m4a", "downloaded_bytes": 50,
                 "total_bytes": 100, "info_dict": {"requested_formats": requested_formats}}
        stage, progress, _, track = get_download_progress(audio, file_name, track)
        self.assertEqual((stage, progress), ("downloading_audio", 74))

    def test_muxed_file_keeps_full_progress_range(self):
        """Проверяет полный диапазон прогресса для файла с видео и звуком."""
        data = {"filename": "output.mp4", "downloaded_bytes": 50, "total_bytes": 100,
                "info_dict": {"requested_formats": [{"format_id": "18"}]}}
        stage, progress, _, _ = get_download_progress(data, "", "file")
        self.assertEqual((stage, progress), ("downloading_file", 49))

    def test_youtube_uses_mweb_with_local_ejs(self):
        """Проверяет настройки клиента YouTube и локального выполнения JavaScript."""
        options = get_info_ydl_opts()
        self.assertEqual(options["extractor_args"]["youtube"]["player_client"], ["mweb"])
        self.assertNotIn("remote_components", options)

    def test_fractional_duration_from_twitter(self):
        """Проверяет отображение дробной длительности без долей секунды."""
        self.assertEqual(format_duration(12.85), "0:12")
        self.assertEqual(format_duration(3661.5), "1:01:01")

    def test_unknown_filesize_is_not_shown_as_a_fake_size(self):
        """Проверяет отсутствие выдуманного размера у файла неизвестной длины."""
        self.assertIsNone(format_filesize(0))

    def test_portrait_tiktok_quality_uses_shorter_side(self):
        """Проверяет определение качества вертикального видео по короткой стороне."""
        formats = build_format_list({"formats": [
            {"width": 576, "height": 1024, "vcodec": "h264", "acodec": "aac",
             "ext": "mp4", "filesize": 1024, "format_id": "h264_540p_428414-0"},
            {"width": 720, "height": 1280, "vcodec": "h264", "acodec": "aac",
             "ext": "mp4", "filesize": 2048, "format_id": "bytevc1_720p_626782-0"},
            {"width": 1080, "height": 1920, "vcodec": "h264", "acodec": "aac",
             "ext": "mp4", "filesize": 4096, "format_id": "bytevc1_1080p_1453265-0"},
        ]})
        self.assertEqual([item["height"] for item in formats], [1024, 1280, 1920])
        self.assertEqual([item["label"] for item in formats], ["540p", "720p", "1080p"])

    def test_portrait_formats_do_not_round_540p_to_a_second_720p(self):
        """Проверяет отдельные подписи качества 540p и 720p у вертикальных форматов."""
        formats = build_format_list({"formats": [
            {"width": 540, "height": 960, "vcodec": "vp9", "acodec": "none", "ext": "mp4", "tbr": 258},
            {"width": 720, "height": 1280, "vcodec": "vp9", "acodec": "none", "ext": "mp4", "tbr": 515},
            {"width": 720, "height": 1280, "vcodec": "vp9", "acodec": "none", "ext": "mp4", "tbr": 1729},
            {"width": 1080, "height": 1920, "vcodec": "vp9", "acodec": "none", "ext": "mp4", "tbr": 2552},
        ]})
        self.assertEqual([item["height"] for item in formats], [960, 1280, 1920])
        self.assertEqual([item["label"] for item in formats], ["540p", "720p", "1080p"])
        self.assertTrue(all(item["size"] is None for item in formats))

    def test_split_quality_is_fast_when_muxed_variant_exists(self):
        """Проверяет доступность быстрой передачи при наличии цельного варианта качества."""
        formats = build_format_list({"formats": [
            {"height": 720, "width": 1280, "vcodec": "avc", "acodec": "none",
             "ext": "mp4", "filesize": 5000},
            {"height": 720, "width": 1280, "vcodec": "avc", "acodec": "mp4a",
             "ext": "mp4", "filesize": 1000, "url": "https://cdn/video.mp4"},
        ]})
        self.assertEqual(formats[0]["height"], 720)
        self.assertTrue(formats[0]["fast"])

    def test_extra_fast_quality_marks_split_format_as_fast(self):
        """Проверяет отметку быстрого режима для дополнительно подтверждённого качества."""
        info = {"formats": [{"height": 360, "vcodec": "avc1", "acodec": "none", "ext": "mp4"}]}
        formats = build_format_list(info, extra_fast_heights={360})
        self.assertTrue(formats[0]["fast"])

    def test_fast_selector_requires_exact_height(self):
        """Проверяет отказ быстрого выбора, если точная высота формата отсутствует."""
        info = {"formats": [{"height": 720, "vcodec": "avc", "acodec": "mp4a",
                             "ext": "mp4", "url": "https://cdn/video.mp4"}]}
        self.assertIsNone(select_fast_format(info, 1080))

    def test_fast_selector_prefers_mp4_for_exact_height(self):
        """Проверяет предпочтение MP4 среди форматов с одинаковой высотой."""
        info = {"formats": [
            {"height": 720, "vcodec": "avc", "acodec": "opus", "ext": "webm",
             "url": "https://cdn/video.webm", "tbr": 1000},
            {"height": 720, "vcodec": "avc", "acodec": "mp4a", "ext": "mp4",
             "url": "https://cdn/video.mp4", "tbr": 500},
        ]}
        self.assertEqual(select_fast_format(info, 720)["ext"], "mp4")

    def test_fast_source_probe_reads_one_chunk(self):
        """Проверяет короткий запрос доступности потока без чтения всего файла."""
        response = Mock()
        response.iter_bytes.return_value = iter([b"x", b"unread"])
        response.raise_for_status = lambda: None

        class Stream:
            """Подставной контекст HTTP-потока с заранее заданным ответом."""
            def __enter__(self):
                """Возвращает подготовленный ответ при открытии потока."""
                return response
            def __exit__(self, *_):
                """Завершает контекст потока без подавления исключений."""
                return False

        class Client:
            """Подставной HTTP-клиент, запоминающий параметры запроса."""
            def __enter__(self):
                """Возвращает подставной клиент при входе в контекст."""
                return self
            def __exit__(self, *_):
                """Завершает контекст клиента без подавления исключений."""
                return False
            def stream(self, method, url, headers):
                """Запоминает параметры запроса и возвращает подготовленный поток."""
                self.request = (method, headers)
                return Stream()

        with patch("media.worker.httpx.Client", return_value=Client()) as factory:
            self.assertTrue(probe_fast_source("https://cdn.example/video.mp4", {"User-Agent": "test"}))
        self.assertEqual(factory.return_value.request[1]["Range"], "bytes=0-0")

    def test_fast_source_probe_falls_back_on_http_error(self):
        """Проверяет отказ от прямого потока при HTTP-ошибке источника."""
        class Response:
            """Подставной ответ источника с HTTP-ошибкой."""
            def __enter__(self):
                """Возвращает подставной ответ при открытии потока."""
                return self
            def __exit__(self, *_):
                """Завершает контекст ответа без подавления исключений."""
                return False
            def raise_for_status(self):
                """Имитирует отклонение запроса источником с HTTP-ошибкой."""
                import httpx
                raise httpx.HTTPStatusError("forbidden", request=None, response=None)
            def iter_bytes(self, _):
                """Возвращает пустой поток данных для ошибочного ответа."""
                return iter(())

        class Client:
            """Подставной HTTP-клиент, возвращающий ошибочный ответ."""
            def __enter__(self):
                """Возвращает подставной клиент при входе в контекст."""
                return self
            def __exit__(self, *_):
                """Завершает контекст клиента без подавления исключений."""
                return False
            def stream(self, *_args, **_kwargs):
                """Возвращает поток с подставной HTTP-ошибкой источника."""
                return Response()

        with patch("media.worker.httpx.Client", return_value=Client()):
            self.assertFalse(probe_fast_source("https://cdn.example/video.mp4", {}))

    def test_rutube_shorts_is_normalized_for_rutube_extractor(self):
        """Проверяет преобразование короткой ссылки Rutube в поддерживаемый путь видео."""
        url = "https://rutube.ru/shorts/2f18c8153e2b589a2f895e81b400137e/"
        self.assertEqual(
            normalize_platform_url(url, detect_platform(url)),
            "https://rutube.ru/video/2f18c8153e2b589a2f895e81b400137e/",
        )

    def test_age_restriction_has_a_clear_message(self):
        """Проверяет понятное сообщение о возрастном ограничении видео."""
        message = get_user_error(
            Exception("Sorry, this content is age-restricted"),
            "youtube",
        )
        self.assertEqual(message, "Видео с возрастным ограничением пока нельзя скачать")

    def test_instagram_audience_restriction_has_a_clear_message(self):
        """Проверяет сообщение об ограниченной аудитории публикации Instagram."""
        message = get_user_error(
            Exception("This content isn't available to everyone: It can't be seen by certain audiences."),
            "instagram",
        )
        self.assertEqual(message, "Видео с ограниченным доступом скачать нельзя")

    def test_instagram_carousel_has_a_clear_message(self):
        """Проверяет сообщение о необходимости ссылки на одно видео вместо подборки."""
        message = get_user_error(
            ValueError("Нужна ссылка на отдельное опубликованное видео"),
            "instagram",
        )
        self.assertEqual(message, "Нужна ссылка на одно видео, а не на подборку")

    def test_each_platform_uses_only_its_own_cookie_file(self):
        """Проверяет выбор отдельного cookie-файла для каждой платформы."""
        with tempfile.TemporaryDirectory() as directory:
            instagram_cookie = Path(directory) / "instagram.txt"
            instagram_cookie.write_text("cookie", encoding="utf-8")
            with patch.object(settings, "instagram_cookies_file", instagram_cookie), \
                 patch.object(settings, "youtube_cookies_file", Path(directory) / "youtube.txt"):
                self.assertEqual(get_platform_cookie_file("instagram"), instagram_cookie)
                self.assertIsNone(get_platform_cookie_file("youtube"))

    def test_invalid_youtube_cookie_retries_once_without_it(self):
        """Проверяет условие повторного обращения к YouTube без устаревших cookies."""
        cookie_file = Path("youtube.txt")
        error = Exception("The page needs to be reloaded")
        self.assertTrue(should_retry_without_youtube_cookies(error, "youtube", cookie_file))
        unavailable_error = Exception("Requested format is not available")
        self.assertTrue(should_retry_without_youtube_cookies(unavailable_error, "youtube", cookie_file))
        self.assertFalse(should_retry_without_youtube_cookies(error, "instagram", cookie_file))
        self.assertFalse(should_retry_without_youtube_cookies(error, "youtube", None))

    def test_proxy_authentication_failure_uses_another_ip(self):
        """Проверяет распознавание ошибок прокси и причины повторной попытки с другим IP."""
        for message in (
            "HTTP Error 407: Proxy Authentication Required",
            "SOCKS5 authentication failed",
            "Unable to connect to proxy: authentication failed",
        ):
            with self.subTest(message=message):
                error = Exception(message)
                self.assertTrue(is_proxy_or_ip_error(error))
                self.assertEqual(get_proxy_error_kind(error), "connection_error")

        self.assertFalse(is_proxy_or_ip_error(Exception("Login required for this video")))

    def test_tiktok_browser_challenge_has_a_short_message(self):
        """Проверяет короткое пользовательское сообщение при отказе TikTok."""
        message = get_user_error(
            Exception("Unexpected response from webpage request; impersonation unavailable"),
            "tiktok",
        )
        self.assertEqual(message, "TikTok временно не отвечает. Попробуйте позже")

    def test_domains_and_short_links(self):
        """Проверяет распознавание основных доменов и коротких ссылок платформ."""
        examples = {"https://youtu.be/a": "youtube", "https://www.youtube.com/shorts/a": "youtube",
                    "https://rutube.ru/video/a": "rutube", "https://vkvideo.ru/video-1_2": "vk",
                    "https://m.vk.com/clip-1_2": "vk", "https://x.com/a/status/1": "twitter",
                    "https://t.co/abc": "twitter", "https://vm.tiktok.com/abc": "tiktok",
                    "https://www.instagram.com/reel/a/": "instagram"}
        for url, platform in examples.items():
            with self.subTest(url=url):
                self.assertEqual(detect_platform(url)["id"], platform)

    def test_rejects_unsupported_hosts_and_credentials(self):
        """Проверяет отклонение посторонних доменов и ссылок с учётными данными."""
        for url in ["file:///etc/passwd", "http://127.0.0.1", "https://youtube.com.evil.test/a",
                    "https://youtube.com@localhost/a", "https://youtube.com:8000/a", "not a url"]:
            with self.subTest(url=url), self.assertRaises(ValueError):
                detect_platform(url)


class CancellationTest(unittest.IsolatedAsyncioTestCase):
    """Проверки отмены задач, завершения процессов и очистки временных файлов."""
    async def asyncSetUp(self):
        """Создаёт изолированный менеджер задач и подменяет worker локальной фикстурой."""
        self.temp = tempfile.TemporaryDirectory(prefix="media-tests-")
        self.root_patch = patch.object(manager, "TASK_ROOT", Path(self.temp.name) / "tasks")
        self.root_patch.start()
        original = asyncio.create_subprocess_exec

        async def fixture_process(*args, **kwargs):
            """Запускает локальную фикстуру вместо сетевого процесса скачивания."""
            return await original(args[0], "-u", "-m", "tests.worker_fixture", **kwargs)

        self.process_patch = patch.object(manager.asyncio, "create_subprocess_exec", fixture_process)
        self.process_patch.start()
        manager.QUEUES.clear()
        manager.WORKERS.clear()
        self.reaper = await manager.start_tasks()
        self.child_pids = []

    async def asyncTearDown(self):
        """Останавливает задачи, освобождает временные данные и проверяет завершение потомков."""
        await manager.shutdown_tasks(self.reaper)
        manager.TASKS.clear()
        manager.QUEUES.clear()
        self.process_patch.stop()
        self.root_patch.stop()
        self.temp.cleanup()
        for pid in self.child_pids:
            self.assertFalse(process_alive(pid), f"Child {pid} survived cleanup")

    async def running_task(self, name="download", mode="download"):
        """Запускает тестовую задачу и дожидается записи PID её дочернего процесса."""
        task = manager.create_task(f"https://youtube.com/watch?v={name}", mode=mode)
        await wait_for_condition(lambda: (task.directory / "child.pid").exists() or
                                 (task.runner is not None and task.runner.done()), 15)
        # Ждём запись PID целиком.
        await wait_for_condition(lambda: bool((task.directory / "child.pid").read_text()), 15)
        content = (task.directory / "child.pid").read_text()
        pid = int(content)
        self.child_pids.append(pid)
        # Fixture с вариантом ready успевает завершиться до следующей проверки;
        # это успешный сценарий, если PID уже был записан.
        if task.runner.done() and task.status != "ready":
            self.fail(task.error)
        return task, pid

    async def test_cancel_download_kills_child_and_removes_partial_files(self):
        """Проверяет завершение потомка и удаление частичных файлов после отмены."""
        task, child = await self.running_task()
        self.assertTrue(process_alive(child))
        await asyncio.wait_for(manager.cancel_task(task.id), 5)
        self.assertEqual(task.status, "cancelled")
        self.assertFalse(process_alive(child))
        self.assertFalse(task.directory.exists())

    async def test_cancel_real_ffmpeg(self):
        """Проверяет остановку реального процесса ffmpeg при отмене конвертации."""
        if not settings.ffmpeg_path.exists():
            self.skipTest("ffmpeg binary unavailable")
        task, child = await self.running_task("conversion")
        self.assertTrue(process_alive(child))
        await asyncio.wait_for(manager.cancel_task(task.id), 5)
        self.assertFalse(process_alive(child))
        self.assertFalse(task.directory.exists())

    async def test_info_worker_is_also_cancelled(self):
        """Проверяет отмену процесса получения информации о видео."""
        task, child = await self.running_task(mode="info")
        await manager.cancel_task(task.id)
        self.assertFalse(process_alive(child))

    async def test_info_post_returns_result_once_and_cleans_task(self):
        """Проверяет ответ с информацией о видео и удаление завершённой информационной задачи."""
        task_id = str(uuid4())
        with patch("media.tasks.add_proxy_info_success", new_callable=AsyncMock) as stats:
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
                result = await client.post("/api/media/info", json={"url": "https://youtu.be/ready", "task_id": task_id})
            stats.assert_awaited_once()
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json()["filename"], "output.mp4")
        self.assertNotIn(task_id.replace("-", ""), manager.TASKS)

    async def test_info_disconnect_cancels_worker_tree(self):
        """Проверяет остановку дерева процессов при разрыве запроса информации."""
        class DisconnectingRequest:
            """Подставной запрос с управляемым состоянием разрыва соединения."""
            disconnected = False
            headers = {}

            async def is_disconnected(self):
                """Возвращает установленное тестом состояние разрыва соединения."""
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
        """Проверяет, что позднее создание не оживляет заранее отменённую задачу."""
        task_id = str(uuid4())
        await manager.cancel_task(task_id)
        task = manager.create_task("https://youtu.be/a", task_id=task_id)
        self.assertEqual(task.status, "cancelled")
        self.assertIsNone(task.runner)
        self.assertFalse(task.directory.exists())

    async def test_cancel_immediately_after_create(self):
        """Проверяет отмену сразу после создания задачи."""
        task = manager.create_task("https://youtu.be/a")
        await manager.cancel_task(task.id)
        self.assertIsNone(task.runner)
        self.assertEqual(task.status, "cancelled")
        self.assertFalse(task.directory.exists())

    async def test_cancel_one_task_keeps_other_running(self):
        """Проверяет, что отмена одной задачи не останавливает другую."""
        first, first_pid = await self.running_task()
        second, second_pid = await self.running_task()
        await manager.cancel_task(first.id)
        self.assertFalse(process_alive(first_pid))
        self.assertTrue(process_alive(second_pid))
        self.assertEqual(second.status, "running")

    async def test_timeout_stops_entire_tree(self):
        """Проверяет завершение дерева процессов по таймауту подготовки файла."""
        with patch.object(settings, "media_task_timeout_sec", 1):
            task, child = await self.running_task()
            await asyncio.wait_for(task.runner, 5)
        self.assertEqual(task.status, "failed")
        self.assertFalse(process_alive(child))
        self.assertFalse(task.directory.exists())

    async def test_missing_heartbeat_stops_task(self):
        """Проверяет отмену задачи при отсутствии обращений клиента."""
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
        """Проверяет завершение потомков даже после успешного создания файла."""
        task, child = await self.running_task("ready")
        await asyncio.wait_for(task.runner, 5)
        self.assertEqual(task.status, "ready")
        self.assertFalse(process_alive(child))
        self.assertTrue((task.directory / "output.mp4").exists())

    async def test_cancel_blocked_http_transfer_closes_file(self):
        """Проверяет отмену зависшей передачи клиенту и освобождение файла."""
        task, _ = await self.running_task("ready")
        await task.runner
        response = ManagedFileResponse(task, task.directory / "output.mp4")
        started = asyncio.Event()

        async def send(message):
            """Имитирует клиента, который перестал принимать тело ответа."""
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
        """Проверяет отказ по лимиту до запуска дополнительного процесса."""
        task, _ = await self.running_task()
        with patch.object(settings, "max_queue_total", 1):
            with self.assertRaises(Exception) as error:
                manager.create_task("https://youtu.be/other")
        self.assertEqual(error.exception.status_code, 503)
        self.assertEqual(task.status, "running")

    async def test_successful_transfer_cleans_file_and_records_stat(self):
        """Проверяет очистку файла и однократную запись статистики успешной передачи."""
        task, _ = await self.running_task("ready")
        await task.runner
        response = ManagedFileResponse(task, task.directory / "output.mp4")
        body = bytearray()

        async def send(message):
            """Собирает переданные части тела ответа для проверки размера файла."""
            body.extend(message.get("body", b""))

        with patch("media.router.add_download_stat", new_callable=AsyncMock) as stats, \
             patch("media.router.add_proxy_download_success", new_callable=AsyncMock) as proxy_stats:
            await response({"type": "http", "asgi": {"spec_version": "2.4"}}, AsyncMock(), send)
            stats.assert_awaited_once()
            proxy_stats.assert_awaited_once()
        self.assertEqual(len(body), 500000)
        self.assertEqual(task.status, "completed")
        self.assertFalse(task.directory.exists())

    async def test_browser_disconnect_cleans_file(self):
        """Проверяет очистку файла и отмену задачи при отключении браузера."""
        from starlette.requests import ClientDisconnect
        task, _ = await self.running_task("ready")
        await task.runner
        response = ManagedFileResponse(task, task.directory / "output.mp4")

        async def send(message):
            """Имитирует разрыв клиентского соединения во время передачи тела ответа."""
            if message["type"] == "http.response.body":
                raise OSError("Client disconnected")

        with self.assertRaises(ClientDisconnect):
            await response({"type": "http", "asgi": {"spec_version": "2.4"}}, AsyncMock(), send)
        self.assertEqual(task.status, "cancelled")
        self.assertFalse(task.directory.exists())

    async def test_shutdown_stops_active_conversion(self):
        """Проверяет завершение активной конвертации при остановке менеджера."""
        task, child = await self.running_task("conversion")
        reaper = asyncio.create_task(manager.reap_tasks())
        await manager.shutdown_tasks(reaper)
        self.assertFalse(process_alive(child))
        self.assertFalse(task.directory.exists())
        self.assertEqual(manager.TASKS, {})

    async def test_disk_budget_stops_task(self):
        """Проверяет отмену задачи при превышении лимита временных файлов."""
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
        """Проверяет отправку сигналов всей группе после завершения родительского процесса."""
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
        """Проверяет публикацию готовности только после завершения дерева процессов."""
        entered = asyncio.Event()
        release = asyncio.Event()
        original_stop = manager.stop_process_tree

        async def delayed_stop(process, job):
            """Задерживает остановку процесса до разрешающего сигнала теста."""
            entered.set()
            await release.wait()
            await original_stop(process, job)

        with patch.object(manager, "stop_process_tree", delayed_stop), \
             patch.object(manager, "add_proxy_info_success", new_callable=AsyncMock):
            task = manager.create_task("https://youtu.be/ready", mode="info")
            await asyncio.wait_for(entered.wait(), 5)
            self.assertEqual(task.status, "running")
            release.set()
            await asyncio.wait_for(task.runner, 5)
        self.assertEqual(task.status, "ready")

    async def test_api_cancel_before_post(self):
        """Проверяет отмену до POST-запроса и отклонение неподдерживаемой ссылки."""
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            task_id = str(uuid4())
            result = await client.delete(f"/api/media/download-tasks/{task_id}")
            self.assertEqual(result.json()["status"], "cancelled")
            result = await client.post("/api/media/download-tasks", json={"url": "https://youtu.be/a", "task_id": task_id, "format": {"height": 720}})
            self.assertEqual(result.json()["status"], "cancelled")
            invalid = await client.post("/api/media/info", json={"url": "http://localhost:8000"})
            self.assertEqual(invalid.status_code, 400)


if __name__ == "__main__":
    unittest.main()
