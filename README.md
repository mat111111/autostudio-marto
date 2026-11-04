# AutoStudio Manual

Editor de video vertical (Reels / TikTok / Shorts) **100 % manual**: subís tu video, lo editás vos con la línea de tiempo y exportás un MP4.
Sin IA, sin automatismos, sin cuentas. **El render corre en tu navegador** (ffmpeg.wasm): el video nunca se sube a ningún servidor,
así que no hay límite de minutos, de cola ni de plan de servidor.

## Qué podés hacer (todo a mano)

| Función | Cómo |
|---|---|
| Subir video | Botón o arrastrar (MP4/MOV H.264). Nunca se sube: se lee local. |
| Cortes | Dividir (`S`), marcar entrada/salida (`I`/`O`) y cortar (`X`) o conservar (`K`); arrastrar bordes de clips. |
| Silencios | La onda muestra en rojo los tramos silenciosos (umbral y duración ajustables). **Vos** elegís cuáles cortar. |
| Velocidad / volumen | ×0.25 a ×4 por rango o clip; volumen por clip. |
| Zoom | Rangos con intensidad y centro elegido arrastrando un punto. |
| Reencuadre 9:16 · 1:1 · 4:5 · 16:9 | Recortar para llenar (con centro ajustable) o completo con fondo desenfocado. |
| Subtítulos | Escribir, editar tiempos, importar `.srt`, exportar `.srt` (ya ajustado a tus cortes). Estilo y posición. |
| Títulos e imágenes/logos | Texto con fuente/color/caja; imágenes con tamaño y opacidad. Se arrastran en la vista previa. |
| Tarjetas académicas | Cita, definición, línea de tiempo, esquema y referencia: **solo con los datos que escribís**. |
| Audio | Reducción de ruido, normalización a −14 LUFS, música con *ducking*, fades y loop. |
| Portada | Cuadro del cabezal + texto → PNG. |
| Título / descripción / hashtags | Plantillas rellenadas con tus campos (sin inventar nada). |
| Historial | Deshacer/rehacer (80 pasos), versiones con nombre, guardar/abrir proyecto `.json`, autoguardado local. |
| Exportar | 540p / 720p / 1080p, 24–60 fps, calidad y velocidad de compresión. |

Atajos: `Espacio` reproducir · `S` dividir · `I`/`O` marcas · `X` cortar I–O · `K` conservar I–O · `Supr` eliminar elemento · `←/→` cuadro · `Ctrl+Z / Ctrl+Y`.

## Levantarlo

```bash
npm install
npm start            # http://localhost:3000
npm test             # lógica + render real con ffmpeg nativo
npm run test:e2e     # (opcional) Chrome real + ffmpeg.wasm: requiere python3 + playwright y el server en :3111
```

Docker:

```bash
docker compose up --build      # http://localhost:3000
```

Render: conectá el repo y usá `render.yaml` (Blueprint). Es un servidor **estático**: gasta muy poco; el trabajo pesado lo hace el equipo de quien edita.

### Importante para que sea rápido
El servidor envía `Cross-Origin-Opener-Policy: same-origin` y `Cross-Origin-Embedder-Policy: require-corp`. Con eso el navegador habilita
`SharedArrayBuffer` y ffmpeg corre **multi-hilo**. Si lo ponés detrás de otro proxy/CDN, conservá esos encabezados; sin ellos funciona igual,
pero en un solo hilo (varias veces más lento). La pestaña *Exportar* indica qué motor se está usando.

## Límites honestos
- El render depende de la memoria del navegador: para videos largos o pesados usá 540p/720p. Más de ~1.5 GB de origen puede fallar.
- La reducción de ruido y la normalización se aplican al exportar (no se escuchan en la vista previa).
- El zoom es estático por rango (sin animación suave); es lo que mantiene el render rápido y fiel a la vista previa.
- La vista previa necesita que el navegador decodifique el video (H.264 va siempre; HEVC/H.265 depende del equipo). El render con ffmpeg.wasm tampoco decodifica HEVC.
- La imagen del `Dockerfile` no pudo construirse en el entorno donde se desarrolló (Docker Hub bloqueado); es mínimo, pero probalo.

## Licencias
El código de la app es tuyo. `public/vendor/` incluye ffmpeg.wasm (`@ffmpeg/*`, núcleo GPL-2.0-or-later): si redistribuís el binario como servicio público, revisá las obligaciones de GPL.
