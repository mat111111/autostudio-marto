"""Persistencia (SQLite). Los proyectos son un historial de revisiones inmutables.

- Cada confirmación de cambios (manual, Gemini o automática) crea una revisión con el documento completo.
- `head_seq` apunta a la revisión actual. Deshacer/rehacer solo mueven ese puntero.
- Restaurar una versión vieja crea una revisión NUEVA (el historial es de solo agregado).
- El video original vive en disco y jamás se modifica; el documento solo lo referencia.
"""
from __future__ import annotations

import json
import sqlite3
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, Optional


class NotFound(LookupError):
    pass


class Conflict(RuntimeError):
    """El proyecto cambió desde que el cliente lo leyó (otra edición ganó)."""


SCHEMA = """
CREATE TABLE IF NOT EXISTS projects(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL, error TEXT,
  head_seq INTEGER NOT NULL DEFAULT 0, redo_stack TEXT NOT NULL DEFAULT '[]',
  created_at REAL NOT NULL, updated_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS revisions(
  project_id TEXT NOT NULL, seq INTEGER NOT NULL, parent_seq INTEGER, label TEXT NOT NULL,
  actor TEXT NOT NULL, ops TEXT NOT NULL, doc TEXT NOT NULL, created_at REAL NOT NULL,
  PRIMARY KEY(project_id, seq));
CREATE TABLE IF NOT EXISTS jobs(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
  progress REAL NOT NULL DEFAULT 0, stage TEXT NOT NULL DEFAULT '', error TEXT,
  created_at REAL NOT NULL, updated_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS chat_messages(
  id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, role TEXT NOT NULL,
  text TEXT NOT NULL, ops TEXT NOT NULL DEFAULT '[]', created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS exports(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, revision_seq INTEGER NOT NULL, settings TEXT NOT NULL,
  job_id TEXT NOT NULL, path TEXT, created_at REAL NOT NULL);
"""


def _id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:10]}"


class Repo:
    def __init__(self, db_path: Path | str):
        self.db_path = str(db_path)
        Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)
        with self._conn() as c:
            c.executescript(SCHEMA)

    @contextmanager
    def _conn(self) -> Iterator[sqlite3.Connection]:
        c = sqlite3.connect(self.db_path, timeout=30, isolation_level=None)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA journal_mode=WAL")
        c.execute("PRAGMA busy_timeout=30000")
        try:
            yield c
        finally:
            c.close()

    @contextmanager
    def _write(self) -> Iterator[sqlite3.Connection]:
        with self._conn() as c:
            c.execute("BEGIN IMMEDIATE")
            try:
                yield c
                c.execute("COMMIT")
            except BaseException:
                c.execute("ROLLBACK")
                raise

    # ------------------------------------------------------------ proyectos

    def create_project(self, pid: str, name: str, doc: dict, status: str = "analyzing") -> None:
        now = time.time()
        with self._write() as c:
            c.execute("INSERT INTO projects(id,name,status,head_seq,created_at,updated_at) VALUES(?,?,?,1,?,?)",
                      (pid, name, status, now, now))
            c.execute("INSERT INTO revisions VALUES(?,?,?,?,?,?,?,?)",
                      (pid, 1, None, "Proyecto creado", "system", "[]", json.dumps(doc), now))

    def get_project(self, pid: str) -> dict[str, Any]:
        with self._conn() as c:
            row = c.execute("SELECT * FROM projects WHERE id=?", (pid,)).fetchone()
        if row is None:
            raise NotFound(f"Proyecto '{pid}' inexistente")
        d = dict(row)
        d["redo_stack"] = json.loads(d["redo_stack"])
        return d

    def list_projects(self) -> list[dict[str, Any]]:
        with self._conn() as c:
            rows = c.execute("SELECT id,name,status,head_seq,created_at,updated_at FROM projects "
                             "ORDER BY updated_at DESC").fetchall()
        return [dict(r) for r in rows]

    def set_status(self, pid: str, status: str, error: Optional[str] = None) -> None:
        with self._write() as c:
            c.execute("UPDATE projects SET status=?, error=?, updated_at=? WHERE id=?",
                      (status, error, time.time(), pid))

    # ------------------------------------------------------------ revisiones

    def get_doc(self, pid: str, seq: Optional[int] = None) -> dict[str, Any]:
        with self._conn() as c:
            if seq is None:
                row = c.execute("SELECT r.doc FROM revisions r JOIN projects p "
                                "ON p.id=r.project_id AND p.head_seq=r.seq WHERE p.id=?", (pid,)).fetchone()
            else:
                row = c.execute("SELECT doc FROM revisions WHERE project_id=? AND seq=?", (pid, seq)).fetchone()
        if row is None:
            raise NotFound("Revisión inexistente")
        return json.loads(row["doc"])

    def commit(self, pid: str, doc: dict, label: str, actor: str, ops: list[dict],
               expected_head: Optional[int] = None) -> int:
        with self._write() as c:
            head = self._head(c, pid)
            if expected_head is not None and expected_head != head:
                raise Conflict(f"El proyecto cambió (versión {head}, esperaba {expected_head}). Recargá e intentá de nuevo.")
            seq = c.execute("SELECT MAX(seq) FROM revisions WHERE project_id=?", (pid,)).fetchone()[0] + 1
            now = time.time()
            c.execute("INSERT INTO revisions VALUES(?,?,?,?,?,?,?,?)",
                      (pid, seq, head, label[:200], actor, json.dumps(ops), json.dumps(doc), now))
            c.execute("UPDATE projects SET head_seq=?, redo_stack='[]', updated_at=? WHERE id=?", (seq, now, pid))
        return seq

    def undo(self, pid: str) -> int:
        with self._write() as c:
            head = self._head(c, pid)
            parent = c.execute("SELECT parent_seq FROM revisions WHERE project_id=? AND seq=?",
                               (pid, head)).fetchone()["parent_seq"]
            if parent is None:
                raise Conflict("No hay nada para deshacer.")
            stack = json.loads(c.execute("SELECT redo_stack FROM projects WHERE id=?", (pid,)).fetchone()[0])
            stack.append(head)
            c.execute("UPDATE projects SET head_seq=?, redo_stack=?, updated_at=? WHERE id=?",
                      (parent, json.dumps(stack), time.time(), pid))
        return parent

    def redo(self, pid: str) -> int:
        with self._write() as c:
            stack = json.loads(c.execute("SELECT redo_stack FROM projects WHERE id=?", (pid,)).fetchone()[0])
            if not stack:
                raise Conflict("No hay nada para rehacer.")
            target = stack.pop()
            c.execute("UPDATE projects SET head_seq=?, redo_stack=?, updated_at=? WHERE id=?",
                      (target, json.dumps(stack), time.time(), pid))
        return target

    def restore(self, pid: str, seq: int) -> int:
        doc = self.get_doc(pid, seq)
        return self.commit(pid, doc, f"Restaurado desde la versión {seq}", "user", [])

    def list_revisions(self, pid: str) -> list[dict[str, Any]]:
        with self._conn() as c:
            head = self._head(c, pid)
            rows = c.execute("SELECT seq,parent_seq,label,actor,ops,created_at FROM revisions "
                             "WHERE project_id=? ORDER BY seq DESC", (pid,)).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["ops"] = json.loads(d["ops"])
            d["is_head"] = d["seq"] == head
            out.append(d)
        return out

    def history_flags(self, pid: str) -> dict[str, bool]:
        with self._conn() as c:
            head = self._head(c, pid)
            parent = c.execute("SELECT parent_seq FROM revisions WHERE project_id=? AND seq=?",
                               (pid, head)).fetchone()["parent_seq"]
            stack = json.loads(c.execute("SELECT redo_stack FROM projects WHERE id=?", (pid,)).fetchone()[0])
        return {"can_undo": parent is not None, "can_redo": bool(stack)}

    @staticmethod
    def _head(c: sqlite3.Connection, pid: str) -> int:
        row = c.execute("SELECT head_seq FROM projects WHERE id=?", (pid,)).fetchone()
        if row is None:
            raise NotFound(f"Proyecto '{pid}' inexistente")
        return row["head_seq"]

    # ------------------------------------------------------------ jobs

    def create_job(self, pid: str, kind: str) -> str:
        jid, now = _id("job"), time.time()
        with self._write() as c:
            c.execute("INSERT INTO jobs(id,project_id,kind,status,created_at,updated_at) VALUES(?,?,?,?,?,?)",
                      (jid, pid, kind, "queued", now, now))
        return jid

    def update_job(self, jid: str, **fields: Any) -> None:
        allowed = {"status", "progress", "stage", "error"}
        sets = {k: v for k, v in fields.items() if k in allowed}
        if not sets:
            return
        with self._write() as c:
            c.execute(f"UPDATE jobs SET {', '.join(k + '=?' for k in sets)}, updated_at=? WHERE id=?",
                      (*sets.values(), time.time(), jid))

    def get_job(self, jid: str) -> dict[str, Any]:
        with self._conn() as c:
            row = c.execute("SELECT * FROM jobs WHERE id=?", (jid,)).fetchone()
        if row is None:
            raise NotFound(f"Job '{jid}' inexistente")
        return dict(row)

    def latest_job(self, pid: str, kind: str) -> Optional[dict[str, Any]]:
        with self._conn() as c:
            row = c.execute("SELECT * FROM jobs WHERE project_id=? AND kind=? ORDER BY created_at DESC LIMIT 1",
                            (pid, kind)).fetchone()
        return dict(row) if row else None

    # ------------------------------------------------------------ chat

    def add_chat(self, pid: str, role: str, text: str, ops: Optional[list] = None) -> None:
        with self._write() as c:
            c.execute("INSERT INTO chat_messages(project_id,role,text,ops,created_at) VALUES(?,?,?,?,?)",
                      (pid, role, text, json.dumps(ops or []), time.time()))

    def list_chat(self, pid: str, limit: int = 50) -> list[dict[str, Any]]:
        with self._conn() as c:
            rows = c.execute("SELECT role,text,ops,created_at FROM chat_messages WHERE project_id=? "
                             "ORDER BY id DESC LIMIT ?", (pid, limit)).fetchall()
        out = [dict(r) for r in reversed(rows)]
        for d in out:
            d["ops"] = json.loads(d["ops"])
        return out

    # ------------------------------------------------------------ exports

    def create_export(self, pid: str, revision_seq: int, settings: dict, job_id: str) -> str:
        eid = _id("exp")
        with self._write() as c:
            c.execute("INSERT INTO exports(id,project_id,revision_seq,settings,job_id,created_at) VALUES(?,?,?,?,?,?)",
                      (eid, pid, revision_seq, json.dumps(settings), job_id, time.time()))
        return eid

    def set_export_path(self, eid: str, path: str) -> None:
        with self._write() as c:
            c.execute("UPDATE exports SET path=? WHERE id=?", (path, eid))

    def get_export(self, eid: str) -> dict[str, Any]:
        with self._conn() as c:
            row = c.execute("SELECT * FROM exports WHERE id=?", (eid,)).fetchone()
        if row is None:
            raise NotFound(f"Exportación '{eid}' inexistente")
        d = dict(row)
        d["settings"] = json.loads(d["settings"])
        return d
