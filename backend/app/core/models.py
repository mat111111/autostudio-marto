"""Modelo del proyecto. Es un documento JSON puro: todo lo que ve el editor sale de acá.

Convención: TODOS los tiempos están en segundos sobre el video ORIGINAL.
El recorte (`trim`) solo define qué rango se exporta; el render desplaza los tiempos.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Literal, Optional

from .schema import F, ValidationError, from_dict, revalidate

SCHEMA_VERSION = 1
EPS = 0.05  # tolerancia de bordes en segundos


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:8]}"


@dataclass(kw_only=True)
class Source:
    path: str = F(desc="Ruta relativa a la carpeta del proyecto")
    filename: str = F()
    duration: float = F(ge=0)
    width: int = F(ge=1)
    height: int = F(ge=1)
    fps: float = F(30.0, ge=1)
    has_audio: bool = F(True)
    sha256: str = F("")
    proxy_path: Optional[str] = F(None)


@dataclass(kw_only=True)
class Word:
    text: str = F()
    start: float = F(ge=0)
    end: float = F(ge=0)
    highlight: bool = F(False)

    def validate(self) -> None:
        if self.end < self.start:
            raise ValidationError(f"palabra '{self.text}': fin < inicio")


@dataclass(kw_only=True)
class Transcript:
    language: str = F("es")
    words: list[Word] = F(factory=list)


@dataclass(kw_only=True)
class Caption:
    id: str = F(factory=lambda: new_id("cap"))
    start: float = F(ge=0)
    end: float = F(ge=0)
    words: list[Word] = F(factory=list)

    @property
    def text(self) -> str:
        return " ".join(w.text for w in self.words)

    def validate(self) -> None:
        if self.end <= self.start:
            raise ValidationError(f"subtítulo {self.id}: el fin debe ser mayor que el inicio")


@dataclass(kw_only=True)
class CaptionStyle:
    preset: str = F("bold_pop")
    font: str = F("Montserrat")
    font_size: int = F(76, ge=24, le=200, desc="Tamaño en px sobre ancho de 1080")
    bold: bool = F(True)
    uppercase: bool = F(True)
    color: str = F("#FFFFFF", desc="Color del texto, hex #RRGGBB")
    highlight_color: str = F("#FFD400", desc="Color de la palabra activa (modo karaoke)")
    keyword_color: str = F("#FFD400", desc="Color de las palabras marcadas como importantes")
    outline_color: str = F("#000000")
    outline_width: float = F(7.0, ge=0, le=30)
    shadow: float = F(2.0, ge=0, le=20)
    box: bool = F(False, desc="Fondo opaco detrás del texto")
    box_color: str = F("#000000")
    box_opacity: float = F(0.6, ge=0, le=1)
    position_y: float = F(0.70, ge=0.1, le=0.95, desc="Altura del centro del texto: 0 arriba, 1 abajo")
    animation: Literal["none", "pop", "karaoke"] = F("karaoke")

    def validate(self) -> None:
        for name in ("color", "highlight_color", "keyword_color", "outline_color", "box_color"):
            v = getattr(self, name)
            if not (isinstance(v, str) and len(v) == 7 and v[0] == "#"
                    and all(c in "0123456789abcdefABCDEF" for c in v[1:])):
                raise ValidationError(f"{name}: debe ser un color hex #RRGGBB, recibí {v!r}")


@dataclass(kw_only=True)
class Zoom:
    id: str = F(factory=lambda: new_id("zoom"))
    start: float = F(ge=0)
    end: float = F(ge=0)
    scale: float = F(1.25, ge=1.05, le=3.0, desc="Factor de acercamiento máximo")
    ease_in: float = F(0.3, ge=0, le=3)
    ease_out: float = F(0.3, ge=0, le=3)
    center_x: Optional[float] = F(None, ge=0, le=1)
    center_y: Optional[float] = F(None, ge=0, le=1)

    def validate(self) -> None:
        if self.end - self.start < 0.3 - 1e-9:
            raise ValidationError(f"zoom {self.id}: debe durar al menos 0.3 s")
        if (self.center_x is None) != (self.center_y is None):
            raise ValidationError(f"zoom {self.id}: center_x y center_y van juntos")


@dataclass(kw_only=True)
class Keyframe:
    t: float = F(ge=0)
    x: float = F(ge=0, le=1)
    y: float = F(ge=0, le=1)


@dataclass(kw_only=True)
class Reframe:
    mode: Literal["face_track", "center", "fixed"] = F("face_track")
    fixed_x: float = F(0.5, ge=0, le=1)
    fixed_y: float = F(0.5, ge=0, le=1)
    keyframes: list[Keyframe] = F(factory=list)


@dataclass(kw_only=True)
class Trim:
    start: float = F(ge=0)
    end: float = F(ge=0)

    def validate(self) -> None:
        if self.end - self.start < 0.5 - 1e-9:
            raise ValidationError("el recorte debe durar al menos 0.5 s")


@dataclass(kw_only=True)
class OutputFormat:
    width: int = F(1080, ge=240, le=4320)
    height: int = F(1920, ge=240, le=7680)
    fps: int = F(30, ge=10, le=60)


@dataclass(kw_only=True)
class Project:
    schema_version: int = F(SCHEMA_VERSION)
    id: str = F()
    name: str = F("Sin título")
    source: Source
    trim: Trim
    output: OutputFormat = F(factory=OutputFormat)
    transcript: Transcript = F(factory=Transcript)
    captions: list[Caption] = F(factory=list)
    caption_style: CaptionStyle = F(factory=CaptionStyle)
    zooms: list[Zoom] = F(factory=list)
    reframe: Reframe = F(factory=Reframe)


def new_project(project_id: str, name: str, source: Source) -> Project:
    return Project(id=project_id, name=name, source=source,
                   trim=Trim(start=0.0, end=source.duration))


def project_from_dict(data: dict) -> Project:
    return from_dict(Project, data, strict=False)


def validate_project(p: Project) -> None:
    """Normaliza (orden) y valida invariantes. Lanza ValidationError si algo no cierra."""
    p.captions.sort(key=lambda c: c.start)
    p.zooms.sort(key=lambda z: z.start)
    p.reframe.keyframes.sort(key=lambda k: k.t)
    revalidate(p)  # tipos, rangos y validaciones de cada elemento

    dur = p.source.duration
    if p.trim.end > dur + EPS:
        raise ValidationError(f"el recorte termina en {p.trim.end:.2f} s pero el video dura {dur:.2f} s")
    for c in p.captions:
        if c.end > dur + EPS:
            raise ValidationError(f"subtítulo {c.id} termina fuera del video ({c.end:.2f} s)")
    for a, b in zip(p.captions, p.captions[1:]):
        if b.start < a.end - 0.02:
            raise ValidationError(f"los subtítulos {a.id} y {b.id} se superponen")
    for z in p.zooms:
        if z.end > dur + EPS:
            raise ValidationError(f"zoom {z.id} termina fuera del video ({z.end:.2f} s)")
    for a, b in zip(p.zooms, p.zooms[1:]):
        if b.start < a.end - 1e-6:
            raise ValidationError(f"los zooms {a.id} y {b.id} se superponen")
