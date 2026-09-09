import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

from config import settings
from routers.media_router import ManagedFastResponse
from services import media_tasks as manager


async def eventually(predicate, timeout=2):
    deadline = asyncio.get_running_loop().time() + timeout
    while not predicate():
        if asyncio.get_running_loop().time() >= deadline:
            raise AssertionError("condition was not reached")
        await asyncio.sleep(0.01)


class QueueContractTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="queue-tests-")
        self.root_patch = patch.object(manager, "TASK_ROOT", Path(self.temp.name) / "tasks")
        self.root_patch.start()
        manager.TASKS.clear()
        manager.QUEUES.clear()
        manager.WORKERS.clear()

    async def asyncTearDown(self):
        for worker in manager.WORKERS:
            worker.cancel()
        await asyncio.gather(*manager.WORKERS, return_exceptions=True)
        manager.WORKERS.clear()
        manager.TASKS.clear()
        manager.QUEUES.clear()
        self.root_patch.stop()
        self.temp.cleanup()

    async def test_start_tasks_starts_workers_before_create(self):
        reaper = await manager.start_tasks()
        try:
            self.assertGreaterEqual(len(manager.WORKERS), 1)
            task = manager.create_task("https://youtu.be/queued", mode="info")
            self.assertIn(task, manager.QUEUES["info"]._queue)
        finally:
            await manager.shutdown_tasks(reaper)

    async def test_queue_position_is_after_worker_capacity(self):
        with patch.object(settings, "max_queue_total", 10), \
             patch.object(settings, "file_queue_size", 10), \
             patch.object(settings, "file_worker_count", 3):
            first = manager.create_task("https://youtu.be/one", ip="one")
            second = manager.create_task("https://youtu.be/two", ip="two")
            third = manager.create_task("https://youtu.be/three", ip="three")
            fourth = manager.create_task("https://youtu.be/four", ip="four")
            self.assertIsNone(manager.queue_position(first))
            self.assertIsNone(manager.queue_position(second))
            self.assertIsNone(manager.queue_position(third))
            self.assertEqual(manager.queue_position(fourth), 1)
            with self.assertRaises(HTTPException) as error:
                for index in range(7):
                    manager.create_task(f"https://youtu.be/full-{index}", ip=f"full-{index}")
            self.assertEqual(error.exception.status_code, 503)

    async def test_per_ip_capacity_is_enforced(self):
        with patch.object(settings, "max_queue_per_ip", 1):
            manager.create_task("https://youtu.be/one", ip="same")
            with self.assertRaises(HTTPException) as error:
                manager.create_task("https://youtu.be/two", ip="same")
            self.assertEqual(error.exception.status_code, 429)

    async def test_queued_cancel_never_spawns_worker(self):
        manager.ensure_queues()
        task = manager.create_task("https://youtu.be/queued")
        with patch.object(manager, "run_task", new_callable=AsyncMock) as run_task:
            await manager.cancel_task(task.id)
            await asyncio.wait_for(manager.QUEUES["file"].join(), timeout=0.1)
        run_task.assert_not_awaited()
        self.assertEqual(task.status, "cancelled")
        self.assertIsNone(task.runner)

    async def test_info_queue_dispatches_and_keeps_task_identity(self):
        async def fake_run(task):
            task.status = task.stage = "ready"
            task.result = {"formats": []}

        with patch.object(settings, "info_worker_count", 1), \
             patch.object(settings, "fast_worker_count", 0), \
             patch.object(settings, "file_worker_count", 0), \
             patch.object(manager, "run_task", side_effect=fake_run) as run_task:
            reaper = await manager.start_tasks()
            try:
                task = manager.create_task("https://youtu.be/info", mode="info")
                await eventually(lambda: task.status == "ready")
                run_task.assert_awaited_once_with(task)
                self.assertIs(manager.TASKS[task.id], task)
            finally:
                await manager.shutdown_tasks(reaper)

    async def test_fast_queue_dispatches_fast_task_with_same_id(self):
        seen = []

        async def fake_run(task):
            seen.append((task.id, task.requested_fast, task.queue_name))
            task.status = task.stage = "ready"
            task.result = {"delivery_mode": "fast"}

        with patch.object(settings, "info_worker_count", 0), \
             patch.object(settings, "fast_worker_count", 1), \
             patch.object(settings, "file_worker_count", 0), \
             patch.object(manager, "run_task", side_effect=fake_run):
            reaper = await manager.start_tasks()
            try:
                task = manager.create_task("https://youtu.be/fast", requested_fast=True)
                await eventually(lambda: task.status == "ready")
                self.assertEqual(seen, [(task.id, True, "fast")])
                self.assertIs(manager.TASKS[task.id], task)
            finally:
                await manager.shutdown_tasks(reaper)

    async def test_fast_fallback_moves_same_task_to_file_queue(self):
        seen = []

        async def fake_run(task):
            seen.append((task.id, task.requested_fast, task.queue_name))
            if task.requested_fast:
                task.requested_fast = False
                task.delivery_mode = task.queue_name = "file"
                task.status = task.stage = "queued"
                task.fallback_requested = True
                return
            task.status = task.stage = "ready"
            task.result = {"filename": "video.mp4"}

        with patch.object(settings, "info_worker_count", 0), \
             patch.object(settings, "fast_worker_count", 1), \
             patch.object(settings, "file_worker_count", 1), \
             patch.object(manager, "run_task", side_effect=fake_run):
            reaper = await manager.start_tasks()
            try:
                task = manager.create_task("https://youtu.be/fallback", requested_fast=True)
                await eventually(lambda: task.status == "ready")
                self.assertEqual(seen, [(task.id, True, "fast"), (task.id, False, "file")])
                self.assertIs(manager.TASKS[task.id], task)
                self.assertEqual(task.delivery_mode, "file")
            finally:
                await manager.shutdown_tasks(reaper)

    async def test_fast_response_hides_upstream_and_cancellation_closes_transfer(self):
        task = manager.create_task("https://youtu.be/fast-response", requested_fast=True)
        task.status = task.stage = "ready"
        task.result = {
            "url": "https://cdn.invalid/private-signed-url",
            "headers": {"Authorization": "secret"},
            "filename": "video.mp4",
            "title": "Video",
            "ext": "mp4",
        }
        response = ManagedFastResponse(task)
        self.assertNotIn("cdn.invalid", str(response.raw_headers))
        self.assertNotIn("Authorization", str(response.raw_headers))

        async def body():
            while True:
                yield b"chunk"
                await asyncio.sleep(0)

        response.body_iterator = body()
        started = asyncio.Event()
        async def send(message):
            if message["type"] == "http.response.body":
                started.set()
                await asyncio.Event().wait()

        sending = asyncio.create_task(response({"type": "http", "asgi": {"spec_version": "2.4"}}, AsyncMock(), send))
        await eventually(lambda: task.streaming)
        await started.wait()
        await manager.cancel_task(task.id)
        await sending
        self.assertEqual(task.status, "cancelled")
        self.assertTrue(task.transfer_done.is_set())
        self.assertFalse(task.streaming)


if __name__ == "__main__":
    unittest.main()
