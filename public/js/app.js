import { store, ui, $, toast, seek, curT, duration, act, select } from './ctx.js';
import { initialState, sanitize } from './store.js';
import { initPreview, togglePlay, stopPlayback } from './preview.js';
import { initTimeline, renderTimeline } from './timeline_ui.js';
import { renderPanel, splitHere, deleteSelected, cutMarked, keepMarked, setMark, importSrt, addImage, openProject, rehydrateImages, runExport } from './panels.js';
import { analyzeAudio } from './audio.js';
import { clamp } from './util.js';

const VIDEO_RE = /\.(mp4|m4v|mov|webm|mkv)$/i;

// ---- Carga de video -------------------------------------------------------------------------
async function loadVideo(file) {
  if (!file) return;
  if (!(file.type.startsWith('video/') || VIDEO_RE.test(file.name))) return toast('Elegí un archivo de video (MP4 o MOV).', 'err');
  if (ui.exporting) return toast('Esperá a que termine la exportación.', 'err');
  stopPlayback();
  const v = ui.video;
  if (ui.url) URL.revokeObjectURL(ui.url);
  ui.url = URL.createObjectURL(file);
  v.src = ui.url;
  $('#drop').classList.add('busy');
  try {
    await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error('El navegador no puede reproducir este video (¿códec HEVC/H.265?). Convertilo a H.264 e intentá de nuevo.')); });
  } catch (e) { $('#drop').classList.remove('busy'); return toast(e.message, 'err'); }
  if (!Number.isFinite(v.duration) || !v.videoWidth) { $('#drop').classList.remove('busy'); return toast('No se pudo leer la duración del video.', 'err'); }
  const source = { name: file.name, duration: +v.duration.toFixed(3), width: v.videoWidth, height: v.videoHeight, size: file.size };
  ui.file = file;
  ui.sig = `${file.name}|${file.size}|${Math.round(v.duration * 1000)}`;
  ui.marks = { a: null, b: null }; ui.sel = null; ui.result = null; ui.images.clear();
  let state = initialState(source);
  try {
    const saved = localStorage.getItem('asm:proj:' + ui.sig);
    if (saved && confirm('Encontré una edición anterior de este video en este navegador.\n¿Querés recuperarla? (Cancelar = empezar de cero)')) state = sanitize(JSON.parse(saved), source);
  } catch { /* sin almacenamiento */ }
  store.load(state);
  rehydrateImages();
  $('#drop').classList.add('hidden');
  $('#drop').classList.remove('busy');
  $('#fileName').textContent = `${file.name} · ${source.width}×${source.height} · ${(file.size / 1048576).toFixed(1)} MB`;
  if (file.size > 1.5 * 1024 ** 3) toast('Archivo muy grande: el render puede agotar la memoria del navegador. Usá 540p/720p.', 'err');
  await primeFrame(v);
  ui.analysis = null; ui.analysisState = 'busy';
  analyzeAudio(file).then((a) => { if (ui.file !== file) return; ui.analysis = a; ui.analysisState = a ? 'ok' : 'fail'; renderTimeline(); renderPanel(); });
}

/** Fuerza a que el navegador decodifique y entregue un cuadro real (algunas grabaciones no lo hacen en t=0). */
async function primeFrame(v) {
  const once = (ev, ms = 2500) => new Promise((res) => { const t = setTimeout(res, ms); v.addEventListener(ev, () => { clearTimeout(t); res(); }, { once: true }); });
  try {
    v.muted = true;
    await v.play().catch(() => {});
    await new Promise((r) => setTimeout(r, 150));
    v.pause();
    v.muted = false;
  } catch { /* seguimos igual */ }
  const dur = v.duration;
  v.currentTime = Math.min(0.1, dur / 2); await once('seeked');
  v.currentTime = 0; await once('seeked');
  checkBlack(v);
}

/** Si tras cargar el cuadro sigue siendo todo negro, avisamos con una causa probable. */
function checkBlack(v) {
  setTimeout(() => {
    if (ui.video !== v || !store.state) return;
    const c = document.createElement('canvas'); c.width = 32; c.height = 32;
    const g = c.getContext('2d', { willReadFrequently: true });
    try { g.drawImage(v, 0, 0, 32, 32); } catch { return; }
    const d = g.getImageData(0, 0, 32, 32).data;
    let max = 0; for (let i = 0; i < d.length; i += 4) max = Math.max(max, d[i], d[i + 1], d[i + 2]);
    // Un cuadro real casi nunca es 100 % negro; si readyState < 2 el navegador ni siquiera tiene imagen.
    if (v.readyState < 2 || (max < 3 && v.currentTime < 0.5)) {
      toast('La vista previa está negra: el navegador no está decodificando este video (¿códec HEVC/H.265 o 10-bit?). Probá avanzar con ▶; si sigue negro, convertilo a H.264 (HandBrake o QuickTime → Exportar).', 'err');
    }
  }, 600);
}

// ---- Cambios de estado ----------------------------------------------------------------------
let saveTimer;
function onState() {
  renderTimeline();
  if (!ui.skipPanel) renderPanel();
  ui.skipPanel = false;
  $('#btnUndo').disabled = !store.past.length;
  $('#btnRedo').disabled = !store.future.length;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { localStorage.setItem('asm:proj:' + ui.sig, JSON.stringify(store.state)); } catch { /* cuota */ } }, 700);
}

// ---- Arranque -------------------------------------------------------------------------------
function init() {
  ui.video = $('#src');
  initPreview();
  initTimeline();
  store.on(onState);
  renderPanel();

  $('#videoIn').addEventListener('change', (e) => { loadVideo(e.target.files[0]); e.target.value = ''; });
  $('#srtIn').addEventListener('change', (e) => { e.target.files[0] && importSrt(e.target.files[0]); e.target.value = ''; });
  $('#imgIn').addEventListener('change', (e) => { e.target.files[0] && addImage(e.target.files[0]); e.target.value = ''; });
  $('#projIn').addEventListener('change', (e) => { e.target.files[0] && openProject(e.target.files[0]); e.target.value = ''; });
  $('#musicIn').addEventListener('change', (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    if (!(f.type.startsWith('audio/') || /\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(f.name))) return toast('Elegí un archivo de audio.', 'err');
    ui.musicFile = f;
    act((s) => { s.settings.music.enabled = true; }, 'música');
  });
  for (const id of ['btnOpen', 'dropBtn']) $('#' + id).addEventListener('click', () => $('#videoIn').click());
  $('#btnUndo').addEventListener('click', () => store.undo());
  $('#btnRedo').addEventListener('click', () => store.redo());
  $('#btnPlay').addEventListener('click', togglePlay);
  $('#btnStart').addEventListener('click', () => seek(0));
  $('#btnPrev').addEventListener('click', () => step(-1));
  $('#btnNext').addEventListener('click', () => step(1));
  $('#qSplit').addEventListener('click', splitHere);
  $('#qIn').addEventListener('click', () => setMark('a'));
  $('#qOut').addEventListener('click', () => setMark('b'));
  $('#qCut').addEventListener('click', cutMarked);
  $('#btnExport').addEventListener('click', () => { if (!store.state) return toast('Abrí un video primero.', 'err'); ui.tab = 'exportar'; store.emit('select'); });
  $('#zoomTl').addEventListener('input', (e) => { ui.pps = +e.target.value; renderTimeline(); });

  // Arrastrar y soltar
  addEventListener('dragover', (e) => e.preventDefault());
  addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer?.files?.[0]; if (f) loadVideo(f); });

  addEventListener('keydown', onKey);
  addEventListener('beforeunload', (e) => { if (ui.exporting) { e.preventDefault(); e.returnValue = ''; } });
  if (typeof WebAssembly === 'undefined') toast('Tu navegador no soporta WebAssembly: no se podrá exportar.', 'err');
  window.__app = { store, ui, loadVideo, runExport, select, seek, act };
}

function step(n) {
  const fps = store.state?.settings.fps || 30;
  stopPlayback();
  seek(curT() + n / fps);
}

function onKey(e) {
  const tag = (e.target.tagName || '').toLowerCase();
  const typing = tag === 'input' || tag === 'textarea' || tag === 'select';
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !typing && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? store.redo() : store.undo(); return; }
  if (mod && !typing && e.key.toLowerCase() === 'y') { e.preventDefault(); store.redo(); return; }
  if (typing || mod || !store.state) return;
  const k = e.key;
  const map = {
    ' ': togglePlay, s: splitHere, S: splitHere, x: cutMarked, X: cutMarked, k: keepMarked, K: keepMarked,
    i: () => setMark('a'), I: () => setMark('a'), o: () => setMark('b'), O: () => setMark('b'),
    Delete: deleteSelected, Backspace: deleteSelected,
    ArrowLeft: () => (e.shiftKey ? (stopPlayback(), seek(curT() - 1)) : step(-1)), ArrowRight: () => (e.shiftKey ? (stopPlayback(), seek(curT() + 1)) : step(1)),
    Home: () => seek(0), End: () => seek(duration()),
  };
  if (map[k]) { e.preventDefault(); map[k](); }
}

init();
