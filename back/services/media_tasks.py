"""Задачи живут в одном event loop. Запускать backend с одним worker."""
import asyncio
import json
import logging
import os
import shutil
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from uuid import UUID, uuid4

from fastapi import HTTPException

from config import BASE_DIR, settings
from database.db_tools import add_proxy_info_success, add_proxy_ip_error
from services.media_platforms import detect_platform
from services.process_tree import WindowsJob, stop_process_tree
from services.media_messages import get_stage_message
from services.proxy_pool import (
    get_proxy_key, get_proxy_url, max_proxy_attempts, put_on_cooldown,
)


logger = logging.getLogger(__name__)
TASK_ROOT = BASE_DIR / "tmp" / "media_tasks"
TERMINAL = {"failed", "cancelled", "completed"}


@dataclass
class MediaTask:
    id: str
    url: str = ""
    mode: str = "download"
    requested_fast: bool = False
    delivery_mode: str = "file"
    format_kind: str = "video"
    height: str = "720"
    platform: str = ""
    status: str = "queued"
    stage: str = "queued"
    progress: int | None = 0
    error: str | None = None
    result: dict | None = None
    created: float = field(default_factory=time.monotonic)
    touched: float = field(default_factory=time.monotonic)
    ready_at: float | None = None
    cancel: asyncio.Event = field(default_factory=asyncio.Event)
    runner: asyncio.Task | None = None
    streaming: bool = False
    transfer_done: asyncio.Event = field(default_factory=asyncio.Event)
    ip: str = "unknown"
    user_agent: str | None = None
    queue_name: str = "file"
    fallback_requested: bool = False
    proxy_key: str | None = None
    proxy_attempts: int = 0
    retry_with_another_proxy: bool = False
    proxy_error_kind: str | None = None

    @property
    def directory(self):
        return TASK_ROOT / self.id


TASKS: dict[str, MediaTask] = {}
QUEUES: dict[str, asyncio.Queue] = {}
WORKERS: list[asyncio.Task] = []


def normalize_id(task_id):
    try:
        return UUID(str(task_id)).hex
    except ValueError:
        raise HTTPException(422, "Некорректный идентификатор задачи")


def cleanup_directory(task):
    """Только отдельная папка задачи; не затрагиваем старый tmp и чужие файлы."""
    directory = task.directory.resolve()
    if directory.parent != TASK_ROOT.resolve():
        raise ValueError("Папка задачи находится вне media_tasks")
    try:
        shutil.rmtree(directory)
    except FileNotFoundError:
        pass
    except OSError:
        # Например, браузер ещё читает файл на Windows. Reaper повторит очистку.
        logger.warning("Cannot clean task directory %s", task.id)


def get_task(task_id, touch=True):
    task = TASKS.get(normalize_id(task_id))
    if not task:
        raise HTTPException(404, "Задача не найдена")
    if touch:
        task.touched = time.monotonic()
    return task


def serialize_task(task):
    data = {"task_id": task.id, "status": task.status, "stage": task.stage,
            "message": task.error or get_stage_message(task.stage), "progress": task.progress,
            "error": task.error, "error_code": 500 if task.status == "failed" else None,
            "platform": task.platform, "download_url": None,
            "delivery_mode": task.delivery_mode, "queue": task.queue_name}
    if task.status == "queued":
        data["queue_position"] = queue_position(task)
    if task.status == "ready" and task.mode == "download":
        data["download_url"] = f"/api/media/download-tasks/{task.id}/download"
    if task.status == "ready" and task.mode == "info":
        data["result"] = task.result
    return data


def queue_position(task):
    # Очередь живёт только в одном event loop; _queue читается без await.
    queue = QUEUES.get(task.queue_name)
    if queue is None:
        return None
    queued_position = None
    for position, item in enumerate(queue._queue, 1):
        if item is task:
            queued_position = position
            break
    if queued_position is None:
        return None
    worker_count = {
        "info": settings.info_worker_count,
        "fast": settings.fast_worker_count,
        "file": settings.file_worker_count,
    }.get(task.queue_name, 0)
    occupied = sum(
        item.queue_name == task.queue_name and item.status in {"running", "cancelling"}
        for item in TASKS.values()
    )
    position = occupied + queued_position - worker_count
    return position if position > 0 else None


def ensure_queues():
    if QUEUES:
        return
    QUEUES.update({
        "info": asyncio.Queue(maxsize=settings.info_queue_size),
        "fast": asyncio.Queue(maxsize=settings.fast_queue_size),
        "file": asyncio.Queue(maxsize=settings.file_queue_size),
    })


def create_task(url, height="720", mode="download", task_id=None, *, requested_fast=False,
                ip="unknown", user_agent=None, kind="video"):
    ensure_queues()
    platform = detect_platform(url)
    task_id = normalize_id(task_id or uuid4())
    if task_id in TASKS:
        previous = TASKS[task_id]
        # DELETE может прийти раньше POST. Такая задача уже не должна стартовать.
        if previous.cancel.is_set():
            return previous
        raise HTTPException(409, "Этот идентификатор задачи уже используется")
    active = sum(task.status not in TERMINAL for task in TASKS.values())
    if active >= settings.max_queue_total:
        raise HTTPException(503, "Сервис занят. Попробуйте через минуту")
    ip_active = sum(task.status not in TERMINAL and task.ip == ip for task in TASKS.values())
    if ip_active >= settings.max_queue_per_ip:
        raise HTTPException(429, "Слишком много попыток. Попробуйте через минуту")
    if len(TASKS) >= settings.max_retained_media_tasks:
        raise HTTPException(503, "Сервис занят. Попробуйте через минуту")
    queue_name = "info" if mode == "info" else ("fast" if requested_fast else "file")
    task = MediaTask(task_id, url=url, height=str(height), mode=mode,
                     requested_fast=requested_fast,
                     delivery_mode="fast" if requested_fast else "file",
                     format_kind=kind,
                     platform=platform["id"], ip=ip, user_agent=user_agent,
                     queue_name=queue_name)
    TASKS[task.id] = task
    try:
        QUEUES[queue_name].put_nowait(task)
    except asyncio.QueueFull:
        TASKS.pop(task.id, None)
        raise HTTPException(503, "Queue is full")
    return task


async def cancel_task(task_id):
    task_id = normalize_id(task_id)
    task = TASKS.get(task_id)
    if task is None:
        if len(TASKS) >= settings.max_retained_media_tasks:
            raise HTTPException(503, "Сервис занят. Попробуйте через минуту")
        task = MediaTask(task_id)
        TASKS[task_id] = task
    if task.status == "completed":
        return task
    if task.mode == "info" and task.status == "ready":
        # Успешный POST /info уже отдал результат: очищаем без tombstone.
        cleanup_directory(task)
        TASKS.pop(task.id, None)
        return task
    task.cancel.set()
    if task.status == "queued" and task.runner is None:
        queue = QUEUES.get(task.queue_name)
        if queue is not None:
            try:
                queue._queue.remove(task)
                queue.task_done()
            except ValueError:
                pass
    task.status = task.stage = "cancelling"
    # Ответ DELETE означает, что worker и его потомки уже завершены.
    if task.runner:
        await asyncio.shield(task.runner)
    if task.streaming:
        await task.transfer_done.wait()
    task.status = task.stage = "cancelled"
    task.progress = 0
    task.error = None
    task.result = None
    task.touched = time.monotonic()
    if not task.streaming:
        cleanup_directory(task)
    return task


async def read_events(process, task):
    result = None
    error_message = "Не удалось получить видео. Попробуйте ещё раз"
    while line := await process.stdout.readline():
        event = json.loads(line)
        if event.get("event") == "progress" and not task.cancel.is_set():
            task.stage = event["stage"]
            task.progress = event.get("progress")
        elif event.get("event") == "fallback":
            task.fallback_requested = True
        elif event.get("event") == "result":
            result = event["data"]
        elif event.get("event") == "error":
            error_message = event["message"]
            task.retry_with_another_proxy = event.get("proxy_error", False)
            task.proxy_error_kind = event.get("proxy_error_kind")
    await process.wait()
    if process.returncode or result is None:
        raise RuntimeError(error_message)
    return result


async def drain_errors(process, task):
    # Ограниченный вывод в журнал; не накапливаем stderr длинного скачивания в RAM.
    async for line in process.stderr:
        logger.warning("Media worker %s: %s", task.id, line.decode("utf-8", errors="replace").rstrip()[:2000])


async def queue_worker(queue_name):
    queue = QUEUES[queue_name]
    while True:
        task = await queue.get()
        requeue = False
        try:
            if task.cancel.is_set() or task.status != "queued":
                continue
            task.status = task.stage = "running"
            task.runner = asyncio.create_task(run_task(task), name=f"media-{task.id}")
            await task.runner
            if (task.fallback_requested or task.retry_with_another_proxy) and not task.cancel.is_set():
                task.fallback_requested = False
                task.retry_with_another_proxy = False
                requeue = True
        except asyncio.QueueFull:
            task.status = task.stage = "failed"
            task.error = "Сервис занят. Попробуйте через минуту"
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Media queue worker %s failed for %s", queue_name, task.id)
            if task.status not in TERMINAL:
                task.status = task.stage = "failed"
        finally:
            queue.task_done()
            task.runner = None
        if requeue:
            try:
                QUEUES[task.queue_name].put_nowait(task)
            except asyncio.QueueFull:
                task.status = task.stage = "failed"
                task.error = "Сервис занят. Попробуйте через минуту"


async def run_task(task):
    process = job = None
    readers = []
    succeeded = False
    rescheduled = False
    try:
        if task.cancel.is_set():
            return
        task.status, task.stage = "running", "preparing"
        if task.proxy_key is None:
            task.proxy_key = get_proxy_key()
            task.proxy_attempts += 1
        task.directory.mkdir(parents=True, exist_ok=False)
        # На Linux отдельная session включает yt-dlp, ffmpeg и JS runtime.
        process = await asyncio.create_subprocess_exec(
            sys.executable, "-u", "-m", "services.media_worker", cwd=BASE_DIR,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE, limit=1024 * 1024,
            start_new_session=os.name != "nt",
            creationflags=0x08000000 if os.name == "nt" else 0,
            env={**os.environ, "PYTHONIOENCODING": "utf-8"},
        )
        if os.name == "nt":
            job = WindowsJob(process.pid)
        payload = {"url": task.url,
                   "mode": "fast" if task.requested_fast else task.mode,
                   "height": task.height, "kind": task.format_kind,
                   "directory": str(task.directory), "max_bytes": settings.media_max_bytes,
                   "proxy": get_proxy_url(task.proxy_key)}
        process.stdin.write((json.dumps(payload) + "\n").encode())
        await process.stdin.drain()
        process.stdin.close()
        output = asyncio.create_task(read_events(process, task))
        errors = asyncio.create_task(drain_errors(process, task))
        cancelled = asyncio.create_task(task.cancel.wait())
        readers = [output, errors, cancelled]
        timeout = settings.media_info_timeout_sec if task.mode == "info" else settings.media_task_timeout_sec
        done, _ = await asyncio.wait([output, cancelled], timeout=timeout, return_when=asyncio.FIRST_COMPLETED)
        if task.cancel.is_set():
            return
        if output not in done:
            raise TimeoutError("Подготовка файла заняла слишком много времени. Попробуйте ещё раз")
        task.result = output.result()
        if task.mode == "download" and task.delivery_mode != "fast":
            path = task.directory / task.result["filename"]
            if path.resolve().parent != task.directory.resolve() or not path.is_file():
                raise RuntimeError("Не удалось подготовить файл. Попробуйте ещё раз")
        # «Готово» публикуем только после остановки всей группы процессов ниже.
        # Иначе HTTP-ответ мог бы начать читать файл одновременно с очисткой.
        succeeded = True
    except Exception as error:
        if task.retry_with_another_proxy:
            try:
                operation = "info" if task.mode == "info" else "download"
                await add_proxy_ip_error(task.proxy_key, task.platform, operation,
                                         task.proxy_error_kind or "connection_error")
            except Exception:
                logger.exception("Cannot save proxy error statistics for task %s", task.id)
        if task.retry_with_another_proxy and task.proxy_attempts < max_proxy_attempts() and not task.cancel.is_set():
            put_on_cooldown(task.proxy_key)
            task.proxy_key = None
            task.status = task.stage = "queued"
            task.error = None
            rescheduled = True
        elif task.fallback_requested and task.requested_fast and not task.cancel.is_set():
            task.requested_fast = False
            task.delivery_mode = task.queue_name = "file"
            task.status = task.stage = "queued"
            task.error = None
            rescheduled = True
        else:
            task.retry_with_another_proxy = False
            logger.warning("Media task %s failed: %s", task.id, error)
            task.status = task.stage = "failed"
        task.error = str(error) if isinstance(error, (RuntimeError, TimeoutError)) else "Не удалось подготовить скачивание. Попробуйте ещё раз"
    finally:
        # Сначала останавливаем дерево, затем закрываем читателей и удаляем файлы.
        if process:
            await stop_process_tree(process, job)
        for reader in readers:
            reader.cancel()
        await asyncio.gather(*readers, return_exceptions=True)
        if task.cancel.is_set():
            task.status = task.stage = "cancelled"
            task.result = None
        elif succeeded:
            task.status = task.stage = "ready"
            task.progress = 100
            task.ready_at = time.monotonic()
            if task.mode == "info":
                try:
                    await add_proxy_info_success(task.proxy_key, task.platform)
                except Exception:
                    logger.exception("Cannot save proxy info statistics for task %s", task.id)
        if task.status != "ready" or task.mode == "info" or task.delivery_mode == "fast":
            cleanup_directory(task)
        elif task.directory.exists():
            try:
                (task.directory / "cookies.txt").unlink(missing_ok=True)
            except OSError:
                logger.warning("Cannot remove cookie copy for task %s", task.id)
        if rescheduled:
            task.error = None


async def reap_tasks():
    """Отмена забытых работ и периодическая очистка, даже если новых запросов нет."""
    while True:
        await asyncio.sleep(2)
        now = time.monotonic()
        for task in list(TASKS.values()):
            try:
                if task.status in TERMINAL:
                    cleanup_directory(task)
                    if now - task.touched > settings.temp_file_max_age_sec and not task.directory.exists():
                        TASKS.pop(task.id, None)
                    continue
                if task.streaming:
                    continue
                expired = now - task.touched > settings.media_client_timeout_sec
                expired |= task.ready_at is not None and now - task.ready_at > settings.media_ready_timeout_sec
                # Размер включает промежуточные дорожки, .part и результаты ffmpeg.
                size = 0
                if task.directory.exists():
                    for path in task.directory.rglob("*"):
                        try:
                            if path.is_file():
                                size += path.stat().st_size
                        except OSError:
                            pass
                if expired or size > settings.media_max_bytes:
                    await cancel_task(task.id)
            except OSError:
                # Ошибка доступа к одной временной папке не должна останавливать reaper.
                logger.warning("Cannot inspect media task %s", task.id)


async def start_tasks():
    TASK_ROOT.mkdir(parents=True, exist_ok=True)
    QUEUES.clear()
    QUEUES.update({
        "info": asyncio.Queue(maxsize=settings.info_queue_size),
        "fast": asyncio.Queue(maxsize=settings.fast_queue_size),
        "file": asyncio.Queue(maxsize=settings.file_queue_size),
    })
    WORKERS.clear()
    for name, count in (("info", settings.info_worker_count),
                        ("fast", settings.fast_worker_count),
                        ("file", settings.file_worker_count)):
        WORKERS.extend(asyncio.create_task(queue_worker(name), name=f"media-{name}-{i}")
                       for i in range(count))
    # Папка выделена только этому менеджеру. Старые файлы прежнего API не трогаем.
    for directory in TASK_ROOT.iterdir():
        try:
            task_id = UUID(directory.name).hex
        except ValueError:
            continue
        if directory.is_dir() and directory.name == task_id:
            cleanup_directory(MediaTask(task_id))
    return asyncio.create_task(reap_tasks(), name="media-cleanup")


async def shutdown_tasks(reaper):
    reaper.cancel()
    await asyncio.gather(reaper, return_exceptions=True)
    await asyncio.gather(*(cancel_task(task.id) for task in list(TASKS.values())))
    for worker in WORKERS:
        worker.cancel()
    await asyncio.gather(*WORKERS, return_exceptions=True)
    WORKERS.clear()
    TASKS.clear()
