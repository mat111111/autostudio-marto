// Render en el NAVEGADOR con ffmpeg.wasm: sin límites de servidor, y el video nunca se sube.
import { FFmpeg } from '/vendor/ffmpeg/index.js';
import { buildGraph } from './graph.js';
import { planOverlay } from './overlay_plan.js';
import { paintOverlay } from './paint.js';
import { outputSrt } from './subs.js';

const DEBUG = (() => { try { return localStorage.getItem('asm:debug') === '1'; } catch { return false; } })();
let ff = null;
let loadedKind = null;
const blobCache = new Map();

export const canMultiThread = () => typeof SharedArrayBuffer !== 'undefined' && self.crossOriginIsolated === true;

/** Preferencia guardada: 'auto' | 'single'. */
export const getEnginePref = () => { try { return localStorage.getItem('asm:engine') || 'auto'; } catch { return 'auto'; } };
export const setEnginePref = (v) => { try { localStorage.setItem('asm:engine', v); } catch { /* sin storage */ } };

/** Multi-hilo solo si se puede Y el equipo parece tener recursos (el multi-hilo reserva mucha memoria compartida). */
export function pickEngine() {
  if (getEnginePref() === 'single' || !canMultiThread()) return 'single';
  if (getEnginePref() === 'multi') return 'multi'; // forzado (solo pruebas / usuarios avanzados)
  const cores = navigator.hardwareConcurrency || 2;
  const mem = navigator.deviceMemory || 8; // Chrome lo topea en 8; si no existe, asumimos suficiente
  return cores >= 4 && mem >= 8 ? 'multi' : 'single';
}

/** Descarga un archivo con progreso y devuelve una URL blob (se cachea en memoria). */
async function blobURL(url, mime, onBytes) {
  if (blobCache.has(url)) return blobCache.get(url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`No se pudo descargar ${url} (HTTP ${res.status})`);
  const total = +res.headers.get('X-Raw-Length') || +res.headers.get('content-length') || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onBytes(got, total);
  }
  const u = URL.createObjectURL(new Blob(chunks, { type: mime }));
  blobCache.set(url, u);
  return u;
}

const withTimeout = (p, ms, msg) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error(msg)), ms); p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); }); });

async function loadKind(kind, onLog, onProgress) {
  const mt = kind === 'multi';
  const dir = `${location.origin}/vendor/${mt ? 'core-mt' : 'core'}/`;
  const names = mt ? ['ffmpeg-core.js', 'ffmpeg-core.wasm', 'ffmpeg-core.worker.js'] : ['ffmpeg-core.js', 'ffmpeg-core.wasm'];
  const mimes = { js: 'text/javascript', wasm: 'application/wasm' };
  const urls = [];
  for (const n of names) {
    urls.push(await blobURL(dir + n, mimes[n.endsWith('wasm') ? 'wasm' : 'js'], (g, t) => onProgress(`Descargando motor de video… ${(g / 1048576).toFixed(1)}${t ? ' / ' + (t / 1048576).toFixed(0) : ''} MB (${n})`)));
  }
  const f = new FFmpeg();
  f.on('log', ({ message }) => { if (DEBUG) console.log('[ffmpeg]', message); onLog && onLog(message); });
  onProgress(`Iniciando motor (${mt ? 'multi-hilo' : 'un hilo'})…`);
  try {
    await withTimeout(f.load(mt ? { coreURL: urls[0], wasmURL: urls[1], workerURL: urls[2] } : { coreURL: urls[0], wasmURL: urls[1] }), mt ? 60000 : 120000, 'El motor tardó demasiado en iniciar.');
  } catch (e) { try { f.terminate(); } catch { /* nada */ } throw e; }
  return f;
}

async function getFFmpeg(onLog, onProgress = () => {}) {
  if (ff && ff.loaded) return ff;
  const want = pickEngine();
  try {
    ff = await loadKind(want, onLog, onProgress);
    loadedKind = want === 'multi' ? 'multi-hilo' : 'un hilo';
  } catch (e1) {
    if (want === 'multi') {
      onProgress('El modo multi-hilo no arrancó; probando modo compatible (un hilo)…');
      try { ff = await loadKind('single', onLog, onProgress); loadedKind = 'un hilo'; setEnginePref('single'); }
      catch (e2) { ff = null; throw new Error('No se pudo cargar el motor de video: ' + (e2.message || e2)); }
    } else { ff = null; throw new Error('No se pudo cargar el motor de video: ' + (e1.message || e1)); }
  }
  return ff;
}
export const engineKind = () => loadedKind || (pickEngine() === 'multi' ? 'multi-hilo' : 'un hilo');

const toPng = (canvas) => new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('No se pudo generar el PNG'))), 'image/png'));
const ext = (name, d) => (/\.([a-z0-9]{1,5})$/i.exec(name || '') || [, d])[1].toLowerCase();

export function cancelExport() {
  if (ff) { try { ff.terminate(); } catch { /* ya cerrado */ } ff = null; }
}

/**
 * @param {object} p { state, file, musicFile, images: Map(id->HTMLImageElement), onProgress(0..1, texto), onLog }
 * @returns {{blob:Blob, srt:string, seconds:number, kind:string}}
 */
export async function exportVideo({ state, file, musicFile, images, onProgress = () => {}, onLog = () => {} }) {
  const t0 = performance.now();
  onProgress(0, 'Cargando motor de video (ffmpeg.wasm)…');
  let logBuf = [];
  const f = await getFFmpeg((m) => { logBuf.push(m); if (logBuf.length > 400) logBuf.shift(); onLog(m); }, (msg) => onProgress(0, msg));

  const cleanup = [];
  const rmFile = async (p) => { try { await f.deleteFile(p); } catch { /* no existía */ } };
  try {
    // Montamos el archivo SIN copiarlo a memoria (WORKERFS lo lee a demanda).
    const srcName = 'src.' + ext(file.name, 'mp4');
    await f.createDir('/in').catch(() => {});
    await f.mount('WORKERFS', { files: [new File([file], srcName)] }, '/in');
    cleanup.push(async () => { try { await f.unmount('/in'); } catch { /* ok */ } });
    const srcPath = `/in/${srcName}`;

    // Sondeo: ¿tiene audio?
    logBuf = [];
    await f.exec(['-hide_banner', '-i', srcPath, '-t', '0.04', '-f', 'null', '-']).catch(() => {});
    const probeLog = logBuf.join('\n');
    const hasAudio = /Stream #\d+:\d+.*Audio:/.test(probeLog);

    // Capa de superposiciones => secuencia de PNG (una por cambio visible).
    const plan = planOverlay(state);
    const useOverlay = plan.some((p) => p.sig !== '');
    const { W, H, duration } = buildGraph(state, { hasAudio }); // valida y da tamaño/duración
    const args = ['-hide_banner', '-i', srcPath];
    let overlayInput = null;
    let musicInput = null;
    if (useOverlay) {
      onProgress(0.02, 'Preparando subtítulos, títulos y tarjetas…');
      await f.createDir('/ov').catch(() => {});
      const canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext('2d');
      const names = new Map();
      const lines = [];
      let lastName = null;
      for (let i = 0; i < plan.length; i++) {
        const p = plan[i];
        let name = names.get(p.sig);
        if (!name) {
          name = `/ov/f${names.size}.png`;
          names.set(p.sig, name);
          paintOverlay(ctx, W, H, state, p.src, images);
          await f.writeFile(name, new Uint8Array(await (await toPng(canvas)).arrayBuffer()));
          cleanup.push(() => rmFile(name));
        }
        lines.push(`file '${name}'`, `duration ${(p.b - p.a).toFixed(4)}`);
        lastName = name;
        if (i % 25 === 0) onProgress(0.02 + 0.06 * (i / plan.length), 'Preparando capas…');
      }
      lines.push(`file '${lastName}'`); // el demuxer concat ignora la duración del último
      await f.writeFile('/ov/list.txt', lines.join('\n'));
      cleanup.push(() => rmFile('/ov/list.txt'));
      // reinit_filter 0: el decodificador PNG cambia metadatos de color tras el 1er cuadro y ffmpeg 5.x
      // reconstruiría el grafo (fallando en el audio). Así lo evitamos.
      args.push('-reinit_filter', '0', '-f', 'concat', '-safe', '0', '-i', '/ov/list.txt');
      overlayInput = 1;
    }
    if (musicFile && state.settings.music.enabled) {
      const mname = 'music.' + ext(musicFile.name, 'mp3');
      await f.writeFile(mname, new Uint8Array(await musicFile.arrayBuffer()));
      cleanup.push(() => rmFile(mname));
      args.push('-i', mname);
      musicInput = overlayInput == null ? 1 : 2;
    }

    const g = buildGraph(state, { hasAudio, overlayInput, musicInput });
    const st = state.settings;
    args.push(
      '-filter_complex', g.graph,
      '-map', '[vo]', '-map', '[ao]',
      '-t', g.duration.toFixed(3),
      '-c:v', 'libx264', '-preset', st.preset, '-crf', String(st.crf), '-pix_fmt', 'yuv420p', '-r', String(st.fps),
      '-c:a', 'aac', '-b:a', '160k',
      '-movflags', '+faststart', '-y', 'out.mp4',
    );

    const onLine = ({ message }) => {
      const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(message);
      if (m) {
        const sec = +m[1] * 3600 + +m[2] * 60 + +m[3];
        onProgress(Math.min(0.99, 0.08 + 0.9 * (sec / g.duration)), `Renderizando… ${sec.toFixed(1)} / ${g.duration.toFixed(1)} s`);
      }
    };
    f.on('log', onLine);
    onProgress(0.08, `Renderizando (${engineKind()})…`);
    logBuf = [];
    let code;
    try { code = await f.exec(args); } finally { f.off('log', onLine); }
    if (code !== 0) throw new Error('ffmpeg terminó con error ' + code + ':\n' + logBuf.slice(-8).join('\n'));

    const data = await f.readFile('out.mp4');
    cleanup.push(() => rmFile('out.mp4'));
    const blob = new Blob([data], { type: 'video/mp4' });
    onProgress(1, 'Listo');
    return { blob, srt: outputSrt(state.subs, state.clips), seconds: (performance.now() - t0) / 1000, kind: engineKind(), W, H, duration: g.duration };
  } finally {
    for (const c of cleanup.reverse()) await c();
  }
}
