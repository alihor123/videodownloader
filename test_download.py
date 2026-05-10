#!/usr/bin/env python
"""Тест скачивания видео через yt-dlp с ffmpeg"""
import sys, os, tempfile

ffmpeg_path = r'c:\Users\Egor\Desktop\videodownloader\back\bin\ffmpeg.exe'
print(f"ffmpeg exists: {os.path.exists(ffmpeg_path)}", flush=True)

import yt_dlp

# Только путь, без создания файла
tmp_fd, tmp_path = tempfile.mkstemp(suffix='.mp4')
os.close(tmp_fd)
os.unlink(tmp_path)  # <-- ВАЖНО: удаляем пустой файл!
print(f"Temp path (file deleted): {tmp_path}", flush=True)

ydl_opts = {
    'format': 'bestvideo[height<=360]+bestaudio/best[height<=360]',
    'outtmpl': tmp_path,
    'merge_output_format': 'mp4',
    'ffmpeg_location': ffmpeg_path,
    'quiet': False,
    'no_warnings': False,
    'extractor_args': {'youtube': ['player_client=android,ios,web']},
}

try:
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info('https://www.youtube.com/watch?v=dQw4w9WgXcQ', download=True)
    
    size = os.path.getsize(tmp_path)
    print(f"Downloaded: {size} bytes ({size/1024/1024:.1f} MB)", flush=True)
    
    # Проверка MP4 заголовка
    with open(tmp_path, 'rb') as f:
        header = f.read(16)
    print(f"File header (hex): {header.hex()}", flush=True)
    
    if b'ftyp' in header:
        print("OK - MP4 header valid (ftyp box found)", flush=True)
    else:
        print("FAIL - NO MP4 header!", flush=True)
    
    print(f"Title: {info.get('title', 'N/A')}", flush=True)
except Exception as e:
    print(f"ERROR: {e}", flush=True)
    import traceback
    traceback.print_exc()
finally:
    if os.path.exists(tmp_path):
        os.unlink(tmp_path)
        print("Cleaned up", flush=True)
