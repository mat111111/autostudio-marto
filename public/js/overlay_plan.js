// Plan de la capa de superposiciones: en qué instantes de SALIDA cambia lo visible.
// Devuelve intervalos [a,b] (tiempo de salida) con su tiempo original representativo.
import { mapRange, outToSrc, outDuration } from './timeline.js';
import { visibleSignature } from './paint.js';

export function overlayItems(state) {
  const items = [...state.overlays, ...state.titles];
  if (state.subStyle.enabled) items.push(...state.subs);
  return items;
}

export function planOverlay(state) {
  const items = overlayItems(state);
  if (!items.length) return [];
  const D = outDuration(state.clips);
  const cuts = new Set([0, D]);
  for (const it of items) for (const [a, b] of mapRange(state.clips, it.start, it.end)) { cuts.add(a); cuts.add(b); }
  const pts = [...cuts].filter((x) => x >= 0 && x <= D + 1e-6).sort((a, b) => a - b);
  const plan = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (b - a < 1e-3) continue;
    const src = outToSrc(state.clips, (a + b) / 2);
    if (src == null) continue;
    plan.push({ a, b, src, sig: visibleSignature(state, src) });
  }
  // Une intervalos contiguos con la misma firma (menos PNG, menos trabajo).
  const merged = [];
  for (const p of plan) {
    const l = merged[merged.length - 1];
    if (l && l.sig === p.sig && Math.abs(l.b - p.a) < 1e-3) l.b = p.b;
    else merged.push({ ...p });
  }
  return merged;
}
