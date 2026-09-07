"""Локальный worker для проверки отмены; сетевых запросов не делает."""
import json
import subprocess
import sys
import time
from pathlib import Path


payload = json.loads(sys.stdin.readline())
directory = Path(payload["directory"])
from config import settings

conversion = "conversion" in payload["url"]
if conversion:
    command = [str(settings.ffmpeg_path), "-nostdin", "-re", "-f", "lavfi", "-i",
               "testsrc=size=64x64:rate=10", "-t", "600", "-f", "null", "-"]
else:
    command = [sys.executable, "-c", "import time; time.sleep(600)"]
child = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
(directory / "child.pid").write_text(str(child.pid), encoding="utf-8")
(directory / "video.part").write_bytes(b"partial download")
print(json.dumps({"event": "progress", "stage": "merging" if conversion else "downloading_file", "progress": 50}), flush=True)
if "ready" in payload["url"]:
    (directory / "output.mp4").write_bytes(b"video" * 100000)
    print(json.dumps({"event": "result", "data": {"filename": "output.mp4", "title": "Тест"}}), flush=True)
else:
    while True:
        time.sleep(1)
