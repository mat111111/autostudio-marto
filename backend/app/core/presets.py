"""Presets de estilo de subtítulos. Tamaños en píxeles sobre un ancho de referencia de 1080."""
from __future__ import annotations

from typing import Any, Literal

PresetName = Literal["bold_pop", "clean_minimal", "editorial", "boxed"]

PRESETS: dict[str, dict[str, Any]] = {
    "bold_pop": dict(
        preset="bold_pop", font="Montserrat", font_size=76, bold=True, uppercase=True,
        color="#FFFFFF", highlight_color="#FFD400", keyword_color="#FFD400",
        outline_color="#000000", outline_width=7.0, shadow=2.0, box=False,
        position_y=0.70, animation="karaoke",
    ),
    "clean_minimal": dict(
        preset="clean_minimal", font="Montserrat", font_size=58, bold=True, uppercase=False,
        color="#FFFFFF", highlight_color="#FFFFFF", keyword_color="#9BE7FF",
        outline_color="#000000", outline_width=3.0, shadow=1.0, box=False,
        position_y=0.78, animation="pop",
    ),
    "editorial": dict(
        preset="editorial", font="Liberation Serif", font_size=62, bold=False, uppercase=False,
        color="#F5F1E8", highlight_color="#E8C07A", keyword_color="#E8C07A",
        outline_color="#1A1A1A", outline_width=2.0, shadow=2.0, box=False,
        position_y=0.80, animation="pop",
    ),
    "boxed": dict(
        preset="boxed", font="Montserrat", font_size=60, bold=True, uppercase=False,
        color="#FFFFFF", highlight_color="#FFD400", keyword_color="#FFD400",
        outline_color="#000000", outline_width=3.0, shadow=0.0, box=True,
        box_color="#000000", box_opacity=0.6,
        position_y=0.74, animation="karaoke",
    ),
}
