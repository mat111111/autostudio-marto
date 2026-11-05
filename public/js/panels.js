// Paneles de herramientas. Todo es manual: cada botón hace exactamente una cosa que vos pedís.
import { store, ui, $, toast, act, edit, seek, curT, duration, select, isSel, markRange } from './ctx.js';
import { h, fmt, parseTime, clamp, newId, round } from './util.js';
import * as T from './timeline.js';
const ANIM_LABEL = Object.fromEntries(T.ZOOM_ANIMS);
import { parseSrt, outputSrt } from './subs.js';
import { findSilences } from './audio.js';
import { focusPicker, drawFrame, stopPlayback } from './preview.js';
import { FONTS, drawText } from './paint.js';
import { buildCopy } from './copy.js';
import { outputSize, RATIOS } from './frame.js';
import { exportVideo, cancelExport, canMultiThread, engineKind, pickEngine, getEnginePref, setEnginePref } from './render.js';
import { sanitize, initialState } from './store.js';

export const TABS = [
  ['cortes', '✂️ Cortes'], ['encuadre', '🔍 Encuadre'], ['subs', '💬 Subtítulos'], ['textos', '🔤 Textos'],
  ['tarjetas', '🎓 Tarjetas'], ['audio', '🎧 Audio'], ['publicar', '📣 Publicar'], ['historial', '🕘 Historial'], ['exportar', '⬇️ Exportar'],
];

// ---- Widgets ---------------------------------------------------------------------------------
const btn = (label, onClick, cls = '', title = '') => h('button', { class: 'btn ' + cls, onclick: onClick, title, type: 'button' }, label);
const sec = (title, ...kids) => h('section', { class: 'sec' }, h('h3', {}, title), ...kids);
const hint = (t) => h('p', { class: 'hint' }, t);
const field = (label, input, cls = '') => h('label', { class: 'fld ' + cls }, h('span', {}, label), input);
const num = (v, o, on) => h('input', { type: 'number', value: v, min: o.min, max: o.max, step: o.step ?? 'any', oninput: (e) => { const n = parseFloat(e.target.value); if (Number.isFinite(n)) on(clamp(n, o.min ?? -1e9, o.max ?? 1e9)); } });
const range = (v, o, on, fmtV = (x) => x) => {
  const out = h('b', {}, fmtV(v));
  const inp = h('input', { type: 'range', min: o.min, max: o.max, step: o.step ?? 0.01, value: v, oninput: (e) => { const n = parseFloat(e.target.value); out.textContent = fmtV(n); on(n); } });
  return h('div', { class: 'rng' }, inp, out);
};
const select_ = (opts, v, on) => h('select', { onchange: (e) => on(e.target.value) }, opts.map((o) => { const [val, lab] = Array.isArray(o) ? o : [o, o]; return h('option', { value: val, selected: String(val) === String(v) }, lab); }));
const check = (label, v, on) => h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: !!v, onchange: (e) => on(e.target.checked) }), label);
const color = (v, on) => h('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(v) ? v : '#ffffff', oninput: (e) => on(e.target.value) });
const text = (v, on, ph = '', tag = 'input') => h(tag, { value: v, placeholder: ph, oninput: (e) => on(e.target.value), ...(tag === 'textarea' ? { rows: 3 } : {}) }, ...(tag === 'textarea' ? [v] : []));
const mm = (n) => (Number.isFinite(n) ? fmt(n) : '');

/** start/end editables + botones "usar cabezal". `get` devuelve el ítem vivo del estado. */
function timesRow(kind, id) {
  const list = () => ({ clip: 'clips', zoom: 'zooms', sub: 'subs', title: 'titles', overlay: 'overlays' }[kind]);
  const it = () => store.state[list()].find((x) => x.id === id);
  const set = (k, v, key) => edit((s) => { const o = s[list()].find((x) => x.id === id); if (!o) return; const D = duration(); v = clamp(v, 0, D); if (k === 'start') o.start = Math.min(v, o.end - 0.1); else o.end = Math.max(v, o.start + 0.1); }, key);
  const tin = (k) => h('input', { class: 'tm', value: mm(it()[k]), onchange: (e) => { const v = parseTime(e.target.value); if (v == null) { e.target.value = mm(it()[k]); return toast('Tiempo inválido. Ej: 1:23.5', 'err'); } set(k, v, `t-${id}-${k}`); e.target.value = mm(it()[k]); } });
  return h('div', { class: 'times' },
    btn('⇤', () => { set('start', curT(), 'x'); store.emit('select'); }, 'mini', 'Inicio = cabezal'), tin('start'), h('span', {}, '→'), tin('end'),
    btn('⇥', () => { set('end', curT(), 'x'); store.emit('select'); }, 'mini', 'Fin = cabezal'),
    btn('▶', () => seek(it().start), 'mini', 'Ir al inicio'));
}

// ---- Panel raíz ------------------------------------------------------------------------------
export function renderTabs() {
  const bar = $('#tabs');
  bar.replaceChildren(...TABS.map(([k, label]) => h('button', { class: 'tab' + (ui.tab === k ? ' on' : ''), onclick: () => { ui.tab = k; store.emit('select'); } }, label)));
}

export function renderPanel() {
  const st = store.state;
  const box = $('#panel');
  if (!st) { box.replaceChildren(h('p', { class: 'hint' }, 'Abrí un video para empezar.')); return; }
  renderTabs();
  const fn = { cortes, encuadre, subs, textos, tarjetas, audio, publicar, historial, exportar }[ui.tab] || cortes;
  const top = box.scrollTop;
  box.replaceChildren(fn(st));
  box.scrollTop = top;
}

// ---- Cortes ----------------------------------------------------------------------------------
function cortes(st) {
  const r = markRange();
  const selClip = ui.sel?.kind === 'clip' ? st.clips.find((c) => c.id === ui.sel.id) : null;
  const target = () => { const m = markRange(); return m || (selClip ? [selClip.start, selClip.end] : null); };
  const needRange = () => { const m = markRange(); if (!m) toast('Marcá una selección con I (entrada) y O (salida), o arrastrá sobre la regla.', 'err'); return m; };

  const marks = sec('Selección (marcas I / O)',
    h('div', { class: 'marks' }, h('div', {}, 'Entrada: ', h('b', {}, ui.marks.a == null ? '—' : fmt(ui.marks.a))), h('div', {}, 'Salida: ', h('b', {}, ui.marks.b == null ? '—' : fmt(ui.marks.b))), h('div', {}, 'Dura: ', h('b', {}, r ? fmt(r[1] - r[0]) : '—'))),
    h('div', { class: 'bar' }, btn('Marcar entrada [I]', () => setMark('a')), btn('Marcar salida [O]', () => setMark('b')), btn('Limpiar', () => { ui.marks = { a: null, b: null }; store.emit('select'); }, 'ghost')),
    hint('Con la selección marcada podés cortar, conservar, acelerar, hacer zoom o agregar un subtítulo justo ahí.'));

  const tools = sec('Cortar',
    h('div', { class: 'grid2' },
      btn('Dividir en cabezal [S]', () => splitHere(), '', 'Parte el clip en el punto actual'),
      btn('Cortar selección [X]', () => { const m = needRange(); if (m) act((s) => { s.clips = T.cutRange(s.clips, m[0], m[1]); }, 'cortar'); }, 'danger'),
      btn('Conservar selección [K]', () => { const m = needRange(); if (m) act((s) => { s.clips = T.keepRange(s.clips, m[0], m[1]); }, 'conservar'); }),
      btn('Eliminar clip elegido [Supr]', () => deleteSelected(), 'danger'),
    ),
    btn('Restaurar video completo', () => act((s) => { s.clips = [{ id: newId('c_'), start: 0, end: duration(), speed: 1, volume: 1 }]; }, 'restaurar'), 'ghost'),
    hint('Los clips también se recortan arrastrando sus bordes en la línea de tiempo. Lo cortado queda como hueco rayado y se puede recuperar con Deshacer.'));

  const speed = sec('Velocidad y volumen',
    h('div', { class: 'chips' }, [0.5, 0.75, 1, 1.25, 1.5, 2, 3].map((v) => btn('×' + v, () => applySpeed(v), 'chip'))),
    field('Personalizada', num(selClip?.speed ?? 1, { min: 0.25, max: 4, step: 0.05 }, (v) => { /* se aplica con Enter via botón */ speedDraft = v; })),
    btn('Aplicar velocidad a ' + (r ? 'la selección' : selClip ? 'el clip elegido' : '…(elegí un clip o marcá un rango)'), () => applySpeed(speedDraft), ''),
    selClip ? field('Volumen del clip', range(selClip.volume, { min: 0, max: 2, step: 0.05 }, (v) => edit((s) => { s.clips.find((c) => c.id === selClip.id).volume = v; }, 'vol-' + selClip.id), (x) => Math.round(x * 100) + '%')) : null);
  speedDraft = selClip?.speed ?? 1;

  const list = sec(`Clips (${st.clips.length})`, h('div', { class: 'list' }, st.clips.map((c, i) => h('div', { class: 'row' + (isSel('clip', c.id) ? ' sel' : ''), onclick: () => select('clip', c.id) },
    h('b', {}, '#' + (i + 1)), h('span', {}, `${fmt(c.start)} → ${fmt(c.end)}`), h('span', { class: 'dim' }, `${fmt((c.end - c.start) / c.speed, false)} s${c.speed !== 1 ? ' · ×' + c.speed : ''}`)))));

  return h('div', {}, marks, tools, speed, silencios(st), list);
}
let speedDraft = 1;

function setMark(k) {
  ui.marks[k] = round(curT());
  store.emit('select');
}
export function splitHere() {
  const t = curT();
  if (!store.state.clips.some((c) => t > c.start + T.EPS && t < c.end - T.EPS)) return toast('El cabezal tiene que estar dentro de un clip.', 'err');
  act((s) => { s.clips = T.splitAt(s.clips, t); }, 'dividir');
}
export function deleteSelected() {
  const sel = ui.sel;
  if (!sel) return toast('Elegí un elemento en la línea de tiempo.', 'err');
  act((s) => {
    const map = { clip: 'clips', zoom: 'zooms', sub: 'subs', title: 'titles', overlay: 'overlays' };
    if (sel.kind === 'clip' && s.clips.length === 1) return toast('Tiene que quedar al menos un clip.', 'err');
    s[map[sel.kind]] = s[map[sel.kind]].filter((x) => x.id !== sel.id);
  }, 'eliminar');
  ui.sel = null;
}
export function cutMarked() { const m = markRange(); if (!m) return toast('Marcá I y O primero.', 'err'); act((s) => { s.clips = T.cutRange(s.clips, m[0], m[1]); }, 'cortar'); }
export function keepMarked() { const m = markRange(); if (!m) return toast('Marcá I y O primero.', 'err'); act((s) => { s.clips = T.keepRange(s.clips, m[0], m[1]); }, 'conservar'); }
export { setMark };

function applySpeed(v) {
  v = clamp(+v || 1, 0.25, 4);
  const m = markRange();
  const sel = ui.sel?.kind === 'clip' ? store.state.clips.find((c) => c.id === ui.sel.id) : null;
  if (!m && !sel) return toast('Marcá un rango con I/O o elegí un clip.', 'err');
  act((s) => { const [a, b] = m || [sel.start, sel.end]; s.clips = T.setSpeedRange(s.clips, a, b, v); }, 'velocidad');
}

/** Ayuda visual: muestra silencios en la onda; cortar es decisión (clic) tuya. */
function silencios(st) {
  if (!ui.analysis) return sec('Ayuda con silencios', hint(ui.analysisState === 'busy' ? 'Analizando el audio…' : 'No hay forma de onda disponible (archivo muy grande, sin audio o formato no decodificable). Podés cortar a mano igual.'));
  const sil = findSilences(ui.analysis, ui.silence.db, ui.silence.min).filter((s) => T.insideClips(st.clips, (s.start + s.end) / 2));
  const total = sil.reduce((a, s) => a + s.end - s.start, 0);
  return sec('Ayuda con silencios',
    hint('Marca en la onda (rojo) los tramos silenciosos según el umbral. No corta nada solo: elegís cuáles.'),
    field('Umbral', range(ui.silence.db, { min: -60, max: -15, step: 1 }, (v) => { ui.silence.db = v; store.emit('select'); }, (x) => x + ' dB')),
    field('Duración mínima', range(ui.silence.min, { min: 0.15, max: 3, step: 0.05 }, (v) => { ui.silence.min = v; store.emit('select'); }, (x) => x.toFixed(2) + ' s')),
    h('p', {}, `${sil.length} silencio(s) · ${total.toFixed(1)} s`),
    h('div', { class: 'list tall' }, sil.slice(0, 80).map((s) => h('div', { class: 'row' }, h('span', {}, `${fmt(s.start)} → ${fmt(s.end)}`), h('span', { class: 'dim' }, (s.end - s.start).toFixed(2) + ' s'), btn('Ver', () => seek(s.start), 'mini'), btn('Cortar', () => act((x) => { x.clips = T.cutRange(x.clips, s.start, s.end); }, 'cortar silencio'), 'mini danger')))),
    sil.length ? btn(`Cortar los ${sil.length} silencios mostrados`, () => act((x) => { for (const s of sil) x.clips = T.cutRange(x.clips, s.start, s.end); }, 'cortar silencios'), 'danger') : null);
}

// ---- Encuadre y zoom -------------------------------------------------------------------------
function encuadre(st) {
  const s = st.settings;
  const fmtSec = sec('Formato',
    field('Relación', select_(Object.keys(RATIOS), s.ratio, (v) => act((x) => { x.settings.ratio = v; }, 'formato'))),
    field('Ajuste', select_([['cover', 'Recortar para llenar'], ['blur', 'Completo con fondo desenfocado']], s.fit, (v) => act((x) => { x.settings.fit = v; }, 'ajuste'))),
    h('p', { class: 'dim' }, 'Centro del encuadre (cuando no hay zoom) — arrastrá el punto:'),
    focusPicker({ get: () => [store.state.settings.cx, store.state.settings.cy], set: (cx, cy) => edit((x) => { x.settings.cx = round(cx); x.settings.cy = round(cy); }, 'focus'), scale: () => 1 }),
    hint('Con "recortar" el rectángulo amarillo es lo que se ve. Mové el punto para centrar a la persona.'));

  const mk = () => {
    const m = markRange();
    const a = m ? m[0] : curT(), b = m ? m[1] : Math.min(duration(), curT() + 2);
    if (b - a < 0.1) return toast('No hay espacio para el zoom.', 'err');
    const id = newId('z_');
    act((x) => { x.zooms = T.carveZooms(x.zooms, a, b); x.zooms.push({ id, start: a, end: b, scale: 1.4, cx: x.settings.cx, cy: x.settings.cy, anim: 'in' }); x.zooms.sort((p, q) => p.start - q.start); }, 'zoom');
    select('zoom', id);
  };
  const zs = sec(`Zooms (${st.zooms.length})`,
    btn('＋ Zoom en la selección (o 2 s desde el cabezal)', mk),
    hint('Elegí el efecto de cada zoom: fijo, acercar/alejar suave, acercar y volver, o golpe rápido. Si tocás otro rango, el zoom nuevo reemplaza al anterior en esa zona. Con efecto, la cámara se desplaza desde el centro general hasta el centro del zoom.'),
    h('div', { class: 'list' }, st.zooms.map((z) => h('div', { class: 'card-row' + (isSel('zoom', z.id) ? ' sel row' : ' row'), onclick: () => !isSel('zoom', z.id) && select('zoom', z.id) },
      h('div', { class: 'top' }, h('b', {}, '🔍 ×' + z.scale + ' · ' + (ANIM_LABEL[z.anim || 'static'])), btn('✕', (e) => { e.stopPropagation(); act((x) => { x.zooms = x.zooms.filter((q) => q.id !== z.id); }, 'borrar zoom'); }, 'mini danger')),
      isSel('zoom', z.id) ? h('div', {}, timesRow('zoom', z.id),
        field('Efecto', select_(T.ZOOM_ANIMS, z.anim || 'static', (v) => act((x) => { x.zooms.find((q) => q.id === z.id).anim = v; }, 'efecto zoom'))),
        store.state.settings.fit === 'blur' && (z.anim || 'static') !== 'static' ? hint('Con "fondo desenfocado" el zoom se aplica fijo; para animarlo elegí "Recortar para llenar".') : null,
        field('Intensidad', range(z.scale, { min: 1, max: 3, step: 0.05 }, (v) => edit((x) => { x.zooms.find((q) => q.id === z.id).scale = v; }, 'zs-' + z.id), (v) => '×' + v.toFixed(2))),
        focusPicker({ get: () => { const q = store.state.zooms.find((i) => i.id === z.id) || z; return [q.cx, q.cy]; }, set: (cx, cy) => edit((x) => { const q = x.zooms.find((i) => i.id === z.id); if (q) { q.cx = round(cx); q.cy = round(cy); } }, 'zf-' + z.id), scale: () => (store.state.zooms.find((i) => i.id === z.id) || z).scale })) : h('span', { class: 'dim' }, `${fmt(z.start)} → ${fmt(z.end)}`)))));
  return h('div', {}, fmtSec, zs, sec('Ayudas', check('Mostrar zonas seguras de Reels/TikTok', ui.guides, (v) => { ui.guides = v; })));
}

// ---- Subtítulos ------------------------------------------------------------------------------
function subs(st) {
  const addAt = () => {
    const m = markRange();
    const a = m ? m[0] : curT(), b = m ? m[1] : Math.min(duration(), curT() + 2);
    const id = newId('s_');
    act((x) => { x.subs.push({ id, start: a, end: b, text: 'Nuevo subtítulo' }); x.subs.sort((p, q) => p.start - q.start); }, 'subtítulo');
    select('sub', id);
  };
  const ss = st.subStyle;
  const style = sec('Estilo',
    check('Mostrar subtítulos en el video', ss.enabled, (v) => act((x) => { x.subStyle.enabled = v; }, 'subs on/off')),
    field('Tamaño', range(ss.size, { min: 24, max: 140, step: 1 }, (v) => edit((x) => { x.subStyle.size = v; }, 'sst'), (v) => v + ' px')),
    field('Posición vertical', range(ss.y, { min: 0.1, max: 0.95, step: 0.01 }, (v) => edit((x) => { x.subStyle.y = v; }, 'ssy'), (v) => Math.round(v * 100) + ' %')),
    h('div', { class: 'grid2' }, field('Texto', color(ss.color, (v) => edit((x) => { x.subStyle.color = v; }, 'ssc'))), field('Contorno', color(ss.outline, (v) => edit((x) => { x.subStyle.outline = v; }, 'sso')))),
    field('Fuente', select_(Object.keys(FONTS), ss.font, (v) => act((x) => { x.subStyle.font = v; }, 'fuente'))),
    check('MAYÚSCULAS', ss.upper, (v) => act((x) => { x.subStyle.upper = v; }, 'mayus')),
    check('Caja de fondo', !!ss.box, (v) => act((x) => { x.subStyle.box = v ? 'rgba(0,0,0,0.6)' : ''; }, 'caja')),
    hint('También podés arrastrar el subtítulo en la vista previa (con uno seleccionado) para subirlo o bajarlo.'));

  const io = sec('Importar / exportar',
    h('div', { class: 'bar' }, btn('＋ Subtítulo aquí', addAt), btn('Importar .srt', () => $('#srtIn').click()), btn('Descargar .srt', () => downloadSrt(), 'ghost')),
    hint('El .srt que importás se toma como tiempo del video ORIGINAL. El que descargás ya descuenta tus cortes y velocidades.'));

  const list = sec(`Subtítulos (${st.subs.length})`, h('div', { class: 'list tall' }, st.subs.map((c) => h('div', { class: 'card-row row' + (isSel('sub', c.id) ? ' sel' : ''), onclick: () => !isSel('sub', c.id) && select('sub', c.id) },
    h('div', { class: 'top' }, timesRow('sub', c.id), btn('✕', (e) => { e.stopPropagation(); act((x) => { x.subs = x.subs.filter((q) => q.id !== c.id); }, 'borrar'); }, 'mini danger')),
    h('textarea', { rows: 2, value: c.text, oninput: (e) => edit((x) => { const q = x.subs.find((i) => i.id === c.id); if (q) q.text = e.target.value.slice(0, 500); }, 'stx-' + c.id), onfocus: () => !isSel('sub', c.id) && (ui.sel = { kind: 'sub', id: c.id }) }, c.text)))),
    st.subs.length ? btn('Borrar todos', () => confirm('¿Borrar todos los subtítulos?') && act((x) => { x.subs = []; }, 'borrar subs'), 'ghost danger') : null);
  return h('div', {}, io, list, style);
}
export async function importSrt(file) {
  const subs = parseSrt(await file.text());
  if (!subs.length) return toast('No se encontraron subtítulos en el archivo.', 'err');
  const D = duration();
  act((x) => { x.subs = [...x.subs, ...subs.map((s) => ({ ...s, start: clamp(s.start, 0, D), end: clamp(s.end, 0, D) })).filter((s) => s.end > s.start)].sort((a, b) => a.start - b.start); }, 'importar srt');
  toast(`${subs.length} subtítulos importados`);
}
function download(blob, name) {
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
const baseName = () => (store.state.source.name || 'video').replace(/\.[^.]+$/, '').replace(/[^\w\-. ]+/g, '_');
function downloadSrt() {
  const st = store.state;
  const srt = outputSrt(st.subs, st.clips);
  if (!srt) return toast('No hay subtítulos visibles en el resultado final.', 'err');
  download(new Blob([srt], { type: 'application/x-subrip' }), baseName() + '-editado.srt');
}

// ---- Textos (títulos + imágenes) -------------------------------------------------------------
function textos(st) {
  const addTitle = () => {
    const m = markRange();
    const a = m ? m[0] : curT(), b = m ? m[1] : Math.min(duration(), curT() + 3);
    const id = newId('t_');
    act((x) => { x.titles.push({ id, start: a, end: b, text: 'Tu título', x: 0.5, y: 0.2, size: 84, color: '#ffffff', bg: '', font: 'Impact', weight: 800 }); }, 'título');
    select('title', id);
  };
  const titles = sec(`Títulos (${st.titles.length})`, btn('＋ Título', addTitle), hint('Con uno seleccionado, arrastralo en la vista previa para ubicarlo.'),
    h('div', { class: 'list' }, st.titles.map((t) => h('div', { class: 'card-row row' + (isSel('title', t.id) ? ' sel' : ''), onclick: () => !isSel('title', t.id) && select('title', t.id) },
      h('div', { class: 'top' }, timesRow('title', t.id), btn('✕', (e) => { e.stopPropagation(); act((x) => { x.titles = x.titles.filter((q) => q.id !== t.id); }, 'borrar'); }, 'mini danger')),
      h('textarea', { rows: 2, value: t.text, oninput: (e) => edit((x) => { const q = x.titles.find((i) => i.id === t.id); if (q) q.text = e.target.value.slice(0, 300); }, 'ttx-' + t.id) }, t.text),
      isSel('title', t.id) ? h('div', {},
        field('Tamaño', range(t.size, { min: 24, max: 200, step: 1 }, (v) => edit((x) => { x.titles.find((q) => q.id === t.id).size = v; }, 'tsz-' + t.id), (v) => v + ' px')),
        h('div', { class: 'grid2' }, field('Color', color(t.color, (v) => edit((x) => { x.titles.find((q) => q.id === t.id).color = v; }, 'tc-' + t.id))), field('Fuente', select_(Object.keys(FONTS), t.font, (v) => act((x) => { x.titles.find((q) => q.id === t.id).font = v; }, 'tf')))),
        check('Caja de fondo', !!t.bg, (v) => act((x) => { x.titles.find((q) => q.id === t.id).bg = v ? 'rgba(0,0,0,0.65)' : ''; }, 'tbg'))) : null))));

  const imgs = st.overlays.filter((o) => o.kind === 'image');
  const images = sec(`Imágenes (${imgs.length})`, btn('＋ Subir imagen / logo', () => $('#imgIn').click()), hint('PNG, JPG, WebP o GIF. Se guardan dentro del proyecto. Arrastralas en la vista previa para moverlas.'),
    h('div', { class: 'list' }, imgs.map((o) => h('div', { class: 'card-row row' + (isSel('overlay', o.id) ? ' sel' : ''), onclick: () => !isSel('overlay', o.id) && select('overlay', o.id) },
      h('div', { class: 'top' }, h('b', {}, '🖼 ' + (st.assets[o.assetId]?.name || 'imagen')), btn('✕', (e) => { e.stopPropagation(); act((x) => { x.overlays = x.overlays.filter((q) => q.id !== o.id); }, 'borrar'); }, 'mini danger')),
      timesRow('overlay', o.id),
      isSel('overlay', o.id) ? h('div', {},
        field('Tamaño', range(o.w, { min: 0.05, max: 1.2, step: 0.01 }, (v) => edit((x) => { x.overlays.find((q) => q.id === o.id).w = v; }, 'ow-' + o.id), (v) => Math.round(v * 100) + ' % del ancho')),
        field('Opacidad', range(o.opacity, { min: 0.1, max: 1, step: 0.05 }, (v) => edit((x) => { x.overlays.find((q) => q.id === o.id).opacity = v; }, 'oo-' + o.id), (v) => Math.round(v * 100) + ' %'))) : null))));
  return h('div', {}, titles, images);
}
export async function addImage(file) {
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) return toast('Formato no soportado (usá PNG, JPG, WebP o GIF).', 'err');
  if (file.size > 8 * 1024 * 1024) return toast('La imagen pesa más de 8 MB.', 'err');
  const dataUrl = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
  const id = newId('a_');
  await loadImage(id, dataUrl);
  const m = markRange(), a = m ? m[0] : curT(), b = m ? m[1] : Math.min(duration(), curT() + 3);
  const oid = newId('o_');
  act((x) => { x.assets[id] = { name: file.name.slice(0, 80), dataUrl }; x.overlays.push({ id: oid, kind: 'image', assetId: id, start: a, end: b, x: 0.82, y: 0.1, w: 0.22, opacity: 1 }); }, 'imagen');
  select('overlay', oid);
}
export function loadImage(id, dataUrl) {
  return new Promise((res) => { const im = new Image(); im.onload = () => { ui.images.set(id, im); res(); }; im.onerror = () => res(); im.src = dataUrl; });
}

// ---- Tarjetas académicas ---------------------------------------------------------------------
const CARD_HELP = {
  quote: 'Cita textual: escribí la cita y el autor.', definition: 'Término + definición.',
  timeline: 'Una línea por hito: "1859 | Darwin publica El origen de las especies".', diagram: 'Un paso por línea; se dibujan cajas con flechas.', reference: 'Autor, año, título y fuente (la forma la armás vos).',
};
let cardDraft = { type: 'quote', title: '', body: '', author: '', year: '', source: '', accent: '#ffd23f' };
function tarjetas(st) {
  const d = cardDraft;
  const form = sec('Nueva tarjeta',
    field('Tipo', select_([['quote', 'Cita'], ['definition', 'Definición'], ['timeline', 'Línea de tiempo'], ['diagram', 'Esquema / diagrama'], ['reference', 'Referencia']], d.type, (v) => { d.type = v; store.emit('select'); })),
    hint(CARD_HELP[d.type]),
    ['definition', 'timeline', 'diagram', 'reference'].includes(d.type) ? field(d.type === 'reference' ? 'Título de la obra' : 'Título', text(d.title, (v) => (d.title = v))) : null,
    d.type !== 'reference' ? field(d.type === 'quote' ? 'Cita' : d.type === 'definition' ? 'Definición' : 'Líneas', text(d.body, (v) => (d.body = v), '', 'textarea')) : null,
    ['quote', 'reference'].includes(d.type) ? field('Autor', text(d.author, (v) => (d.author = v))) : null,
    d.type === 'reference' ? h('div', { class: 'grid2' }, field('Año', text(d.year, (v) => (d.year = v))), field('Fuente / editorial', text(d.source, (v) => (d.source = v)))) : null,
    field('Color de acento', color(d.accent, (v) => (d.accent = v))),
    btn('Agregar en la selección (o 4 s desde el cabezal)', () => {
      const m = markRange(), a = m ? m[0] : curT(), b = m ? m[1] : Math.min(duration(), curT() + 4);
      if (!(d.body.trim() || d.title.trim() || d.author.trim())) return toast('Completá el contenido de la tarjeta.', 'err');
      const id = newId('o_');
      act((x) => { x.overlays.push({ id, kind: 'card', start: a, end: b, x: 0.5, y: 0.5, w: 1, opacity: 1, card: { ...d, y: 0.5 } }); }, 'tarjeta');
      select('overlay', id);
    }),
    hint('Solo se muestra lo que vos escribís; no se inventan datos ni referencias.'));
  const cards = st.overlays.filter((o) => o.kind === 'card');
  const list = sec(`Tarjetas en el video (${cards.length})`, h('div', { class: 'list' }, cards.map((o) => h('div', { class: 'card-row row' + (isSel('overlay', o.id) ? ' sel' : ''), onclick: () => !isSel('overlay', o.id) && select('overlay', o.id) },
    h('div', { class: 'top' }, h('b', {}, '🎓 ' + o.card.type), btn('✕', (e) => { e.stopPropagation(); act((x) => { x.overlays = x.overlays.filter((q) => q.id !== o.id); }, 'borrar'); }, 'mini danger')),
    timesRow('overlay', o.id),
    isSel('overlay', o.id) ? h('div', {}, ['title', 'body', 'author', 'year', 'source'].filter((k) => o.card[k] !== '' || k === 'body').map((k) => field({ title: 'Título', body: 'Contenido', author: 'Autor', year: 'Año', source: 'Fuente' }[k], text(o.card[k], (v) => edit((x) => { x.overlays.find((q) => q.id === o.id).card[k] = v.slice(0, 1500); }, `cd-${o.id}-${k}`), '', k === 'body' ? 'textarea' : 'input'))),
      field('Posición vertical', range(o.card.y, { min: 0.15, max: 0.85, step: 0.01 }, (v) => edit((x) => { x.overlays.find((q) => q.id === o.id).card.y = v; }, 'cy-' + o.id), (v) => Math.round(v * 100) + ' %'))) : h('span', { class: 'dim' }, (o.card.body || o.card.title || '').slice(0, 60))))));
  return h('div', {}, form, list);
}

// ---- Audio -----------------------------------------------------------------------------------
function audio(st) {
  const s = st.settings, m = s.music;
  return h('div', {},
    sec('Voz',
      check('Reducir ruido de fondo', s.denoise, (v) => act((x) => { x.settings.denoise = v; }, 'denoise')),
      check('Normalizar volumen (−14 LUFS, estándar redes)', s.normalize, (v) => act((x) => { x.settings.normalize = v; }, 'norm')),
      field('Volumen general', range(s.volume, { min: 0, max: 2, step: 0.05 }, (v) => edit((x) => { x.settings.volume = v; }, 'vol'), (v) => Math.round(v * 100) + ' %')),
      hint('La reducción de ruido y la normalización se aplican al exportar (no se escuchan en la vista previa).')),
    sec('Música de fondo',
      btn(ui.musicFile ? '🎵 ' + ui.musicFile.name : '＋ Elegir archivo de música', () => $('#musicIn').click()),
      ui.musicFile ? h('div', {},
        check('Usar música', m.enabled, (v) => act((x) => { x.settings.music.enabled = v; }, 'music')),
        field('Volumen', range(m.volume, { min: 0, max: 1, step: 0.01 }, (v) => edit((x) => { x.settings.music.volume = v; }, 'mv'), (v) => Math.round(v * 100) + ' %')),
        check('Bajar la música cuando hablo (ducking)', m.duck, (v) => act((x) => { x.settings.music.duck = v; }, 'duck')),
        check('Repetir si es más corta que el video', m.loop, (v) => act((x) => { x.settings.music.loop = v; }, 'loop')),
        h('div', { class: 'grid2' }, field('Fade in (s)', num(m.fadeIn, { min: 0, max: 10, step: 0.5 }, (v) => edit((x) => { x.settings.music.fadeIn = v; }, 'fi'))), field('Fade out (s)', num(m.fadeOut, { min: 0, max: 10, step: 0.5 }, (v) => edit((x) => { x.settings.music.fadeOut = v; }, 'fo'))))) : hint('Usá música con derechos para publicar (tuya, libre de regalías o con licencia).'),
      ui.musicFile && store.state.settings.music.enabled === false ? null : null));
}

// ---- Publicar (portada + textos por plantilla) -----------------------------------------------
let copyForm = { tema: '', gancho: '', publico: '', cta: '', claves: '', firma: '' };
let coverText = '';
function publicar() {
  const out = h('div', { class: 'out' });
  const draw = () => {
    const c = buildCopy(copyForm);
    out.replaceChildren(
      h('h4', {}, 'Títulos posibles'), ...c.titles.map((t) => h('div', { class: 'cp' }, h('span', {}, t), btn('Copiar', () => copy(t), 'mini'))),
      h('h4', {}, 'Descripción'), h('pre', {}, c.description || '(completá algún campo)'), c.description ? btn('Copiar descripción', () => copy(c.description)) : null,
      h('h4', {}, 'Hashtags'), h('p', {}, c.hashtags.join(' ') || '—'), c.hashtags.length ? btn('Copiar hashtags', () => copy(c.hashtags.join(' ')), 'mini') : null);
  };
  const f = (k, label, ph, tag) => field(label, text(copyForm[k], (v) => { copyForm[k] = v; draw(); }, ph, tag));
  const cover = h('canvas', { class: 'cover' });
  const paintCover = () => {
    const st = store.state; const { W, H } = outputSize(st.settings.ratio, 720);
    cover.width = W; cover.height = H;
    const c = cover.getContext('2d');
    drawFrame(c, W, H, st, curT(), { overlay: false });
    if (coverText.trim()) {
      const g = c.createLinearGradient(0, H * 0.45, 0, H); g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.75)');
      c.fillStyle = g; c.fillRect(0, H * 0.45, W, H * 0.55);
      drawText(c, coverText, { cx: W / 2, cy: H * 0.74, size: 96, s: W / 1080, maxW: W * 0.86, color: '#fff', outline: '#000', upper: true, font: FONTS.Impact });
    }
  };
  setTimeout(paintCover, 0);
  draw();
  return h('div', {},
    sec('Portada', hint('Se usa el cuadro donde está el cabezal.'), cover,
      field('Texto de portada', text(coverText, (v) => { coverText = v; paintCover(); }, 'Opcional')),
      h('div', { class: 'bar' }, btn('Actualizar con el cabezal', paintCover), btn('Descargar PNG', () => cover.toBlob((b) => download(b, baseName() + '-portada.png'), 'image/png')))),
    sec('Título, descripción y hashtags (plantillas)',
      f('tema', 'Tema', 'ej: la fotosíntesis'), f('gancho', 'Gancho / idea fuerte', 'ej: cómo la luz se vuelve azúcar'), f('publico', 'Público', 'ej: estudiantes de secundaria'),
      f('cta', 'Llamado a la acción', 'ej: guardalo para repasar'), f('claves', 'Palabras clave (separadas por coma)', 'biología, ciencia, estudio'), f('firma', 'Firma / crédito', ''), out));
}
const copy = (t) => navigator.clipboard?.writeText(t).then(() => toast('Copiado'), () => toast('No se pudo copiar', 'err'));

// ---- Historial y proyecto --------------------------------------------------------------------
const verKey = () => `asm:ver:${ui.sig}`;
const readVers = () => { try { return JSON.parse(localStorage.getItem(verKey()) || '[]'); } catch { return []; } };
function historial() {
  const vers = readVers();
  const name = h('input', { placeholder: 'Nombre de la versión (ej: corte final)' });
  return h('div', {},
    sec('Deshacer / rehacer', h('div', { class: 'bar' }, btn('↶ Deshacer [Ctrl+Z]', () => store.undo()), btn('↷ Rehacer [Ctrl+Y]', () => store.redo())), h('p', { class: 'dim' }, `${store.past.length} paso(s) para deshacer · ${store.future.length} para rehacer`),
      h('div', { class: 'list' }, [...store.past].reverse().slice(0, 12).map((p) => h('div', { class: 'row dim' }, '• ' + (p.label || 'edición'))))),
    sec('Versiones guardadas', hint('Quedan en este navegador, asociadas a este archivo de video.'), name,
      btn('Guardar versión actual', () => { const v = readVers(); v.unshift({ name: name.value.trim() || 'Versión ' + (v.length + 1), at: Date.now(), state: JSON.stringify(store.state) }); try { localStorage.setItem(verKey(), JSON.stringify(v.slice(0, 20))); toast('Versión guardada'); store.emit('select'); } catch { toast('No hay espacio en el navegador. Descargá el proyecto como archivo.', 'err'); } }),
      h('div', { class: 'list' }, vers.map((v, i) => h('div', { class: 'row' }, h('b', {}, v.name), h('span', { class: 'dim' }, new Date(v.at).toLocaleString()),
        btn('Restaurar', () => { try { store.replace(sanitize(JSON.parse(v.state), store.state.source), 'restaurar versión'); rehydrateImages(); toast('Versión restaurada (podés deshacer)'); } catch { toast('Versión dañada', 'err'); } }, 'mini'),
        btn('✕', () => { const l = readVers(); l.splice(i, 1); localStorage.setItem(verKey(), JSON.stringify(l)); store.emit('select'); }, 'mini danger'))))),
    sec('Proyecto en archivo', h('div', { class: 'bar' }, btn('Guardar proyecto (.json)', () => download(new Blob([JSON.stringify({ app: 'autostudio-manual', state: store.state })], { type: 'application/json' }), baseName() + '.autostudio.json')), btn('Abrir proyecto…', () => $('#projIn').click())),
      hint('El archivo guarda tus ediciones (no el video). Para seguir editando, abrí primero el mismo video y luego el proyecto. La música no se guarda: volvé a elegirla.')));
}
export function rehydrateImages() { for (const [id, a] of Object.entries(store.state.assets)) if (!ui.images.has(id)) loadImage(id, a.dataUrl); }
export async function openProject(file) {
  try {
    const j = JSON.parse(await file.text());
    store.replace(sanitize(j.state || j, store.state.source), 'abrir proyecto');
    await Promise.all(Object.entries(store.state.assets).map(([id, a]) => loadImage(id, a.dataUrl)));
    toast('Proyecto cargado');
  } catch { toast('El archivo no es un proyecto válido.', 'err'); }
}

// ---- Exportar --------------------------------------------------------------------------------
let progress = { p: 0, msg: '' };
function exportar(st) {
  const s = st.settings;
  const { W, H } = outputSize(s.ratio, s.res);
  const D = st.clips.reduce((a, c) => a + (c.end - c.start) / c.speed, 0);
  const bar = h('div', { class: 'pbar' }, h('i', { style: { width: progress.p * 100 + '%' } }));
  const msg = h('p', { class: 'dim', id: 'expMsg' }, progress.msg);
  const res = ui.result ? h('div', { class: 'result' },
    h('video', { src: ui.result.url, controls: true, playsinline: true }),
    h('p', {}, `✔ ${(ui.result.blob.size / 1048576).toFixed(1)} MB · ${ui.result.W}×${ui.result.H} · ${fmt(ui.result.duration, false)} · ${ui.result.seconds.toFixed(0)} s (${ui.result.kind})`),
    h('div', { class: 'bar' }, btn('⬇ Descargar MP4', () => download(ui.result.blob, baseName() + '-editado.mp4'), 'primary'), st.subs.length ? btn('⬇ Descargar .srt', downloadSrt) : null)) : null;
  return h('div', {},
    sec('Calidad',
      field('Resolución (lado corto)', select_([[540, '540p (rápido)'], [720, '720p (recomendado)'], [1080, '1080p (lento, más memoria)']], s.res, (v) => act((x) => { x.settings.res = +v; }, 'res'))),
      field('Cuadros por segundo', select_([24, 25, 30, 60], s.fps, (v) => act((x) => { x.settings.fps = +v; }, 'fps'))),
      field('Calidad (CRF, menor = mejor)', range(s.crf, { min: 18, max: 30, step: 1 }, (v) => edit((x) => { x.settings.crf = v; }, 'crf'), (v) => v)),
      field('Velocidad de compresión', select_([['ultrafast', 'Más rápida'], ['veryfast', 'Rápida'], ['fast', 'Equilibrada'], ['medium', 'Más lenta, archivo menor']], s.preset, (v) => act((x) => { x.settings.preset = v; }, 'preset'))),
      field('Motor de render', select_([['auto', 'Automático'], ['single', 'Un hilo (compatible, poca memoria)']], getEnginePref(), (v) => { setEnginePref(v); store.emit('select'); })),
      h('p', { class: 'dim' }, `Resultado: ${W}×${H} · ${fmt(D, false)} · motor ${pickEngine() === 'multi' ? 'multi-hilo ✔' : 'un hilo' + (canMultiThread() ? '' : ' (el servidor no habilita multi-hilo)')}`),
      hint('Si la exportación se queda en "Cargando motor", elegí "Un hilo": usa menos memoria y casi siempre arranca.')),
    sec('Exportar',
      ui.exporting ? h('div', {}, bar, msg, btn('Cancelar', () => { cancelExport(); ui.exporting = false; progress = { p: 0, msg: 'Cancelado' }; toast('Exportación cancelada'); store.emit('select'); }, 'danger')) : btn('🎬 Exportar MP4', runExport, 'primary big'),
      hint('El render ocurre en tu navegador; el video no se sube a ningún servidor. Cerrá otras pestañas pesadas y no cambies de pestaña mientras renderiza.'),
      res));
}
async function runExport() {
  const st = store.state;
  if (ui.exporting) return;
  stopPlayback();
  ui.exporting = true; ui.result = null; progress = { p: 0, msg: 'Iniciando…' };
  store.emit('select');
  try {
    const r = await exportVideo({
      state: JSON.parse(JSON.stringify(st)), file: ui.file, musicFile: ui.musicFile, images: ui.images,
      onProgress: (p, msg) => { progress = { p, msg }; const el = $('#expMsg'); if (el) { el.textContent = msg; el.previousSibling.firstChild.style.width = p * 100 + '%'; } },
    });
    ui.result = { ...r, url: URL.createObjectURL(r.blob) };
    toast('¡Listo! Ya podés descargarlo', 'ok');
  } catch (e) {
    console.error(e);
    if (ui.exporting) toast('Error al exportar: ' + (e.message || e), 'err');
  } finally { ui.exporting = false; store.emit('select'); }
}
export { runExport };
