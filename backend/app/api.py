"""API HTTP. Capa fina: valida entrada, delega en el motor de operaciones, el repositorio y los jobs.

La clave de Gemini se usa únicamente acá (backend); el navegador nunca la ve.
"""
from __future__ import annotations

import hashlib
import shutil
import uuid
from pathlib import Path
from typing import Any, Literal, Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field

from .ai.director import Director, DirectorError
from .ai.gemini_client import GeminiClient
from .config import get_settings
from .core import ops as engine
from .core.models import Source, new_project, project_from_dict
from .core.schema import to_dict
from .jobs.queue import enqueue
from .media.probe import ProbeError, probe
from .render.ass import build_srt
from .storage import Conflict, NotFound, Repo

settings = get_settings()
repo = Repo(settings.db_path)
app = FastAPI(title="AutoStudio AI", version="0.1.0")
app.add_middleware(CORSMiddleware, allow_origins=list(settings.cors_origins),
                   allow_methods=["*"], allow_headers=["*"])

ALLOWED_EXT = {".mp4", ".mov"}


@app.exception_handler(NotFound)
def _not_found(_, exc: NotFound):
    return Response(str(exc), status_code=404)


@app.exception_handler(Conflict)
def _conflict(_, exc: Conflict):
    return Response(str(exc), status_code=409)


def _state(pid: str) -> dict[str, Any]:
    proj = repo.get_project(pid)
    return {
        "id": pid, "name": proj["name"], "status": proj["status"], "error": proj["error"],
        "head_seq": proj["head_seq"], **repo.history_flags(pid),
        "project": repo.get_doc(pid),
        "analysis_job": repo.latest_job(pid, "analyze"),
    }


# ------------------------------------------------------------------ salud y catálogo

@app.get("/api/health")
def health():
    return {"ok": True, "ffmpeg": shutil.which("ffmpeg") is not None, "gemini_configured": bool(settings.gemini_api_key)}


@app.get("/api/ops")
def ops_catalog():
    """Operaciones disponibles con sus parámetros (la UI y Gemini usan el mismo catálogo)."""
    return engine.describe_ops()


# ------------------------------------------------------------------ proyectos

@app.post("/api/projects", status_code=201)
def create_project(file: UploadFile = File(...), name: Optional[str] = Form(None)):
    ext = Path(file.filename or "").suffix.lower()
    if ext not in ALLOWED_EXT:
        raise HTTPException(415, "Formato no soportado. Subí un archivo MP4 o MOV.")
    pid = f"prj_{uuid.uuid4().hex[:10]}"
    pdir = settings.project_dir(pid)
    orig = pdir / "original"
    orig.mkdir(parents=True, exist_ok=True)
    dest = orig / f"source{ext}"
    sha, size, limit = hashlib.sha256(), 0, settings.max_upload_mb * 1024 * 1024
    try:
        with open(dest, "wb") as out:
            while chunk := file.file.read(1024 * 1024):
                size += len(chunk)
                if size > limit:
                    raise HTTPException(413, f"El archivo supera el máximo de {settings.max_upload_mb} MB.")
                sha.update(chunk)
                out.write(chunk)
        info = probe(dest)
    except ProbeError as e:
        shutil.rmtree(pdir, ignore_errors=True)
        raise HTTPException(422, str(e))
    except BaseException:
        shutil.rmtree(pdir, ignore_errors=True)
        raise
    dest.chmod(0o444)  # el original queda de solo lectura

    source = Source(path=f"original/source{ext}", filename=file.filename or dest.name, duration=info.duration,
                    width=info.width, height=info.height, fps=info.fps, has_audio=info.has_audio,
                    sha256=sha.hexdigest())
    project = new_project(pid, name or Path(file.filename or "Proyecto").stem, source)
    repo.create_project(pid, project.name, to_dict(project), status="analyzing")
    job_id = repo.create_job(pid, "analyze")
    enqueue("app.jobs.tasks.analyze_project", pid, job_id)
    return _state(pid)


@app.get("/api/projects")
def list_projects():
    return repo.list_projects()


@app.get("/api/projects/{pid}")
def get_project(pid: str):
    return _state(pid)


@app.get("/api/projects/{pid}/media/{kind}")
def get_media(pid: str, kind: Literal["proxy", "original"]):
    p = project_from_dict(repo.get_doc(pid))
    rel = p.source.proxy_path if kind == "proxy" else p.source.path
    path = settings.project_dir(pid) / (rel or "")
    if not rel or not path.exists():
        raise HTTPException(404, "El archivo todavía no está disponible.")
    return FileResponse(path, media_type="video/mp4")  # soporta Range (necesario para el <video>)


# ------------------------------------------------------------------ operaciones e historial

class OpItem(BaseModel):
    name: str
    params: dict[str, Any] = Field(default_factory=dict)


class OpsBody(BaseModel):
    ops: list[OpItem]
    label: Optional[str] = None
    expected_head: Optional[int] = None


@app.post("/api/projects/{pid}/ops")
def apply_ops(pid: str, body: OpsBody):
    """Aplica operaciones como una sola transacción atómica (una revisión, un deshacer)."""
    if repo.get_project(pid)["status"] == "analyzing":
        raise HTTPException(409, "El proyecto todavía se está analizando.")
    head = repo.get_project(pid)["head_seq"]
    tx = engine.Transaction(project_from_dict(repo.get_doc(pid)))
    for item in body.ops:
        tx.apply(item.name, item.params)
    failed = [r.to_dict() for r in tx.results if not r.ok]
    if failed:
        raise HTTPException(422, {"errors": failed})
    label = body.label or (body.ops[0].name if body.ops else "Edición")
    repo.commit(pid, to_dict(tx.work), label, "user", tx.applied, expected_head=body.expected_head or head)
    return _state(pid)


@app.post("/api/projects/{pid}/undo")
def undo(pid: str):
    repo.undo(pid)
    return _state(pid)


@app.post("/api/projects/{pid}/redo")
def redo(pid: str):
    repo.redo(pid)
    return _state(pid)


@app.get("/api/projects/{pid}/revisions")
def revisions(pid: str):
    return repo.list_revisions(pid)


@app.post("/api/projects/{pid}/revisions/{seq}/restore")
def restore(pid: str, seq: int):
    repo.restore(pid, seq)
    return _state(pid)


# ------------------------------------------------------------------ chat con Gemini

class ChatBody(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    playhead: Optional[float] = None
    selection: Optional[dict[str, Any]] = None


@app.get("/api/projects/{pid}/chat")
def chat_history(pid: str):
    return repo.list_chat(pid)


@app.post("/api/projects/{pid}/chat")
def chat(pid: str, body: ChatBody):
    if not settings.gemini_api_key:
        raise HTTPException(503, "Gemini no está configurado: definí GEMINI_API_KEY en el backend.")
    proj = repo.get_project(pid)
    if proj["status"] != "ready":
        raise HTTPException(409, "El proyecto todavía no terminó de analizarse.")
    head = proj["head_seq"]
    history = [{"role": m["role"], "text": m["text"]} for m in repo.list_chat(pid, limit=10)]
    try:
        turn = Director(GeminiClient(settings.gemini_api_key, settings.gemini_model)).run_turn(
            project_from_dict(repo.get_doc(pid)), body.message, history, body.playhead, body.selection)
    except DirectorError as e:
        raise HTTPException(502, str(e))

    seq = None
    if turn.tx.changed:  # todo el turno = UNA revisión => un solo "deshacer"
        seq = repo.commit(pid, to_dict(turn.tx.work), f"Chat: {body.message[:80]}", "gemini",
                          turn.tx.applied, expected_head=head)
    repo.add_chat(pid, "user", body.message)
    repo.add_chat(pid, "model", turn.reply, turn.results)
    return {"reply": turn.reply, "results": turn.results, "revision": seq, **_state(pid)}


# ------------------------------------------------------------------ exportación

class ExportBody(BaseModel):
    resolution: Literal["1080p", "4k"] = "1080p"
    burn_subtitles: bool = True
    enhance_audio: bool = False
    high_quality_scaling: bool = False


@app.post("/api/projects/{pid}/exports", status_code=202)
def start_export(pid: str, body: ExportBody):
    proj = repo.get_project(pid)
    if proj["status"] != "ready":
        raise HTTPException(409, "El proyecto todavía no terminó de analizarse.")
    job_id = repo.create_job(pid, "export")
    export_id = repo.create_export(pid, proj["head_seq"], body.model_dump(), job_id)
    enqueue("app.jobs.tasks.render_export", export_id, job_id)
    return {"export_id": export_id, "job_id": job_id, "revision": proj["head_seq"]}


@app.get("/api/jobs/{job_id}")
def job_status(job_id: str):
    return repo.get_job(job_id)


@app.get("/api/exports/{export_id}")
def export_status(export_id: str):
    exp = repo.get_export(export_id)
    return {**exp, "job": repo.get_job(exp["job_id"])}


@app.get("/api/exports/{export_id}/download")
def export_download(export_id: str, kind: Literal["video", "srt"] = "video"):
    exp = repo.get_export(export_id)
    if not exp["path"] or not Path(exp["path"]).exists():
        raise HTTPException(404, "La exportación todavía no está lista.")
    path = Path(exp["path"])
    if kind == "srt":
        path = path.with_suffix(".srt")
        return FileResponse(path, media_type="application/x-subrip", filename=f"{export_id}.srt")
    return FileResponse(path, media_type="video/mp4", filename=f"{export_id}.mp4")


@app.get("/api/projects/{pid}/captions.srt")
def captions_srt(pid: str):
    srt = build_srt(project_from_dict(repo.get_doc(pid)))
    return Response(srt, media_type="application/x-subrip",
                    headers={"Content-Disposition": f'attachment; filename="{pid}.srt"'})
