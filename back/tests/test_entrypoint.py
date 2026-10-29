import runpy
import unittest
from unittest.mock import patch

from config import BASE_DIR


class EntrypointTest(unittest.TestCase):
    """Проверки параметров прямого запуска backend."""
    def test_direct_entrypoint_keeps_reload_disabled(self):
        """Проверяет запуск без перезагрузки, чтобы на Windows работали дочерние процессы."""
        with patch("uvicorn.run") as run:
            runpy.run_path(str(BASE_DIR / "app.py"), run_name="__main__")

        run.assert_called_once_with("app:app", host="0.0.0.0", port=8000, reload=False)


if __name__ == "__main__":
    unittest.main()
