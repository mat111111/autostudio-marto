"""Motor de operaciones: la ÚNICA vía para modificar un proyecto.

La UI (herramientas manuales) y Gemini llaman a las mismas operaciones. Cada operación:
  - recibe parámetros tipados (validados con `from_dict(strict=True)`),
  - muta una copia de trabajo del proyecto,
  - es validada globalmente (rangos, solapes) antes de aceptarse.

Una `Transaction` agrupa varias operaciones; al confirmarse genera UNA sola revisión,
así un único "deshacer" revierte todo lo que hizo un turno de chat.
"""
from __future__ import annotations

import dataclasses
import re
import unicodedata
from dataclasses import dataclass
from typing import Any, Callable, Optional

from .models import Caption, CaptionStyle, Project, Reframe, Trim, Word, Zoom, new_id, validate_project
from .presets import PRESETS, PresetName
from .schema import F, ValidationError, from_dict, json_schema
from typing import Literal


class OpError(ValueError):
    """La operación es válida en forma pero no se puede aplicar (p. ej. id inexistente)."""


@dataclass
class OpSpec:
    name: str
    description: str
    params: type
    fn: Callable[[Project, Any], str]


REGISTRY: dict[str, OpSpec] = {}


def operation(name: str, description: str, params: type):
    def deco(fn):
        REGISTRY[name] = OpSpec(name, description, params, fn)
        return fn
    return deco


def describe_ops() -> list[dict[str, Any]]:
    """Catálogo de operaciones con su esquema (lo usan el frontend y Gemini)."""
    return [{"name": s.name, "description": s.description, "parameters": json_schema(s.params)}
            for s in REGISTRY.values()]


# ------------------------------------------------------------------ helpers

def _norm(text: str) -> str:
    t = unicodedata.normalize("NFKD", text.lower())
    t = "".join(c for c in t if not unicodedata.combining(c))
    return re.sub(r"[^\w]", "", t)


def _caption(p: Project, cid: str) -> Caption:
    for c in p.captions:
        if c.id == cid:
            return c
    raise OpError(f"No existe el subtítulo '{cid}'.")


def _zoom(p: Project, zid: str) -> Zoom:
    for z in p.zooms:
        if z.id == zid:
            return z
    raise OpError(f"No existe el zoom '{zid}'.")


def _check_zoom_free(p: Project, start: float, end: float, ignore: str | None = None) -> None:
    for z in p.zooms:
        if z.id != ignore and start < z.end and end > z.start:
            raise OpError(f"El rango {start:.2f}-{end:.2f} s se superpone con el zoom {z.id} "
                          f"({z.start:.2f}-{z.end:.2f} s). Eliminalo o modificalo primero.")


def _spread(tokens: list[str], start: float, end: float) -> list[Word]:
    step = (end - start) / len(tokens)
    return [Word(text=t, start=round(start + i * step, 3), end=round(start + (i + 1) * step, 3))
            for i, t in enumerate(tokens)]


def _patch(target: Any, params: Any, skip: tuple[str, ...] = ()) -> list[str]:
    changed = []
    for f in dataclasses.fields(params):
        v = getattr(params, f.name)
        if v is not None and f.name not in skip:
            setattr(target, f.name, v)
            changed.append(f.name)
    return changed


# ------------------------------------------------------------------ recorte

@dataclass(kw_only=True)
class SetTrimP:
    start: float = F(ge=0, desc="Inicio del recorte, en segundos del video original")
    end: float = F(ge=0, desc="Fin del recorte, en segundos del video original")


@operation("set_trim", "Define qué tramo del video original se exporta (por ejemplo, para armar un Reel de 45 s).", SetTrimP)
def set_trim(p: Project, a: SetTrimP) -> str:
    p.trim = Trim(start=a.start, end=a.end)
    return f"Recorte: {a.start:.2f}-{a.end:.2f} s ({a.end - a.start:.1f} s de duración)."


# ------------------------------------------------------------------ subtítulos

@dataclass(kw_only=True)
class AddCaptionP:
    start: float = F(ge=0, desc="Inicio en segundos")
    end: float = F(ge=0, desc="Fin en segundos")
    text: str = F(desc="Texto del subtítulo")


@operation("add_caption", "Agrega un subtítulo nuevo en un rango de tiempo.", AddCaptionP)
def add_caption(p: Project, a: AddCaptionP) -> str:
    tokens = a.text.split()
    if not tokens:
        raise OpError("El texto del subtítulo está vacío.")
    cap = Caption(start=a.start, end=a.end, words=_spread(tokens, a.start, a.end))
    p.captions.append(cap)
    return f"Subtítulo {cap.id} agregado."


@dataclass(kw_only=True)
class UpdateCaptionTextP:
    caption_id: str = F()
    text: str = F(desc="Nuevo texto completo del subtítulo")


@operation("update_caption_text", "Corrige el texto de un subtítulo existente.", UpdateCaptionTextP)
def update_caption_text(p: Project, a: UpdateCaptionTextP) -> str:
    cap = _caption(p, a.caption_id)
    tokens = a.text.split()
    if not tokens:
        raise OpError("El texto del subtítulo está vacío. Usá delete_caption para borrarlo.")
    if len(tokens) == len(cap.words):
        for w, t in zip(cap.words, tokens):
            w.text = t
    else:  # cambia la cantidad de palabras: se reparte el tiempo en partes iguales
        cap.words = _spread(tokens, cap.start, cap.end)
    return f"Texto del subtítulo {cap.id} actualizado."


@dataclass(kw_only=True)
class MoveCaptionP:
    caption_id: str = F()
    start: float = F(ge=0)
    end: float = F(ge=0)


@operation("move_caption", "Cambia el inicio y fin de un subtítulo (las palabras se reescalan).", MoveCaptionP)
def move_caption(p: Project, a: MoveCaptionP) -> str:
    cap = _caption(p, a.caption_id)
    old_len = cap.end - cap.start
    new_len = a.end - a.start
    if new_len <= 0:
        raise OpError("El fin debe ser mayor que el inicio.")
    for w in cap.words:
        w.start = round(a.start + (w.start - cap.start) / old_len * new_len, 3)
        w.end = round(a.start + (w.end - cap.start) / old_len * new_len, 3)
    cap.start, cap.end = a.start, a.end
    return f"Subtítulo {cap.id} movido a {a.start:.2f}-{a.end:.2f} s."


@dataclass(kw_only=True)
class DeleteCaptionP:
    caption_id: str = F()


@operation("delete_caption", "Elimina un subtítulo.", DeleteCaptionP)
def delete_caption(p: Project, a: DeleteCaptionP) -> str:
    cap = _caption(p, a.caption_id)
    p.captions.remove(cap)
    return f"Subtítulo {cap.id} eliminado."


@dataclass(kw_only=True)
class SplitCaptionP:
    caption_id: str = F()
    at: float = F(ge=0, desc="Segundo donde se parte el subtítulo")


@operation("split_caption", "Parte un subtítulo en dos en un instante dado.", SplitCaptionP)
def split_caption(p: Project, a: SplitCaptionP) -> str:
    cap = _caption(p, a.caption_id)
    if not (cap.start < a.at < cap.end):
        raise OpError(f"El instante {a.at:.2f} s debe estar dentro del subtítulo ({cap.start:.2f}-{cap.end:.2f} s).")
    left = [w for w in cap.words if w.start < a.at]
    right = [w for w in cap.words if w.start >= a.at]
    if not left or not right:
        raise OpError("El corte deja un lado sin palabras; elegí otro instante.")
    new = Caption(start=a.at, end=cap.end, words=right)
    cap.words, cap.end = left, a.at
    p.captions.append(new)
    return f"Subtítulo {cap.id} dividido; el segundo tramo es {new.id}."


@dataclass(kw_only=True)
class SetCaptionStyleP:
    font: Optional[str] = F(None, desc="Nombre de la fuente (Montserrat, Liberation Serif, DejaVu Sans)")
    font_size: Optional[int] = F(None, ge=24, le=200, desc="Tamaño en px sobre ancho 1080")
    bold: Optional[bool] = F(None)
    uppercase: Optional[bool] = F(None)
    color: Optional[str] = F(None, desc="Hex #RRGGBB")
    highlight_color: Optional[str] = F(None, desc="Color de la palabra activa, hex #RRGGBB")
    keyword_color: Optional[str] = F(None, desc="Color de palabras importantes, hex #RRGGBB")
    outline_color: Optional[str] = F(None)
    outline_width: Optional[float] = F(None, ge=0, le=30)
    shadow: Optional[float] = F(None, ge=0, le=20)
    box: Optional[bool] = F(None)
    box_color: Optional[str] = F(None)
    box_opacity: Optional[float] = F(None, ge=0, le=1)
    position_y: Optional[float] = F(None, ge=0.1, le=0.95, desc="0 arriba, 1 abajo")
    animation: Optional[Literal["none", "pop", "karaoke"]] = F(None)


@operation("set_caption_style", "Modifica propiedades del estilo de los subtítulos (tamaño, color, posición, animación...). Solo cambia los campos indicados.", SetCaptionStyleP)
def set_caption_style(p: Project, a: SetCaptionStyleP) -> str:
    changed = _patch(p.caption_style, a)
    if not changed:
        raise OpError("No indicaste ningún campo para cambiar.")
    return "Estilo de subtítulos actualizado: " + ", ".join(changed) + "."


@dataclass(kw_only=True)
class ApplyPresetP:
    preset: PresetName = F(desc="bold_pop (llamativo), clean_minimal (sobrio), editorial (serif elegante), boxed (con caja)")


@operation("apply_style_preset", "Aplica un estilo completo de subtítulos. Usar para pedidos como 'estética sobria o editorial'.", ApplyPresetP)
def apply_style_preset(p: Project, a: ApplyPresetP) -> str:
    p.caption_style = from_dict(CaptionStyle, PRESETS[a.preset])
    return f"Preset '{a.preset}' aplicado."


@dataclass(kw_only=True)
class SetHighlightWordsP:
    words: list[str] = F(desc="Palabras a resaltar (se ignoran mayúsculas, acentos y puntuación). Lista vacía = quitar resaltados")
    replace: bool = F(True, desc="true: reemplaza los resaltados actuales; false: los suma")
    from_time: Optional[float] = F(None, ge=0, desc="Limita el resaltado a partir de este segundo")
    to_time: Optional[float] = F(None, ge=0, desc="Limita el resaltado hasta este segundo")


@operation("set_highlight_words", "Marca palabras importantes para que se muestren con el color de palabras clave.", SetHighlightWordsP)
def set_highlight_words(p: Project, a: SetHighlightWordsP) -> str:
    targets = {_norm(w) for w in a.words if _norm(w)}
    lo = a.from_time if a.from_time is not None else 0.0
    hi = a.to_time if a.to_time is not None else float("inf")
    marked = 0
    for c in p.captions:
        for w in c.words:
            in_range = lo <= w.start <= hi
            if a.replace and in_range:
                w.highlight = False
            if in_range and _norm(w.text) in targets:
                w.highlight = True
                marked += 1
    return f"{marked} palabra(s) resaltada(s)."


# ------------------------------------------------------------------ zooms

@dataclass(kw_only=True)
class AddZoomP:
    start: float = F(ge=0, desc="Inicio en segundos del video original")
    end: float = F(ge=0, desc="Fin en segundos (mínimo 0.3 s de duración)")
    scale: float = F(1.25, ge=1.05, le=3.0, desc="Acercamiento máximo; 1.2 sutil, 1.4 marcado")
    ease_in: float = F(0.3, ge=0, le=3)
    ease_out: float = F(0.3, ge=0, le=3)
    center_x: Optional[float] = F(None, ge=0, le=1, desc="Punto de interés horizontal 0-1; omitir para seguir el encuadre")
    center_y: Optional[float] = F(None, ge=0, le=1)


@operation("add_zoom", "Agrega un zoom (acercamiento suave) en un rango de tiempo.", AddZoomP)
def add_zoom(p: Project, a: AddZoomP) -> str:
    _check_zoom_free(p, a.start, a.end)
    z = Zoom(start=a.start, end=a.end, scale=a.scale, ease_in=a.ease_in, ease_out=a.ease_out,
             center_x=a.center_x, center_y=a.center_y)
    p.zooms.append(z)
    return f"Zoom {z.id} x{a.scale} en {a.start:.2f}-{a.end:.2f} s."


@dataclass(kw_only=True)
class AddZoomOnCaptionP:
    caption_id: str = F()
    scale: float = F(1.25, ge=1.05, le=3.0)


@operation("add_zoom_on_caption", "Agrega un zoom que cubre exactamente un subtítulo (frase). Ideal para 'hacé zoom en esta frase'.", AddZoomOnCaptionP)
def add_zoom_on_caption(p: Project, a: AddZoomOnCaptionP) -> str:
    cap = _caption(p, a.caption_id)
    end = max(cap.end, cap.start + 0.8)
    _check_zoom_free(p, cap.start, end)
    z = Zoom(start=cap.start, end=end, scale=a.scale)
    p.zooms.append(z)
    return f"Zoom {z.id} x{a.scale} sobre el subtítulo {cap.id}."


@dataclass(kw_only=True)
class UpdateZoomP:
    zoom_id: str = F()
    start: Optional[float] = F(None, ge=0)
    end: Optional[float] = F(None, ge=0)
    scale: Optional[float] = F(None, ge=1.05, le=3.0)
    ease_in: Optional[float] = F(None, ge=0, le=3)
    ease_out: Optional[float] = F(None, ge=0, le=3)
    center_x: Optional[float] = F(None, ge=0, le=1)
    center_y: Optional[float] = F(None, ge=0, le=1)


@operation("update_zoom", "Modifica un zoom existente (tiempo, intensidad o suavidad). Solo cambia los campos indicados.", UpdateZoomP)
def update_zoom(p: Project, a: UpdateZoomP) -> str:
    z = _zoom(p, a.zoom_id)
    changed = _patch(z, a, skip=("zoom_id",))
    if not changed:
        raise OpError("No indicaste ningún campo para cambiar.")
    _check_zoom_free(p, z.start, z.end, ignore=z.id)
    return f"Zoom {z.id} actualizado: " + ", ".join(changed) + "."


@dataclass(kw_only=True)
class RemoveZoomP:
    zoom_id: str = F()


@operation("remove_zoom", "Elimina un zoom por su id.", RemoveZoomP)
def remove_zoom(p: Project, a: RemoveZoomP) -> str:
    z = _zoom(p, a.zoom_id)
    p.zooms.remove(z)
    return f"Zoom {z.id} eliminado."


@dataclass(kw_only=True)
class RemoveZoomsAtP:
    time: float = F(ge=0, desc="Segundo del video original")


@operation("remove_zooms_at", "Elimina el/los zoom que estén activos en un segundo dado. Ideal para 'eliminá el zoom del segundo 35'.", RemoveZoomsAtP)
def remove_zooms_at(p: Project, a: RemoveZoomsAtP) -> str:
    hit = [z for z in p.zooms if z.start - 0.05 <= a.time <= z.end + 0.05]
    if not hit:
        raise OpError(f"No hay ningún zoom activo en {a.time:.2f} s.")
    for z in hit:
        p.zooms.remove(z)
    return f"Eliminé {len(hit)} zoom(s): " + ", ".join(z.id for z in hit) + "."


@dataclass(kw_only=True)
class ClearZoomsP:
    pass


@operation("clear_zooms", "Elimina todos los zooms del proyecto.", ClearZoomsP)
def clear_zooms(p: Project, a: ClearZoomsP) -> str:
    n = len(p.zooms)
    p.zooms.clear()
    return f"{n} zoom(s) eliminados."


# ------------------------------------------------------------------ reencuadre

@dataclass(kw_only=True)
class SetReframeP:
    mode: Literal["face_track", "center", "fixed"] = F(desc="face_track sigue el rostro; center centra; fixed usa fixed_x/fixed_y")
    fixed_x: Optional[float] = F(None, ge=0, le=1)
    fixed_y: Optional[float] = F(None, ge=0, le=1)


@operation("set_reframe", "Cambia cómo se encuadra el video vertical (seguir rostro, centrado o posición fija).", SetReframeP)
def set_reframe(p: Project, a: SetReframeP) -> str:
    p.reframe.mode = a.mode
    if a.fixed_x is not None:
        p.reframe.fixed_x = a.fixed_x
    if a.fixed_y is not None:
        p.reframe.fixed_y = a.fixed_y
    return f"Reencuadre: {a.mode}."


# ------------------------------------------------------------------ transacciones

@dataclass
class OpResult:
    op: str
    ok: bool
    message: str = ""
    error: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {"op": self.op, "ok": self.ok, "message": self.message, "error": self.error}


class Transaction:
    """Aplica operaciones sobre una copia de trabajo. Las fallidas se descartan sin dañar las demás."""

    def __init__(self, project: Project):
        self.work: Project = _clone(project)
        self.results: list[OpResult] = []
        self.applied: list[dict[str, Any]] = []

    def apply(self, name: str, params: dict[str, Any] | None = None) -> OpResult:
        params = params or {}
        spec = REGISTRY.get(name)
        if spec is None:
            return self._record(OpResult(name, False, error=f"Operación desconocida '{name}'."))
        try:
            parsed = from_dict(spec.params, params, strict=True)
        except ValidationError as e:
            return self._record(OpResult(name, False, error=f"Parámetros inválidos: {e}"))

        snapshot = _clone(self.work)
        try:
            msg = spec.fn(self.work, parsed)
            validate_project(self.work)
        except (OpError, ValidationError) as e:
            self.work = snapshot
            return self._record(OpResult(name, False, error=str(e)))
        self.applied.append({"name": name, "params": params})
        return self._record(OpResult(name, True, message=msg))

    def _record(self, r: OpResult) -> OpResult:
        self.results.append(r)
        return r

    @property
    def changed(self) -> bool:
        return bool(self.applied)


def _clone(p: Project) -> Project:
    import copy
    return copy.deepcopy(p)
