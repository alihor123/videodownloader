from datetime import datetime, timezone

from database import new_session
from media.models import DownloadModel


async def add_download_stat(ip, user_agent, video_url, format_value, file_ext):
    """Сохраняет сведения об успешно завершённой передаче файла клиенту."""
    async with new_session() as session:
        session.add(
            DownloadModel(
                created_at=datetime.now(timezone.utc),
                ip=ip,
                user_agent=user_agent,
                video_url=video_url,
                format_value=str(format_value),
                file_ext=file_ext,
            )
        )
        await session.commit()


