"""Genera vectores de prueba (proyecto + tiempos -> rectángulo) con el código Python real.
El test del frontend los usa para comprobar que el preview del navegador calcula lo mismo que el render.
Uso: python tools/make_camera_vectors.py ../frontend/tests/camera_vectors.json
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.core.camera import camera_at  # noqa: E402
from app.core.models import Keyframe, Source, Zoom, new_project  # noqa: E402
from app.core.schema import to_dict  # noqa: E402


def case(w, h, zooms, mode, kfs):
    p = new_project("p", "p", Source(path="x", filename="x", duration=30.0, width=w, height=h, fps=30))
    p.zooms = zooms
    p.reframe.mode = mode
    p.reframe.fixed_x, p.reframe.fixed_y = 0.8, 0.3
    p.reframe.keyframes = kfs
    times = [i * 0.37 for i in range(0, 81)]
    out = []
    for t in times:
        r = camera_at(p, t)
        out.append({"t": t, "x": r.x, "y": r.y, "w": r.w, "h": r.h})
    return {"project": to_dict(p), "samples": out}


kf = [Keyframe(t=0, x=0.2, y=0.5), Keyframe(t=10, x=0.8, y=0.4), Keyframe(t=25, x=0.5, y=0.6)]
zs = [Zoom(start=2, end=6, scale=1.8, ease_in=1, ease_out=0.5),
      Zoom(start=8, end=9, scale=1.3, ease_in=0.3, ease_out=0.3, center_x=0.9, center_y=0.2),
      Zoom(start=20, end=24, scale=3.0, ease_in=3, ease_out=3)]
cases = [case(1920, 1080, zs, "face_track", kf), case(1080, 1920, zs, "center", []),
         case(1000, 1000, zs, "fixed", []), case(3840, 2160, [], "face_track", kf)]
Path(sys.argv[1]).write_text(json.dumps({"cases": cases}))
print("casos:", len(cases), "muestras:", sum(len(c["samples"]) for c in cases))
