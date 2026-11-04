"""Proxy de preview (720p H.264, 30 fps constantes) y extracción de audio para transcribir."""
from __future__ import annotations

import subprocess
from pathlib import Path


class MediaError(RuntimeError):
    pass


def _run(cmd: list[str], timeout: int = 7200) -> None:
    try:
        subprocess.run(cmd, capture_output=True, text=True, check=True, timeout=timeout)
    except subprocess.CalledProcessError as e:
        raise MediaError(f"{cmd[0]} falló: {e.stderr.strip()[-600:]}") from e
    except subprocess.TimeoutExpired as e:
        raise MediaError(f"{cmd[0]} excedió el tiempo máximo") from e


def make_proxy(src: Path, dst: Path, fps: int = 30) -> None:
    """Mismo fps que el render, así el tiempo del preview coincide con el del export."""
    _run(["ffmpeg", "-y", "-v", "error", "-i", str(src),
          "-vf", f"scale=-2:720,fps={fps}", "-c:v", "libx264", "-preset", "veryfast", "-crf", "24",
          "-g", str(fps), "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k",
          "-movflags", "+faststart", str(dst)])


def extract_audio(src: Path, dst: Path) -> None:
    _run(["ffmpeg", "-y", "-v", "error", "-i", str(src), "-vn", "-ac", "1", "-ar", "16000",
          "-c:a", "pcm_s16le", str(dst)])
