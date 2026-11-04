"""Detección del rostro principal para el reencuadre inteligente.

Usa MediaPipe si está disponible y cae a un detector Haar de OpenCV si no. Trabaja sobre el proxy (720p),
muestreando unos pocos cuadros por segundo; el suavizado vive en core/tracking.py.
"""
from __future__ import annotations

from typing import Callable, Optional

from ..core.tracking import Sample


def _make_detector():
    """Devuelve una función frame_bgr -> (cx, cy) normalizados del rostro más grande, o None."""
    import cv2
    try:
        import mediapipe as mp
        fd = mp.solutions.face_detection.FaceDetection(model_selection=1, min_detection_confidence=0.5)

        def detect(frame):
            res = fd.process(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
            if not res.detections:
                return None
            box = max((d.location_data.relative_bounding_box for d in res.detections),
                      key=lambda b: b.width * b.height)
            return box.xmin + box.width / 2, box.ymin + box.height / 2
        return detect
    except Exception:
        try:
            cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
        except (AttributeError, cv2.error):  # sin detectores disponibles: el reencuadre queda centrado
            return lambda frame: None

        def detect(frame):
            h, w = frame.shape[:2]
            scale = 480 / w if w > 480 else 1.0
            small = cv2.resize(frame, None, fx=scale, fy=scale) if scale != 1.0 else frame
            gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
            faces = cascade.detectMultiScale(gray, 1.1, 5, minSize=(40, 40))
            if len(faces) == 0:
                return None
            x, y, fw, fh = max(faces, key=lambda f: f[2] * f[3])
            sh, sw = gray.shape[:2]
            return (x + fw / 2) / sw, (y + fh / 2) / sh
        return detect


def detect_face_track(video_path, *, sample_fps: float = 4.0,
                      progress: Optional[Callable[[float], None]] = None) -> list[Sample]:
    import cv2
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        return []
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 0
    step = max(1, int(round(fps / sample_fps)))
    detect = _make_detector()
    samples: list[Sample] = []
    idx = 0
    try:
        while True:
            if not cap.grab():
                break
            if idx % step == 0:
                ok, frame = cap.retrieve()
                if ok:
                    found = detect(frame)
                    samples.append((idx / fps, found[0] if found else None, found[1] if found else None))
                    if progress and total:
                        progress(min(idx / total, 1.0))
            idx += 1
    finally:
        cap.release()
    return samples
