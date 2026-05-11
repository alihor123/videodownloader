import asyncio
import os
from datetime import datetime, timezone
from threading import RLock
from uuid import uuid4

from database.db_tools import add_download_stat
from pydantic import BaseModel, ConfigDict
from services.youtube_service import (
    create_download_paths,
    extract_info,
    get_download_ydl_opts,
    get_fast_format_url,
    get_info_ydl_opts,
    get_media_type,
    get_output_ext,
    get_safe_title,
    remove_if_exists,
)
from services.youtube_download_stages import get_stage_message


TASKS = {}
TASKS_LOCK = RLock()


class DownloadTask(BaseModel):
    """Внутреннее состояние задачи, с которым работает backend."""

    model_config = ConfigDict(validate_assignment=True)

    id: str
    url: str
    height: str
    requested_fast: bool
    ip: str
    user_agent: str | None
    status: str = "queued"
    stage: str = "queued"
    message: str = get_stage_message("queued")
    progress: int | None = None
    error: str | None = None
    mode: str | None = None
    direct_url: str | None = None
    file_path: str | None = None
    safe_title: str = "video"
    created_at: str = ""
    updated_at: str = ""


class DownloadTaskResponse(BaseModel):
    """Короткий ответ для фронта во время polling."""

    task_id: str
    status: str
    stage: str
    message: str
    progress: int | None = None
    error: str | None = None
    download_url: str | None = None


def now_date():
    """Возвращает текущее UTC-время строкой для created_at/updated_at."""
    return datetime.now(timezone.utc).isoformat()


def save_download_task(task):
    """Кладет задачу в общий словарь под lock, чтобы запись была атомарной."""
    with TASKS_LOCK:
        TASKS[task.id] = task


def get_download_task(task_id):
    """Безопасно читает задачу из общего словаря."""
    with TASKS_LOCK:
        return TASKS.get(task_id)


def delete_download_task(task_id):
    """Закрывает задачу: удаляет ее из памяти, когда результат уже отдан браузеру."""
    with TASKS_LOCK:
        TASKS.pop(task_id, None)


def update_download_task(task_id, **values):
    """Безопасно обновляет задачу и держит lock на чтение и запись сразу."""
    with TASKS_LOCK:
        # Здесь нельзя сначала вызвать get_download_task(), а потом отдельно писать:
        # между чтением и записью другая задача могла бы изменить тот же объект.
        task = TASKS.get(task_id)
        if not task:
            return None

        if "stage" in values and "message" not in values:
            values["message"] = get_stage_message(values["stage"])

        for key, value in values.items():
            setattr(task, key, value)

        task.updated_at = now_date()
        return task


def get_download_progress(data):
    """Достает процент загрузки из progress-события yt-dlp."""
    total = data.get("total_bytes") or data.get("total_bytes_estimate")
    downloaded = data.get("downloaded_bytes")

    if not total or not downloaded:
        return None

    return min(99, round(downloaded * 100 / total))


def get_ydl_download_stage(data):
    """Определяет, какой поток сейчас скачивает yt-dlp: видео или аудио."""
    filename = (data.get("tmpfilename") or data.get("filename") or "").lower()
    if filename.endswith((".m4a", ".mp3", ".opus", ".aac", ".wav")):
        return "downloading_audio"

    info = data["info_dict"]
    vcodec = info.get("vcodec")
    acodec = info.get("acodec")

    if vcodec and vcodec != "none":
        return "downloading_video"

    if acodec and acodec != "none":
        return "downloading_audio"

    return "downloading_video"


def create_progress_hook(task_id, height):
    """Создает callback, через который yt-dlp обновляет stage/progress задачи."""
    file_ext = get_output_ext(height)

    def progress_hook(data):
        if data.get("status") == "downloading":
            update_download_task(
                task_id,
                stage=get_ydl_download_stage(data),
                progress=get_download_progress(data),
            )
            return

        if data.get("status") == "finished":
            if file_ext == "mp3":
                stage = "decoding_audio"
            else:
                stage = "merging"

            update_download_task(task_id, stage=stage, progress=None)

    return progress_hook


async def save_download_stat(task, file_ext):
    """Пишет статистику после успешной подготовки fast-ссылки или файла."""
    await add_download_stat(
        ip=task.ip,
        user_agent=task.user_agent,
        video_url=task.url,
        format_value=task.height,
        file_ext=file_ext,
    )


def serialize_download_task(task):
    """Превращает внутреннюю задачу в безопасный ответ для фронта."""
    payload = DownloadTaskResponse(
        task_id=task.id,
        status=task.status,
        stage=task.stage,
        message=task.message,
        progress=task.progress,
        error=task.error,
    )

    if task.status == "ready":
        payload.download_url = f"/api/youtube/download-tasks/{task.id}/download"

    return payload.model_dump()


def get_download_response_data(task):
    """Готовит внутренние данные, которые нужны download endpoint для отдачи файла."""
    file_ext = get_output_ext(task.height)

    return {
        "mode": task.mode,
        "direct_url": task.direct_url,
        "file_path": task.file_path,
        "media_type": get_media_type(task.height),
        "safe_title": task.safe_title,
        "file_ext": file_ext,
    }


def create_download_task(url, height, requested_fast, ip, user_agent):
    """Создает задачу и сохраняет ее в памяти до запуска фоновой работы."""
    height = str(height)
    current_time = now_date()

    task = DownloadTask(
        id=uuid4().hex,
        url=url,
        height=height,
        requested_fast=bool(requested_fast),
        ip=ip,
        user_agent=user_agent,
        created_at=current_time,
        updated_at=current_time,
    )

    save_download_task(task)
    return task


async def prepare_fast_download(task_id):
    """Пробует подготовить fast-скачивание через прямую ссылку YouTube."""
    task = get_download_task(task_id)
    if not task:
        return False

    file_ext = get_output_ext(task.height)

    update_download_task(
        task_id,
        stage="resolving_fast_url",
    )

    try:
        info = await asyncio.to_thread(extract_info, task.url, get_info_ydl_opts())
        direct_url = get_fast_format_url(info, task.height)
    except Exception:
        direct_url = None
        info = None

    if not direct_url or not info:
        update_download_task(
            task_id,
            stage="fallback_to_file",
        )
        return False

    update_download_task(
        task_id,
        status="ready",
        stage="ready",
        mode="fast",
        direct_url=direct_url,
        safe_title=get_safe_title(info),
    )

    await save_download_stat(task, file_ext)
    return True


async def prepare_file_download(task_id):
    """Скачивает и при необходимости склеивает/конвертирует файл на сервере."""
    task = get_download_task(task_id)
    if not task:
        return

    file_ext = get_output_ext(task.height)
    download_path, tmp_path = create_download_paths(task.height, file_ext)
    progress_hook = create_progress_hook(task_id, task.height)
    ydl_opts = get_download_ydl_opts(task.height, file_ext, download_path, progress_hook)

    try:
        update_download_task(
            task_id,
            stage="downloading_file",
            mode="file",
        )

        info = await asyncio.to_thread(
            extract_info,
            task.url,
            ydl_opts,
            True,
        )

        if not os.path.exists(tmp_path):
            raise FileNotFoundError("Файл не найден после скачивания")

        update_download_task(
            task_id,
            status="ready",
            stage="ready",
            file_path=tmp_path,
            safe_title=get_safe_title(info),
            progress=100,
        )

        await save_download_stat(task, file_ext)
    except Exception:
        remove_if_exists(tmp_path)
        remove_if_exists(download_path)
        raise


async def run_download_task(task_id):
    """Ведет задачу от queued до ready/failed в фоновой async-задаче."""
    task = get_download_task(task_id)
    if not task:
        return

    update_download_task(
        task_id,
        status="running",
        stage="preparing",
    )

    try:
        if task.requested_fast:
            fast_ready = await prepare_fast_download(task_id)
            if fast_ready:
                return

        await prepare_file_download(task_id)
    except Exception as error:
        task = get_download_task(task_id)
        if task and task.file_path:
            remove_if_exists(task.file_path)

        update_download_task(
            task_id,
            status="failed",
            stage="failed",
            error=str(error),
        )
