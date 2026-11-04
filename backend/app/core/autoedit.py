"""Edición automática determinística: agrupa palabras en subtítulos y propone zooms.

No usa IA generativa: son heurísticas simples y predecibles. Gemini puede ajustarlas después
con las mismas operaciones que usa el usuario.
"""
from __future__ import annotations

import re

from .models import Caption, Word, Zoom

SENTENCE_END = (".", "?", "!", "…")
EMPHASIS = {
    "nunca", "siempre", "secreto", "error", "clave", "importante", "increíble", "increible",
    "ojo", "atención", "atencion", "cuidado", "gratis", "jamás", "jamas", "verdad", "mentira",
    "never", "always", "secret", "mistake", "key", "important", "amazing", "free", "truth",
}


def build_captions(words: list[Word], *, max_words: int = 4, max_chars: int = 26,
                   max_gap: float = 0.55, tail: float = 0.2) -> list[Caption]:
    """Agrupa palabras en subtítulos cortos, cortando en pausas y fin de oración."""
    groups: list[list[Word]] = []
    cur: list[Word] = []
    for w in words:
        if cur:
            too_long = len(cur) >= max_words or len(" ".join(x.text for x in cur + [w])) > max_chars
            pause = w.start - cur[-1].end > max_gap
            ended = cur[-1].text.endswith(SENTENCE_END) or (cur[-1].text.endswith(",") and len(cur) >= 2)
            if too_long or pause or ended:
                groups.append(cur)
                cur = []
        cur.append(w)
    if cur:
        groups.append(cur)

    captions: list[Caption] = []
    for i, g in enumerate(groups):
        start, last_end = g[0].start, g[-1].end
        limit = groups[i + 1][0].start if i + 1 < len(groups) else last_end + tail
        end = max(min(last_end + tail, limit), last_end)
        if end - start < 0.2:
            end = start + 0.2
        captions.append(Caption(start=round(start, 3), end=round(end, 3),
                                words=[Word(text=w.text, start=w.start, end=w.end) for w in g]))
    # evita solapes introducidos por el mínimo de duración
    for a, b in zip(captions, captions[1:]):
        if a.end > b.start:
            a.end = b.start
    return [c for c in captions if c.end - c.start > 0.05]


def _score(c: Caption, prev_end: float | None) -> float:
    text = c.text
    s = 0.0
    if "?" in text or "!" in text:
        s += 2.0
    if re.search(r"\d", text):
        s += 1.5
    if any(re.sub(r"[^\w]", "", w.text.lower()) in EMPHASIS for w in c.words):
        s += 2.0
    if max((len(re.sub(r"[^\w]", "", w.text)) for w in c.words), default=0) >= 9:
        s += 1.0
    if prev_end is not None and c.start - prev_end > 0.7:  # idea nueva después de una pausa
        s += 1.0
    return s


def suggest_zooms(captions: list[Caption], trim_start: float, trim_end: float, *,
                  min_gap: float = 3.5, min_score: float = 2.0, hook_zoom: bool = True) -> list[Zoom]:
    """Elige momentos de énfasis y propone zooms alternando intensidad para dar ritmo."""
    inside = [c for c in captions if c.start >= trim_start and c.end <= trim_end]
    scored: list[tuple[float, int]] = []
    prev_end = None
    for idx, c in enumerate(inside):
        scored.append((_score(c, prev_end), idx))
        prev_end = c.end

    chosen: list[int] = []
    if hook_zoom and inside:
        chosen.append(0)  # el primer subtítulo es el gancho
    for score, idx in sorted(scored, key=lambda s: (-s[0], s[1])):
        if score < min_score or idx in chosen:
            continue
        c = inside[idx]
        if all(abs(c.start - inside[j].start) >= min_gap for j in chosen):
            chosen.append(idx)
    chosen.sort()

    zooms: list[Zoom] = []
    for n, idx in enumerate(chosen):
        c = inside[idx]
        dur = min(max(c.end - c.start, 1.0), 2.2)
        end = min(c.start + dur, trim_end)
        if end - c.start < 0.5:
            continue
        zooms.append(Zoom(start=c.start, end=end, scale=1.32 if n % 2 == 0 else 1.18))
    return zooms
