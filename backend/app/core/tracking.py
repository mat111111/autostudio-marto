"""Convierte detecciones de rostro ruidosas en keyframes de cámara suaves."""
from __future__ import annotations

import math
from typing import Optional

from .models import Keyframe

Sample = tuple[float, Optional[float], Optional[float]]  # (t, x|None, y|None)


def _fill(values: list[Optional[float]]) -> list[float]:
    last = next((v for v in values if v is not None), 0.5)
    out: list[float] = []
    for v in values:
        last = v if v is not None else last
        out.append(last)
    return out


def _median(values: list[float], k: int = 5) -> list[float]:
    half = k // 2
    out = []
    for i in range(len(values)):
        window = sorted(values[max(0, i - half): i + half + 1])
        out.append(window[len(window) // 2])
    return out


def _follow(values: list[float], dt: float, tau: float, deadzone: float) -> list[float]:
    """Cámara con zona muerta + suavizado exponencial: ignora temblores y sigue movimientos reales."""
    alpha = 1 - math.exp(-dt / tau)
    cam = values[0]
    out = [cam]
    for v in values[1:]:
        if abs(v - cam) > deadzone:
            cam += (v - cam) * alpha
        out.append(cam)
    return out


def _simplify(points: list[Keyframe], tol: float) -> list[Keyframe]:
    """Descarta keyframes que la interpolación lineal ya reproduce dentro de la tolerancia."""
    if len(points) <= 2:
        return points
    kept = [points[0]]
    anchor = 0
    for i in range(1, len(points) - 1):
        a, b = points[anchor], points[i + 1]
        span = b.t - a.t
        ok = True
        for j in range(anchor + 1, i + 1):
            u = (points[j].t - a.t) / span if span > 0 else 0
            if (abs(points[j].x - (a.x + (b.x - a.x) * u)) > tol
                    or abs(points[j].y - (a.y + (b.y - a.y) * u)) > tol):
                ok = False
                break
        if not ok:
            kept.append(points[i])
            anchor = i
    kept.append(points[-1])
    return kept


def smooth_track(samples: list[Sample], *, tau: float = 0.6, deadzone: float = 0.035,
                 tol: float = 0.004) -> list[Keyframe]:
    """Devuelve keyframes (t, x, y normalizados). Lista vacía si nunca se detectó un rostro."""
    if len(samples) < 2 or all(s[1] is None for s in samples):
        return []
    ts = [s[0] for s in samples]
    xs = _median(_fill([s[1] for s in samples]))
    ys = _median(_fill([s[2] for s in samples]))
    dt = max((ts[-1] - ts[0]) / (len(ts) - 1), 1e-3)
    xs = _follow(xs, dt, tau, deadzone)
    ys = _follow(ys, dt, tau, deadzone)
    pts = [Keyframe(t=round(t, 3), x=round(min(max(x, 0), 1), 4), y=round(min(max(y, 0), 1), 4))
           for t, x, y in zip(ts, xs, ys)]
    return _simplify(pts, tol)
