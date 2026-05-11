# Ограничение запросов по IP.

from fastapi import HTTPException, Request
from time import time


def get_client_ip(request: Request):
    forwarded_for = request.headers.get("x-forwarded-for")
    if forwarded_for:
        return forwarded_for.split(",")[0].strip()

    real_ip = request.headers.get("x-real-ip")
    if real_ip:
        return real_ip

    if request.client:
        return request.client.host

    return "unknown"


class RateLimiter:
    def __init__(self, max_requests: int, period: int): #Запросов в промежуток времени
        self.max_requests = max_requests
        self.period = period
        self.history = {}

    def __call__(self, request: Request):
        user_id = get_client_ip(request)
        current_time = time()

        if user_id not in self.history:
            self.history[user_id] = []

        new_history = []
        for old_time in self.history[user_id]:
            if current_time - old_time < self.period:
                new_history.append(old_time)
        self.history[user_id] = new_history

        if len(self.history[user_id]) >= self.max_requests:
            raise HTTPException(status_code=429, detail="Rate limit exceeded")
        
        self.history[user_id].append(current_time)
    
        return user_id
        
