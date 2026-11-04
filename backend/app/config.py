"""Configuración por variables de entorno. Las claves viven SOLO en el backend."""
from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    redis_url: str
    inline_jobs: bool
    gemini_api_key: str
    gemini_model: str
    whisper_model: str
    whisper_device: str
    whisper_compute_type: str
    max_upload_mb: int
    cors_origins: tuple[str, ...]
    fonts_dir: str

    @property
    def db_path(self) -> Path:
        return self.data_dir / "autostudio.db"

    def project_dir(self, pid: str) -> Path:
        return self.data_dir / "projects" / pid


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    env = os.environ.get
    return Settings(
        data_dir=Path(env("DATA_DIR", "./data")).resolve(),
        redis_url=env("REDIS_URL", "redis://localhost:6379/0"),
        inline_jobs=env("INLINE_JOBS", "0") == "1",
        gemini_api_key=env("GEMINI_API_KEY", ""),
        gemini_model=env("GEMINI_MODEL", "gemini-3.6-flash"),
        whisper_model=env("WHISPER_MODEL", "small"),
        whisper_device=env("WHISPER_DEVICE", "cpu"),
        whisper_compute_type=env("WHISPER_COMPUTE_TYPE", "int8"),
        max_upload_mb=int(env("MAX_UPLOAD_MB", "2048")),
        cors_origins=tuple(o for o in env("CORS_ORIGINS", "http://localhost:5173").split(",") if o),
        fonts_dir=env("FONTS_DIR", "/usr/share/fonts"),
    )
