from sqlalchemy import Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from database import Base


class ProxyPlatformStatModel(Base):
    """Счётчики успехов и IP-ошибок для одной пары адреса прокси и платформы."""
    __tablename__ = "proxy_platform_stats"

    proxy_endpoint: Mapped[str] = mapped_column(Text, primary_key=True)
    platform: Mapped[str] = mapped_column(String(32), primary_key=True)
    info_success_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    download_success_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    info_ip_error_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    download_ip_error_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    last_info_success_at: Mapped[str | None] = mapped_column(Text)
    last_download_success_at: Mapped[str | None] = mapped_column(Text)
    last_ip_error_at: Mapped[str | None] = mapped_column(Text)
    last_ip_error_kind: Mapped[str | None] = mapped_column(String(32))


