// Servidor ESTÁTICO mínimo. No procesa video: solo entrega la app y los archivos de ffmpeg.wasm.
// Los encabezados COOP/COEP habilitan SharedArrayBuffer => ffmpeg multi-hilo (mucho más rápido).
import express from 'express';
import compression from 'compression';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(compression());
  app.use((req, res, next) => {
    res.set({
      // ISOLATION=0 solo sirve para probar el modo de respaldo (un hilo).
      ...(process.env.ISOLATION === '0' ? {} : { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' }),
      'Cross-Origin-Resource-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      // Todo es local: ningún script ni recurso externo. 'wasm-unsafe-eval' lo exige WebAssembly.
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self' blob: data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
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
  createApp().listen(PORT, '0.0.0.0', () => console.log(`AutoStudio Manual en http://localhost:${PORT}`));
}
