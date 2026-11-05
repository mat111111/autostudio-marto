// Funciones PURAS sobre la línea de tiempo. Sin I/O: fáciles de testear.
//
// Idea central del modelo: TODOS los elementos (subtítulos, zooms, títulos) viven
// en "tiempo del video original". Lo único que define qué se ve y en qué orden son
// los CLIPS (rangos del original que se conservan). Así, cortar un silencio no obliga
// a desplazar nada: al renderizar se convierte tiempo-original -> tiempo-de-salida.
import { newId } from './util.js';

export const EPS = 0.03;
const sp = (c) => c.speed || 1;

export function outDuration(clips) {
  return clips.reduce((a, c) => a + (c.end - c.start) / sp(c), 0);
}

/** Tiempo original -> tiempo de salida (null si ese instante fue cortado). */
export function srcToOut(clips, t) {
  let acc = 0;
  for (const c of clips) {
    if (t >= c.start - 1e-6 && t <= c.end + 1e-6) return acc + (t - c.start) / sp(c);
    acc += (c.end - c.start) / sp(c);
  }
  return null;
}

/** Tiempo de salida -> tiempo original. */
export function outToSrc(clips, o) {
  let acc = 0;
  for (const c of clips) {
    const d = (c.end - c.start) / sp(c);
    if (o <= acc + d + 1e-6) return c.start + (o - acc) * sp(c);
    acc += d;
  }
  return null;
}

/** Trozos de [a,b] (tiempo original) que sobreviven, expresados en tiempo de salida. */
export function mapRange(clips, a, b) {
  const pieces = [];
  let acc = 0;
  for (const c of clips) {
    const s = Math.max(a, c.start);
    const e = Math.min(b, c.end);
    if (e - s > 1e-3) pieces.push([acc + (s - c.start) / sp(c), acc + (e - c.start) / sp(c)]);
    acc += (c.end - c.start) / sp(c);
  }
  return pieces;
}

/** Un único intervalo de salida [primer inicio, último fin] o null si todo fue cortado. */
export function mapSpan(clips, a, b) {
  const p = mapRange(clips, a, b);
  return p.length ? [p[0][0], p[p.length - 1][1]] : null;
}

export function normalizeClips(clips) {
  return clips
    .filter((c) => c.end - c.start > EPS)
    .sort((x, y) => x.start - y.start);
}

/** Elimina el rango [a,b] del original. */
export function cutRange(clips, a, b) {
  const out = [];
  for (const c of clips) {
    if (b <= c.start || a >= c.end) {
      out.push(c);
      continue;
    }
    const keepLeft = a > c.start + EPS;
    if (keepLeft) out.push({ ...c, end: Math.min(a, c.end) });
    if (b < c.end - EPS) out.push({ ...c, id: keepLeft ? newId('c_') : c.id, start: Math.max(b, c.start) });
  }
  return normalizeClips(out);
}

/** Conserva SOLO el rango [a,b]. */
export function keepRange(clips, a, b) {
  const out = [];
  for (const c of clips) {
    const s = Math.max(a, c.start);
    const e = Math.min(b, c.end);
    if (e - s > EPS) out.push({ ...c, start: s, end: e });
  }
  return normalizeClips(out);
}

export function splitAt(clips, t) {
  const out = [];
  for (const c of clips) {
    if (t > c.start + EPS && t < c.end - EPS) {
      out.push({ ...c, end: t }, { ...c, id: newId('c_'), start: t });
    } else out.push(c);
  }
  return out;
}

/** Cambia la velocidad de [a,b] partiendo los clips en los bordes. */
export function setSpeedRange(clips, a, b, speed) {
  let cs = splitAt(splitAt(clips, a), b);
  cs = cs.map((c) => (c.start >= a - EPS && c.end <= b + EPS ? { ...c, speed } : c));
  return cs;
}

export function mergeIntervals(list, gap = 0) {
  const s = [...list].sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const iv of s) {
    const last = out[out.length - 1];
    if (last && iv[0] <= last[1] + gap) last[1] = Math.max(last[1], iv[1]);
    else out.push([iv[0], iv[1]]);
  }
  return out;
}

export const insideClips = (clips, t) => clips.some((c) => t >= c.start && t < c.end);

/** Bloques de habla = complemento de los silencios detectados. */
export function speechBlocks(silences, duration, minLen = 0.25) {
  const blocks = [];
  let cur = 0;
  for (const s of [...silences].sort((a, b) => a.start - b.start)) {
    if (s.start - cur >= minLen) blocks.push({ start: cur, end: s.start });
    cur = Math.max(cur, s.end);
  }
  if (duration - cur >= minLen) blocks.push({ start: cur, end: duration });
  return blocks;
}

/**
 * Hace lugar para un zoom nuevo: los zooms existentes que se superponen se recortan
 * o se parten. El zoom nuevo siempre gana (así "zoom en 12" nunca falla por solapamiento).
 */
export function carveZooms(zooms, a, b) {
  const out = [];
  for (const z of zooms) {
    if (b <= z.start || a >= z.end) {
      out.push(z);
      continue;
    }
    if (a > z.start + EPS) out.push({ ...z, end: a });
    if (b < z.end - EPS) out.push({ ...z, id: a > z.start + EPS ? newId('z_') : z.id, start: b });
  }
  return out;
}

/**
 * Segmentos de render: cada clip se parte en los bordes de zoom. Dentro de un
 * segmento el encuadre es constante => un solo `crop` estático por segmento.
 * El zoom es {scale, cx, cy}: cx/cy = centro del encuadre (0..1 sobre el original).
 */
export function buildSegments({ clips, zooms }) {
  const segs = [];
  for (const c of clips) {
    const cuts = new Set([c.start, c.end]);
    for (const z of zooms) {
      if (z.end > c.start && z.start < c.end) {
        cuts.add(Math.min(c.end, Math.max(c.start, z.start)));
        cuts.add(Math.min(c.end, Math.max(c.start, z.end)));
      }
    }
    const pts = [...cuts].sort((a, b) => a - b);
    for (let i = 0; i < pts.length - 1; i++) {
      const s = pts[i];
      const e = pts[i + 1];
      if (e - s < 0.02) continue;
      const mid = (s + e) / 2;
      let z = null;
      for (const zz of zooms) if (mid >= zz.start && mid < zz.end) z = zz; // el último gana
      segs.push({
        start: s,
        end: e,
        speed: c.speed || 1,
        volume: c.volume ?? 1,
        zoom: z ? { scale: z.scale, cx: z.cx, cy: z.cy, anim: z.anim || 'static', zstart: z.start, zend: z.end } : null,
      });
    }
  }
  return segs;
}

/** Zoom activo en el instante t (tiempo original) o null. */
export function zoomAt(zooms, t) {
  let z = null;
  for (const zz of zooms) if (t >= zz.start && t < zz.end) z = zz;
  return z;
}

export const clipAt = (clips, t) => clips.find((c) => t >= c.start - 1e-6 && t < c.end - 1e-6) || null;
export const nextClip = (clips, t) => clips.find((c) => c.start > t) || null;

// ---- Efectos de zoom --------------------------------------------------------------------------
export const ZOOM_ANIMS = [['static', 'Fijo'], ['in', 'Acercar suave'], ['out', 'Alejar suave'], ['inout', 'Acercar y volver'], ['punch', 'Golpe (rápido)']];
export const PUNCH_SECS = 0.3;
const ease = (p) => p * p * (3 - 2 * p); // smoothstep
const cl = (v, a, b) => Math.min(b, Math.max(a, v));

/** Fracción 0..1 del efecto. p = progreso en el rango, secs = segundos desde el inicio del zoom. */
export function zoomFrac(anim, p, secs) {
  switch (anim) {
    case 'in': return ease(p);
    case 'out': return 1 - ease(p);
    case 'inout': return Math.sin(Math.PI * p);
    case 'punch': return ease(cl(secs / PUNCH_SECS, 0, 1));
    default: return 1;
  }
}

/**
 * Encuadre (escala + centro) para un zoom en el instante t (tiempo original).
 * La vista previa y el render usan ESTA misma definición. `animate=false` => valor final fijo.
 * g = foco global {cx,cy}: el zoom animado se desplaza desde ahí hasta su propio centro.
 */
export function zoomState(z, t, g, animate = true) {
  if (!z) return { scale: 1, cx: g.cx, cy: g.cy };
  if (!animate || !z.anim || z.anim === 'static') return { scale: z.scale, cx: z.cx, cy: z.cy };
  const dur = z.end - z.start;
  const secs = cl(t - z.start, 0, dur);
  const f = zoomFrac(z.anim, dur > 0 ? secs / dur : 1, secs);
  return { scale: 1 + (z.scale - 1) * f, cx: g.cx + (z.cx - g.cx) * f, cy: g.cy + (z.cy - g.cy) * f };
}
