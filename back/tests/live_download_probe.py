"""Проверка реального скачивания без сохранения результата в проекте.

Запуск из back:
python -m tests.live_download_probe https://example/video --mode file
или python -m tests.live_download_probe https://example/video --mode fast.

Обычный режим проверяет готовый непустой временный файл. Быстрый режим
читает не более 256 КиБ и затем отменяет задачу: неполная передача
не считается завершённой. Вывод содержит только платформу, режим,
состояние, число байтов и безопасное сообщение об ошибке.
"""
import argparse
import asyncio
import inspect
import tempfile
from pathlib import Path

from media.router import ManagedFastResponse
from media import tasks as manager
from media.platforms import detect_platform

MAX_FAST_BYTES = 256 * 1024


async def wait_terminal(task, timeout=900):
    """Дожидается готовности или завершения задачи в пределах заданного времени."""
    deadline = asyncio.get_running_loop().time() + timeout
    while task.status not in {"ready", "failed", "cancelled", "completed"}:
        if asyncio.get_running_loop().time() >= deadline:
            raise TimeoutError("task did not reach a terminal status")
        await asyncio.sleep(0.1)


async def probe(url, mode):
    """Проверяет файл целиком либо начало прямого потока и затем освобождает задачу."""
    platform = detect_platform(url)["id"]
    info = manager.create_task(url, mode="info")
    await wait_terminal(info)
    if info.status != "ready":
        await manager.cancel_task(info.id)
        return {"platform": platform, "mode": mode, "status": info.status,
                "bytes": 0, "error": info.error or "info failed"}

    formats = (info.result or {}).get("formats", [])
    candidates = [item for item in formats if item.get("kind", "video") == "video" and item.get("height")
                  and item.get("ext") in {"mp4", "webm", "mkv"}]
    if mode == "fast":
        candidates = [item for item in candidates if item.get("fast")]
    if not candidates:
        await manager.cancel_task(info.id)
        return {"platform": platform, "mode": mode, "status": "failed", "bytes": 0,
                "error": "no suitable format"}
    height = min(int(item["height"]) for item in candidates)
    await manager.cancel_task(info.id)

    task_args = {"height": height, "requested_fast": mode == "fast"}
    if "kind" in inspect.signature(manager.create_task).parameters:
        task_args["kind"] = "video"
    task = manager.create_task(url, **task_args)
    bytes_read = 0
    error = None
    status = "failed"
    try:
        await wait_terminal(task)
        if task.status != "ready":
            error = task.error or "download failed"
        elif task.delivery_mode == "file":
            path = task.directory / task.result["filename"]
            bytes_read = path.stat().st_size
            if bytes_read == 0:
                error = "empty output file"
            else:
                status = "passed"
        else:
            response = ManagedFastResponse(task)
            stream = response.body_iterator
            try:
                async for chunk in stream:
                    bytes_read += len(chunk)
                    if bytes_read >= MAX_FAST_BYTES:
                        break
            finally:
                await stream.aclose()
            # Неполная передача прямого потока не считается завершённой.
            status = "passed" if bytes_read else "failed"
            if not bytes_read:
                error = "fast stream returned no data"
    except Exception as exc:
        error = str(exc)[:300]
    finally:
        await manager.cancel_task(task.id)
    return {"platform": platform, "mode": mode,
            "delivery": task.delivery_mode, "status": status,
            "bytes": bytes_read, "error": error}


async def main():
    """Читает параметры запуска и выполняет проверку скачивания во временном каталоге."""
    parser = argparse.ArgumentParser()
    parser.add_argument("url", help="public https video URL")
    parser.add_argument("--mode", choices=("file", "fast"), default="file")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="live-media-probe-") as directory:
        manager.TASK_ROOT = Path(directory) / "tasks"
        reaper = await manager.start_tasks()
        try:
            result = await probe(args.url, args.mode)
            result.setdefault("delivery", "none")
            print("platform={platform} mode={mode} delivery={delivery} status={status} "
                  "bytes={bytes} error={error}".format(**result))
        finally:
            await manager.shutdown_tasks(reaper)


if __name__ == "__main__":
    asyncio.run(main())
