import hashlib
import hmac
import unittest
from unittest.mock import patch

from fastapi import HTTPException
from pydantic import SecretStr

from config import settings
from deployment.router import get_push_commit, verify_github_signature
from deployment.service import DeploymentService


class DeploymentWebhookTest(unittest.TestCase):
    """Проверки подписи webhook, разрешённой ветки и резервирования деплоя."""
    def test_signature_is_verified(self):
        """Проверяет принятие верной подписи и отклонение изменённого тела запроса."""
        body = b'{"ref":"refs/heads/update"}'
        signature = "sha256=" + hmac.new(b"secret", body, hashlib.sha256).hexdigest()
        with patch.object(settings, "deploy_webhook_secret", SecretStr("secret")):
            self.assertTrue(verify_github_signature(body, signature))
            self.assertFalse(verify_github_signature(body + b" ", signature))

    def test_only_configured_branch_is_deployed(self):
        """Проверяет выбор коммита только из настроенной ветки."""
        commit = "a" * 40
        with patch.object(settings, "deploy_branch", "update"):
            self.assertEqual(get_push_commit({"ref": "refs/heads/update", "after": commit}), commit)
            self.assertIsNone(get_push_commit({"ref": "refs/heads/main", "after": commit}))

    def test_invalid_commit_is_rejected(self):
        """Проверяет отклонение некорректного SHA коммита."""
        with patch.object(settings, "deploy_branch", "update"):
            with self.assertRaises(HTTPException):
                get_push_commit({"ref": "refs/heads/update", "after": "not-a-sha"})

    def test_second_deployment_cannot_be_reserved(self):
        """Проверяет запрет повторного резервирования занятого сервиса."""
        service = DeploymentService()
        self.assertTrue(service.reserve())
        self.assertFalse(service.reserve())


if __name__ == "__main__":
    unittest.main()
