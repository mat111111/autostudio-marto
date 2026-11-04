import unittest

from app.core import autoedit, camera, ops, tracking
from app.core.models import Caption, Project, Source, Word, Zoom, new_project, project_from_dict, validate_project
from app.core.presets import PRESETS
from app.core.schema import ValidationError, from_dict, json_schema, to_dict
from app.media.probe import parse_probe
from app.render.ass import ass_color, ass_time, build_ass, build_srt


def make_project(duration=60.0, w=1920, h=1080) -> Project:
    src = Source(path="original/source.mp4", filename="source.mp4", duration=duration, width=w, height=h, fps=30)
    p = new_project("prj_test", "Test", src)
    words = [Word(text=t, start=i * 0.4, end=i * 0.4 + 0.35) for i, t in enumerate(
        "Hola a todos esto es un video de prueba. Nunca dejes de aprender, ¿te imaginás eso? Gracias".split())]
    p.transcript.words = words
    p.captions = autoedit.build_captions(words)
    return p


class SchemaTests(unittest.TestCase):
    def test_roundtrip_and_strict(self):
        p = make_project()
        again = project_from_dict(to_dict(p))
        self.assertEqual(to_dict(p), to_dict(again))
        with self.assertRaises(ValidationError):
            from_dict(Zoom, {"start": 1, "end": 3, "extra": 1}, strict=True)

    def test_ranges_and_types(self):
        with self.assertRaises(ValidationError):
            from_dict(Zoom, {"start": 1, "end": 3, "scale": 9})
        with self.assertRaises(ValidationError):
            from_dict(Zoom, {"start": "1", "end": 3})
        with self.assertRaises(ValidationError):
            from_dict(Zoom, {"start": 1, "end": 1.1})  # < 0.3 s

    def test_schema_for_gemini_has_no_refs(self):
        for spec in ops.REGISTRY.values():
            s = json_schema(spec.params)
            blob = str(s)
            self.assertNotIn("$ref", blob)
            self.assertNotIn("anyOf", blob)
            self.assertEqual(s["type"], "object")
        s = json_schema(ops.AddZoomP)
        self.assertEqual(set(s["required"]), {"start", "end"})
        self.assertTrue(s["properties"]["center_x"]["nullable"])

    def test_preset_names_match(self):
        from typing import get_args
        from app.core.presets import PresetName
        self.assertEqual(set(get_args(PresetName)), set(PRESETS))


class OpsTests(unittest.TestCase):
    def setUp(self):
        self.p = make_project()

    def test_add_zoom_and_overlap_rejected(self):
        tx = ops.Transaction(self.p)
        self.assertTrue(tx.apply("add_zoom", {"start": 2, "end": 4, "scale": 1.3}).ok)
        r = tx.apply("add_zoom", {"start": 3, "end": 5})
        self.assertFalse(r.ok)
        self.assertIn("superpone", r.error)
        self.assertEqual(len(tx.work.zooms), 1)
        self.assertEqual(len(self.p.zooms), 0)  # el original no se toca

    def test_failed_op_does_not_poison_the_rest(self):
        tx = ops.Transaction(self.p)
        r1 = tx.apply("add_zoom", {"start": 1, "end": 2})
        r2 = tx.apply("add_zoom", {"start": 1.5, "end": 3})
        r3 = tx.apply("add_zoom", {"start": 10, "end": 12})
        self.assertEqual([r1.ok, r2.ok, r3.ok], [True, False, True])
        self.assertEqual(len(tx.applied), 2)

    def test_remove_zoom_at(self):
        tx = ops.Transaction(self.p)
        tx.apply("add_zoom", {"start": 30, "end": 36})
        self.assertFalse(tx.apply("remove_zooms_at", {"time": 20}).ok)
        self.assertTrue(tx.apply("remove_zooms_at", {"time": 35}).ok)
        self.assertEqual(tx.work.zooms, [])

    def test_unknown_op_and_bad_params(self):
        tx = ops.Transaction(self.p)
        self.assertFalse(tx.apply("make_coffee", {}).ok)
        self.assertFalse(tx.apply("add_zoom", {"start": 1}).ok)
        self.assertFalse(tx.apply("add_zoom", {"start": 1, "end": 2, "scale": 99}).ok)
        self.assertFalse(tx.apply("add_zoom", {"start": 1, "end": 500}).ok)  # fuera del video

    def test_zoom_on_caption(self):
        tx = ops.Transaction(self.p)
        cap = self.p.captions[1]
        self.assertTrue(tx.apply("add_zoom_on_caption", {"caption_id": cap.id, "scale": 1.4}).ok)
        z = tx.work.zooms[0]
        self.assertAlmostEqual(z.start, cap.start)
        self.assertFalse(tx.apply("add_zoom_on_caption", {"caption_id": "nope"}).ok)

    def test_update_caption_text(self):
        tx = ops.Transaction(self.p)
        cap = self.p.captions[0]
        n = len(cap.words)
        starts = [w.start for w in cap.words]
        tx.apply("update_caption_text", {"caption_id": cap.id, "text": " ".join(["x"] * n)})
        self.assertEqual([w.start for w in tx.work.captions[0].words], starts)  # conserva tiempos
        tx.apply("update_caption_text", {"caption_id": cap.id, "text": "uno dos"})
        self.assertEqual(len(tx.work.captions[0].words), 2)
        self.assertFalse(tx.apply("update_caption_text", {"caption_id": cap.id, "text": "  "}).ok)

    def test_split_and_move_caption(self):
        tx = ops.Transaction(self.p)
        cap = next(c for c in self.p.captions if len(c.words) >= 2)
        mid = cap.words[1].start
        self.assertTrue(tx.apply("split_caption", {"caption_id": cap.id, "at": mid}).ok)
        self.assertEqual(len(tx.work.captions), len(self.p.captions) + 1)
        self.assertFalse(tx.apply("split_caption", {"caption_id": cap.id, "at": 999}).ok)
        first = tx.work.captions[0]
        r = tx.apply("move_caption", {"caption_id": first.id, "start": first.start, "end": first.end + 0.05})
        self.assertIn(r.ok, (True, False))  # puede chocar con el siguiente, pero no debe romper

    def test_style_and_preset(self):
        tx = ops.Transaction(self.p)
        self.assertTrue(tx.apply("set_caption_style", {"font_size": 100, "color": "#00FF00"}).ok)
        self.assertEqual(tx.work.caption_style.font_size, 100)
        self.assertFalse(tx.apply("set_caption_style", {"color": "rojo"}).ok)
        self.assertEqual(tx.work.caption_style.color, "#00FF00")  # rollback del inválido
        self.assertFalse(tx.apply("set_caption_style", {}).ok)
        self.assertTrue(tx.apply("apply_style_preset", {"preset": "editorial"}).ok)
        self.assertEqual(tx.work.caption_style.font, "Liberation Serif")
        self.assertFalse(tx.apply("apply_style_preset", {"preset": "inexistente"}).ok)

    def test_highlight_words_accent_insensitive(self):
        tx = ops.Transaction(self.p)
        r = tx.apply("set_highlight_words", {"words": ["IMAGINAS", "nunca"]})
        self.assertTrue(r.ok)
        marked = [w.text for c in tx.work.captions for w in c.words if w.highlight]
        self.assertEqual(len(marked), 2)
        tx.apply("set_highlight_words", {"words": []})
        self.assertFalse(any(w.highlight for c in tx.work.captions for w in c.words))

    def test_trim(self):
        tx = ops.Transaction(self.p)
        self.assertTrue(tx.apply("set_trim", {"start": 5, "end": 50}).ok)
        self.assertFalse(tx.apply("set_trim", {"start": 5, "end": 5.1}).ok)
        self.assertFalse(tx.apply("set_trim", {"start": 5, "end": 500}).ok)
        self.assertEqual((tx.work.trim.start, tx.work.trim.end), (5, 50))

    def test_catalog(self):
        names = {o["name"] for o in ops.describe_ops()}
        self.assertTrue({"add_zoom", "remove_zooms_at", "set_caption_style", "set_trim"} <= names)


class CameraTests(unittest.TestCase):
    def test_base_crop(self):
        self.assertEqual(camera.base_crop(1920, 1080, 1080, 1920), (607.5, 1080.0))
        self.assertEqual(camera.base_crop(1080, 1920, 1080, 1920), (1080.0, 1920.0))
        bw, bh = camera.base_crop(1000, 1000, 1080, 1920)
        self.assertLessEqual(bw, 1000)
        self.assertLessEqual(bh, 1000)

    def test_envelope_and_clamp(self):
        p = make_project()
        p.zooms = [Zoom(start=10, end=14, scale=2.0, ease_in=1, ease_out=1)]
        self.assertAlmostEqual(camera.camera_at(p, 5).w, 607.5)
        self.assertLess(camera.camera_at(p, 10.5).w, 607.5)
        self.assertAlmostEqual(camera.camera_at(p, 12).w, 607.5 / 2)
        self.assertAlmostEqual(camera.camera_at(p, 14.5).w, 607.5)
        p.reframe.mode, p.reframe.fixed_x = "fixed", 1.0
        r = camera.camera_at(p, 0)
        self.assertAlmostEqual(r.x + r.w, 1920)  # no se sale de la fuente

    def test_face_track_interpolation(self):
        from app.core.models import Keyframe
        p = make_project()
        p.reframe.keyframes = [Keyframe(t=0, x=0.2, y=0.5), Keyframe(t=10, x=0.8, y=0.5)]
        self.assertAlmostEqual(camera.reframe_center(p.reframe, 5)[0], 0.5)
        self.assertAlmostEqual(camera.reframe_center(p.reframe, 99)[0], 0.8)

    def test_matrix_maps_crop_corners(self):
        r = camera.Rect(100, 50, 400, 600)
        m = camera.frame_matrix(r, 800, 1200)
        self.assertAlmostEqual(m[0], 2.0)
        self.assertAlmostEqual(m[2], (0.5 - 100) * 2 - 0.5)


class AutoEditTests(unittest.TestCase):
    def test_captions_break_on_punctuation_and_dont_overlap(self):
        p = make_project()
        for a, b in zip(p.captions, p.captions[1:]):
            self.assertLessEqual(a.end, b.start + 1e-9)
        self.assertTrue(all(len(c.words) <= 4 for c in p.captions))
        validate_project(p)

    def test_zoom_suggestions_spaced_and_valid(self):
        words = [Word(text=("¿Sabías?" if i % 7 == 0 else "palabra"), start=i * 0.5, end=i * 0.5 + 0.4) for i in range(120)]
        caps = autoedit.build_captions(words)
        zooms = autoedit.suggest_zooms(caps, 0, 60)
        self.assertGreater(len(zooms), 2)
        for a, b in zip(zooms, zooms[1:]):
            self.assertGreaterEqual(b.start - a.start, 3.5 - 1e-6)
            self.assertLessEqual(a.end, b.start)
        p = make_project(duration=70)
        p.zooms = zooms
        validate_project(p)


class TrackingTests(unittest.TestCase):
    def test_noise_collapses_to_few_keyframes(self):
        import random
        random.seed(1)
        samples = [(i * 0.25, 0.5 + random.uniform(-0.01, 0.01), 0.45) for i in range(80)]
        kf = tracking.smooth_track(samples)
        self.assertLessEqual(len(kf), 4)

    def test_follows_real_movement(self):
        samples = [(i * 0.25, 0.3 if i < 40 else 0.7, 0.5) for i in range(80)]
        kf = tracking.smooth_track(samples)
        self.assertLess(kf[0].x, 0.35)
        self.assertGreater(kf[-1].x, 0.65)

    def test_no_faces(self):
        self.assertEqual(tracking.smooth_track([(0, None, None), (1, None, None)]), [])


class OutputTests(unittest.TestCase):
    def test_ass_structure_and_trim_shift(self):
        p = make_project()
        p.trim.start, p.trim.end = 2.0, 30.0
        text = build_ass(p, 1080, 1920)
        self.assertIn("PlayResX: 1080", text)
        self.assertIn("[Events]", text)
        first = next(l for l in text.splitlines() if l.startswith("Dialogue"))
        start = first.split(",")[1]
        self.assertEqual(start, "0:00:00.00")  # el primer subtítulo visible arranca en 0
        self.assertEqual(ass_color("#FF8000"), "&H000080FF")
        self.assertEqual(ass_time(3661.5), "1:01:01.50")

    def test_ass_animations(self):
        p = make_project()
        for anim, per_word in (("none", False), ("pop", False), ("karaoke", True)):
            p.caption_style.animation = anim
            n = sum(1 for l in build_ass(p, 1080, 1920).splitlines() if l.startswith("Dialogue"))
            if per_word:
                self.assertGreaterEqual(n, sum(len(c.words) for c in p.captions) - len(p.captions))
            else:
                self.assertEqual(n, len(p.captions))

    def test_ass_escapes_braces(self):
        p = make_project()
        p.captions[0].words[0].text = "{\\b1}hack"
        self.assertNotIn("{\\b1}", build_ass(p, 1080, 1920).split("[Events]")[1])

    def test_srt(self):
        p = make_project()
        p.trim.start = 1.0
        srt = build_srt(p)
        self.assertTrue(srt.startswith("1\n00:00:"))
        self.assertIn(" --> ", srt)


class ProbeTests(unittest.TestCase):
    def test_rotation_swaps_dimensions(self):
        data = {"streams": [{"codec_type": "video", "width": 1920, "height": 1080, "avg_frame_rate": "30000/1001",
                             "side_data_list": [{"rotation": -90}]}, {"codec_type": "audio"}],
                "format": {"duration": "12.5"}}
        info = parse_probe(data)
        self.assertEqual((info.width, info.height), (1080, 1920))
        self.assertAlmostEqual(info.fps, 29.97, places=2)
        self.assertTrue(info.has_audio)


if __name__ == "__main__":
    unittest.main()
