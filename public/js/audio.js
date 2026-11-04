// Forma de onda y ayuda visual para silencios. Todo local con WebAudio; el usuario decide qué cortar.
const BIN = 0.02; // 20 ms por barra

/** Devuelve { db: Float32Array (dB por bin), peaks: Float32Array (0..1) } o null si no se pudo decodificar. */
export async function analyzeAudio(file, maxMB = 400) {
  if (file.size > maxMB * 1024 * 1024) return null;
  try {
    const buf = await file.arrayBuffer();
    const AC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const ctx = new AC(1, 44100, 44100);
    const audio = await ctx.decodeAudioData(buf);
    const ch = audio.getChannelData(0);
    const step = Math.max(1, Math.floor(audio.sampleRate * BIN));
    const n = Math.floor(ch.length / step);
    const db = new Float32Array(n);
    const peaks = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let sum = 0, pk = 0;
      for (let j = i * step; j < (i + 1) * step; j++) { const v = ch[j]; sum += v * v; if (Math.abs(v) > pk) pk = Math.abs(v); }
      db[i] = 10 * Math.log10(sum / step + 1e-12);
      peaks[i] = pk;
    }
    return { db, peaks, bin: step / audio.sampleRate, duration: audio.duration };
  } catch {
    return null;
  }
}

/** Tramos por debajo de `thresholdDb` que duran al menos `minDur` s (solo SUGERENCIAS en pantalla). */
export function findSilences(a, thresholdDb, minDur, pad = 0.06) {
  const out = [];
  let s = -1;
  const n = a.db.length;
  for (let i = 0; i <= n; i++) {
    const quiet = i < n && a.db[i] < thresholdDb;
    if (quiet && s < 0) s = i;
    if (!quiet && s >= 0) {
      const t0 = s * a.bin + pad, t1 = i * a.bin - pad;
      if (t1 - t0 >= minDur) out.push({ start: t0, end: Math.min(t1, a.duration) });
      s = -1;
    }
  }
  return out;
}
