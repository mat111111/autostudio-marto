import type { Caption } from "../types";
import { round3 } from "./format";

export interface Span { id: string; start: number; end: number }
export type DragMode = "move" | "l" | "r";

/** Calcula el nuevo rango de un bloque arrastrado sin pisar a sus vecinos ni salirse del video. */
export function clampSpan(spans: Span[], id: string, mode: DragMode, origin: { start: number; end: number },
                          dt: number, duration: number, minLen: number): { start: number; end: number } {
  let lo = 0, hi = duration;
  for (const s of spans) {
    if (s.id === id) continue;
    if (s.start < origin.start - 1e-9) lo = Math.max(lo, s.end);
    else hi = Math.min(hi, s.start);
  }
  const len = origin.end - origin.start;
  let start = origin.start, end = origin.end;
  if (mode === "move") {
    start = Math.min(Math.max(origin.start + dt, lo), Math.max(lo, hi - len));
    end = start + len;
  } else if (mode === "l") {
    start = Math.min(Math.max(origin.start + dt, lo), origin.end - minLen);
  } else {
    end = Math.max(Math.min(origin.end + dt, hi), origin.start + minLen);
  }
  return { start: round3(start), end: round3(end) };
}

export function captionAt(captions: Caption[], t: number): Caption | null {
  for (const c of captions) if (t >= c.start && t < c.end) return c;
  return null;
}

/** Índice de la palabra "activa" (la que se está diciendo) dentro de un subtítulo. */
export function activeWordIndex(c: Caption, t: number): number {
  let idx = 0;
  for (let i = 0; i < c.words.length; i++) if (t >= c.words[i].start) idx = i;
  return idx;
}

/** Separación de marcas de la regla según el zoom (px por segundo). */
export function tickSteps(pxPerSec: number): { major: number; minor: number } {
  const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  const major = steps.find((s) => s * pxPerSec >= 90) ?? 600;
  return { major, minor: major / 5 };
}
