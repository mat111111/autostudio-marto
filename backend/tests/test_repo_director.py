import tempfile
import unittest
from pathlib import Path

from app.ai.director import Director, ModelReply, ToolCall, build_context, tool_declarations
from app.core import autoedit
from app.core.models import Source, Word, new_project, project_from_dict
from app.core.schema import to_dict
from app.storage import Conflict, NotFound, Repo


def make_project():
    src = Source(path="original/source.mp4", filename="source.mp4", duration=60.0, width=1920, height=1080, fps=30)
    p = new_project("prj_t", "T", src)
    words = [Word(text=t, start=i * 0.4, end=i * 0.4 + 0.35) for i, t in enumerate(
        "Hola a todos esto es un video de prueba. Nunca dejes de aprender, ¿te imaginás eso? Gracias".split())]
    p.captions = autoedit.build_captions(words)
    return p


class RepoTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Repo(Path(self.tmp.name) / "t.db")
        self.doc = to_dict(make_project())
        self.repo.create_project("prj_t", "T", self.doc)

    def tearDown(self):
        self.tmp.cleanup()

    def edit(self, label, n_zooms):
        d = self.repo.get_doc("prj_t")
        d["zooms"] = [{"id": f"z{i}", "start": i * 5.0, "end": i * 5.0 + 1.0, "scale": 1.2} for i in range(n_zooms)]
        return self.repo.commit("prj_t", d, label, "user", [])

    def test_undo_redo_cycle(self):
        self.assertEqual(self.edit("a", 1), 2)
        self.assertEqual(self.edit("b", 2), 3)
        self.assertEqual(len(self.repo.get_doc("prj_t")["zooms"]), 2)
        self.assertEqual(self.repo.undo("prj_t"), 2)
        self.assertEqual(len(self.repo.get_doc("prj_t")["zooms"]), 1)
        self.assertEqual(self.repo.history_flags("prj_t"), {"can_undo": True, "can_redo": True})
        self.assertEqual(self.repo.redo("prj_t"), 3)
        self.assertEqual(len(self.repo.get_doc("prj_t")["zooms"]), 2)
        with self.assertRaises(Conflict):
            self.repo.redo("prj_t")

    def test_new_commit_after_undo_clears_redo_but_keeps_history(self):
        self.edit("a", 1)
        self.edit("b", 2)
        self.repo.undo("prj_t")
        seq = self.edit("c", 3)
        self.assertEqual(seq, 4)
        self.assertFalse(self.repo.history_flags("prj_t")["can_redo"])
        self.assertEqual([r["seq"] for r in self.repo.list_revisions("prj_t")], [4, 3, 2, 1])  # nada se pierde

    def test_undo_stops_at_first_revision(self):
        with self.assertRaises(Conflict):
            self.repo.undo("prj_t")

    def test_restore_creates_new_revision(self):
        self.edit("a", 1)
        self.edit("b", 3)
        new = self.repo.restore("prj_t", 2)
        self.assertEqual(new, 4)
        self.assertEqual(len(self.repo.get_doc("prj_t")["zooms"]), 1)
        self.assertEqual(len(self.repo.get_doc("prj_t", 3)["zooms"]), 3)  # la versión vieja sigue intacta
        self.repo.undo("prj_t")
        self.assertEqual(len(self.repo.get_doc("prj_t")["zooms"]), 3)

    def test_optimistic_concurrency(self):
        self.edit("a", 1)
        d = self.repo.get_doc("prj_t")
        with self.assertRaises(Conflict):
            self.repo.commit("prj_t", d, "x", "gemini", [], expected_head=1)
        self.repo.commit("prj_t", d, "x", "gemini", [], expected_head=2)

    def test_jobs_chat_exports(self):
        jid = self.repo.create_job("prj_t", "analyze")
        self.repo.update_job(jid, status="running", progress=0.4, stage="transcribing")
        self.assertEqual(self.repo.get_job(jid)["progress"], 0.4)
        self.assertEqual(self.repo.latest_job("prj_t", "analyze")["id"], jid)
        self.repo.add_chat("prj_t", "user", "hola")
        self.repo.add_chat("prj_t", "model", "chau", [{"op": "x"}])
        self.assertEqual([m["role"] for m in self.repo.list_chat("prj_t")], ["user", "model"])
        eid = self.repo.create_export("prj_t", 1, {"resolution": "1080p"}, jid)
        self.repo.set_export_path(eid, "/x.mp4")
        self.assertEqual(self.repo.get_export(eid)["path"], "/x.mp4")
        with self.assertRaises(NotFound):
            self.repo.get_project("nope")

    def test_doc_roundtrips_into_project(self):
        p = project_from_dict(self.repo.get_doc("prj_t"))
        self.assertEqual(p.id, "prj_t")


class FakeModel:
    """Modelo simulado: devuelve respuestas guionadas y guarda lo que recibió."""

    def __init__(self, script):
        self.script = list(script)
        self.seen = []

    def generate(self, system, messages, tools):
        self.seen.append((system, [dict(m) for m in messages], tools))
        return self.script.pop(0)


class DirectorTests(unittest.TestCase):
    def setUp(self):
        self.p = make_project()

    def test_executes_tools_and_reports(self):
        cap = self.p.captions[1]
        model = FakeModel([
            ModelReply(text="", calls=[ToolCall("add_zoom_on_caption", {"caption_id": cap.id, "scale": 1.4}),
                                       ToolCall("set_caption_style", {"font_size": 90})], raw="RAW1"),
            ModelReply(text="Listo: zoom en la frase y subtítulos más grandes."),
        ])
        out = Director(model).run_turn(self.p, "hacé zoom en esta frase y agrandá los subtítulos", playhead=cap.start)
        self.assertEqual(out.reply, "Listo: zoom en la frase y subtítulos más grandes.")
        self.assertTrue(out.tx.changed)
        self.assertEqual(len(out.tx.work.zooms), 1)
        self.assertEqual(out.tx.work.caption_style.font_size, 90)
        self.assertEqual(len(self.p.zooms), 0)  # el proyecto original no se muta
        # el segundo mensaje reenvía el contenido crudo del modelo y los resultados de las herramientas
        msgs = model.seen[1][1]
        self.assertEqual(msgs[-2]["raw"], "RAW1")
        self.assertTrue(all(r["response"]["ok"] for r in msgs[-1]["results"]))

    def test_model_can_recover_from_error(self):
        cap = self.p.captions[0]
        model = FakeModel([
            ModelReply(text="", calls=[ToolCall("add_zoom", {"start": 1, "end": 3})]),
            ModelReply(text="", calls=[ToolCall("add_zoom", {"start": 2, "end": 4})]),   # se superpone
            ModelReply(text="", calls=[ToolCall("remove_zooms_at", {"time": 2}), ToolCall("add_zoom", {"start": 2, "end": 4})]),
            ModelReply(text="Reemplacé el zoom."),
        ])
        out = Director(model).run_turn(self.p, "poné un zoom en 2-4")
        self.assertEqual([(z.start, z.end) for z in out.tx.work.zooms], [(2, 4)])
        errors = [r for r in out.results if not r["ok"]]
        self.assertEqual(len(errors), 1)

    def test_find_in_transcript_is_read_only(self):
        model = FakeModel([
            ModelReply(text="", calls=[ToolCall("find_in_transcript", {"query": "IMAGINAS"})]),
            ModelReply(text="Está en el segundo indicado."),
        ])
        out = Director(model).run_turn(self.p, "¿dónde digo imaginás?")
        self.assertFalse(out.tx.changed)
        resp = model.seen[1][1][-1]["results"][0]["response"]
        self.assertEqual(resp["total"], 1)

    def test_text_only_and_empty_text_fallback(self):
        out = Director(FakeModel([ModelReply(text="Eso todavía no está disponible.")])).run_turn(self.p, "agregá música")
        self.assertFalse(out.tx.changed)
        self.assertIn("no está disponible", out.reply)
        model = FakeModel([ModelReply(text="", calls=[ToolCall("add_zoom", {"start": 1, "end": 3})]), ModelReply(text="")])
        out = Director(model).run_turn(self.p, "zoom")
        self.assertIn("Apliqué", out.reply)

    def test_step_limit(self):
        loop = [ModelReply(text="", calls=[ToolCall("clear_zooms", {})]) for _ in range(20)]
        out = Director(FakeModel(loop), max_steps=3).run_turn(self.p, "loop")
        self.assertIn("límite", out.reply)

    def test_context_and_tool_declarations(self):
        ctx = build_context(self.p, playhead=3.2, selection={"caption_ids": ["x"]})
        self.assertIn(self.p.captions[0].id, ctx)
        self.assertIn("PLAYHEAD", ctx)
        decls = tool_declarations()
        names = [d["name"] for d in decls]
        self.assertIn("find_in_transcript", names)
        clear = next(d for d in decls if d["name"] == "clear_zooms")
        self.assertNotIn("parameters", clear)  # Gemini rechaza objetos de parámetros vacíos
        for d in decls:
            self.assertIn("description", d)


if __name__ == "__main__":
    unittest.main()
