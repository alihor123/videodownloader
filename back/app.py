from fastapi import FastAPI, APIRouter
import uvicorn
from routers.youtube_router import youtube_router

app = FastAPI()

api_router = APIRouter(prefix="/api") #Главный роут

api_router.include_router(youtube_router, tags=["YouTube"])

app.include_router(api_router) #Подключение к главному роуту


if __name__ == "__main__":
    # reload=True отключён: он убивает in-progress скачивания при любом изменении файла.
    # Для разработки можно включить обратно (reload=True), но скачивание будет снова ломаться.
    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=True)
