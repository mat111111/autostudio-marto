"""Generación de subtítulos ASS (se queman con libass vía FFmpeg) y exportación SRT."""
from __future__ import annotations

from ..core.models import Caption, CaptionStyle, Project, Word

REF_WIDTH = 1080  # los tamaños del estilo están expresados sobre un ancho de 1080 px


def ass_color(hex_color: str, alpha: int = 0) -> str:
    """'#RRGGBB' -> '&HAABBGGRR' (alpha 0 = opaco, 255 = transparente)."""
    h = hex_color.lstrip("#")
    r, g, b = h[0:2], h[2:4], h[4:6]
    return f"&H{alpha:02X}{b}{g}{r}".upper()


def _tag_color(hex_color: str) -> str:
    """Color para etiquetas de override dentro del texto: '&HBBGGRR&'."""
    h = hex_color.lstrip("#")
    return f"&H{h[4:6]}{h[2:4]}{h[0:2]}&".upper()


def ass_time(sec: float) -> str:
    cs = max(0, int(round(sec * 100)))
    h, rem = divmod(cs, 360000)
    m, rem = divmod(rem, 6000)
    s, c = divmod(rem, 100)
    return f"{h}:{m:02d}:{s:02d}.{c:02d}"


def _clean(text: str, upper: bool) -> str:
    t = text.replace("\\", "").replace("{", "(").replace("}", ")").replace("\n", " ")
    return t.upper() if upper else t


def _visible_window(c: Caption, trim_start: float, trim_end: float) -> tuple[float, float] | None:
    start = max(c.start, trim_start) - trim_start
    end = min(c.end, trim_end) - trim_start
    return (start, end) if end - start > 0.01 else None


def _compose(words: list[Word], style: CaptionStyle, active: int | None) -> str:
    parts = []
    base = _tag_color(style.color)
    for i, w in enumerate(words):
        txt = _clean(w.text, style.uppercase)
        color = None
        if active is not None and i == active:
            color = style.highlight_color
        elif w.highlight:
            color = style.keyword_color
        parts.append(f"{{\\1c{_tag_color(color)}}}{txt}{{\\1c{base}}}" if color else txt)
    return " ".join(parts)


def build_ass(p: Project, out_w: int, out_h: int) -> str:
    st = p.caption_style
    k = out_w / REF_WIDTH
    trim_s, trim_e = p.trim.start, p.trim.end
    pos = f"\\an5\\pos({out_w // 2},{int(out_h * st.position_y)})"

    if st.box:
        border_style, outline = 3, 16 * k
        outline_col = ass_color(st.box_color, int(round((1 - st.box_opacity) * 255)))
        back_col = ass_color("#000000", 255)
        shadow = 0
    else:
        border_style, outline = 1, st.outline_width * k
        outline_col = ass_color(st.outline_color)
        back_col = ass_color("#000000", 100)
        shadow = st.shadow * k

    margin = int(70 * k)
    lines = [
        "[Script Info]", "ScriptType: v4.00+", f"PlayResX: {out_w}", f"PlayResY: {out_h}",
        "WrapStyle: 0", "ScaledBorderAndShadow: yes", "YCbCr Matrix: TV.709", "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, "
        "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, "
        "Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        f"Style: Default,{st.font},{int(st.font_size * k)},{ass_color(st.color)},{ass_color(st.color)},"
        f"{outline_col},{back_col},{-1 if st.bold else 0},0,0,0,100,100,0,0,{border_style},"
        f"{outline:.1f},{shadow:.1f},5,{margin},{margin},0,1",
        "", "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]

    pop = "\\fscx85\\fscy85\\t(0,120,\\fscx100\\fscy100)"
    for c in p.captions:
        win = _visible_window(c, trim_s, trim_e)
        if win is None or not c.words:
            continue
        start, end = win
        if st.animation == "karaoke":
            for i, w in enumerate(c.words):
                ev_start = start if i == 0 else max(start, w.start - trim_s)
                nxt = c.words[i + 1].start - trim_s if i + 1 < len(c.words) else end
                ev_end = min(end, nxt)
                if ev_end - ev_start < 0.01:
                    continue
                tags = pos + (pop if i == 0 else "")
                lines.append(f"Dialogue: 0,{ass_time(ev_start)},{ass_time(ev_end)},Default,,0,0,0,,"
                             f"{{{tags}}}{_compose(c.words, st, i)}")
        else:
            tags = pos + (pop if st.animation == "pop" else "")
            lines.append(f"Dialogue: 0,{ass_time(start)},{ass_time(end)},Default,,0,0,0,,"
                         f"{{{tags}}}{_compose(c.words, st, None)}")
    return "\n".join(lines) + "\n"


def srt_time(sec: float) -> str:
    ms = max(0, int(round(sec * 1000)))
    h, rem = divmod(ms, 3600000)
    m, rem = divmod(rem, 60000)
    s, ms = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def build_srt(p: Project) -> str:
    """SRT con tiempos relativos al recorte (coincide con el MP4 exportado)."""
    out, n = [], 1
    for c in p.captions:
        win = _visible_window(c, p.trim.start, p.trim.end)
        if win is None:
            continue
        out.append(f"{n}\n{srt_time(win[0])} --> {srt_time(win[1])}\n{c.text}\n")
        n += 1
    return "\n".join(out)
