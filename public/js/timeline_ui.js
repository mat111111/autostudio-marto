// Línea de tiempo multipista. Eje = tiempo del video ORIGINAL; los huecos son lo que cortaste.
import { store, ui, seek, select, isSel, duration, curT, markRange, setPps } from './ctx.js';
import { findSilences } from './audio.js';
import { h, clamp, fmt } from './util.js';

const ROWS = [
  ['ruler', 'Tiempo', 22], ['wave', 'Audio', 46], ['clip', 'Clips', 34], ['zoom', 'Zoom', 24],
  ['sub', 'Subs', 24], ['title', 'Títulos', 24], ['overlay', 'Capas', 24],
];
const MIN = 0.1;
let inner, scroll, playhead, waveCanvas;

export function initTimeline() {
  const labels = document.getElementById('tlLabels');
  labels.replaceChildren(...ROWS.map(([k, name, ht]) => h('div', { class: 'lbl', style: { height: ht + 'px' } }, name)));
  scroll = document.getElementById('tlScroll');
  inner = h('div', { id: 'tlInner' });
  playhead = h('div', { id: 'playhead' });
  scroll.replaceChildren(inner);
  inner.addEventListener('pointerdown', onDown);
  scroll.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setPps(ui.pps * (e.deltaY < 0 ? 1.15 : 0.87));
    renderTimeline();
  }, { passive: false });
  window.__tl = { update };
}

function tickStep(pps) {
  for (const s of [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800]) if (s * pps >= 70) return s;
  return 3600;
}

export function renderTimeline() {
  const st = store.state;
  if (!st || !inner) return;
  const D = duration(), pps = ui.pps, W = Math.max(300, Math.ceil(D * pps));
  inner.style.width = W + 'px';
  const rows = {};
  inner.replaceChildren(...ROWS.map(([k, , ht]) => (rows[k] = h('div', { class: 'trow ' + k, 'data-row': k, style: { height: ht + 'px' } }))));
  const px = (t) => t * pps;
  const place = (el, a, b) => { el.style.left = px(a) + 'px'; el.style.width = Math.max(3, px(b - a)) + 'px'; return el; };

  // Regla
  const step = tickStep(pps);
  for (let t = 0; t <= D + 1e-6; t += step) rows.ruler.append(h('div', { class: 'tick', style: { left: px(t) + 'px' } }, h('span', {}, fmt(t, false))));

  // Audio (forma de onda) + huecos cortados + sugerencias de silencio
  waveCanvas = h('canvas', { class: 'wave' });
  rows.wave.append(waveCanvas);
  drawWave(W);
  let prev = 0;
  const gaps = [];
  for (const c of st.clips) { if (c.start > prev + 0.01) gaps.push([prev, c.start]); prev = c.end; }
  if (prev < D - 0.01) gaps.push([prev, D]);
  for (const [a, b] of gaps) { rows.wave.append(place(h('div', { class: 'gap' }), a, b)); rows.clip.append(place(h('div', { class: 'gap' }), a, b)); }
  if (ui.tab === 'cortes' && ui.analysis) {
    for (const s of findSilences(ui.analysis, ui.silence.db, ui.silence.min)) rows.wave.append(place(h('div', { class: 'sil', title: 'Silencio sugerido (clic para ir)', 'data-t': s.start }), s.start, s.end));
  }

  const blk = (row, kind, it, text, cls = '') => rows[row].append(place(h('div', { class: `blk ${kind} ${cls} ${isSel(kind, it.id) ? 'on' : ''}`, 'data-kind': kind, 'data-id': it.id, title: text }, h('i', { class: 'hl' }), h('span', {}, text), h('i', { class: 'hr' })), it.start, it.end));
  for (const c of st.clips) blk('clip', 'clip', c, `${fmt(c.end - c.start, false)}${c.speed !== 1 ? ' ×' + c.speed : ''}`, c.speed !== 1 ? 'fast' : '');
  for (const z of st.zooms) blk('zoom', 'zoom', z, `🔍 ×${z.scale}${z.anim && z.anim !== 'static' ? ' ' + ({ in: '↗', out: '↘', inout: '↗↘', punch: '⚡' }[z.anim]) : ''}`);
  for (const s of st.subs) blk('sub', 'sub', s, s.text);
  for (const t of st.titles) blk('title', 'title', t, t.text);
  for (const o of st.overlays) blk('overlay', 'overlay', o, o.kind === 'card' ? `🎓 ${o.card.type}` : `🖼 ${st.assets[o.assetId]?.name || 'imagen'}`, o.kind === 'card' ? 'card' : '');

  const r = markRange();
  if (r) for (const k of ['ruler', 'clip']) rows[k].append(place(h('div', { class: 'mark' }), r[0], r[1]));
  else if (ui.marks.a != null) rows.ruler.append(place(h('div', { class: 'mark pin' }), ui.marks.a, ui.marks.a));

  inner.append(playhead);
  update();
}

function drawWave(W) {
  const a = ui.analysis;
  const cw = Math.min(W, 16000), ch = 46;
  waveCanvas.width = cw; waveCanvas.height = ch;
  waveCanvas.style.width = W + 'px';
  const c = waveCanvas.getContext('2d');
  if (!a) {
    c.fillStyle = '#6b7488'; c.font = '11px sans-serif';
    c.fillText(ui.analysisState === 'busy' ? 'Analizando audio…' : 'Sin forma de onda (archivo muy grande o sin audio)', 8, 26);
    return;
  }
  c.fillStyle = '#4aa3ff';
  const perPx = a.duration / cw;
  for (let x = 0; x < cw; x++) {
    const i0 = Math.floor((x * perPx) / a.bin), i1 = Math.max(i0 + 1, Math.floor(((x + 1) * perPx) / a.bin));
    let pk = 0;
    for (let i = i0; i < i1 && i < a.peaks.length; i++) if (a.peaks[i] > pk) pk = a.peaks[i];
    const hh = Math.max(1, Math.min(1, pk * 1.6) * (ch - 4));
    c.fillRect(x, (ch - hh) / 2, 1, hh);
  }
}

export function update() {
  if (!playhead) return;
  const t = curT();
  playhead.style.transform = `translateX(${t * ui.pps}px)`;
  if (ui.playing) {
    const x = t * ui.pps;
    if (x < scroll.scrollLeft + 20 || x > scroll.scrollLeft + scroll.clientWidth - 40) scroll.scrollLeft = Math.max(0, x - 80);
  }
}

// ---- Interacción -----------------------------------------------------------------------------
let drag = null;
function xToT(e) {
  const r = inner.getBoundingClientRect();
  return clamp((e.clientX - r.left) / ui.pps, 0, duration());
}

function onDown(e) {
  if (e.button !== 0) return;
  const el = e.target.closest('.blk');
  if (!el) {
    const sil = e.target.closest('.sil');
    if (sil) return seek(+sil.dataset.t);
    drag = { type: 'seek' };
    seek(xToT(e));
  } else {
    const kind = el.dataset.kind, id = el.dataset.id;
    const it = findItem(kind, id);
    if (!it) return;
    const mode = e.target.classList.contains('hl') ? 'l' : e.target.classList.contains('hr') ? 'r' : 'm';
    if (!isSel(kind, id)) select(kind, id);
    drag = { type: 'item', kind, id, mode, x0: e.clientX, a: it.start, b: it.end, moved: false };
  }
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp, { once: true });
  e.preventDefault();
}

const findItem = (kind, id) => {
  const s = store.state;
  const list = { clip: s.clips, zoom: s.zooms, sub: s.subs, title: s.titles, overlay: s.overlays }[kind];
  return list.find((i) => i.id === id);
};

function onMove(e) {
  if (!drag) return;
  if (drag.type === 'seek') return seek(xToT(e));
  const dt = (e.clientX - drag.x0) / ui.pps;
  if (Math.abs(e.clientX - drag.x0) > 2) drag.moved = true;
  if (!drag.moved) return;
  const D = duration();
  ui.skipPanel = true;
  store.mutate((s) => {
    const list = { clip: s.clips, zoom: s.zooms, sub: s.subs, title: s.titles, overlay: s.overlays }[drag.kind];
    const it = list.find((i) => i.id === drag.id);
    if (!it) return;
    let a = drag.a, b = drag.b;
    if (drag.mode === 'm' && drag.kind !== 'clip') { const len = b - a; a = clamp(a + dt, 0, D - len); b = a + len; }
    if (drag.mode === 'l') a = clamp(a + dt, 0, b - MIN);
    if (drag.mode === 'r') b = clamp(b + dt, a + MIN, D);
    if (drag.kind === 'clip') {
      const idx = list.indexOf(it);
      const lo = idx > 0 ? list[idx - 1].end : 0, hi = idx < list.length - 1 ? list[idx + 1].start : D;
      a = clamp(a, lo, b - MIN); b = clamp(b, a + MIN, hi);
    }
    it.start = +a.toFixed(3); it.end = +b.toFixed(3);
  }, { coalesce: `drag-${drag.kind}-${drag.id}-${drag.mode}` });
}

function onUp() {
  window.removeEventListener('pointermove', onMove);
  if (drag?.type === 'item' && drag.moved) { ui.skipPanel = false; store.emit('mutate'); }
  drag = null;
}
