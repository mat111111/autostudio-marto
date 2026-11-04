import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PointerEvent as RPointerEvent, RefObject } from "react";
import { fmtTime } from "../lib/format";
import { clampSpan, tickSteps } from "../lib/timeline";
import type { DragMode, Span } from "../lib/timeline";
import { useStore } from "../store";

const LABEL_W = 112;
type Kind = "caption" | "zoom" | "trim";
type Mode = DragMode | "ts" | "te";
interface DragState { kind: Kind; id: string; mode: Mode; x0: number; origin: { start: number; end: number }; moved: boolean }
interface Draft { kind: Kind; id: string; start: number; end: number }

function PlayheadLine({ scrollRef }: { scrollRef: RefObject<HTMLDivElement | null> }) {
  const playhead = useStore((s) => s.playhead);
  const playing = useStore((s) => s.playing);
  const px = useStore((s) => s.pxPerSec);
  const x = playhead * px;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !playing) return;
    if (x < el.scrollLeft || x > el.scrollLeft + el.clientWidth - 30) el.scrollLeft = Math.max(0, x - el.clientWidth * 0.2);
  }, [x, playing, scrollRef]);
  return <div className="playhead" style={{ left: x }}><span>{fmtTime(playhead)}</span></div>;
}

export function Timeline() {
  const cur = useStore((s) => s.current);
  const px = useStore((s) => s.pxPerSec);
  const setPx = useStore((s) => s.setPxPerSec);
  const selection = useStore((s) => s.selection);
  const select = useStore((s) => s.select);
  const seek = useStore((s) => s.seek);
  const applyOps = useStore((s) => s.applyOps);

  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const draftRef = useRef<Draft | null>(null);
  const [draft, setDraftState] = useState<Draft | null>(null);
  const setDraft = (d: Draft | null) => { draftRef.current = d; setDraftState(d); };

  const project = cur?.project;
  const duration = project?.source.duration ?? 0;

  // Ajusta el zoom para que el video entre completo al abrir el proyecto.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && duration > 0) setPx(Math.max(8, (el.clientWidth - 24) / duration));
  }, [cur?.id, duration]); // eslint-disable-line react-hooks/exhaustive-deps

  // Ctrl + rueda = zoom horizontal (listener nativo: React registra "wheel" como pasivo).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cursorT = (el.scrollLeft + e.clientX - rect.left) / useStore.getState().pxPerSec;
      const next = useStore.getState().pxPerSec * (e.deltaY < 0 ? 1.15 : 1 / 1.15);
      useStore.getState().setPxPerSec(next);
      requestAnimationFrame(() => { el.scrollLeft = cursorT * useStore.getState().pxPerSec - (e.clientX - rect.left); });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  if (!project) return null;
  const ready = cur!.status === "ready";
  const width = Math.max(duration * px, 1);
  const { major, minor } = tickSteps(px);
  const trim = draft?.kind === "trim" ? { start: draft.start, end: draft.end } : project.trim;

  const spanOf = (kind: "caption" | "zoom"): Span[] =>
    (kind === "caption" ? project.captions : project.zooms).map((x) => ({ id: x.id, start: x.start, end: x.end }));

  const timeAt = (clientX: number) => {
    const r = contentRef.current!.getBoundingClientRect();
    return (clientX - r.left) / px;
  };

  // --- Buscar (regla y zonas vacías)
  const onSeekDown = (e: RPointerEvent<HTMLDivElement>) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    seek(timeAt(e.clientX));
    if (e.currentTarget.dataset.deselect) select(null, null);
  };
  const onSeekMove = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.buttons === 1) seek(timeAt(e.clientX));
  };

  // --- Arrastre de bloques y de los bordes del recorte
  const begin = (e: RPointerEvent<HTMLElement>, kind: Kind, id: string, mode: Mode, origin: { start: number; end: number }) => {
    if (!ready || e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { kind, id, mode, x0: e.clientX, origin, moved: false };
    if (kind !== "trim") select(kind, id);
  };
  const move = (e: RPointerEvent<HTMLElement>) => {
    const d = dragRef.current;
    if (!d) return;
    if (Math.abs(e.clientX - d.x0) > 3) d.moved = true;
    if (!d.moved) return;
    const dt = (e.clientX - d.x0) / px;
    let r: { start: number; end: number };
    if (d.kind === "trim") {
      r = d.mode === "ts"
        ? { start: Math.min(Math.max(d.origin.start + dt, 0), d.origin.end - 0.5), end: d.origin.end }
        : { start: d.origin.start, end: Math.max(Math.min(d.origin.end + dt, duration), d.origin.start + 0.5) };
    } else {
      r = clampSpan(spanOf(d.kind), d.id, d.mode as DragMode, d.origin, dt, duration, d.kind === "zoom" ? 0.3 : 0.2);
    }
    setDraft({ kind: d.kind, id: d.id, start: Math.round(r.start * 1000) / 1000, end: Math.round(r.end * 1000) / 1000 });
  };
  const end = async () => {
    const d = dragRef.current;
    const f = draftRef.current;
    dragRef.current = null;
    if (!d || !d.moved || !f) { setDraft(null); return; }
    if (f.start === d.origin.start && f.end === d.origin.end) { setDraft(null); return; }
    if (d.kind === "trim") await applyOps([{ name: "set_trim", params: { start: f.start, end: f.end } }], "Recortar");
    else if (d.kind === "caption") await applyOps([{ name: "move_caption", params: { caption_id: f.id, start: f.start, end: f.end } }], "Mover subtítulo");
    else await applyOps([{ name: "update_zoom", params: { zoom_id: f.id, start: f.start, end: f.end } }], "Ajustar zoom");
    setDraft(null);
  };
  const handlers = { onPointerMove: move, onPointerUp: end, onPointerCancel: () => { dragRef.current = null; setDraft(null); } };

  const ticks: JSX.Element[] = [];
  for (let t = 0; t <= duration + 1e-6; t += minor) {
    const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
    ticks.push(
      <div key={t.toFixed(3)} className={isMajor ? "tick major" : "tick"} style={{ left: t * px }}>
        {isMajor && <span>{fmtTime(t)}</span>}
      </div>,
    );
  }

  const block = (kind: "caption" | "zoom", item: { id: string; start: number; end: number }, label: string) => {
    const d = draft && draft.kind === kind && draft.id === item.id ? draft : null;
    const s = d ? d.start : item.start, e2 = d ? d.end : item.end;
    const sel = selection.kind === kind && selection.id === item.id;
    return (
      <div key={item.id} className={`block ${kind}${sel ? " sel" : ""}${d ? " dragging" : ""}`}
           style={{ left: s * px, width: Math.max((e2 - s) * px, 4) }} title={label}
           onPointerDown={(e) => begin(e, kind, item.id, "move", { start: item.start, end: item.end })} {...handlers}>
        <div className="grip l" onPointerDown={(e) => begin(e, kind, item.id, "l", { start: item.start, end: item.end })} {...handlers} />
        <span>{label}</span>
        <div className="grip r" onPointerDown={(e) => begin(e, kind, item.id, "r", { start: item.start, end: item.end })} {...handlers} />
      </div>
    );
  };

  return (
    <div className="timeline">
      <div className="tl-toolbar">
        <span className="muted">Ctrl + rueda: zoom · Espacio: reproducir · S: dividir · Z: zoom · Supr: eliminar</span>
        <span className="spacer" />
        <button className="btn small" onClick={() => setPx(px / 1.3)}>−</button>
        <button className="btn small" onClick={() => scrollRef.current && setPx((scrollRef.current.clientWidth - 24) / duration)}>Ajustar</button>
        <button className="btn small" onClick={() => setPx(px * 1.3)}>+</button>
      </div>
      <div className="tl-body">
        <div className="tl-labels">
          <div className="tl-label ruler-label" />
          <div className="tl-label">Video</div>
          <div className="tl-label">Audio</div>
          <div className="tl-label">Subtítulos</div>
          <div className="tl-label">Zooms</div>
          <div className="tl-label">Encuadre</div>
        </div>
        <div className="tl-scroll" ref={scrollRef}>
          <div className="tl-content" ref={contentRef} style={{ width }}>
            <div className="tl-row ruler" onPointerDown={onSeekDown} onPointerMove={onSeekMove}>{ticks}</div>

            <div className="tl-row" data-deselect="1" onPointerDown={onSeekDown} onPointerMove={onSeekMove}>
              <div className="clip video" style={{ width }}><span>{project.source.filename}</span></div>
              <div className="dim" style={{ left: 0, width: trim.start * px }} />
              <div className="dim" style={{ left: trim.end * px, width: Math.max(0, (duration - trim.end) * px) }} />
              <div className="trim-handle" style={{ left: trim.start * px }} title="Inicio del recorte"
                   onPointerDown={(e) => begin(e, "trim", "trim", "ts", project.trim)} {...handlers} />
              <div className="trim-handle r" style={{ left: trim.end * px }} title="Fin del recorte"
                   onPointerDown={(e) => begin(e, "trim", "trim", "te", project.trim)} {...handlers} />
            </div>

            <div className="tl-row" data-deselect="1" onPointerDown={onSeekDown} onPointerMove={onSeekMove}>
              {project.source.has_audio
                ? <div className="clip audio" style={{ width }}><span>Audio original</span></div>
                : <span className="muted pad">Sin pista de audio</span>}
              <div className="dim" style={{ left: 0, width: trim.start * px }} />
              <div className="dim" style={{ left: trim.end * px, width: Math.max(0, (duration - trim.end) * px) }} />
            </div>

            <div className="tl-row" data-deselect="1" onPointerDown={onSeekDown} onPointerMove={onSeekMove}>
              {project.captions.map((c) => block("caption", c, c.words.map((w) => w.text).join(" ")))}
            </div>

            <div className="tl-row" data-deselect="1" onPointerDown={onSeekDown} onPointerMove={onSeekMove}>
              {project.zooms.map((z) => block("zoom", z, `×${z.scale}`))}
            </div>

            <div className="tl-row" data-deselect="1" onPointerDown={onSeekDown} onPointerMove={onSeekMove}>
              <span className="muted pad">
                {project.reframe.mode === "face_track" ? `Seguimiento de rostro · ${project.reframe.keyframes.length} puntos`
                  : project.reframe.mode === "center" ? "Centrado" : "Posición fija"}
              </span>
              {project.reframe.mode === "face_track" && project.reframe.keyframes.map((k, i) => (
                <div key={i} className="kf" style={{ left: k.t * px }} title={`${fmtTime(k.t)} · x ${k.x.toFixed(2)}`} />
              ))}
            </div>

            <PlayheadLine scrollRef={scrollRef} />
          </div>
        </div>
      </div>
    </div>
  );
}
