import hashlib
import hmac
import re

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request, status

from config import settings
from deployment.service import deployment_service


deployment_router = APIRouter()
COMMIT_PATTERN = re.compile(r"^[0-9a-f]{40}$")
MAX_PAYLOAD_BYTES = 1024 * 1024


def verify_github_signature(body: bytes, signature: str | None) -> bool:
    """Проверяет подпись тела webhook с помощью секрета GitHub."""
    if not settings.deploy_webhook_secret or not signature:
        return False
    digest = hmac.new(
        settings.deploy_webhook_secret.get_secret_value().encode(),
        body,
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(signature, f"sha256={digest}")


def get_push_commit(payload: dict) -> str | None:
    """Возвращает корректный SHA коммита только для разрешённой ветки."""
    expected_ref = f"refs/heads/{settings.deploy_branch}"
    if payload.get("ref") != expected_ref or payload.get("deleted"):
        return None
    commit = payload.get("after", "")
    if not COMMIT_PATTERN.fullmatch(commit):
        raise HTTPException(400, "GitHub прислал некорректный commit SHA")
    return commit


@deployment_router.post("/github", status_code=status.HTTP_202_ACCEPTED)
async def github_webhook(request: Request, background_tasks: BackgroundTasks):
    """Принимает только подписанный push нужной ветки."""
    if not settings.deploy_enabled or not settings.deploy_webhook_secret:
        raise HTTPException(404, "Автодеплой выключен")

    body = await request.body()
    if len(body) > MAX_PAYLOAD_BYTES:
        raise HTTPException(413, "Webhook payload слишком большой")
    if not verify_github_signature(body, request.headers.get("x-hub-signature-256")):
        raise HTTPException(401, "Некорректная подпись webhook")

    event = request.headers.get("x-github-event")
    if event == "ping":
        return {"status": "ok"}
    if event != "push":
        return {"status": "ignored"}

    try:
        payload = await request.json()
    except ValueError as error:
        raise HTTPException(400, "Некорректный JSON") from error

    commit = get_push_commit(payload)
    if commit is None:
        return {"status": "ignored"}
    if not deployment_service.reserve():
        raise HTTPException(409, "Предыдущий деплой ещё выполняется")

    background_tasks.add_task(deployment_service.deploy_reserved, commit)
    return {"status": "accepted", "commit": commit}
