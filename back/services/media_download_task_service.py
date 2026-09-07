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
from services.media_platforms import detect_platform
from services.process_tree import WindowsJob, stop_process_tree
from services.youtube_download_constants import get_stage_message


logger = logging.getLogger(__name__)
TASK_ROOT = BASE_DIR / "tmp" / "media_tasks"
TERMINAL = {"failed", "cancelled", "completed"}


@dataclass
class MediaTask:
    id: str
    url: str = ""
    mode: str = "download"
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

    @property
    def directory(self):
        return TASK_ROOT / self.id


TASKS: dict[str, MediaTask] = {}


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
            "platform": task.platform, "download_url": None}
    if task.status == "ready" and task.mode == "download":
        data["download_url"] = f"/api/media/download-tasks/{task.id}/download"
    if task.status == "ready" and task.mode == "info":
        data["result"] = task.result
    return data


def create_task(url, height="720", mode="download", task_id=None):
    platform = detect_platform(url)
    task_id = normalize_id(task_id or uuid4())
    if task_id in TASKS:
        previous = TASKS[task_id]
        # DELETE может прийти раньше POST. Такая задача уже не должна стартовать.
        if previous.cancel.is_set():
            return previous
        raise HTTPException(409, "Этот идентификатор задачи уже используется")
    active = sum(task.status not in TERMINAL and task.status != "ready" for task in TASKS.values())
    if active >= settings.max_active_file_tasks:
        raise HTTPException(503, "Сервер уже занят, попробуйте чуть позже")
    if len(TASKS) >= settings.max_retained_media_tasks:
        raise HTTPException(503, "Слишком много задач, попробуйте чуть позже")
    task = MediaTask(task_id, url=url, height=str(height), mode=mode, platform=platform["id"])
    TASKS[task.id] = task
    task.runner = asyncio.create_task(run_task(task), name=f"media-{task.id}")
    return task


async def cancel_task(task_id):
    task_id = normalize_id(task_id)
    task = TASKS.get(task_id)
    if task is None:
        if len(TASKS) >= settings.max_retained_media_tasks:
            raise HTTPException(503, "Слишком много задач, попробуйте чуть позже")
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
    error_message = "Источник не отдал видео. Возможно, нужны авторизация или другая ссылка"
    while line := await process.stdout.readline():
        event = json.loads(line)
        if event.get("event") == "progress" and not task.cancel.is_set():
            task.stage = event["stage"]
            task.progress = event.get("progress")
        elif event.get("event") == "result":
            result = event["data"]
        elif event.get("event") == "error":
            error_message = event["message"]
    await process.wait()
    if process.returncode or result is None:
        raise RuntimeError(error_message)
    return result


async def drain_errors(process, task):
    # Ограниченный вывод в журнал; не накапливаем stderr длинного скачивания в RAM.
    async for line in process.stderr:
        logger.warning("Media worker %s: %s", task.id, line.decode("utf-8", errors="replace").rstrip()[:2000])


async def run_task(task):
    process = job = None
    readers = []
    succeeded = False
    try:
        if task.cancel.is_set():
            return
        task.status, task.stage = "running", "preparing"
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
        payload = {"url": task.url, "mode": task.mode, "height": task.height,
                   "directory": str(task.directory), "max_bytes": settings.media_max_bytes}
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
            raise TimeoutError("Превышено время обработки видео")
        task.result = output.result()
        if task.mode == "download":
            path = task.directory / task.result["filename"]
            if path.resolve().parent != task.directory.resolve() or not path.is_file():
                raise RuntimeError("Готовый файл не найден")
        # «Готово» публикуем только после остановки всей группы процессов ниже.
        # Иначе HTTP-ответ мог бы начать читать файл одновременно с очисткой.
        succeeded = True
    except Exception as error:
        logger.warning("Media task %s failed: %s", task.id, error)
        task.status = task.stage = "failed"
        task.error = str(error) if isinstance(error, (RuntimeError, TimeoutError)) else "Не удалось обработать видео"
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
        if task.status != "ready" or task.mode == "info":
            cleanup_directory(task)


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
    TASKS.clear()
