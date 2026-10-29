from fastapi import FastAPI, APIRouter
import uvicorn
from config import settings
from database import lifespan
from deployment.router import deployment_router
from media.router import media_router

app = FastAPI(
    lifespan=lifespan,
    docs_url="/docs" if settings.enable_docs else None,
    redoc_url="/redoc" if settings.enable_docs else None,
    openapi_url="/openapi.json" if settings.enable_docs else None,
)

api_router = APIRouter(prefix="/api") #Главный роут

api_router.include_router(media_router, prefix="/media", tags=["Media"])
api_router.include_router(deployment_router, prefix="/deploy", tags=["Deploy"])

app.include_router(api_router) #Подключение к главному роуту


if __name__ == "__main__":
    # Reload запускает на Windows Selector loop, который не поддерживает asyncio subprocess.
    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=False)
