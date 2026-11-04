// Estado del proyecto + deshacer/rehacer por instantáneas.
import { newId, clamp } from './util.js';
import { normalizeClips } from './timeline.js';

export const defaultSubStyle = () => ({ enabled: true, size: 64, color: '#ffffff', outline: '#000000', box: '', y: 0.78, font: 'Sans (Arial)', upper: false });
export const defaultSettings = () => ({
  ratio: '9:16', res: 720, fps: 30, fit: 'cover', cx: 0.5, cy: 0.5,
  denoise: false, normalize: true, volume: 1,
  music: { enabled: false, volume: 0.25, duck: true, fadeIn: 1, fadeOut: 2, loop: true },
  crf: 23, preset: 'veryfast',
});

export function initialState(source) {
  return {
    v: 1,
    source, // {name,duration,width,height,size}
    clips: [{ id: newId('c_'), start: 0, end: source.duration, speed: 1, volume: 1 }],
    zooms: [], subs: [], titles: [], overlays: [],
    subStyle: defaultSubStyle(),
    settings: defaultSettings(),
    assets: {}, // id -> {name, dataUrl}  (imágenes; viajan dentro del proyecto)
  };
}

const pick = (src, tpl) => { const o = {}; if (src && typeof src === 'object') for (const k of Object.keys(tpl)) if (k in src && typeof src[k] === typeof tpl[k]) o[k] = src[k]; return o; };

/** Sanea un estado cargado de un archivo (nunca confiamos en JSON externo). */
export function sanitize(raw, source) {
  const st = initialState(source);
  if (!raw || typeof raw !== 'object') return st;
  const dur = source.duration;
  const num = (v, d) => (Number.isFinite(+v) ? +v : d);
  const rng = (o) => { const a = clamp(num(o.start, 0), 0, dur); const b = clamp(num(o.end, a + 1), 0, dur); return b > a ? { start: a, end: b } : null; };
  const arr = (a) => (Array.isArray(a) ? a : []);
  const clips = arr(raw.clips).map((c) => { const r = rng(c || {}); return r && { id: newId('c_'), ...r, speed: clamp(num(c.speed, 1), 0.25, 4), volume: clamp(num(c.volume, 1), 0, 2) }; }).filter(Boolean);
  if (clips.length) st.clips = normalizeClips(clips);
  st.zooms = arr(raw.zooms).map((z) => { const r = rng(z || {}); return r && { id: newId('z_'), ...r, scale: clamp(num(z.scale, 1.3), 1, 4), cx: clamp(num(z.cx, 0.5), 0, 1), cy: clamp(num(z.cy, 0.5), 0, 1) }; }).filter(Boolean);
  st.subs = arr(raw.subs).map((c) => { const r = rng(c || {}); return r && { id: newId('s_'), ...r, text: String(c.text || '').slice(0, 500) }; }).filter(Boolean);
  st.titles = arr(raw.titles).map((t) => { const r = rng(t || {}); return r && { id: newId('t_'), ...r, text: String(t.text || '').slice(0, 300), x: clamp(num(t.x, 0.5), 0, 1), y: clamp(num(t.y, 0.2), 0, 1), size: clamp(num(t.size, 80), 10, 300), color: String(t.color || '#ffffff').slice(0, 30), bg: String(t.bg || '').slice(0, 40), font: String(t.font || 'Sans (Arial)'), weight: 800 }; }).filter(Boolean);
  for (const [id, a] of Object.entries(raw.assets && typeof raw.assets === 'object' ? raw.assets : {})) {
    if (a && typeof a.dataUrl === 'string' && /^data:image\/(png|jpeg|webp|gif);base64,/.test(a.dataUrl)) st.assets[id] = { name: String(a.name || 'imagen').slice(0, 80), dataUrl: a.dataUrl };
  }
  st.overlays = arr(raw.overlays).map((o) => {
    const r = rng(o || {}); if (!r) return null;
    const base = { id: newId('o_'), ...r, x: clamp(num(o.x, 0.5), 0, 1), y: clamp(num(o.y, 0.5), 0, 1), w: clamp(num(o.w, 0.4), 0.02, 1.5), opacity: clamp(num(o.opacity, 1), 0, 1) };
    if (o.kind === 'card' && o.card) {
      const c = o.card; const T = ['quote', 'definition', 'timeline', 'diagram', 'reference'];
      return { ...base, kind: 'card', card: { type: T.includes(c.type) ? c.type : 'quote', title: String(c.title || '').slice(0, 200), body: String(c.body || '').slice(0, 1500), author: String(c.author || '').slice(0, 200), year: String(c.year || '').slice(0, 20), source: String(c.source || '').slice(0, 300), accent: /^#[0-9a-f]{6}$/i.test(c.accent) ? c.accent : '#ffd23f', y: clamp(num(c.y, 0.5), 0.1, 0.9) } };
    }
    return st.assets[o.assetId] ? { ...base, kind: 'image', assetId: o.assetId } : null;
  }).filter(Boolean);
  Object.assign(st.subStyle, pick(raw.subStyle, defaultSubStyle()));
  const d = defaultSettings();
  const rs = raw.settings || {};
  Object.assign(st.settings, pick(rs, d));
  st.settings.music = { ...d.music, ...pick(rs.music, d.music) };
  if (!['9:16', '1:1', '4:5', '16:9'].includes(st.settings.ratio)) st.settings.ratio = '9:16';
  if (![540, 720, 1080].includes(+st.settings.res)) st.settings.res = 720;
  if (!['cover', 'blur'].includes(st.settings.fit)) st.settings.fit = 'cover';
  st.settings.fps = clamp(num(st.settings.fps, 30), 10, 60);
  st.settings.crf = clamp(num(st.settings.crf, 23), 14, 35);
  if (!['ultrafast', 'veryfast', 'fast', 'medium'].includes(st.settings.preset)) st.settings.preset = 'veryfast';
  return st;
}

export class Store {
  constructor() { this.state = null; this.past = []; this.future = []; this.listeners = new Set(); this._last = { key: null, at: 0 }; }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(why) { for (const fn of this.listeners) fn(this.state, why); }
  load(state) { this.state = state; this.past = []; this.future = []; this._last.key = null; this.emit('load'); }
  /** Aplica un cambio. `coalesce` agrupa ediciones seguidas (arrastres, sliders) en un solo paso de deshacer. */
  mutate(fn, { coalesce = null, label = '' } = {}) {
    const now = performance.now();
    const same = coalesce && this._last.key === coalesce && now - this._last.at < 900;
    if (!same) { this.past.push({ s: JSON.stringify(this.state), label }); if (this.past.length > 80) this.past.shift(); }
    this._last = { key: coalesce, at: now };
    this.future = [];
    fn(this.state);
    this.state.clips = normalizeClips(this.state.clips);
    this.emit('mutate');
  }
  undo() { if (!this.past.length) return false; this.future.push({ s: JSON.stringify(this.state) }); this.state = JSON.parse(this.past.pop().s); this._last.key = null; this.emit('undo'); return true; }
  redo() { if (!this.future.length) return false; this.past.push({ s: JSON.stringify(this.state) }); this.state = JSON.parse(this.future.pop().s); this._last.key = null; this.emit('redo'); return true; }
  /** Reemplaza todo el estado (restaurar versión) conservando el deshacer. */
  replace(state, label = '') { this.past.push({ s: JSON.stringify(this.state), label }); this.future = []; this.state = state; this._last.key = null; this.emit('replace'); }
}
