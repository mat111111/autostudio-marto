// Servidor ESTÁTICO mínimo. No procesa video: solo entrega la app y los archivos de ffmpeg.wasm.
// Los encabezados COOP/COEP habilitan SharedArrayBuffer => ffmpeg multi-hilo (mucho más rápido).
import express from 'express';
import compression from 'compression';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';

const gz = promisify(gzip);

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

const packed = new Map(); // '/core/ffmpeg-core.wasm' -> { buf (gzip), raw (bytes), type }
const TYPES = { '.wasm': 'application/wasm', '.js': 'text/javascript' };
export async function warmVendor(root = join(here, 'public', 'vendor')) {
  for (const dir of ['core', 'core-mt']) {
    let names = [];
    try { names = await readdir(join(root, dir)); } catch { continue; }
    for (const n of names) {
      const t = TYPES[extname(n)];
      if (!t) continue;
      const raw = await readFile(join(root, dir, n));
      packed.set(`/${dir}/${n}`, { buf: await gz(raw, { level: 9 }), raw: raw.length, type: t });
    }
  }
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // El motor pesa ~32 MB: comprimirlo en cada pedido ahoga a un servidor chico (plan gratis) y la carga se "cuelga".
  // Lo comprimimos UNA vez al arrancar (en segundo plano) y lo servimos desde memoria; mientras tanto va sin comprimir.
  app.use(compression({ filter: (req, res) => !req.path.startsWith('/vendor/core') && compression.filter(req, res) }));
  app.use('/vendor', (req, res, next) => {
    const hit = packed.get(req.path);
    if (!hit || !/\bgzip\b/.test(req.headers['accept-encoding'] || '')) return next();
    res.set({ 'Content-Encoding': 'gzip', 'Content-Type': hit.type, 'Content-Length': hit.buf.length, Vary: 'Accept-Encoding', 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Raw-Length': hit.raw });
    res.end(hit.buf);
  });
  app.use((req, res, next) => {
    res.set({
      // ISOLATION=0 solo sirve para probar el modo de respaldo (un hilo).
      ...(process.env.ISOLATION === '0' ? {} : { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' }),
      'Cross-Origin-Resource-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      // Todo es local: ningún script ni recurso externo. 'wasm-unsafe-eval' lo exige WebAssembly.
      'Content-Security-Policy': "default-src 'self'; script-src 'self' blob: 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self' blob: data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    });
    next();
  });
  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.use(express.static(join(here, 'public'), {
    setHeaders(res, p) {
      if (p.includes(`${join('public', 'vendor')}`)) res.set('Cache-Control', 'public, max-age=31536000, immutable');
      else res.set('Cache-Control', 'no-cache');
    },
  }));
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp().listen(PORT, '0.0.0.0', () => {
    console.log(`AutoStudio Manual en http://localhost:${PORT}`);
    warmVendor().then(() => console.log('Motor de video precomprimido y listo.'), (e) => console.error('warmVendor:', e.message));
  });
}
