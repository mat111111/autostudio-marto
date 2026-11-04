import { useEffect, useRef, useState } from "react";
import { proxyUrl } from "../api";
import { cameraAt } from "../lib/camera";
import { fmtTime, hexToRgba } from "../lib/format";
import { activeWordIndex, captionAt } from "../lib/timeline";
import { useStore } from "../store";
import type { Project } from "../types";

const REF_W = 1080; // el estilo de subtítulos está expresado sobre 1080 px de ancho

function CaptionOverlay({ project, t, boxW }: { project: Project; t: number; boxW: number }) {
  const cap = captionAt(project.captions, t);
  if (!cap) return null;
  const st = project.caption_style;
  const k = boxW / REF_W;
  const active = st.animation === "karaoke" ? activeWordIndex(cap, t) : -1;
  return (
    <div
      key={cap.id}
      className={st.animation !== "none" ? "cap-pop" : undefined}
      style={{
        position: "absolute", left: "50%", top: `${st.position_y * 100}%`, transform: "translate(-50%, -50%)",
        maxWidth: boxW - 140 * k, textAlign: "center", lineHeight: 1.15, pointerEvents: "none",
        fontFamily: `'${st.font}', ${/serif/i.test(st.font) ? "Georgia, 'Times New Roman', serif" : "Montserrat, sans-serif"}`,
        fontWeight: st.bold ? 800 : 400, fontSize: st.font_size * k,
        textTransform: st.uppercase ? "uppercase" : "none", color: st.color,
        WebkitTextStroke: st.box ? undefined : `${st.outline_width * k * 1.4}px ${st.outline_color}`,
        paintOrder: "stroke fill",
        textShadow: st.box ? undefined : `${st.shadow * k}px ${st.shadow * k}px 0 rgba(0,0,0,.45)`,
        background: st.box ? hexToRgba(st.box_color, st.box_opacity) : undefined,
        padding: st.box ? `${8 * k}px ${16 * k}px` : undefined, borderRadius: st.box ? 8 * k : undefined,
      }}
    >
      {cap.words.map((w, i) => (
        <span key={i} style={{ color: i === active ? st.highlight_color : w.highlight ? st.keyword_color : undefined }}>
          {w.text}{i < cap.words.length - 1 ? " " : ""}
        </span>
      ))}
    </div>
  );
}

export function Player() {
  const cur = useStore((s) => s.current);
  const playhead = useStore((s) => s.playhead);
  const playing = useStore((s) => s.playing);
  const seekNonce = useStore((s) => s.seekNonce);
  const trimOnly = useStore((s) => s.trimOnly);
  const setTrimOnly = useStore((s) => s.setTrimOnly);
  const seek = useStore((s) => s.seek);
  const setPlaying = useStore((s) => s.setPlaying);

  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState({ w: 0, h: 0 });
  const project = cur?.project;

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setStage({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setStage({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // Seek pedido desde la UI (timeline, atajos, botones).
  useEffect(() => {
    const v = videoRef.current;
    if (v) v.currentTime = useStore.getState().playhead;
  }, [seekNonce]);

  // Reproducción: el reloj es el propio <video>; cada cuadro se vuelca al store.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !project) return;
    if (!playing) { v.pause(); return; }
    const { start, end } = project.trim;
    const limit = () => (useStore.getState().trimOnly ? end : project.source.duration);
    if (useStore.getState().trimOnly && (v.currentTime < start || v.currentTime >= end - 0.05)) {
      v.currentTime = start;
      useStore.getState().setPlayhead(start);
    }
    v.play().catch(() => setPlaying(false));
    let raf = 0;
    const tick = () => {
      const t = v.currentTime;
      if (t >= limit()) {
        v.pause();
        useStore.getState().setPlayhead(limit());
        setPlaying(false);
        return;
      }
      useStore.getState().setPlayhead(t);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, project?.trim.start, project?.trim.end, trimOnly]);

  if (!project || !cur) return null;
  const { width: ow, height: oh } = project.output;
  const aspect = ow / oh;
  const boxH = Math.max(0, Math.min(stage.h, stage.w / aspect));
  const boxW = boxH * aspect;

  // Misma cámara que usa el render (ver lib/camera.ts): se traduce a posición y tamaño del <video>.
  const rect = cameraAt(project, playhead);
  const sx = boxW > 0 ? boxW / rect.w : 1;

  return (
    <div className="player">
      <div className="stage" ref={stageRef}>
        <div className="phone" style={{ width: boxW, height: boxH }}>
          <video
            ref={videoRef}
            src={proxyUrl(cur.id)}
            playsInline
            preload="auto"
            onEnded={() => setPlaying(false)}
            style={{ position: "absolute", maxWidth: "none", width: project.source.width * sx, height: project.source.height * sx,
                     left: -rect.x * sx, top: -rect.y * sx }}
          />
          <CaptionOverlay project={project} t={playhead} boxW={boxW} />
        </div>
      </div>
      <div className="transport">
        <button className="btn icon" title="Inicio del recorte" onClick={() => seek(project.trim.start)}>⏮</button>
        <button className="btn primary" onClick={() => setPlaying(!playing)} title="Espacio">{playing ? "❚❚ Pausa" : "▶ Reproducir"}</button>
        <span className="time">{fmtTime(playhead)} <i>/ {fmtTime(project.source.duration)}</i></span>
        <label className="check" title="Reproduce solo el tramo que se exporta">
          <input type="checkbox" checked={trimOnly} onChange={(e) => setTrimOnly(e.target.checked)} /> Solo recorte
        </label>
      </div>
    </div>
  );
}
