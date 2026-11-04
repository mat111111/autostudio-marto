"""Trabajos largos: análisis inicial del video y exportación. Corren en el worker."""
from __future__ import annotations

import traceback

from ..config import get_settings
from ..core import autoedit, tracking
from ..core.models import project_from_dict
from ..core.schema import to_dict
from ..media import faces, proxy, transcribe
from ..render.ass import build_srt
from ..render.pipeline import RenderSettings, render_project
from ..storage import Repo


def _repo() -> Repo:
    return Repo(get_settings().db_path)


def analyze_project(project_id: str, job_id: str) -> None:
    s, repo = get_settings(), _repo()
    pdir = s.project_dir(project_id)
    try:
        repo.update_job(job_id, status="running", stage="proxy", progress=0.02)
        p = project_from_dict(repo.get_doc(project_id))
        src = pdir / p.source.path

        proxy.make_proxy(src, pdir / "proxy.mp4", fps=p.output.fps)
        repo.update_job(job_id, stage="transcribing", progress=0.2)

        wav = pdir / "audio.wav"
        words = []
        language = "es"
        if p.source.has_audio:
            proxy.extract_audio(src, wav)
            tr = transcribe.transcribe_words(
                wav, model_size=s.whisper_model, device=s.whisper_device, compute_type=s.whisper_compute_type,
                progress=lambda f: repo.update_job(job_id, progress=0.2 + 0.5 * f))
            words, language = tr.words, tr.language
            p.transcript = tr

        repo.update_job(job_id, stage="tracking", progress=0.72)
        samples = faces.detect_face_track(pdir / "proxy.mp4",
                                          progress=lambda f: repo.update_job(job_id, progress=0.72 + 0.2 * f))
        keyframes = tracking.smooth_track(samples)

        repo.update_job(job_id, stage="editing", progress=0.95)
        p.source.proxy_path = "proxy.mp4"
        p.captions = autoedit.build_captions(words)
        p.zooms = autoedit.suggest_zooms(p.captions, p.trim.start, p.trim.end)
        p.reframe.keyframes = keyframes
        p.reframe.mode = "face_track" if keyframes else "center"
        label = "Edición automática" + ("" if words else " (sin voz detectada)")
        repo.commit(project_id, to_dict(p), label, "auto", [])
        repo.set_status(project_id, "ready")
        repo.update_job(job_id, status="done", stage="ready", progress=1.0)
    except Exception as e:  # el error queda visible en la UI; el original sigue intacto
        traceback.print_exc()
        repo.set_status(project_id, "error", str(e)[:500])
        repo.update_job(job_id, status="failed", error=str(e)[:500])


def render_export(export_id: str, job_id: str) -> None:
    s, repo = get_settings(), _repo()
    try:
        exp = repo.get_export(export_id)
        pid = exp["project_id"]
        p = project_from_dict(repo.get_doc(pid, exp["revision_seq"]))  # exporta la versión pedida, no la última
        st = RenderSettings(**exp["settings"])
        out_dir = s.project_dir(pid) / "exports"
        out_path = out_dir / f"{export_id}.mp4"
        repo.update_job(job_id, status="running", stage="rendering", progress=0.0)
        render_project(p, s.project_dir(pid), out_path, st, fonts_dir=s.fonts_dir,
                       progress=lambda f, m: repo.update_job(job_id, progress=f, stage=m))
        (out_dir / f"{export_id}.srt").write_text(build_srt(p), encoding="utf-8")
        repo.set_export_path(export_id, str(out_path))
        repo.update_job(job_id, status="done", stage="ready", progress=1.0)
    except Exception as e:
        traceback.print_exc()
        repo.update_job(job_id, status="failed", error=str(e)[:500])
