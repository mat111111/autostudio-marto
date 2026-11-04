"""Encolado de trabajos. Con Redis + RQ en producción; con INLINE_JOBS=1 corre en un hilo (desarrollo/tests)."""
from __future__ import annotations

import importlib
import threading

from ..config import get_settings


def enqueue(func_path: str, *args) -> None:
    s = get_settings()
    if s.inline_jobs:
        mod, _, fn = func_path.rpartition(".")
        threading.Thread(target=getattr(importlib.import_module(mod), fn), args=args, daemon=True).start()
        return
    from redis import Redis
    from rq import Queue
    Queue("autostudio", connection=Redis.from_url(s.redis_url)).enqueue(func_path, *args, job_timeout=4 * 3600)
