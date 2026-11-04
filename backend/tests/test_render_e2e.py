"""Render real con FFmpeg + OpenCV sobre un video sintético. Se omite si faltan las herramientas."""
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

try:
    import cv2  # noqa: F401
    import numpy  # noqa: F401
    HAVE = shutil.which("ffmpeg") and shutil.which("ffprobe")
except ImportError:
    HAVE = False


@unittest.skipUnless(HAVE, "requiere ffmpeg, numpy y opencv")
class RenderE2E(unittest.TestCase):
    def test_render_trim_zoom_subtitles_audio(self):
        from app.core import autoedit, ops
        from app.core.models import Keyframe, Source, Word, new_project
        from app.media.faces import detect_face_track
        from app.media.probe import probe
        from app.media.proxy import make_proxy
        from app.render.pipeline import RenderSettings, render_project

        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            (d / "original").mkdir()
            src = d / "original" / "source.mp4"
            subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30",
                            "-f", "lavfi", "-i", "sine=frequency=440", "-t", "4", "-c:v", "libx264",
                            "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(src)], check=True)
            info = probe(src)
            s = Source(path="original/source.mp4", filename="s.mp4", duration=info.duration, width=info.width,
                       height=info.height, fps=info.fps, has_audio=True)
            p = new_project("p", "p", s)
            words = [Word(text=t, start=0.2 + i * 0.4, end=0.2 + i * 0.4 + 0.35)
                     for i, t in enumerate("uno dos tres cuatro cinco seis siete".split())]
            p.captions = autoedit.build_captions(words)
            p.reframe.keyframes = [Keyframe(t=0, x=0.3, y=0.5), Keyframe(t=4, x=0.7, y=0.5)]
            tx = ops.Transaction(p)
            self.assertTrue(tx.apply("add_zoom", {"start": 1, "end": 2.5, "scale": 1.6}).ok)
            self.assertTrue(tx.apply("set_trim", {"start": 0.5, "end": 3.5}).ok)

            out = d / "out.mp4"
            calls = []
            render_project(tx.work, d, out, RenderSettings(preset="ultrafast"), progress=lambda f, m: calls.append(f))
            o = probe(out)
            self.assertEqual((o.width, o.height), (1080, 1920))
            self.assertAlmostEqual(o.duration, 3.0, delta=0.15)
            self.assertTrue(o.has_audio)
            self.assertTrue(calls and calls[-1] == 1.0)

            # el proxy y el seguimiento de rostros corren sin romper (sin rostros => todas las muestras vacías)
            make_proxy(src, d / "proxy.mp4")
            samples = detect_face_track(d / "proxy.mp4")
            self.assertGreater(len(samples), 5)


if __name__ == "__main__":
    unittest.main()
