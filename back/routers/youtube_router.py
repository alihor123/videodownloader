import asyncio

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel
from starlette.background import BackgroundTasks

from config import settings
from services.youtube_download_task_service import (
    create_download_task,
    delete_download_task,
    get_download_response_data,
    get_download_task,
    serialize_download_task,
    run_download_task,
)
from services.rate_limiter import RateLimiter
from services.youtube_service import (
    build_content_disposition,
    build_format_list,
    extract_info,
    format_duration,
    format_views,
    get_info_ydl_opts,
    remove_if_exists,
    stream_url,
)


# Роутер для эндпоинтов, связанных с YouTube
youtube_router = APIRouter(prefix="/youtube", tags=["youtube"])
info_rate_limiter = RateLimiter(
    max_requests=settings.info_rate_limit_requests,
    period=settings.info_rate_limit_period_sec,
)
fast_download_rate_limiter = RateLimiter(
    max_requests=settings.fast_download_rate_limit_requests,
    period=settings.fast_download_rate_limit_period_sec,
)
file_download_rate_limiter = RateLimiter(
    max_requests=settings.file_download_rate_limit_requests,
    period=settings.file_download_rate_limit_period_sec,
)


class DownloadFormat(BaseModel):
    height: int | str
    fast: bool = False


class CreateDownloadTaskRequest(BaseModel):
    url: str
    format: DownloadFormat


def download_task_rate_limiter(body: CreateDownloadTaskRequest, request: Request):
    """Выбирает лимит по типу скачивания: fast мягче, file строже."""
    if body.format.fast:
        return fast_download_rate_limiter(request)

    return file_download_rate_limiter(request)


@youtube_router.get("/info")
async def get_video_info(
    url: str = Query(..., description="Ссылка на видео YouTube"),
    client_ip: str = Depends(info_rate_limiter),
):
    """
    Получаем информацию о видео:
    название, автор, превью и список готовых форматов.
    """
    ydl_opts = get_info_ydl_opts()

    try:
        info = await asyncio.to_thread(extract_info, url, ydl_opts)
    except Exception:
        raise HTTPException(
            status_code=400,
            detail="Ой! Не удалось получить данные видео. Проверьте ссылку.",
        )

    formats = build_format_list(info)
    duration_str = format_duration(info.get("duration", 0))
    views_str = format_views(info.get("view_count", 0))

    return {
        "title": info.get("title", "Без названия"),
        "duration": duration_str,
        "views": views_str,
        "uploader": info.get("uploader", "Неизвестный автор"),
        "formats": formats,
    }


@youtube_router.post("/download-tasks")
async def create_youtube_download_task(
    body: CreateDownloadTaskRequest,
    request: Request,
    client_ip: str = Depends(download_task_rate_limiter),
):
    """
    Создает задачу скачивания и сразу возвращает task_id.
    Само скачивание идет в фоне, а фронт опрашивает статус отдельно.
    """
    task = create_download_task(
        url=body.url,
        height=body.format.height,
        requested_fast=body.format.fast,
        ip=client_ip,
        user_agent=request.headers.get("user-agent"),
    )

    asyncio.create_task(run_download_task(task.id))

    return serialize_download_task(task)


@youtube_router.get("/download-tasks/{task_id}")
async def get_youtube_download_task(task_id: str):
    """Возвращает текущий статус задачи для polling на фронте."""
    task = get_download_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Задача скачивания не найдена")

    return serialize_download_task(task)


@youtube_router.get("/download-tasks/{task_id}/download")
async def download_youtube_task_file(task_id: str):
    """
    Отдает уже готовый результат задачи:
    fast-формат стримится через сервер, обычный формат отдается из tmp.
    """
    task = get_download_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Задача скачивания не найдена")

    if task.status == "failed":
        raise HTTPException(status_code=409, detail=task.message)

    if task.status != "ready":
        raise HTTPException(status_code=409, detail="Файл еще не готов")

    response_data = get_download_response_data(task)
    headers = {
        "Content-Disposition": build_content_disposition(
            response_data["safe_title"],
            response_data["file_ext"],
        )
    }

    if response_data["mode"] == "fast" and response_data["direct_url"]:
        delete_download_task(task_id)

        return StreamingResponse(
            stream_url(response_data["direct_url"]),
            media_type=response_data["media_type"],
            headers=headers,
        )

    if response_data["mode"] == "file" and response_data["file_path"]:
        delete_download_task(task_id)

        background_tasks = BackgroundTasks()
        background_tasks.add_task(remove_if_exists, response_data["file_path"])

        return FileResponse(
            response_data["file_path"],
            media_type=response_data["media_type"],
            headers=headers,
            background=background_tasks,
        )

    raise HTTPException(status_code=500, detail="Готовый файл не найден")
