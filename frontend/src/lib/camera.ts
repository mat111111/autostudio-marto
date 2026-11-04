// Port EXACTO de backend/app/core/camera.py. El render usa la versión Python; el preview, esta.
// tests/lib.test.cjs verifica que ambas den el mismo rectángulo (ver backend/tools/make_camera_vectors.py).
import type { Project, Reframe, Zoom } from "../types";

export interface Rect { x: number; y: number; w: number; h: number }

export function smoothstep(x: number): number {
  const v = Math.min(1, Math.max(0, x));
  return v * v * (3 - 2 * v);
}

export function baseCrop(srcW: number, srcH: number, outW: number, outH: number): [number, number] {
  const aspect = outW / outH;
  if (srcW / srcH >= aspect) return [srcH * aspect, srcH];
  return [srcW, srcW / aspect];
}

export function reframeCenter(rf: Reframe, t: number): [number, number] {
  if (rf.mode === "fixed") return [rf.fixed_x, rf.fixed_y];
  const k = rf.keyframes;
  if (rf.mode === "center" || k.length === 0) return [0.5, 0.5];
  if (t <= k[0].t) return [k[0].x, k[0].y];
  if (t >= k[k.length - 1].t) return [k[k.length - 1].x, k[k.length - 1].y];
  let i = 0; // bisect_right
  while (i < k.length && k[i].t <= t) i++;
  const a = k[i - 1], b = k[i];
  const u = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
  return [a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u];
}

export function zoomEnvelope(z: Zoom, t: number): number {
  if (t < z.start || t > z.end) return 0;
  const d = z.end - z.start;
  const ein = Math.min(z.ease_in, d / 2);
  const eout = Math.min(z.ease_out, d / 2);
  if (ein > 0 && t < z.start + ein) return smoothstep((t - z.start) / ein);
  if (eout > 0 && t > z.end - eout) return smoothstep((z.end - t) / eout);
  return 1;
}

export function activeZoom(p: Project, t: number): Zoom | null {
  for (const z of p.zooms) if (z.start <= t && t <= z.end) return z;
  return null;
}

export function cameraAt(p: Project, t: number, outW?: number, outH?: number): Rect {
  const ow = outW ?? p.output.width, oh = outH ?? p.output.height;
  const sw = p.source.width, sh = p.source.height;
  const [bw, bh] = baseCrop(sw, sh, ow, oh);
  let [cx, cy] = reframeCenter(p.reframe, t);
  let factor = 1;
  const z = activeZoom(p, t);
  if (z) {
    const env = zoomEnvelope(z, t);
    factor = 1 + (z.scale - 1) * env;
    if (z.center_x !== null && z.center_y !== null) {
      cx += (z.center_x - cx) * env;
      cy += (z.center_y - cy) * env;
    }
  }
  const w = bw / factor, h = bh / factor;
  const x = Math.min(Math.max(cx * sw - w / 2, 0), sw - w);
  const y = Math.min(Math.max(cy * sh - h / 2, 0), sh - h);
  return { x, y, w, h };
}
