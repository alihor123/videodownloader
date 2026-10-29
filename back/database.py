from contextlib import asynccontextmanager

from fastapi import FastAPI
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from config import settings


engine = create_async_engine(f"sqlite+aiosqlite:///{settings.database_name}")
new_session = async_sessionmaker(engine, expire_on_commit=False)


async def get_session():
    """Открывает сессию БД на время обработки запроса и затем закрывает её."""
    async with new_session() as session:
        yield session


class Base(DeclarativeBase):
    """Общая база моделей таблиц приложения."""
    pass


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Создаёт таблицы, запускает обработку задач и освобождает ресурсы при остановке."""
    from media import models as media_models
    from proxies import models as proxy_models
    from media.tasks import start_tasks, shutdown_tasks

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    reaper = await start_tasks()
    try:
        yield
    finally:
        await shutdown_tasks(reaper)
        await engine.dispose()
