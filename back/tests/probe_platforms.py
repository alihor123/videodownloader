"""Сетевая проверка платформ: по умолчанию только информация, без скачивания видео.

Запуск из back: python -m tests.probe_platforms. Название платформы
выбирает встроенный пример, а HTTPS-ссылка проверяется напрямую.
Адреса источников, заголовки и содержимое cookies не выводятся.
"""
import asyncio
import json
import tempfile
from pathlib import Path

from media import tasks as manager
from media.platforms import detect_platform


EXAMPLES = {
    "youtube": "https://www.youtube.com/shorts/tWwvSrN7ffc",
    "rutube": "https://rutube.ru/video/3eac3b4561676c17df9132a9a1e62e3e/",
    "vk": "https://vk.com/video-77521_162222515",
    "twitter": "https://twitter.com/BrooklynNets/status/1349794411333394432",
    "tiktok": "https://www.tiktok.com/@leenabhushan/video/6748451240264420610",
    "instagram": "https://instagram.com/p/aye83DjauH/",
}


async def main():
    """Запускает параллельные проверки выбранных платформ во временном каталоге."""
    import sys
    semaphore = asyncio.Semaphore(3)
    with tempfile.TemporaryDirectory(prefix="media-probe-") as directory:
        manager.TASK_ROOT = Path(directory) / "tasks"
        reaper = await manager.start_tasks()

        async def probe(platform, url):
            """Получает форматы платформы и при запросе проверяет скачивание с Rutube."""
            async with semaphore:
                task = manager.create_task(url, mode="info")
                while task.status not in {"ready", "failed", "cancelled"}:
                    await asyncio.sleep(0.1)
                print(json.dumps({"platform": platform, "status": task.status,
                                  "formats": len((task.result or {}).get("formats", [])),
                                  "fast_formats": sum(1 for item in (task.result or {}).get("formats", []) if item.get("fast")),
                                  "fast_labels": [item.get("label") for item in (task.result or {}).get("formats", []) if item.get("fast")],
                                  "error": task.error}, ensure_ascii=True), flush=True)
                if "--download" in sys.argv and task.status == "ready" and platform == "rutube":
                    download = manager.create_task(url, height=task.result["formats"][0]["height"])
                    while download.status not in {"ready", "failed", "cancelled"}:
                        await asyncio.sleep(0.1)
                    if download.status == "ready":
                        path = download.directory / download.result["filename"]
                        print(json.dumps({"download": platform, "status": download.status, "bytes": path.stat().st_size,
                                          "filename": path.name}), flush=True)
                    else:
                        print(json.dumps({"download": platform, "status": download.status, "error": download.error}), flush=True)
                    await manager.cancel_task(download.id)
                await manager.cancel_task(task.id)

        try:
            args = [arg for arg in sys.argv[1:] if arg != "--download"]
            custom = next((arg for arg in args if arg.startswith("https://")), None)
            if custom:
                selected = {detect_platform(custom)["id"]: custom}
            else:
                selected = {key: url for key, url in EXAMPLES.items() if not args or key in args or "--download" in sys.argv}
            await asyncio.gather(*(probe(platform, url) for platform, url in selected.items()))
        finally:
            await manager.shutdown_tasks(reaper)


if __name__ == "__main__":
    asyncio.run(main())
