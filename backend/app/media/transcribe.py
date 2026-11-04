"""Transcripción con faster-whisper y marcas de tiempo por palabra."""
from __future__ import annotations

from typing import Callable, Optional

from ..core.models import Transcript, Word

_MODEL = None
_MODEL_KEY = None


def _get_model(size: str, device: str, compute_type: str):
    global _MODEL, _MODEL_KEY
    key = (size, device, compute_type)
    if _MODEL is None or _MODEL_KEY != key:
        from faster_whisper import WhisperModel  # import tardío: es pesado
        _MODEL = WhisperModel(size, device=device, compute_type=compute_type)
        _MODEL_KEY = key
    return _MODEL


def transcribe_words(wav_path, *, model_size: str = "small", device: str = "cpu", compute_type: str = "int8",
                     language: Optional[str] = None,
                     progress: Optional[Callable[[float], None]] = None) -> Transcript:
    model = _get_model(model_size, device, compute_type)
    segments, info = model.transcribe(str(wav_path), word_timestamps=True, vad_filter=True,
                                      language=language, beam_size=5)
    words: list[Word] = []
    for seg in segments:  # `segments` es un generador: el trabajo ocurre al iterar
        for w in seg.words or []:
            text = w.word.strip()
            if text:
                words.append(Word(text=text, start=round(max(w.start, 0.0), 3),
                                  end=round(max(w.end, w.start), 3)))
        if progress and info.duration:
            progress(min(seg.end / info.duration, 1.0))
    return Transcript(language=info.language, words=words)
