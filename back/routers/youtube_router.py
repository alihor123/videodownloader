import asyncio
import os

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import FileResponse, StreamingResponse
from starlette.background import BackgroundTask

from database.db_tools import add_download_stat
from services.rate_limiter import RateLimiter
from services.youtube_service import (
    build_content_disposition,
    build_format_list,
    create_download_paths,
    extract_info,
    format_duration,
    format_views,
    get_download_ydl_opts,
    get_fast_format_url,
    get_info_ydl_opts,
    get_media_type,
    get_output_ext,
    get_safe_title,
    remove_if_exists,
)


# Роутер для эндпоинтов, связанных с YouTube
youtube_router = APIRouter(prefix="/youtube", tags=["youtube"])
info_rate_limiter = RateLimiter(max_requests=20, period=60)
download_rate_limiter = RateLimiter(max_requests=5, period=60)


async def stream_url(url):
    """Потоково читает прямую ссылку, не сохраняя файл на сервер."""
    async with httpx.AsyncClient(follow_redirects=True) as client:
        async with client.stream("GET", url) as response:
            response.raise_for_status()
            async for chunk in response.aiter_bytes():
                yield chunk


@youtube_router.get("/info")
async def get_video_info(
    url: str = Query(..., description="Ссылка на видео YouTube"),
    client_ip: str = Depends(info_rate_limiter),
):
    """
    Получаем информацию о видео:
    название, автор, превью и список готовых форматов.
    """

    # 1. Настройки нашего помощника yt-dlp
    ydl_opts = get_info_ydl_opts()

    # 2. Аккуратно запрашиваем данные
    try:
        info = await asyncio.to_thread(extract_info, url, ydl_opts)
    except Exception:
        raise HTTPException(
            status_code=400,
            detail="Ой! Не удалось получить данные видео. Проверьте ссылку.",
        )

    # 3. Перебираем форматы и упаковываем их для фронта
    formats = build_format_list(info)

    # 4. Готовим метаданные для отображения
    duration_str = format_duration(info.get("duration", 0))
    views_str = format_views(info.get("view_count", 0))

    return {
        "title": info.get("title", "Без названия"),
        "duration": duration_str,
        "views": views_str,
        "uploader": info.get("uploader", "Неизвестный автор"),
        "formats": formats,
    }


@youtube_router.get("/download-url")
async def get_download_url(
    request: Request,
    url: str = Query(..., description="Ссылка на YouTube видео"),
    height: str = Query(..., description="Качество из списка /info"),
    client_ip: str = Depends(download_rate_limiter),
):
    """
    Возвращает прямую ссылку на готовый mp4-формат, если YouTube отдаёт его без склейки.
    """

    # 1. Получаем прямую ссылку на быстрый формат
    ydl_opts = get_info_ydl_opts()
    try:
        info = await asyncio.to_thread(extract_info, url, ydl_opts)
    except Exception:
        raise HTTPException(
            status_code=400,
            detail="Ой! Не удалось получить прямую ссылку. Попробуйте обычное скачивание.",
        )

    fast_format_url = get_fast_format_url(info, height)
    if not fast_format_url:
        raise HTTPException(status_code=404, detail="Быстрая ссылка не найдена")

    await add_download_stat(
        ip=client_ip,
        user_agent=request.headers.get("user-agent"),
        video_url=url,
        format_value=height,
        file_ext=get_output_ext(height),
    )

    return {"url": fast_format_url}


@youtube_router.get("/download-stream")
async def download_stream(
    request: Request,
    url: str = Query(..., description="Ссылка на YouTube видео"),
    height: str = Query(..., description="Качество из списка /info"),
    client_ip: str = Depends(download_rate_limiter),
):
    """
    Отдаёт готовый mp4-формат потоком через сервер, без временного файла и ffmpeg.
    """

    # 1. Получаем прямую ссылку на быстрый формат
    ydl_opts = get_info_ydl_opts()
    try:
        info = await asyncio.to_thread(extract_info, url, ydl_opts)
    except Exception:
        raise HTTPException(
            status_code=400,
            detail="Ой! Не удалось получить прямую ссылку. Попробуйте обычное скачивание.",
        )

    fast_format_url = get_fast_format_url(info, height)
    if not fast_format_url:
        raise HTTPException(status_code=404, detail="Быстрая ссылка не найдена")

    await add_download_stat(
        ip=client_ip,
        user_agent=request.headers.get("user-agent"),
        video_url=url,
        format_value=height,
        file_ext=get_output_ext(height),
    )

    # 2. Отдаём поток с нормальным именем файла для браузера
    safe_title = get_safe_title(info)
    output_ext = get_output_ext(height)
    return StreamingResponse(
        stream_url(fast_format_url),
        media_type=get_media_type(height),
        headers={"Content-Disposition": build_content_disposition(safe_title, output_ext)},
    )


@youtube_router.get("/download-file")
async def download_file(
    request: Request,
    url: str = Query(..., description="Ссылка на YouTube видео"),
    height: str = Query(..., description="Качество из списка /info"),
    client_ip: str = Depends(download_rate_limiter),
):
    """
    Скачивает видео или аудио на сервер, готовит итоговый файл
    и отдаёт пользователю. После ответа сервер убирает временный файл.
    """

    # 1. Определяем итоговый формат и временные пути
    output_ext = get_output_ext(height)
    download_path, tmp_path = create_download_paths(height, output_ext)

    # 2. Логируем переход yt-dlp к ffmpeg/postprocessing
    def progress_hook(data):
        if data["status"] == "finished":
            print("  Скачивание завершено, запуск ffmpeg...", flush=True)

    # 3. Собираем настройки yt-dlp для выбранного качества
    ydl_opts = get_download_ydl_opts(height, output_ext, download_path, progress_hook)

    # 4. Скачиваем в отдельном потоке, чтобы не блокировать FastAPI event loop
    def fetch_video():
        print(f"Скачивание видео... (качество: {height})", flush=True)
        return extract_info(url, ydl_opts, download=True)

    try:
        info = await asyncio.to_thread(fetch_video)
    except Exception as error:
        remove_if_exists(tmp_path)
        remove_if_exists(download_path)
        raise HTTPException(
            status_code=400,
            detail=f"Ой! Ошибка загрузки видео: {str(error)}",
        )

    # 5. Проверяем, что итоговый файл действительно появился
    if not os.path.exists(tmp_path):
        print(f"  ОШИБКА: файл {tmp_path} не найден!", flush=True)
        raise HTTPException(
            status_code=500,
            detail="Файл не найден после скачивания",
        )

    file_size = os.path.getsize(tmp_path)
    print(f"  Файл готов: {file_size} байт", flush=True)

    await add_download_stat(
        ip=client_ip,
        user_agent=request.headers.get("user-agent"),
        video_url=url,
        format_value=height,
        file_ext=output_ext,
    )

    # 6. Отдаём готовый файл стандартным ответом Starlette.
    # FileResponse выставит Content-Length, а background удалит временный файл после ответа.
    safe_title = get_safe_title(info)
    return FileResponse(
        tmp_path,
        media_type=get_media_type(height),
        headers={"Content-Disposition": build_content_disposition(safe_title, output_ext)},
        background=BackgroundTask(remove_if_exists, tmp_path),
    )
