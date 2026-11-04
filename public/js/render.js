// Render en el NAVEGADOR con ffmpeg.wasm: sin límites de servidor, y el video nunca se sube.
import { FFmpeg } from '/vendor/ffmpeg/index.js';
import { buildGraph } from './graph.js';
import { planOverlay } from './overlay_plan.js';
import { paintOverlay } from './paint.js';
import { outputSrt } from './subs.js';

const DEBUG = (() => { try { return localStorage.getItem('asm:debug') === '1'; } catch { return false; } })();
let ff = null;
let loadedKind = null;

export const canMultiThread = () => typeof SharedArrayBuffer !== 'undefined' && self.crossOriginIsolated === true;

async function getFFmpeg(onLog) {
  if (ff && ff.loaded) return ff;
  ff = new FFmpeg();
  ff.on('log', ({ message }) => { if (DEBUG) console.log('[ffmpeg]', message); onLog && onLog(message); });
  const mt = canMultiThread();
  const base = `${location.origin}/vendor/${mt ? 'core-mt' : 'core'}/`;
  try {
    await ff.load(mt ? { coreURL: base + 'ffmpeg-core.js', wasmURL: base + 'ffmpeg-core.wasm', workerURL: base + 'ffmpeg-core.worker.js' } : { coreURL: base + 'ffmpeg-core.js', wasmURL: base + 'ffmpeg-core.wasm' });
    loadedKind = mt ? 'multi-hilo' : 'un hilo';
  } catch (e) {
    ff = null;
    throw new Error('No se pudo cargar ffmpeg.wasm: ' + (e.message || e));
  }
  return ff;
}
export const engineKind = () => loadedKind || (canMultiThread() ? 'multi-hilo' : 'un hilo');

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
  const f = await getFFmpeg((m) => { logBuf.push(m); if (logBuf.length > 400) logBuf.shift(); onLog(m); });

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
