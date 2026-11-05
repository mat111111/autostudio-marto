// Construye UN solo filtergraph de ffmpeg a partir del estado del proyecto.
// Función pura (devuelve texto): se puede probar en Node con un ffmpeg nativo y se usa igual en ffmpeg.wasm.
import { buildSegments, outDuration, PUNCH_SECS } from './timeline.js';
import { cropRect, outputSize } from './frame.js';

const f = (n, d = 4) => String(Math.round(n * 10 ** d) / 10 ** d);
const even = (n) => Math.max(2, Math.round(n));

/** Expresiones de ffmpeg equivalentes a zoomState() (en función de `t` = segundos del segmento ya a velocidad final). */
export function zoomExprs(z, seg, g) {
  const A0 = f(seg.start - z.zstart, 5);
  const E = `(${A0}+t*${f(seg.speed, 5)})`; // segundos transcurridos dentro del zoom
  const D = Math.max(0.001, z.zend - z.zstart);
  const P = `clip(${E}/${f(D, 5)},0,1)`;
  const ease = (p) => `((${p})*(${p})*(3-2*(${p})))`;
  const F = { in: ease(P), out: `(1-${ease(P)})`, inout: `sin(PI*${P})`, punch: ease(`clip(${E}/${PUNCH_SECS},0,1)`) }[z.anim];
  return {
    Z: `(1+${f(z.scale - 1, 5)}*${F})`,
    CX: `(${f(g.cx, 5)}+${f(z.cx - g.cx, 5)}*${F})`,
    CY: `(${f(g.cy, 5)}+${f(z.cy - g.cy, 5)}*${F})`,
  };
}

/** atempo solo admite 0.5..2 por filtro: se encadenan. */
export function atempoChain(speed) {
  if (Math.abs(speed - 1) < 1e-6) return '';
  const parts = [];
  let s = speed;
  while (s > 2) { parts.push('atempo=2'); s /= 2; }
  while (s < 0.5) { parts.push('atempo=0.5'); s /= 0.5; }
  parts.push(`atempo=${f(s, 5)}`);
  return parts.join(',');
}

/**
 * opts: { hasAudio, overlayInput (índice de entrada o null), musicInput (índice o null) }
 * Devuelve { graph, duration, W, H, segments }.
 */
export function buildGraph(state, opts) {
  const { hasAudio = true, overlayInput = null, musicInput = null } = opts || {};
  const st = state.settings;
  const { width: sw, height: sh } = state.source;
  const { W, H } = outputSize(st.ratio, st.res);
  const fps = st.fps;
  const segs = buildSegments(state);
  if (!segs.length) throw new Error('No queda nada para exportar: todos los clips fueron eliminados.');
  const D = outDuration(state.clips);
  const lines = [];

  segs.forEach((g, i) => {
    const z = g.zoom;
    const cx = z ? z.cx : st.cx;
    const cy = z ? z.cy : st.cy;
    const head = `[0:v]trim=start=${f(g.start)}:end=${f(g.end)},setpts=(PTS-STARTPTS)/${f(g.speed, 5)}`;
    if (st.fit === 'blur') {
      const r = cropRect(sw, sh, sw / sh, z ? z.scale : 1, cx, cy);
      lines.push(`${head},crop=${even(r.w)}:${even(r.h)}:${Math.floor(r.x)}:${Math.floor(r.y)},split=2[bg${i}][fg${i}]`);
      lines.push(`[bg${i}]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=luma_radius=24:luma_power=2[b${i}]`);
      lines.push(`[fg${i}]scale=${W}:${H}:force_original_aspect_ratio=decrease[f${i}]`);
      lines.push(`[b${i}][f${i}]overlay=(W-w)/2:(H-h)/2,fps=${fps},setsar=1,format=yuv420p[v${i}]`);
    } else if (z && z.anim && z.anim !== 'static') {
      // Zoom animado (solo modo "recortar"): se escala el cuadro completo según t y se coloca con `overlay`
      // sobre un lienzo W×H, de modo que el recorte equivale a cropRect() con el zoom y centro de ese instante.
      const ar = W / H;
      const cw0 = sw / sh > ar ? sh * ar : sw;
      const K = f(W / cw0, 6);
      const e = zoomExprs(z, g, { cx: st.cx, cy: st.cy });
      const SW = `trunc(${sw}*${K}*${e.Z}/2)*2`, SH = `trunc(${sh}*${K}*${e.Z}/2)*2`;
      const dur = (g.end - g.start) / g.speed;
      lines.push(`${head},scale=w='max(2,${SW})':h='max(2,${SH})':eval=frame:flags=bicubic[s${i}]`);
      lines.push(`color=c=black:s=${W}x${H}:r=${fps}:d=${f(dur + 0.5, 3)}[c${i}]`);
      lines.push(`[c${i}][s${i}]overlay=x='-clip(${e.CX}*(${SW})-${W / 2},0,(${SW})-${W})':y='-clip(${e.CY}*(${SH})-${H / 2},0,(${SH})-${H})':eval=frame:shortest=1:format=auto,fps=${fps},setsar=1,format=yuv420p[v${i}]`);
    } else {
      const r = cropRect(sw, sh, W / H, z ? z.scale : 1, cx, cy);
      lines.push(`${head},crop=${even(r.w)}:${even(r.h)}:${Math.floor(r.x)}:${Math.floor(r.y)},scale=${W}:${H}:flags=bicubic,fps=${fps},setsar=1,format=yuv420p[v${i}]`);
    }
    if (hasAudio) {
      const tempo = atempoChain(g.speed);
      lines.push(`[0:a]atrim=start=${f(g.start)}:end=${f(g.end)},asetpts=PTS-STARTPTS${tempo ? ',' + tempo : ''},volume=${f(g.volume, 3)},aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
    }
  });

  const n = segs.length;
  if (hasAudio) lines.push(segs.map((_, i) => `[v${i}][a${i}]`).join('') + `concat=n=${n}:v=1:a=1[vc][ac0]`);
  else {
    lines.push(segs.map((_, i) => `[v${i}]`).join('') + `concat=n=${n}:v=1:a=0[vc]`);
    lines.push(`anullsrc=r=44100:cl=stereo,atrim=duration=${f(D)},asetpts=PTS-STARTPTS[ac0]`);
  }

  // Capa de superposiciones (subtítulos/títulos/imágenes/tarjetas) = una secuencia de PNG transparentes.
  if (overlayInput != null) {
    lines.push(`[${overlayInput}:v]fps=${fps},format=rgba[ov]`);
    lines.push(`[vc][ov]overlay=0:0:format=auto:eof_action=repeat,format=yuv420p[vo]`);
  } else lines.push(`[vc]format=yuv420p[vo]`);

  // Audio: limpieza -> volumen -> música (con ducking opcional) -> normalización.
  const pre = [];
  if (st.denoise) pre.push('afftdn=nf=-25');
  if (Math.abs(st.volume - 1) > 1e-3) pre.push(`volume=${f(st.volume, 3)}`);
  lines.push(`[ac0]${pre.length ? pre.join(',') : 'anull'}[ac]`);
  let last = 'ac';
  if (musicInput != null && st.music.enabled) {
    const m = st.music;
    const fo = Math.min(m.fadeOut, D);
    const fi = Math.min(m.fadeIn, D);
    lines.push(
      `[${musicInput}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,${m.loop ? 'aloop=loop=-1:size=2147483647,' : ''}atrim=duration=${f(D)},asetpts=PTS-STARTPTS,volume=${f(m.volume, 3)}` +
        `${fi > 0 ? `,afade=t=in:st=0:d=${f(fi, 2)}` : ''}${fo > 0 ? `,afade=t=out:st=${f(Math.max(0, D - fo), 2)}:d=${f(fo, 2)}` : ''}[mus]`,
    );
    if (m.duck) {
      lines.push(`[ac]asplit=2[voice][sc]`);
      lines.push(`[mus][sc]sidechaincompress=threshold=0.03:ratio=10:attack=15:release=350[duck]`);
      lines.push(`[voice][duck]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[mix]`);
    } else lines.push(`[ac][mus]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[mix]`);
    last = 'mix';
  }
  // OJO: `loudnorm` + `aresample` falla en ffmpeg.wasm (negociación de canales); `aformat` sí funciona.
  lines.push(`[${last}]${st.normalize ? 'loudnorm=I=-14:TP=-1.5:LRA=11' : 'alimiter=limit=0.95'},aformat=sample_rates=44100:channel_layouts=stereo:sample_fmts=fltp[ao]`);

  return { graph: lines.join(';\n'), duration: D, W, H, segments: segs.length };
}
