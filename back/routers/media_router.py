import asyncio
import logging
import mimetypes
from typing import Literal
from uuid import UUID
import httpx

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from config import settings
from database.db_tools import add_download_stat
from services.media_platforms import detect_platform
from services.media_tasks import (
    cancel_task, cleanup_directory, create_task, get_task, serialize_task,
)
from services.rate_limiter import RateLimiter
from services.media_formats import build_content_disposition


media_router = APIRouter()
info_limiter = RateLimiter(settings.info_rate_limit_requests, settings.info_rate_limit_period_sec)
download_limiter = RateLimiter(settings.file_download_rate_limit_requests, settings.file_download_rate_limit_period_sec)
fast_limiter = RateLimiter(settings.fast_download_rate_limit_requests, settings.fast_download_rate_limit_period_sec)
cancel_limiter = RateLimiter(120, 60)


class InfoRequest(BaseModel):
    url: str = Field(min_length=1, max_length=2048)
    task_id: UUID | None = None


class DownloadFormat(BaseModel):
    height: int = Field(ge=1, le=4320)
    fast: bool = False
    kind: Literal["video", "audio"] = "video"


class DownloadRequest(InfoRequest):
    format: DownloadFormat


def validate_url(url):
    try:
        return detect_platform(url)
    except ValueError as error:
        raise HTTPException(400, str(error))


@media_router.post("/info")
async def get_info(body: InfoRequest, request: Request, client_ip: str = Depends(info_limiter)):
    """Один запрос метаданных; при разрыве соединения worker тоже останавливается."""
    validate_url(body.url)
    task = create_task(body.url, mode="info", task_id=body.task_id, ip=client_ip,
                       user_agent=request.headers.get("user-agent"))
    try:
        while task.status not in {"ready", "failed", "cancelled", "completed"}:
            if await request.is_disconnected():
                raise HTTPException(499, "Запрос отменён")
            await asyncio.sleep(0.1)
        if task.status != "ready":
            raise HTTPException(400, task.error or "Запрос отменён")
        return task.result
    finally:
        await asyncio.shield(cancel_task(task.id))


@media_router.post("/download-tasks")
async def create_download(body: DownloadRequest, request: Request):
    client_ip = (fast_limiter if body.format.fast else download_limiter)(request)
    validate_url(body.url)
    # Fast и file задачи расходятся по отдельным очередям после создания.
    task = create_task(body.url, height=body.format.height, task_id=body.task_id,
                       requested_fast=body.format.fast, ip=client_ip,
                       user_agent=request.headers.get("user-agent"), kind=body.format.kind)
    return serialize_task(task)


@media_router.get("/download-tasks/{task_id}")
async def status(task_id: UUID):
    return serialize_task(get_task(task_id))


@media_router.delete("/download-tasks/{task_id}")
async def cancel(task_id: UUID, client_ip: str = Depends(cancel_limiter)):
    return serialize_task(await cancel_task(task_id))


class ManagedFileResponse(StreamingResponse):
    """Отмена из API прерывает и уже начавшуюся HTTP-передачу файла."""

    def __init__(self, task, path):
        self.task = task
        self.finished = False
        super().__init__(self.chunks(path), media_type=mimetypes.guess_type(path.name)[0] or "application/octet-stream",
                         headers={"Content-Disposition": build_content_disposition(task.result["title"], path.suffix[1:]),
                                  "Content-Length": str(path.stat().st_size)})

    async def chunks(self, path):
        # Небольшие чтения, без накопления видео в памяти приложения.
        with path.open("rb") as file:
            while not self.task.cancel.is_set():
                chunk = file.read(256 * 1024)
                if not chunk:
                    self.finished = True
                    return
                yield chunk
                await asyncio.sleep(0)

    async def __call__(self, scope, receive, send):
        task = self.task
        task.streaming = True
        sending = asyncio.create_task(super().__call__(scope, receive, send))
        cancelled = asyncio.create_task(task.cancel.wait())
        delivered = False
        try:
            await asyncio.wait([sending, cancelled], timeout=settings.media_task_timeout_sec,
                               return_when=asyncio.FIRST_COMPLETED)
            if sending.done():
                await sending
                delivered = self.finished
        finally:
            sending.cancel()
            cancelled.cancel()
            await asyncio.gather(sending, cancelled, return_exceptions=True)
            await self.body_iterator.aclose()
            task.streaming = False
            task.status = task.stage = "completed" if delivered and not task.cancel.is_set() else "cancelled"
            cleanup_directory(task)
            task.transfer_done.set()
        if task.status == "completed":
            try:
                await add_download_stat(ip=task.ip, user_agent=task.user_agent, video_url=task.url,
                                        format_value=task.height, file_ext=task.result["filename"].rsplit(".", 1)[-1])
            except Exception:
                logging.getLogger(__name__).exception("Cannot save download statistics")


class ManagedFastResponse(StreamingResponse):
    """Проксирует fast-поток и закрывает upstream при отмене клиента или задачи."""

    def __init__(self, task):
        self.task = task
        self.finished = False
        result = task.result
        headers = result.get("headers") or {}
        response_headers = {
            "Content-Disposition": build_content_disposition(result.get("title") or result["filename"],
                                                              result.get("ext") or "mp4"),
        }
        if result.get("media_type"):
            media_type = result["media_type"]
        else:
            media_type = "application/octet-stream"
        if result.get("filesize"):
            response_headers["Content-Length"] = str(result["filesize"])
        super().__init__(self.chunks(result["url"], headers, result.get("source_address")), media_type=media_type,
                         headers=response_headers)

    async def chunks(self, url, headers, source_address):
        timeout = httpx.Timeout(settings.media_task_timeout_sec)
        transport = httpx.AsyncHTTPTransport(local_address=source_address) if source_address else None
        async with httpx.AsyncClient(follow_redirects=True, timeout=timeout, transport=transport) as client:
            async with client.stream("GET", url, headers=headers) as response:
                response.raise_for_status()
                async for chunk in response.aiter_bytes(256 * 1024):
                    if self.task.cancel.is_set():
                        return
                    yield chunk
                self.finished = True

    async def __call__(self, scope, receive, send):
        task = self.task
        task.streaming = True
        sending = asyncio.create_task(super().__call__(scope, receive, send))
        cancelled = asyncio.create_task(task.cancel.wait())
        delivered = False
        try:
            done, _ = await asyncio.wait([sending, cancelled], timeout=settings.media_task_timeout_sec,
                                         return_when=asyncio.FIRST_COMPLETED)
            if sending in done:
                await sending
                delivered = self.finished
        finally:
            sending.cancel()
            cancelled.cancel()
            await asyncio.gather(sending, cancelled, return_exceptions=True)
            if hasattr(self.body_iterator, "aclose"):
                await self.body_iterator.aclose()
            task.streaming = False
            task.status = task.stage = "completed" if delivered and not task.cancel.is_set() else "cancelled"
            cleanup_directory(task)
            task.transfer_done.set()
        if task.status == "completed":
            try:
                await add_download_stat(ip=task.ip, user_agent=task.user_agent, video_url=task.url,
                                        format_value=task.height, file_ext=task.result.get("ext", "mp4"))
            except Exception:
                logging.getLogger(__name__).exception("Cannot save download statistics")


@media_router.get("/download-tasks/{task_id}/download")
async def download(task_id: UUID):
    task = get_task(task_id)
    if task.status != "ready" or task.mode != "download":
        raise HTTPException(409, "Файл ещё не готов или загрузка уже завершена")
    if task.delivery_mode == "fast":
        task.status = task.stage = "sending"
        return ManagedFastResponse(task)
    path = task.directory / task.result["filename"]
    if not path.is_file():
        raise HTTPException(410, "Срок хранения файла истёк")
    response = ManagedFileResponse(task, path)
    task.status = task.stage = "sending"
    return response
