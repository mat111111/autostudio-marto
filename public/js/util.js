// Utilidades chicas y sin dependencias del DOM (salvo `h`, que solo se usa en el navegador).
let _n = 0;
export const newId = (p = 'x_') => p + Date.now().toString(36) + (_n++).toString(36) + Math.random().toString(36).slice(2, 5);
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const round = (v, d = 3) => Math.round(v * 10 ** d) / 10 ** d;

/** 75.5 -> "01:15.500" */
export function fmt(t, ms = true) {
  if (!Number.isFinite(t)) return '--:--';
  const neg = t < 0;
  t = Math.abs(t);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  const str = String(m).padStart(2, '0') + ':' + (ms ? s.toFixed(3).padStart(6, '0') : String(Math.floor(s)).padStart(2, '0'));
  return (neg ? '-' : '') + str;
}

/** Acepta "75.5", "1:15", "1:15.5", "00:01:15,500". Devuelve null si no se entiende. */
export function parseTime(v) {
  if (typeof v === 'number') return v;
  const s = String(v).trim().replace(',', '.');
  if (!s) return null;
  const parts = s.split(':');
  if (parts.length > 3 || parts.some((p) => p === '' || isNaN(Number(p)))) return null;
  return parts.reduce((acc, p) => acc * 60 + Number(p), 0);
}

/** Crea nodos DOM sin innerHTML (evita inyección con texto del usuario). */
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
