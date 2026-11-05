// Estado compartido de la interfaz (singletons) y helpers de edición.
import { Store } from './store.js';
import { clamp } from './util.js';

export const store = new Store();
export const ui = {
  file: null, video: null, url: null,
  analysis: null, analysisState: 'idle', // idle | busy | ok | fail
  musicFile: null,
  images: new Map(), // assetId -> HTMLImageElement
  sel: null, // {kind,id}
  marks: { a: null, b: null },
  tab: 'cortes',
  pps: 70, // píxeles por segundo en la línea de tiempo
  playing: false,
  skipPanel: false,
  silence: { db: -40, min: 0.5 },
  guides: false,
  exporting: false,
  result: null,
  sig: '',
};
export const $ = (s, r = document) => r.querySelector(s);

let toastTimer;
export function toast(msg, kind = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'show ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ''), kind === 'err' ? 6000 : 2600);
}

/** Cambio estructural: la barra de herramientas y paneles se redibujan. */
export const act = (fn, label = '') => store.mutate(fn, { label });
/** Cambio de un campo (no redibuja el panel: no se pierde el foco al escribir). */
export const edit = (fn, key) => { ui.skipPanel = true; store.mutate(fn, { coalesce: key }); };

export const curT = () => (ui.video ? ui.video.currentTime : 0);
export const duration = () => store.state?.source.duration || 0;
export function seek(t) {
  if (!ui.video) return;
  ui.video.currentTime = clamp(t, 0, Math.max(0, duration() - 0.001));
}

export const TAB_FOR = { clip: 'cortes', zoom: 'encuadre', sub: 'subs', title: 'textos', overlay: 'textos', card: 'tarjetas' };
export const listeners = { select: [] };
export function select(kind, id) {
  ui.sel = kind ? { kind, id } : null;
  if (kind) {
    const o = kind === 'overlay' ? store.state.overlays.find((x) => x.id === id) : null;
    ui.tab = kind === 'overlay' && o?.kind === 'card' ? 'tarjetas' : TAB_FOR[kind];
  }
  store.emit('select');
  if (kind) requestAnimationFrame(() => document.querySelector('.row.sel')?.scrollIntoView({ block: 'nearest' }));
}
export const isSel = (kind, id) => ui.sel && ui.sel.kind === kind && ui.sel.id === id;

/** Selección de trabajo: marcas I/O si existen; si no, null. */
export function markRange() {
  const { a, b } = ui.marks;
  if (a == null || b == null) return null;
  const s = Math.min(a, b), e = Math.max(a, b);
  return e - s > 0.03 ? [s, e] : null;
}

/** Ancho máximo de la línea de tiempo en px. Más allá, algunas GPU/Chromium dejan de dibujar la página (queda negra). */
export const MAX_TL_WIDTH = 24000;
export const ppsLimits = () => {
  const d = Math.max(1, duration());
  return { min: Math.min(6, MAX_TL_WIDTH / d), max: Math.min(400, MAX_TL_WIDTH / d) };
};
/** Fija el zoom de la línea de tiempo respetando los límites y sincroniza el slider. */
export function setPps(v) {
  const { min, max } = ppsLimits();
  ui.pps = clamp(v, min, Math.max(min, max));
  const el = document.getElementById('zoomTl');
  if (el) { el.min = min; el.max = Math.max(min, max); el.value = ui.pps; }
  return ui.pps;
}
