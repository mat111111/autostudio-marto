"""Render final: FFmpeg decodifica -> Python aplica la cámara (zoom + reencuadre) -> FFmpeg codifica.

Por qué no un único comando de FFmpeg: `crop` no admite tamaño variable por cuadro y `zoompan`
produce saltos de píxel. Calcular la cámara en Python con sub-píxel (cv2.warpAffine) da un zoom
suave y, sobre todo, usa exactamente la misma matemática (core/camera.py) que el preview.
Los subtítulos ASS se queman en la etapa de codificación con libass.
"""
from __future__ import annotations

import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Literal, Optional

from ..core.camera import camera_at, frame_matrix
from ..core.models import Project
from .ass import build_ass

ProgressCb = Callable[[float, str], None]


class RenderError(RuntimeError):
    pass


@dataclass
class RenderSettings:
    resolution: Literal["1080p", "4k"] = "1080p"
    crf: int = 18
    preset: str = "medium"
    burn_subtitles: bool = True
    enhance_audio: bool = False
    high_quality_scaling: bool = False  # bicúbica: más nítida al ampliar, ~3x más lenta que la bilineal


def output_size(p: Project, resolution: str) -> tuple[int, int]:
    """Mantiene la proporción del proyecto (9:16) y fija el lado corto según la resolución."""
    short = 2160 if resolution == "4k" else 1080
    aspect = p.output.width / p.output.height
    if aspect <= 1:  # vertical
        w = short
        h = int(round(w / aspect / 2)) * 2
    else:
        h = short
        w = int(round(h * aspect / 2)) * 2
    return w, h


def _read_exact(stream, n: int) -> Optional[bytes]:
    buf = bytearray()
    while len(buf) < n:
        chunk = stream.read(n - len(buf))
        if not chunk:
            return None
        buf.extend(chunk)
    return bytes(buf)


def _tail(path: Path, n: int = 1500) -> str:
    try:
        return path.read_text(errors="replace")[-n:].strip()
    except OSError:
        return ""


def build_decoder_cmd(src: Path, start: float, dur: float, fps: int, sw: int, sh: int) -> list[str]:
    return ["ffmpeg", "-v", "error", "-ss", f"{start:.3f}", "-t", f"{dur:.3f}", "-i", str(src),
            "-an", "-vf", f"fps={fps},scale={sw}:{sh}", "-f", "rawvideo", "-pix_fmt", "bgr24", "pipe:1"]


def build_encoder_cmd(src: Path, start: float, dur: float, fps: int, out_w: int, out_h: int,
                      out_path: Path, st: RenderSettings, has_audio: bool, ass_name: Optional[str],
                      fonts_dir: Optional[str]) -> list[str]:
    cmd = ["ffmpeg", "-y", "-v", "error",
           "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{out_w}x{out_h}", "-r", str(fps), "-i", "pipe:0"]
    if has_audio:
        cmd += ["-ss", f"{start:.3f}", "-t", f"{dur:.3f}", "-i", str(src)]
    cmd += ["-map", "0:v:0"]
    if has_audio:
        cmd += ["-map", "1:a:0"]

    chain = []
    if ass_name:
        chain.append(f"ass={ass_name}" + (f":fontsdir={fonts_dir}" if fonts_dir else ""))
    chain += ["scale=out_color_matrix=bt709:out_range=tv", "format=yuv420p"]
    cmd += ["-vf", ",".join(chain),
            "-c:v", "libx264", "-preset", st.preset, "-crf", str(st.crf), "-r", str(fps),
            "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"]
    if has_audio:
        cmd += ["-c:a", "aac", "-b:a", "192k"]
        if st.enhance_audio:
            cmd += ["-af", "highpass=f=80,afftdn=nf=-25,loudnorm=I=-16:TP=-1.5:LRA=11"]
        cmd += ["-shortest"]
    cmd += ["-movflags", "+faststart", str(out_path)]
    return cmd


def render_project(p: Project, project_dir: Path, out_path: Path, st: RenderSettings,
                   progress: Optional[ProgressCb] = None, fonts_dir: Optional[str] = None) -> Path:
    import cv2
    import numpy as np

    progress = progress or (lambda f, m: None)
    interp = cv2.INTER_CUBIC if st.high_quality_scaling else cv2.INTER_LINEAR
    out_w, out_h = output_size(p, st.resolution)
    fps = p.output.fps
    start, dur = p.trim.start, p.trim.end - p.trim.start
    total = max(1, int(round(dur * fps)))
    src = project_dir / p.source.path
    sw, sh = p.source.width, p.source.height
    out_path.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="render_") as tmp:
        tmpdir = Path(tmp)
        ass_name = None
        if st.burn_subtitles and p.captions:
            (tmpdir / "subs.ass").write_text(build_ass(p, out_w, out_h), encoding="utf-8")
            ass_name = "subs.ass"

        dec_log, enc_log = tmpdir / "dec.log", tmpdir / "enc.log"
        with open(dec_log, "wb") as dec_err, open(enc_log, "wb") as enc_err:
            decoder = subprocess.Popen(build_decoder_cmd(src, start, dur, fps, sw, sh),
                                       stdout=subprocess.PIPE, stderr=dec_err)
            encoder = subprocess.Popen(
                build_encoder_cmd(src, start, dur, fps, out_w, out_h, out_path, st,
                                  p.source.has_audio, ass_name, fonts_dir),
                stdin=subprocess.PIPE, stderr=enc_err, cwd=tmp)
            frames = 0
            try:
                frame_bytes = sw * sh * 3
                while frames < total:
                    buf = _read_exact(decoder.stdout, frame_bytes)
                    if buf is None:
                        break
                    frame = np.frombuffer(buf, np.uint8).reshape(sh, sw, 3)
                    rect = camera_at(p, start + frames / fps, out_w, out_h)
                    m = np.array(frame_matrix(rect, out_w, out_h), dtype=np.float64).reshape(2, 3)
                    out = cv2.warpAffine(frame, m, (out_w, out_h), flags=interp,
                                         borderMode=cv2.BORDER_REPLICATE)
                    encoder.stdin.write(out.tobytes())
                    frames += 1
                    if frames % 15 == 0:
                        progress(frames / total, "Renderizando")
            except BrokenPipeError:
                pass  # el codificador murió; se informa abajo con su log
            finally:
                try:
                    encoder.stdin.close()
                except (BrokenPipeError, OSError):
                    pass
                decoder.stdout.close()
                if decoder.poll() is None:
                    decoder.terminate()
                decoder.wait()
                encoder.wait()

        if frames == 0:
            raise RenderError("No se pudo decodificar el video: " + _tail(dec_log))
        if encoder.returncode != 0:
            raise RenderError("FFmpeg falló al codificar: " + _tail(enc_log))
    progress(1.0, "Listo")
    return out_path
