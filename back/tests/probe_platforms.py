"""Ручная сетевая проверка публичных примеров yt-dlp, без скачивания видео."""
import asyncio
import json
import tempfile
from pathlib import Path

from services import media_download_task_service as manager


EXAMPLES = {
    "youtube": "https://www.youtube.com/shorts/tWwvSrN7ffc",
    "rutube": "https://rutube.ru/video/3eac3b4561676c17df9132a9a1e62e3e/",
    "vk": "https://vk.com/video-77521_162222515",
    "twitter": "https://twitter.com/BrooklynNets/status/1349794411333394432",
    "tiktok": "https://www.tiktok.com/@leenabhushan/video/6748451240264420610",
    "instagram": "https://instagram.com/p/aye83DjauH/",
}


async def main():
    import sys
    semaphore = asyncio.Semaphore(3)
    with tempfile.TemporaryDirectory(prefix="media-probe-") as directory:
        manager.TASK_ROOT = Path(directory) / "tasks"

        async def probe(platform, url):
            async with semaphore:
                task = manager.create_task(url, mode="info")
                await task.runner
                print(json.dumps({"platform": platform, "url": url, "status": task.status,
                                  "formats": len((task.result or {}).get("formats", [])),
                                  "error": task.error}, ensure_ascii=True), flush=True)
                if "--download" in sys.argv and task.status == "ready" and platform == "rutube":
                    download = manager.create_task(url, height=task.result["formats"][0]["height"])
                    await download.runner
                    if download.status == "ready":
                        path = download.directory / download.result["filename"]
                        print(json.dumps({"download": platform, "status": download.status, "bytes": path.stat().st_size,
                                          "filename": path.name}), flush=True)
                    else:
                        print(json.dumps({"download": platform, "status": download.status, "error": download.error}), flush=True)
                    await manager.cancel_task(download.id)
                await manager.cancel_task(task.id)

        selected = {key: url for key, url in EXAMPLES.items() if len(sys.argv) == 1 or key in sys.argv or sys.argv[1] == "--download"}
        await asyncio.gather(*(probe(platform, url) for platform, url in selected.items()))


if __name__ == "__main__":
    asyncio.run(main())
