from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_name: str = "文流"
    database_url: str = "postgresql+psycopg://docflow:docflow@localhost:5432/docflow"
    redis_url: str = "redis://localhost:6379/0"
    data_root: Path = Path("./data")
    secret_key: str = "change-this-to-a-long-random-string"
    max_upload_mb: int = Field(default=200, ge=1, le=200)
    translation_chunk_chars: int = Field(default=12_000, ge=2_000, le=100_000)
    mineru_poll_seconds: int = Field(default=5, ge=2, le=60)
    mineru_max_wait_seconds: int = Field(default=7_200, ge=60, le=86_400)
    webp_quality: int = Field(default=88, ge=60, le=100)

    @field_validator("secret_key")
    @classmethod
    def reject_empty_secrets(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("secret values may not be empty")
        return value

    @property
    def max_upload_bytes(self) -> int:
        return self.max_upload_mb * 1024 * 1024

    @property
    def sources_root(self) -> Path:
        return self.data_root / "sources"

    @property
    def articles_root(self) -> Path:
        return self.data_root / "articles"

    @property
    def temp_root(self) -> Path:
        return self.data_root / "tmp"


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    for path in (settings.sources_root, settings.articles_root, settings.temp_root):
        path.mkdir(parents=True, exist_ok=True)
    return settings
