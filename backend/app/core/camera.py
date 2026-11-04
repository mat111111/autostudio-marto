"""Cámara virtual: dado el proyecto y un instante, devuelve qué rectángulo del video original se muestra.

Es la ÚNICA fuente de verdad de zoom + reencuadre. El render (Python/OpenCV) la usa tal cual y el
preview del navegador debe portar exactamente estas mismas ecuaciones.
"""
from __future__ import annotations

from bisect import bisect_right
from dataclasses import dataclass

from .models import Project, Reframe, Zoom


@dataclass(frozen=True)
class Rect:
    x: float
    y: float
    w: float
    h: float


def smoothstep(x: float) -> float:
    x = min(1.0, max(0.0, x))
    return x * x * (3.0 - 2.0 * x)


def base_crop(src_w: int, src_h: int, out_w: int, out_h: int) -> tuple[float, float]:
    """Mayor recorte con la proporción de salida que entra en la fuente (sin zoom)."""
    aspect = out_w / out_h
    if src_w / src_h >= aspect:  # fuente más ancha que la salida: se usa toda la altura
        return src_h * aspect, float(src_h)
    return float(src_w), src_w / aspect


def reframe_center(rf: Reframe, t: float) -> tuple[float, float]:
    if rf.mode == "fixed":
        return rf.fixed_x, rf.fixed_y
    kfs = rf.keyframes
    if rf.mode == "center" or not kfs:
        return 0.5, 0.5
    if t <= kfs[0].t:
        return kfs[0].x, kfs[0].y
    if t >= kfs[-1].t:
        return kfs[-1].x, kfs[-1].y
    i = bisect_right([k.t for k in kfs], t)
    a, b = kfs[i - 1], kfs[i]
    u = (t - a.t) / (b.t - a.t) if b.t > a.t else 0.0
    return a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u


def zoom_envelope(z: Zoom, t: float) -> float:
    """0 fuera del zoom, 1 en su meseta; rampas suaves de entrada y salida."""
    if t < z.start or t > z.end:
        return 0.0
    d = z.end - z.start
    ein = min(z.ease_in, d / 2)
    eout = min(z.ease_out, d / 2)
    if ein > 0 and t < z.start + ein:
        return smoothstep((t - z.start) / ein)
    if eout > 0 and t > z.end - eout:
        return smoothstep((z.end - t) / eout)
    return 1.0


def active_zoom(p: Project, t: float) -> Zoom | None:
    for z in p.zooms:
        if z.start <= t <= z.end:
            return z
    return None


def camera_at(p: Project, t: float, out_w: int | None = None, out_h: int | None = None) -> Rect:
    out_w = out_w or p.output.width
    out_h = out_h or p.output.height
    src_w, src_h = p.source.width, p.source.height
    bw, bh = base_crop(src_w, src_h, out_w, out_h)

    cx, cy = reframe_center(p.reframe, t)
    factor = 1.0
    z = active_zoom(p, t)
    if z is not None:
        env = zoom_envelope(z, t)
        factor = 1.0 + (z.scale - 1.0) * env
        if z.center_x is not None and z.center_y is not None:
            cx += (z.center_x - cx) * env
            cy += (z.center_y - cy) * env

    w, h = bw / factor, bh / factor
    x = min(max(cx * src_w - w / 2, 0.0), src_w - w)
    y = min(max(cy * src_h - h / 2, 0.0), src_h - h)
    return Rect(x, y, w, h)


def frame_matrix(r: Rect, out_w: int, out_h: int) -> tuple[float, float, float, float, float, float]:
    """Matriz afín 2x3 (para cv2.warpAffine) que lleva el recorte `r` al cuadro de salida.

    Incluye el desplazamiento de medio píxel para que el muestreo quede centrado.
    """
    sx, sy = out_w / r.w, out_h / r.h
    return (sx, 0.0, (0.5 - r.x) * sx - 0.5,
            0.0, sy, (0.5 - r.y) * sy - 0.5)
