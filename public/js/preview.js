// Vista previa: canvas con el MISMO encuadre y las MISMAS capas que el render.
import { store, ui, curT, seek, duration, toast } from './ctx.js';
import { cropRect, outputSize } from './frame.js';
import { zoomAt, clipAt, nextClip, zoomState } from './timeline.js';
import { paintOverlay } from './paint.js';
import { clamp, fmt } from './util.js';

let canvas, ctx;
const pickers = new Set();
export const PREVIEW_RES = 540;

export function initPreview() {
  canvas = document.getElementById('stage');
  ctx = canvas.getContext('2d');
  bindDrag();
  requestAnimationFrame(loop);
}

/** Dibuja el cuadro de `t` (tiempo original) en cualquier contexto. Lo usa también la portada. */
export function drawFrame(c, W, H, st, t, { overlay = true } = {}) {
  const v = ui.video;
  c.fillStyle = '#000';
  c.fillRect(0, 0, W, H);
  if (!v || !v.videoWidth) return;
  if (v.readyState < 2) { c.fillStyle = '#8c97ad'; c.font = `${Math.round(W / 16)}px sans-serif`; c.textAlign = 'center'; c.fillText('Cargando cuadro…', W / 2, H / 2); return; }
  const sw = v.videoWidth, sh = v.videoHeight;
  const z = zoomAt(st.zooms, t);
  // Los efectos animados solo existen en modo "recortar" (igual que en el render).
  const zs = zoomState(z, t, { cx: st.settings.cx, cy: st.settings.cy }, st.settings.fit === 'cover');
  const cx = zs.cx, cy = zs.cy, zoom = zs.scale;
  if (st.settings.fit === 'blur') {
    const bg = cropRect(sw, sh, W / H, 1, 0.5, 0.5);
    c.save();
    try { c.filter = 'blur(14px)'; } catch { /* sin soporte */ }
    c.drawImage(v, bg.x, bg.y, bg.w, bg.h, -20, -20, W + 40, H + 40);
    c.restore();
    const r = cropRect(sw, sh, sw / sh, zoom, cx, cy);
    const k = Math.min(W / r.w, H / r.h);
    c.drawImage(v, r.x, r.y, r.w, r.h, (W - r.w * k) / 2, (H - r.h * k) / 2, r.w * k, r.h * k);
  } else {
    const r = cropRect(sw, sh, W / H, zoom, cx, cy);
    c.drawImage(v, r.x, r.y, r.w, r.h, 0, 0, W, H);
  }
  if (overlay) paintOverlay(c, W, H, st, t, ui.images, false);
}

function guides(c, W, H) {
  // Zonas que las apps tapan con su interfaz (aprox.): arriba 12 %, abajo 22 %, derecha 14 %.
  c.save();
  c.fillStyle = 'rgba(255,60,60,0.18)';
  c.fillRect(0, 0, W, H * 0.12);
  c.fillRect(0, H * 0.78, W, H * 0.22);
  c.fillRect(W * 0.86, H * 0.12, W * 0.14, H * 0.66);
  c.strokeStyle = 'rgba(255,255,255,0.4)';
  c.setLineDash([6, 6]);
  c.strokeRect(W * 0.06, H * 0.12, W * 0.8, H * 0.66);
  c.restore();
}

function playbackTick(st) {
  const v = ui.video;
  if (!ui.playing || v.seeking) return;
  const t = v.currentTime;
  const c = clipAt(st.clips, t);
  if (!c) {
    const nx = nextClip(st.clips, t);
    if (nx) v.currentTime = nx.start;
    else stopPlayback();
    return;
  }
  if (Math.abs(v.playbackRate - c.speed) > 1e-3) v.playbackRate = c.speed;
  v.volume = clamp(c.volume * st.settings.volume, 0, 1);
  if (t >= c.end - 0.035) {
    const nx = nextClip(st.clips, c.end + 1e-3);
    if (nx) v.currentTime = nx.start;
    else stopPlayback();
  }
}

export function stopPlayback() {
  ui.playing = false;
  ui.video?.pause();
  document.getElementById('btnPlay').textContent = '▶';
}
export function togglePlay() {
  const st = store.state;
  if (!st || !ui.video) return;
  if (ui.playing) return stopPlayback();
  let t = ui.video.currentTime;
  if (!clipAt(st.clips, t)) { const nx = nextClip(st.clips, t) || st.clips[0]; if (nx) ui.video.currentTime = nx.start; }
  ui.playing = true;
  ui.video.play().catch((e) => { stopPlayback(); toast('No se pudo reproducir: ' + e.message, 'err'); });
  document.getElementById('btnPlay').textContent = '⏸';
}

let lastSize = '';
function loop() {
  const st = store.state;
  if (st && ui.video) {
    const { W, H } = outputSize(st.settings.ratio, PREVIEW_RES);
    if (lastSize !== W + 'x' + H) { canvas.width = W; canvas.height = H; canvas.style.aspectRatio = `${W}/${H}`; lastSize = W + 'x' + H; }
    playbackTick(st);
    drawFrame(ctx, W, H, st, curT());
    if (ui.guides) guides(ctx, W, H);
    updateTransport(st);
    for (const p of pickers) { if (!p.canvas.isConnected) pickers.delete(p); else p.draw(); }
    window.__tl?.update();
  }
  requestAnimationFrame(loop);
}

function updateTransport(st) {
  const t = curT();
  const el = document.getElementById('timeInfo');
  const D = st.clips.reduce((a, c) => a + (c.end - c.start) / (c.speed || 1), 0);
  let out = 0, found = false;
  for (const c of st.clips) { if (t >= c.start && t <= c.end) { out += (t - c.start) / (c.speed || 1); found = true; break; } out += (c.end - c.start) / (c.speed || 1); }
  el.textContent = `${fmt(t)} orig · ${found ? fmt(out) : '— (cortado)'} / ${fmt(D)} final`;
}

/** Arrastrar en la vista previa mueve el título / imagen / subtítulo seleccionado. */
function bindDrag() {
  let drag = null;
  const pos = (e) => { const r = canvas.getBoundingClientRect(); return [clamp((e.clientX - r.left) / r.width, 0, 1), clamp((e.clientY - r.top) / r.height, 0, 1)]; };
  canvas.addEventListener('pointerdown', (e) => {
    const sel = ui.sel;
    if (!sel || !['title', 'overlay', 'sub'].includes(sel.kind)) return;
    drag = sel;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const [x, y] = pos(e);
    ui.skipPanel = false;
    store.mutate((s) => {
      if (drag.kind === 'title') { const it = s.titles.find((i) => i.id === drag.id); if (it) { it.x = +x.toFixed(3); it.y = +y.toFixed(3); } }
      else if (drag.kind === 'sub') s.subStyle.y = +y.toFixed(3);
      else { const it = s.overlays.find((i) => i.id === drag.id); if (it) { if (it.kind === 'card') it.card.y = clamp(+y.toFixed(3), 0.1, 0.9); else { it.x = +x.toFixed(3); it.y = +y.toFixed(3); } } }
    }, { coalesce: 'drag-preview' });
  });
  const end = () => { drag = null; };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
}

/** Selector de foco: muestra el cuadro completo y el recorte; arrastrar mueve el centro. */
export function focusPicker({ get, set, scale = () => 1, width = 260 }) {
  const cv = document.createElement('canvas');
  cv.className = 'picker';
  const draw = () => {
    const v = ui.video, st = store.state;
    if (!v || !v.videoWidth || !st) return;
    const sw = v.videoWidth, sh = v.videoHeight;
    const w = width, h = Math.round((width * sh) / sw);
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    const c = cv.getContext('2d');
    c.drawImage(v, 0, 0, w, h);
    const { W, H } = outputSize(st.settings.ratio, 540);
    const [cx, cy] = get();
    const r = cropRect(sw, sh, st.settings.fit === 'blur' ? sw / sh : W / H, scale(), cx, cy);
    const k = w / sw;
    c.fillStyle = 'rgba(0,0,0,0.55)';
    c.beginPath(); c.rect(0, 0, w, h); c.rect(r.x * k, r.y * k, r.w * k, r.h * k); c.fill('evenodd');
    c.strokeStyle = '#ffd23f'; c.lineWidth = 2; c.strokeRect(r.x * k, r.y * k, r.w * k, r.h * k);
    c.beginPath(); c.arc(cx * w, cy * h, 5, 0, 7); c.fillStyle = '#ffd23f'; c.fill();
  };
  const setFrom = (e) => { const b = cv.getBoundingClientRect(); set(clamp((e.clientX - b.left) / b.width, 0, 1), clamp((e.clientY - b.top) / b.height, 0, 1)); };
  let down = false;
  cv.addEventListener('pointerdown', (e) => { down = true; cv.setPointerCapture(e.pointerId); setFrom(e); });
  cv.addEventListener('pointermove', (e) => down && setFrom(e));
  cv.addEventListener('pointerup', () => (down = false));
  pickers.add({ canvas: cv, draw });
  return cv;
}
export { duration, seek };
