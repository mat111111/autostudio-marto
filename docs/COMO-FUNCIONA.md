# Cómo funciona

## Idea central: todo vive en el tiempo del video ORIGINAL
Subtítulos, zooms, títulos y capas guardan sus tiempos respecto del original. Lo único que decide qué se ve y en qué orden son los **clips** (rangos conservados, cada uno con su velocidad).
Cortar un silencio no desplaza nada: al reproducir/exportar se convierte *tiempo original → tiempo de salida* (`srcToOut`, `mapRange` en `public/js/timeline.js`).

## Una sola geometría para vista previa y render
`cropRect()` (`frame.js`) calcula qué rectángulo del original se ve (equivale a `object-fit: cover` + centro + zoom). La vista previa lo dibuja en un `<canvas>` y el render lo traduce a `crop=w:h:x:y,scale=W:H`. Lo que ves es lo que se exporta.

```js
if (sw / sh > ar) { ch = sh; cw = sh * ar } else { cw = sw; ch = sw / ar }
cw /= zoom; ch /= zoom;
x = clamp(cx * sw - cw / 2, 0, sw - cw);   // (cx,cy) = centro elegido
```

## Capa de texto/imágenes sin libass ni fuentes dentro de wasm
Subtítulos, títulos, imágenes y tarjetas se dibujan con **la misma función de canvas** (`paint.js`) en la vista previa y al exportar.
Al exportar, `overlay_plan.js` calcula los instantes en que cambia lo visible y se genera **un PNG transparente por cambio**; ffmpeg los lee como una secuencia (demuxer `concat` con duraciones) y los mezcla con un único `overlay`. Así las fuentes son las del navegador y no hay que cargar nada extra en wasm.

## Un solo filtergraph (`graph.js`)
Por cada tramo (clip partido en los bordes de zoom): `trim → setpts → crop → scale → fps`, y en audio `atrim → atempo… → volume`. Luego `concat`, `overlay` de la capa de PNG, y el audio: `afftdn` (ruido) → volumen → música (`aloop`, `afade`, `sidechaincompress` para *ducking*, `amix`) → `loudnorm` (−14 LUFS). Es una función pura: los tests la ejecutan con un ffmpeg nativo para validar la sintaxis.

## Render en el navegador (`render.js`)
- `@ffmpeg/ffmpeg` 0.12 con el núcleo **multi-hilo** si la página está aislada (COOP/COEP), si no el de un hilo.
- El archivo de video se monta con **WORKERFS** (se lee a demanda, sin copiarlo entero a memoria).
- Progreso leyendo `time=` del log de ffmpeg.

### Dos trampas de ffmpeg.wasm resueltas
1. `loudnorm` seguido de `aresample` falla al negociar canales → se usa `aformat=sample_rates=44100:channel_layouts=stereo:sample_fmts=fltp`.
2. Sondeo de audio con `-f null -` para que ffmpeg termine limpio.

## Seguridad
- Sin servidor de procesamiento: no hay subida de archivos ni ejecución de comandos.
- CSP estricta (`script-src 'self' 'wasm-unsafe-eval'`), sin recursos externos; el DOM se arma sin `innerHTML`.
- Los proyectos `.json` y las versiones se **sanean** al cargarlos (`sanitize` en `store.js`): rangos, tipos y límites.

## Tests
`npm test` → 12 pruebas de lógica + render real con ffmpeg nativo (cover/blur, ducking, música, sin audio).
`test/e2e.py` y `test/e2e_ui.py` → Chrome real: sube video, edita con la UI, exporta con ffmpeg.wasm (multi-hilo y un hilo) y verifica con ffprobe.
