import asyncio
import logging
import mimetypes
from uuid import UUID
import httpx

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse

from config import settings
from media.statistics import add_download_stat
from proxies.statistics import add_proxy_download_success
from media.schemas import DownloadRequest, InfoRequest
from media.platforms import detect_platform
from media.tasks import (
    cancel_task, cleanup_directory, create_task, get_task, serialize_task,
)
from proxies.pool import get_proxy_url
from rate_limiter import RateLimiter
from media.formats import build_content_disposition


media_router = APIRouter()
info_limiter = RateLimiter(settings.info_rate_limit_requests, settings.info_rate_limit_period_sec)
download_limiter = RateLimiter(settings.file_download_rate_limit_requests, settings.file_download_rate_limit_period_sec)
fast_limiter = RateLimiter(settings.fast_download_rate_limit_requests, settings.fast_download_rate_limit_period_sec)
cancel_limiter = RateLimiter(120, 60)


def validate_url(url):
    """Проверяет поддерживаемую платформу и преобразует ошибку ссылки в HTTP-ответ."""
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
    """Проверяет лимит и ссылку, создаёт задачу и возвращает её состояние."""
    client_ip = (fast_limiter if body.format.fast else download_limiter)(request)
    validate_url(body.url)
    # Fast и file задачи расходятся по отдельным очередям после создания.
    task = create_task(body.url, height=body.format.height, task_id=body.task_id,
                       requested_fast=body.format.fast, ip=client_ip,
                       user_agent=request.headers.get("user-agent"), kind=body.format.kind)
    return serialize_task(task)


@media_router.get("/download-tasks/{task_id}")
async def status(task_id: UUID):
    """Возвращает текущее состояние задачи и обновляет время обращения клиента."""
    return serialize_task(get_task(task_id))


@media_router.delete("/download-tasks/{task_id}")
async def cancel(task_id: UUID, client_ip: str = Depends(cancel_limiter)):
    """Отменяет задачу и возвращает состояние после завершения её работы."""
    return serialize_task(await cancel_task(task_id))


class ManagedFileResponse(StreamingResponse):
    """Отмена из API прерывает и уже начавшуюся HTTP-передачу файла."""

    def __init__(self, task, path):
        """Подготавливает поток локального файла и заголовки скачивания."""
        self.task = task
        self.finished = False
        super().__init__(self.chunks(path), media_type=mimetypes.guess_type(path.name)[0] or "application/octet-stream",
                         headers={"Content-Disposition": build_content_disposition(task.result["title"], path.suffix[1:]),
                                  "Content-Length": str(path.stat().st_size)})

    async def chunks(self, path):
        """Читает локальный файл порциями до конца или сигнала отмены."""
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
        """Управляет передачей файла, отменой, очисткой и записью статистики успеха."""
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
                await add_proxy_download_success(task.proxy_key, task.platform)
            except Exception:
                logging.getLogger(__name__).exception("Cannot save download statistics")


class ManagedFastResponse(StreamingResponse):
    """Проксирует fast-поток и закрывает upstream при отмене клиента или задачи."""

    def __init__(self, task):
        """Подготавливает прямой поток через сервер, скрывая адрес и заголовки источника."""
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
        super().__init__(self.chunks(result["url"], headers, result.get("source_address"),
                                     get_proxy_url(task.proxy_key)), media_type=media_type,
                         headers=response_headers)

    async def chunks(self, url, headers, source_address, proxy_url):
        """Передаёт порции от источника через выбранный IP и закрывает соединение при выходе."""
        timeout = httpx.Timeout(settings.media_task_timeout_sec)
        transport = httpx.AsyncHTTPTransport(local_address=source_address, proxy=proxy_url)
        async with httpx.AsyncClient(follow_redirects=True, timeout=timeout, transport=transport) as client:
            async with client.stream("GET", url, headers=headers) as response:
                response.raise_for_status()
                async for chunk in response.aiter_bytes(256 * 1024):
                    if self.task.cancel.is_set():
                        return
                    yield chunk
                self.finished = True

    async def __call__(self, scope, receive, send):
        """Управляет прямой передачей, отменой, очисткой и записью статистики успеха."""
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
                await add_proxy_download_success(task.proxy_key, task.platform)
            except Exception:
                logging.getLogger(__name__).exception("Cannot save download statistics")


@media_router.get("/download-tasks/{task_id}/download")
async def download(task_id: UUID):
    """Проверяет готовность задачи и выбирает передачу файла или прямого потока."""
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
