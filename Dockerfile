# AutoStudio AI en una sola imagen: frontend compilado + backend + FFmpeg.
# Los trabajos (análisis y exportación) corren dentro del mismo proceso (INLINE_JOBS=1), sin Redis.
#
#   docker build -t autostudio .
#   docker run -p 8000:8000 -e GEMINI_API_KEY=tu_clave -v autostudio-data:/data autostudio
#   -> abrir http://localhost:8000

# ---------- Etapa 1: compilar el frontend ----------
FROM node:22-alpine AS web
WORKDIR /web
COPY frontend/package.json ./
RUN npm install
COPY frontend/ ./
RUN npx vite build

# ---------- Etapa 2: backend + frontend compilado ----------
FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg fonts-montserrat fonts-liberation2 fonts-dejavu-core libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/app ./app
COPY --from=web /web/dist ./static

ENV DATA_DIR=/data \
    HF_HOME=/data/hf \
    INLINE_JOBS=1 \
    STATIC_DIR=/srv/static \
    PYTHONUNBUFFERED=1
# Opcionales: GEMINI_API_KEY, GEMINI_MODEL, WHISPER_MODEL (tiny|base|small|medium), MAX_UPLOAD_MB

VOLUME /data
EXPOSE 8000
# Un solo proceso: los trabajos en segundo plano viven en él.
CMD ["uvicorn", "app.api:app", "--host", "0.0.0.0", "--port", "8000"]
