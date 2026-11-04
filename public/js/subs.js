// SRT: leer, escribir y convertir tiempo-original -> tiempo-de-salida.
import { mapSpan } from './timeline.js';
import { newId } from './util.js';

export function srtTime(t) {
  t = Math.max(0, t);
  const ms = Math.round(t * 1000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
}

const T = String.raw`(\d+):(\d{2}):(\d{2})[,.](\d{1,3})`;
const RE = new RegExp(`${T}\\s*-->\\s*${T}`);
const sec = (h, m, s, ms) => +h * 3600 + +m * 60 + +s + +ms.padEnd(3, '0') / 1000;

export function parseSrt(text) {
  const blocks = String(text).replace(/\r/g, '').replace(/^﻿/, '').split(/\n{2,}/);
  const out = [];
  for (const b of blocks) {
    const lines = b.split('\n').filter((l) => l.trim() !== '');
    const i = lines.findIndex((l) => RE.test(l));
    if (i < 0) continue;
    const m = lines[i].match(RE);
    const start = sec(m[1], m[2], m[3], m[4]);
    const end = sec(m[5], m[6], m[7], m[8]);
    const body = lines.slice(i + 1).join('\n').replace(/<[^>]+>/g, '').trim();
    if (body && end > start) out.push({ id: newId('s_'), start, end, text: body });
  }
  return out;
}

/** SRT en tiempo de salida (lo que realmente verá el espectador tras los cortes). */
export function outputSrt(subs, clips) {
  const rows = [];
  for (const s of [...subs].sort((a, b) => a.start - b.start)) {
    const span = mapSpan(clips, s.start, s.end);
    if (span && span[1] - span[0] > 0.05) rows.push({ a: span[0], b: span[1], text: s.text });
  }
  return rows.map((r, i) => `${i + 1}\n${srtTime(r.a)} --> ${srtTime(r.b)}\n${r.text}\n`).join('\n');
}
