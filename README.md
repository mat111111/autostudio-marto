# AutoStudio AI

Editor automático de videos verticales (Reels, TikTok, Shorts) con director de edición Gemini.
`backend/` (FastAPI + FFmpeg) y `frontend/` (React + TypeScript + Vite).

## Cómo correrlo
```bash
cp .env.example .env          # completá GEMINI_API_KEY
docker compose up --build     # Editor: http://localhost:5173 · API: http://localhost:8000/docs
```
Sin Docker: `pip install -r backend/requirements.txt`, instalar FFmpeg, `INLINE_JOBS=1 uvicorn app.api:app` dentro de `backend/`.
Tests: `cd backend && python -m unittest discover -s tests -t .`

## Frontend
Layout: herramientas/estilos/versiones a la izquierda, reproductor al centro, timeline multipista abajo, chat con Gemini a la derecha.
Sin Docker: `cd frontend && npm install && npm run dev` (reenvía `/api` a `localhost:8000`; el navegador nunca ve la clave de Gemini).
- **Preview = render:** `src/lib/camera.ts` es un port de `core/camera.py`. `npm test` lo compara contra 324 muestras generadas
  por el Python real (`backend/tools/make_camera_vectors.py`) y exige diferencia < 1e-9.
- Los cambios se confirman al soltar (arrastrar bloques, sliders): una versión por gesto, no por píxel.
- Atajos: Espacio, ←/→ (cuadro; Shift = 1 s), S dividir, Z zoom, Supr eliminar, Ctrl+Z / Ctrl+Shift+Z.

## Flujo
1. `POST /api/projects` (MP4/MOV) guarda el original **de solo lectura** y encola el análisis: proxy 720p → transcripción
   por palabra (faster-whisper) → seguimiento de rostro → subtítulos + zooms + reencuadre automáticos.
2. Toda edición es una **operación tipada** (`GET /api/ops` lista el catálogo). La UI usa `POST /projects/{id}/ops`;
   Gemini usa las mismas operaciones vía `POST /projects/{id}/chat`. Cada transacción = una revisión = un deshacer.
3. `undo`, `redo`, `revisions`, `revisions/{n}/restore` (restaurar crea una revisión nueva; nada se pierde).
4. `POST /projects/{id}/exports` renderiza la versión actual a MP4 (1080p o 4K) + SRT.

## Arquitectura
| Carpeta | Rol |
|---|---|
| `core/` | Modelo, operaciones, cámara (zoom+reencuadre), heurísticas. Solo librería estándar. |
| `render/` | ASS/SRT y pipeline FFmpeg→OpenCV→FFmpeg |
| `media/` | ffprobe, proxy, Whisper, rostros |
| `ai/` | Bucle de function calling (`director`) + adaptador del SDK (`gemini_client`) |
| `storage.py`, `jobs/`, `api.py` | SQLite con historial, cola RQ/Redis, HTTP |

Decisiones: la cámara (`core/camera.py`) es la única fuente de verdad del zoom; el preview del navegador debe portar
esas mismas ecuaciones. Se calcula en Python con sub-píxel porque `crop`/`zoompan` de FFmpeg no dan zoom suave.

## Qué está verificado y qué no
- **Probado con ejecución real (43 tests):** modelo, operaciones, undo/redo/restauración, concurrencia optimista, ASS/SRT,
  cámara, suavizado de rostro, bucle de Gemini con modelo simulado, y un **render completo con FFmpeg real**
  (recorte, zoom, reencuadre, subtítulos quemados, audio).
- **Escrito pero NO ejecutado:** `api.py` (FastAPI), Docker/Compose, `transcribe.py` (faster-whisper),
  detección con MediaPipe y la llamada real al SDK de Gemini. Es lo primero que conviene correr; pasame los errores.
- Verificá el modelo vigente en `GEMINI_MODEL` (por defecto `gemini-3.6-flash`; Gemini 2.5 ya fue dado de baja).

**Frontend:** la lógica pura (cámara, arrastre de bloques, palabra activa) está probada con `npm test`. Los componentes React
verifican tipos con stubs, pero **no los compilé ni los vi corriendo** (sin red para instalar React): el primer `npm run build`
puede mostrar errores menores. La pista de audio no muestra forma de onda (haría falta un endpoint de picos) y no hay pista
de títulos/gráficos porque el modelo aún no la tiene.

## Límites conocidos
- El render por cuadros es ~2–3x tiempo real en un solo núcleo (`high_quality_scaling` lo hace más lento).
- Todavía no hay: eliminación de silencios, B-roll, música, portadas, lotes, identidad visual ni modo académico.
- Sin autenticación (uso local). Gemini aún no ve el video, solo transcripción y estado del timeline.
