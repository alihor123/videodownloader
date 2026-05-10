import requests

# Получаем информацию о видео
res = requests.get("http://127.0.0.1:8000/api/youtube/info", params={"url": "https://www.youtube.com/watch?v=RLkGvG9rWMg"})
print(res.json())
