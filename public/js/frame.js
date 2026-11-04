// Geometría de encuadre. La usan la vista previa (canvas) y el render (crop de ffmpeg),
// por eso lo que ves es lo que se exporta.
import { clamp } from './util.js';

export const RATIOS = { '9:16': [9, 16], '1:1': [1, 1], '4:5': [4, 5], '16:9': [16, 9] };

/** Tamaño de salida: `res` = lado corto en px (540/720/1080). Siempre par. */
export function outputSize(ratio, res) {
  const [a, b] = RATIOS[ratio] || RATIOS['9:16'];
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  return a <= b ? { W: even(res), H: even((res * b) / a) } : { W: even((res * a) / b), H: even(res) };
}

/**
 * Rectángulo del original que se muestra.
 * ar = relación de aspecto del recorte (W/H de salida en modo "cover"; sw/sh en modo "blur").
 * (cx,cy) = centro deseado (0..1). El rectángulo nunca se sale del cuadro.
 */
export function cropRect(sw, sh, ar, zoom = 1, cx = 0.5, cy = 0.5) {
  let cw, ch;
  if (sw / sh > ar) { ch = sh; cw = sh * ar; } else { cw = sw; ch = sw / ar; }
  cw /= Math.max(1, zoom);
  ch /= Math.max(1, zoom);
  return { x: clamp(cx * sw - cw / 2, 0, sw - cw), y: clamp(cy * sh - ch / 2, 0, sh - ch), w: cw, h: ch };
}
