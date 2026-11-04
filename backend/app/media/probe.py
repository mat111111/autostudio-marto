"""Lectura de metadatos con ffprobe (dimensiones reales de visualización, fps, duración, audio)."""
from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from pathlib import Path


class ProbeError(RuntimeError):
    pass


@dataclass
class ProbeInfo:
    duration: float
    width: int
    height: int
    fps: float
    has_audio: bool


def _parse_rate(rate: str) -> float:
    try:
        num, _, den = rate.partition("/")
        d = float(den) if den else 1.0
        return float(num) / d if d else 0.0
    except ValueError:
        return 0.0


def _rotation(stream: dict) -> int:
    for sd in stream.get("side_data_list", []) or []:
        if "rotation" in sd:
            return int(round(float(sd["rotation"])))
    tag = (stream.get("tags") or {}).get("rotate")
    return int(tag) if tag else 0


def parse_probe(data: dict) -> ProbeInfo:
    streams = data.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video"
                  and s.get("disposition", {}).get("attached_pic", 0) != 1), None)
    if video is None:
        raise ProbeError("El archivo no contiene una pista de video.")
    w, h = int(video["width"]), int(video["height"])
    if abs(_rotation(video)) % 180 == 90:  # videos de celular grabados en vertical
        w, h = h, w
    fps = _parse_rate(video.get("avg_frame_rate", "0/1")) or _parse_rate(video.get("r_frame_rate", "30/1")) or 30.0
    duration = float(data.get("format", {}).get("duration") or video.get("duration") or 0)
    if duration <= 0:
        raise ProbeError("No se pudo determinar la duración del video.")
    has_audio = any(s.get("codec_type") == "audio" for s in streams)
    return ProbeInfo(duration=duration, width=w, height=h, fps=round(fps, 3), has_audio=has_audio)


def probe(path: Path) -> ProbeInfo:
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-print_format", "json", "-show_streams", "-show_format", str(path)],
            capture_output=True, text=True, check=True, timeout=60)
    except subprocess.CalledProcessError as e:
        raise ProbeError(f"ffprobe no pudo leer el archivo: {e.stderr.strip()[:300]}") from e
    except FileNotFoundError as e:
        raise ProbeError("ffprobe no está instalado.") from e
    return parse_probe(json.loads(out.stdout))
