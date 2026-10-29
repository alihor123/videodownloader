from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field


class InfoRequest(BaseModel):
    """Данные запроса информации о видео с необязательным идентификатором задачи."""
    url: str = Field(min_length=1, max_length=2048)
    task_id: UUID | None = None


class DownloadFormat(BaseModel):
    """Параметры выбранного качества, типа медиа и режима скачивания."""
    height: int = Field(ge=1, le=4320)
    fast: bool = False
    kind: Literal["video", "audio"] = "video"


class DownloadRequest(InfoRequest):
    """Данные для создания задачи скачивания видео или аудио."""
    format: DownloadFormat


