import hashlib
import hmac
import unittest
from unittest.mock import patch

from fastapi import HTTPException
from pydantic import SecretStr

from config import settings
from routers.deployment_router import get_push_commit, verify_github_signature
from services.deployment_service import DeploymentService


class DeploymentWebhookTest(unittest.TestCase):
    def test_signature_is_verified(self):
        body = b'{"ref":"refs/heads/update"}'
        signature = "sha256=" + hmac.new(b"secret", body, hashlib.sha256).hexdigest()
        with patch.object(settings, "deploy_webhook_secret", SecretStr("secret")):
            self.assertTrue(verify_github_signature(body, signature))
            self.assertFalse(verify_github_signature(body + b" ", signature))

    def test_only_configured_branch_is_deployed(self):
        commit = "a" * 40
        with patch.object(settings, "deploy_branch", "update"):
            self.assertEqual(get_push_commit({"ref": "refs/heads/update", "after": commit}), commit)
            self.assertIsNone(get_push_commit({"ref": "refs/heads/main", "after": commit}))

    def test_invalid_commit_is_rejected(self):
        with patch.object(settings, "deploy_branch", "update"):
            with self.assertRaises(HTTPException):
                get_push_commit({"ref": "refs/heads/update", "after": "not-a-sha"})

    def test_second_deployment_cannot_be_reserved(self):
        service = DeploymentService()
        self.assertTrue(service.reserve())
        self.assertFalse(service.reserve())


if __name__ == "__main__":
    unittest.main()
