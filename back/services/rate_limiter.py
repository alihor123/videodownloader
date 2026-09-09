"""Ограничение запросов по IP."""
from collections import OrderedDict, deque
from time import time

from fastapi import HTTPException, Request

from config import settings


def get_client_ip(request: Request):
    if settings.trust_proxy_headers:
        real_ip = request.headers.get("x-real-ip")
        if real_ip:
            return real_ip
        forwarded_for = request.headers.get("x-forwarded-for")
        if forwarded_for:
            return forwarded_for.split(",")[-1].strip()
    return request.client.host if request.client else "unknown"


class RateLimiter:
    max_clients = 10000

    def __init__(self, max_requests: int, period: int):
        self.max_requests = max_requests
        self.period = period
        self.history = OrderedDict()

    def __call__(self, request: Request):
        user_id = get_client_ip(request)
        now = time()
        timestamps = self.history.get(user_id)
        if timestamps is None:
            if len(self.history) >= self.max_clients:
                self.history.popitem(last=False)
            timestamps = deque()
            self.history[user_id] = timestamps
        self.history.move_to_end(user_id)
        cutoff = now - self.period
        while timestamps and timestamps[0] < cutoff:
            timestamps.popleft()
        if len(timestamps) >= self.max_requests:
            raise HTTPException(429, "Слишком много запросов, попробуйте позже")
        timestamps.append(now)
        return user_id
