import asyncio
import logging
import shutil
from pathlib import Path

from config import settings


logger = logging.getLogger(__name__)


class DeploymentError(RuntimeError):
    """Ошибка подготовки, сборки или активации новой версии приложения."""
    pass


async def run_command(*command, cwd: Path | None = None, step: str):
    """Выполняет команду, собирает вывод и сообщает об ошибке текущего этапа."""
    process = await asyncio.create_subprocess_exec(
        *(str(item) for item in command),
        cwd=str(cwd) if cwd else None,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    output, _ = await process.communicate()
    text = output.decode("utf-8", errors="replace").strip()
    if process.returncode:
        raise DeploymentError(f"{step} завершился с кодом {process.returncode}:\n{text[-4000:]}")
    return text


class DeploymentService:
    """Последовательно подготавливает, собирает и активирует выбранный коммит."""
    def __init__(self):
        """Создаёт свободный сервис без зарезервированного деплоя."""
        self._reserved = False

    def reserve(self) -> bool:
        """Резервирует сервис для одного деплоя, если он ещё не занят."""
        # Один backend-процесс выполняет только один деплой одновременно.
        if self._reserved:
            return False
        self._reserved = True
        return True

    async def deploy_reserved(self, commit: str):
        """Выполняет зарезервированный деплой и освобождает сервис даже при ошибке."""
        try:
            deployed = await self._deploy(commit)
            logger.info("Deployment completed: %s", deployed)
        except Exception:
            logger.exception("Deployment failed for commit %s", commit)
        finally:
            self._reserved = False

    async def _deploy(self, commit: str) -> str:
        """Выполняет этапы обновления и очищает временный checkout после завершения."""
        await self._prepare_repository()
        await self._validate_commit(commit)

        marker = settings.deploy_release_dir / ".deployed-commit"
        if marker.exists() and marker.read_text(encoding="utf-8").strip() == commit:
            return f"{commit} is already deployed"

        workspace = self._workspace_for(commit)
        try:
            await run_command(
                "git", "-C", settings.deploy_repository_dir,
                "worktree", "add", "--force", "--detach", workspace, commit,
                step="Создание checkout",
            )
            await self._check_and_build(workspace)
            await self._install_requirements(workspace)
            await self._activate(workspace)
            await self._schedule_restart(commit)
            marker.write_text(f"{commit}\n", encoding="utf-8")
            return commit
        finally:
            await self._remove_workspace(workspace)

    async def _prepare_repository(self):
        """Клонирует служебный репозиторий при необходимости и обновляет разрешённую ветку."""
        repository = settings.deploy_repository_dir
        if not (repository / ".git").exists():
            if repository.exists() and any(repository.iterdir()):
                raise DeploymentError(f"Каталог репозитория не пуст: {repository}")
            repository.parent.mkdir(parents=True, exist_ok=True)
            await run_command(
                "git", "clone", "--no-checkout", settings.deploy_repository_url, repository,
                step="Клонирование репозитория",
            )
        await run_command(
            "git", "-C", repository, "fetch", "--prune", "origin",
            f"+refs/heads/{settings.deploy_branch}:refs/remotes/origin/{settings.deploy_branch}",
            step="Обновление репозитория",
        )

    async def _validate_commit(self, commit: str):
        """Проверяет, что коммит webhook совпадает с вершиной разрешённой ветки."""
        repository = settings.deploy_repository_dir
        remote_head = await run_command(
            "git", "-C", repository, "rev-parse", f"origin/{settings.deploy_branch}",
            step="Проверка ветки",
        )
        if remote_head != commit:
            raise DeploymentError(
                f"Commit webhook {commit} уже не является вершиной origin/{settings.deploy_branch}"
            )

    def _workspace_for(self, commit: str) -> Path:
        """Подготавливает отдельный каталог сборки внутри разрешённой рабочей папки."""
        work_root = settings.deploy_work_dir.resolve()
        workspace = (work_root / commit).resolve()
        if workspace.parent != work_root:
            raise DeploymentError("Некорректный путь временной сборки")
        work_root.mkdir(parents=True, exist_ok=True)
        if workspace.exists():
            shutil.rmtree(workspace)
        return workspace

    async def _check_and_build(self, workspace: Path):
        """Проверяет синтаксис backend, устанавливает зависимости frontend и собирает его."""
        await run_command(
            settings.deploy_python_path, "-m", "compileall", "-q", workspace / "back",
            step="Проверка backend",
        )
        await run_command("npm", "ci", cwd=workspace / "front", step="Установка frontend-зависимостей")
        await run_command("npm", "run", "build", cwd=workspace / "front", step="Сборка frontend")

    async def _install_requirements(self, workspace: Path):
        """Устанавливает зависимости backend, только если requirements.txt изменился."""
        current = settings.deploy_release_dir / "back" / "requirements.txt"
        incoming = workspace / "back" / "requirements.txt"
        if current.exists() and current.read_bytes() == incoming.read_bytes():
            return
        await run_command(
            settings.deploy_python_path, "-m", "pip", "install", "-r", incoming,
            step="Установка backend-зависимостей",
        )

    async def _activate(self, workspace: Path):
        """Обновляет рабочие файлы приложения, сохраняя настройки и постоянные данные."""
        backend = settings.deploy_release_dir / "back"
        frontend = settings.deploy_frontend_dir
        backend.mkdir(parents=True, exist_ok=True)
        frontend.mkdir(parents=True, exist_ok=True)

        await run_command(
            "rsync", "-a", "--delete",
            "--exclude=.env", "--exclude=cookies/", "--exclude=venv/",
            "--exclude=tmp/", "--exclude=*.db", "--exclude=*.log",
            f"{workspace / 'back'}/", f"{backend}/",
            step="Обновление backend",
        )
        await run_command(
            "rsync", "-a", "--delete", f"{workspace / 'front' / 'dist'}/", f"{frontend}/",
            step="Обновление frontend",
        )

    async def _schedule_restart(self, commit: str):
        """Планирует отложенный перезапуск сервиса backend через systemd."""
        await run_command(
            "systemd-run", "--collect", f"--unit=videodownloader-restart-{commit[:12]}",
            "--on-active=2s", "/bin/systemctl", "restart", settings.deploy_backend_service,
            step="Планирование перезапуска backend",
        )

    async def _remove_workspace(self, workspace: Path):
        """Удаляет временный checkout и освобождает его каталог после сборки."""
        if not workspace.exists():
            return
        try:
            await run_command(
                "git", "-C", settings.deploy_repository_dir,
                "worktree", "remove", "--force", workspace,
                step="Очистка временного checkout",
            )
        except Exception:
            logger.exception("Cannot remove deployment workspace %s", workspace)
            shutil.rmtree(workspace, ignore_errors=True)


deployment_service = DeploymentService()
