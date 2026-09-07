from contextlib import asynccontextmanager
from datetime import datetime

from fastapi import FastAPI
from sqlalchemy import DateTime, String, Text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from config import settings


engine = create_async_engine(f"sqlite+aiosqlite:///{settings.database_name}")
new_session = async_sessionmaker(engine, expire_on_commit=False)


async def get_session():
    async with new_session() as session:
        yield session


class Base(DeclarativeBase):
    pass


class DownloadModel(Base):
    __tablename__ = "downloads"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    ip: Mapped[str] = mapped_column(String(45), nullable=False)
    user_agent: Mapped[str | None] = mapped_column(Text)
    video_url: Mapped[str | None] = mapped_column(Text)
    format_value: Mapped[str | None] = mapped_column(String(32))
    file_ext: Mapped[str | None] = mapped_column(String(16))


@asynccontextmanager
async def lifespan(app: FastAPI):
    from services.media_tasks import start_tasks, shutdown_tasks

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    reaper = await start_tasks()
    try:
        yield
    finally:
        await shutdown_tasks(reaper)
        await engine.dispose()
