from datetime import datetime, timezone

from database.database import DownloadModel, new_session


async def add_download_stat(ip, user_agent, video_url, format_value, file_ext):
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
