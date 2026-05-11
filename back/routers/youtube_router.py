import asyncio
import os

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from services.youtube_service import (
    build_content_disposition,
    build_format_list,
    create_download_paths,
    extract_info,
    format_duration,
    format_views,
    get_download_ydl_opts,
    get_info_ydl_opts,
    get_media_type,
    get_output_ext,
    get_safe_title,
    remove_if_exists,
)


# Роутер для эндпоинтов, связанных с YouTube
youtube_router = APIRouter(prefix="/youtube", tags=["youtube"])


@youtube_router.get("/info")
async def get_video_info(
    url: str = Query(..., description="Ссылка на видео YouTube"),
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


@youtube_router.get("/download")
async def download_video(
    url: str = Query(..., description="Ссылка на YouTube видео"),
    height: str = Query(..., description="Качество из списка /info"),
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

    # 6. Отдаём готовый файл стандартным ответом Starlette.
    # FileResponse выставит Content-Length, а background удалит временный файл после ответа.
    safe_title = get_safe_title(info)
    return FileResponse(
        tmp_path,
        media_type=get_media_type(height),
        headers={"Content-Disposition": build_content_disposition(safe_title, output_ext)},
        background=BackgroundTask(remove_if_exists, tmp_path),
    )
