"""Director de edición: traduce instrucciones en lenguaje natural a operaciones reales sobre el proyecto.

El bucle es independiente del SDK (usa mensajes neutros y un `ModelClient`), por eso se puede probar sin
red con un modelo simulado. Gemini solo puede ejecutar las operaciones del registro; cada llamada se valida
y se aplica sobre una copia de trabajo. Nada se guarda acá: la API confirma la transacción como UNA revisión.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional, Protocol

from ..core import ops as engine
from ..core.models import Project
from ..core.ops import Transaction, _norm

MAX_STEPS = 8

SYSTEM_PROMPT = """Sos el director de edición de AutoStudio AI, un editor de videos verticales (Reels, TikTok, Shorts).
Recibís el estado del proyecto y un pedido del usuario. Tu trabajo es EJECUTAR el pedido llamando a las herramientas
disponibles; nunca te limites a recomendar.

Reglas:
- Todos los tiempos son segundos del video ORIGINAL (no del recorte).
- Usá los ids exactos que figuran en el contexto (cap_..., zoom_...). Si el usuario dice "esta frase" o "acá", usá el
  playhead o la selección indicados. Si hay ambigüedad real, pedí una aclaración breve en lugar de adivinar.
- Hacé el cambio mínimo necesario. No toques lo que no se pidió.
- Si una herramienta devuelve error, corregí los parámetros y reintentá (por ejemplo, eliminá un zoom que se superpone).
- Para encontrar un momento por lo que se dice, usá find_in_transcript.
- No inventes capacidades. Hoy podés: recortar, editar subtítulos, cambiar estilos, resaltar palabras, agregar/quitar
  zooms y cambiar el reencuadre. Si piden otra cosa (imágenes, B-roll, música, portadas, quitar silencios), decí con
  claridad que todavía no está disponible y ofrecé lo más cercano que sí podés hacer.
- No inventes citas ni datos que no estén en la transcripción.
- Al terminar, respondé en español rioplatense, en 1 a 3 oraciones, diciendo qué cambiaste realmente.
  Si ninguna herramienta tuvo éxito, decilo sin fingir que lo lograste."""


@dataclass
class ToolCall:
    name: str
    args: dict[str, Any]


@dataclass
class ModelReply:
    text: str
    calls: list[ToolCall] = field(default_factory=list)
    raw: Any = None  # contenido original del SDK; Gemini 3 exige reenviarlo intacto (thought signatures)


class ModelClient(Protocol):
    def generate(self, system: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> ModelReply: ...


class DirectorError(RuntimeError):
    pass


@dataclass
class TurnResult:
    reply: str
    tx: Transaction
    results: list[dict[str, Any]]


FIND_TOOL = {
    "name": "find_in_transcript",
    "description": "Busca en los subtítulos un texto (ignora mayúsculas y acentos) y devuelve los ids y tiempos.",
    "parameters": {"type": "object", "properties": {
        "query": {"type": "string", "description": "Texto a buscar"}}, "required": ["query"]},
}


def tool_declarations() -> list[dict[str, Any]]:
    decls = []
    for d in [FIND_TOOL] + engine.describe_ops():
        d = dict(d)
        if not d.get("parameters", {}).get("properties"):
            d.pop("parameters", None)  # Gemini rechaza objetos de parámetros vacíos
        decls.append(d)
    return decls


def find_in_transcript(p: Project, query: str) -> dict[str, Any]:
    q = _norm(query)
    if not q:
        return {"ok": False, "error": "Consulta vacía."}
    hits = [{"caption_id": c.id, "start": c.start, "end": c.end, "text": c.text}
            for c in p.captions if q in _norm(c.text)]
    return {"ok": True, "matches": hits[:10], "total": len(hits)}


def build_context(p: Project, playhead: Optional[float] = None, selection: Optional[dict] = None) -> str:
    st = p.caption_style
    lines = [
        f"DURACIÓN DEL VIDEO ORIGINAL: {p.source.duration:.2f} s",
        f"RECORTE ACTUAL: {p.trim.start:.2f}-{p.trim.end:.2f} s",
        f"PLAYHEAD (posición del cursor del usuario): {playhead:.2f} s" if playhead is not None else "PLAYHEAD: no informado",
    ]
    if selection:
        lines.append(f"SELECCIÓN DEL USUARIO: {selection}")
    lines.append(f"REENCUADRE: {p.reframe.mode}")
    lines.append(f"ESTILO DE SUBTÍTULOS: preset={st.preset} fuente={st.font} tamaño={st.font_size} "
                 f"color={st.color} resaltado={st.highlight_color} palabras_clave={st.keyword_color} "
                 f"mayúsculas={st.uppercase} posición_y={st.position_y} animación={st.animation}")
    lines.append("ZOOMS (id | inicio-fin | escala):")
    lines += [f"  {z.id} | {z.start:.2f}-{z.end:.2f} | x{z.scale}" for z in p.zooms] or ["  (ninguno)"]
    lines.append("SUBTÍTULOS (id | inicio-fin | texto; * = palabra resaltada):")
    for c in p.captions:
        txt = " ".join(f"*{w.text}*" if w.highlight else w.text for w in c.words)
        lines.append(f"  {c.id} | {c.start:.2f}-{c.end:.2f} | {txt}")
    if not p.captions:
        lines.append("  (ninguno)")
    return "\n".join(lines)


class Director:
    def __init__(self, client: ModelClient, max_steps: int = MAX_STEPS):
        self.client = client
        self.max_steps = max_steps

    def run_turn(self, project: Project, user_text: str, history: Optional[list[dict[str, str]]] = None,
                 playhead: Optional[float] = None, selection: Optional[dict] = None) -> TurnResult:
        tx = Transaction(project)
        tools = tool_declarations()
        messages: list[dict[str, Any]] = []
        for h in history or []:  # solo texto de turnos anteriores
            messages.append({"role": "user" if h["role"] == "user" else "model", "text": h["text"]})
        messages.append({"role": "user", "text":
                         f"[ESTADO DEL PROYECTO]\n{build_context(project, playhead, selection)}\n\n[PEDIDO]\n{user_text}"})

        for _ in range(self.max_steps):
            reply = self.client.generate(SYSTEM_PROMPT, messages, tools)
            if not reply.calls:
                text = reply.text.strip() or self._fallback(tx)
                return TurnResult(text, tx, [r.to_dict() for r in tx.results])
            messages.append({"role": "model", "text": reply.text, "calls": reply.calls, "raw": reply.raw})
            results = []
            for call in reply.calls:
                if call.name == "find_in_transcript":
                    response = find_in_transcript(tx.work, str(call.args.get("query", "")))
                else:
                    response = tx.apply(call.name, call.args).to_dict()
                results.append({"name": call.name, "response": response})
            messages.append({"role": "tool", "results": results})
        text = "Llegué al límite de pasos de este turno. " + self._fallback(tx)
        return TurnResult(text, tx, [r.to_dict() for r in tx.results])

    @staticmethod
    def _fallback(tx: Transaction) -> str:
        ok = [r for r in tx.results if r.ok]
        if not ok:
            return "No pude aplicar ningún cambio."
        return "Apliqué: " + " ".join(r.message for r in ok)
