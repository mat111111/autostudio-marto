import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { fmtTime } from "../lib/format";
import { useStore } from "../store";
import type { CaptionStyle } from "../types";
import { ColorField, Slider, Toggle } from "./Controls";

type Tab = "tools" | "style" | "versions";
const PRESETS: { id: string; name: string; hint: string; sample: CSSProperties }[] = [
  { id: "bold_pop", name: "Impacto", hint: "Mayúsculas, amarillo", sample: { fontWeight: 800, textTransform: "uppercase", color: "#fff", WebkitTextStroke: "2px #000", paintOrder: "stroke fill" } },
  { id: "clean_minimal", name: "Minimalista", hint: "Sobrio y limpio", sample: { fontWeight: 700, color: "#fff", textShadow: "1px 1px 0 #000" } },
  { id: "editorial", name: "Editorial", hint: "Serif elegante", sample: { fontFamily: "'Liberation Serif', Georgia, serif", color: "#F5F1E8" } },
  { id: "boxed", name: "Con caja", hint: "Fondo oscuro", sample: { fontWeight: 700, color: "#fff", background: "rgba(0,0,0,.6)", padding: "2px 8px", borderRadius: 4 } },
];
const FONTS = ["Montserrat", "Liberation Serif", "DejaVu Sans"];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="section"><h4>{title}</h4>{children}</section>;
}

function ToolsTab() {
  const cur = useStore((s) => s.current)!;
  const selection = useStore((s) => s.selection);
  const s = useStore.getState(); // solo acciones (estables): no suscribe al store completo
  const [zoomScale, setZoomScale] = useState(1.3);
  const [words, setWords] = useState("");
  const [capText, setCapText] = useState("");
  const p = cur.project;
  const ready = cur.status === "ready";
  const cap = selection.kind === "caption" ? p.captions.find((c) => c.id === selection.id) : undefined;
  const zoom = selection.kind === "zoom" ? p.zooms.find((z) => z.id === selection.id) : undefined;
  const capKey = cap ? cap.words.map((w) => w.text).join(" ") : "";
  useEffect(() => setCapText(capKey), [capKey, cap?.id]);

  return (
    <>
      <Section title="Zoom">
        <Slider label="Intensidad" value={zoomScale} min={1.05} max={2.5} step={0.05} format={(v) => `×${v.toFixed(2)}`} onCommit={setZoomScale} />
        <button className="btn" disabled={!ready} onClick={() => s.addZoomAtPlayhead(zoomScale)}>Agregar zoom en el cursor (2 s) <kbd>Z</kbd></button>
        <button className="btn" disabled={!ready || !cap} onClick={() => s.zoomSelectedCaption(zoomScale)}>Zoom en el subtítulo seleccionado</button>
        <button className="btn" disabled={!ready || p.zooms.length === 0}
                onClick={() => s.applyOps([{ name: "clear_zooms", params: {} }], "Quitar todos los zooms")}>Quitar todos los zooms</button>
      </Section>

      <Section title="Subtítulos">
        <button className="btn" disabled={!ready} onClick={() => s.splitAtPlayhead()}>Dividir en el cursor <kbd>S</kbd></button>
        <div className="row">
          <input className="input" placeholder="Palabras a resaltar (separadas por coma)" value={words} onChange={(e) => setWords(e.target.value)} />
          <button className="btn" disabled={!ready || !words.trim()} onClick={async () => {
            const list = words.split(/[,\n]/).map((w) => w.trim()).filter(Boolean);
            if (await s.applyOps([{ name: "set_highlight_words", params: { words: list, replace: true } }], "Resaltar palabras")) setWords("");
          }}>Resaltar</button>
        </div>
        <button className="btn" disabled={!ready} onClick={() => s.applyOps([{ name: "set_highlight_words", params: { words: [], replace: true } }], "Quitar resaltados")}>Quitar resaltados</button>
      </Section>

      <Section title="Recorte">
        <div className="muted">{fmtTime(p.trim.start)} → {fmtTime(p.trim.end)} · {(p.trim.end - p.trim.start).toFixed(1)} s</div>
        <div className="row">
          <button className="btn" disabled={!ready} onClick={() => s.setTrimFromPlayhead("start")}>Inicio aquí</button>
          <button className="btn" disabled={!ready} onClick={() => s.setTrimFromPlayhead("end")}>Fin aquí</button>
        </div>
      </Section>

      <Section title="Encuadre vertical">
        <select className="input" disabled={!ready} value={p.reframe.mode}
                onChange={(e) => s.applyOps([{ name: "set_reframe", params: { mode: e.target.value } }], "Cambiar encuadre")}>
          <option value="face_track">Seguir rostro</option>
          <option value="center">Centrado</option>
          <option value="fixed">Posición fija</option>
        </select>
        {p.reframe.mode === "fixed" && (
          <Slider label="Posición horizontal" value={p.reframe.fixed_x} min={0} max={1} step={0.01} format={(v) => v.toFixed(2)}
                  onCommit={(v) => s.applyOps([{ name: "set_reframe", params: { mode: "fixed", fixed_x: v } }], "Mover encuadre")} />
        )}
      </Section>

      {cap && (
        <Section title="Subtítulo seleccionado">
          <div className="muted">{fmtTime(cap.start)} → {fmtTime(cap.end)}</div>
          <textarea className="input" rows={3} value={capText} onChange={(e) => setCapText(e.target.value)}
                    onBlur={() => { if (capText.trim() && capText.trim() !== capKey) s.applyOps([{ name: "update_caption_text", params: { caption_id: cap.id, text: capText } }], "Editar texto"); }} />
          <button className="btn danger" onClick={() => s.deleteSelection()}>Eliminar subtítulo <kbd>Supr</kbd></button>
        </Section>
      )}
      {zoom && (
        <Section title="Zoom seleccionado">
          <div className="muted">{fmtTime(zoom.start)} → {fmtTime(zoom.end)}</div>
          <Slider label="Intensidad" value={zoom.scale} min={1.05} max={3} step={0.05} format={(v) => `×${v.toFixed(2)}`}
                  onCommit={(v) => s.applyOps([{ name: "update_zoom", params: { zoom_id: zoom.id, scale: v } }], "Ajustar zoom")} />
          <Slider label="Entrada (s)" value={zoom.ease_in} min={0} max={2} step={0.05} format={(v) => v.toFixed(2)}
                  onCommit={(v) => s.applyOps([{ name: "update_zoom", params: { zoom_id: zoom.id, ease_in: v } }], "Ajustar zoom")} />
          <Slider label="Salida (s)" value={zoom.ease_out} min={0} max={2} step={0.05} format={(v) => v.toFixed(2)}
                  onCommit={(v) => s.applyOps([{ name: "update_zoom", params: { zoom_id: zoom.id, ease_out: v } }], "Ajustar zoom")} />
          <button className="btn danger" onClick={() => s.deleteSelection()}>Eliminar zoom <kbd>Supr</kbd></button>
        </Section>
      )}
    </>
  );
}

function StyleTab() {
  const cur = useStore((s) => s.current)!;
  const applyOps = useStore((s) => s.applyOps);
  const st = cur.project.caption_style;
  const ready = cur.status === "ready";
  const set = (patch: Partial<CaptionStyle>) => applyOps([{ name: "set_caption_style", params: patch as Record<string, unknown> }], "Estilo de subtítulos");
  return (
    <>
      <Section title="Estilos">
        <div className="presets">
          {PRESETS.map((pr) => (
            <button key={pr.id} disabled={!ready} className={`preset${st.preset === pr.id ? " active" : ""}`}
                    onClick={() => applyOps([{ name: "apply_style_preset", params: { preset: pr.id } }], `Estilo ${pr.name}`)}>
              <span style={pr.sample}>Aa</span><b>{pr.name}</b><i>{pr.hint}</i>
            </button>
          ))}
        </div>
      </Section>
      <Section title="Texto">
        <select className="input" disabled={!ready} value={st.font} onChange={(e) => set({ font: e.target.value })}>
          {FONTS.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
        <Slider label="Tamaño" value={st.font_size} min={30} max={140} step={1} onCommit={(v) => set({ font_size: v })} disabled={!ready} />
        <Slider label="Posición vertical" value={st.position_y} min={0.1} max={0.95} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onCommit={(v) => set({ position_y: v })} disabled={!ready} />
        <Slider label="Contorno" value={st.outline_width} min={0} max={20} step={0.5} onCommit={(v) => set({ outline_width: v })} disabled={!ready} />
        <div className="row wrap">
          <Toggle label="Mayúsculas" checked={st.uppercase} disabled={!ready} onChange={(v) => set({ uppercase: v })} />
          <Toggle label="Negrita" checked={st.bold} disabled={!ready} onChange={(v) => set({ bold: v })} />
          <Toggle label="Caja" checked={st.box} disabled={!ready} onChange={(v) => set({ box: v })} />
        </div>
      </Section>
      <Section title="Color">
        <ColorField label="Texto" value={st.color} disabled={!ready} onCommit={(v) => set({ color: v })} />
        <ColorField label="Palabra activa" value={st.highlight_color} disabled={!ready} onCommit={(v) => set({ highlight_color: v })} />
        <ColorField label="Palabras clave" value={st.keyword_color} disabled={!ready} onCommit={(v) => set({ keyword_color: v })} />
        <ColorField label="Contorno" value={st.outline_color} disabled={!ready} onCommit={(v) => set({ outline_color: v })} />
      </Section>
      <Section title="Animación">
        <select className="input" disabled={!ready} value={st.animation} onChange={(e) => set({ animation: e.target.value as CaptionStyle["animation"] })}>
          <option value="karaoke">Palabra por palabra</option>
          <option value="pop">Aparición con rebote</option>
          <option value="none">Sin animación</option>
        </select>
      </Section>
    </>
  );
}

function VersionsTab() {
  const revisions = useStore((s) => s.revisions);
  const loadRevisions = useStore((s) => s.loadRevisions);
  const restore = useStore((s) => s.restore);
  const head = useStore((s) => s.current?.head_seq);
  useEffect(() => { void loadRevisions(); }, [head, loadRevisions]);
  const actor: Record<string, string> = { user: "Manual", gemini: "Gemini", auto: "Automático", system: "Sistema" };
  return (
    <Section title="Historial de versiones">
      <p className="muted">Cada cambio es una versión. Restaurar crea una versión nueva: no se pierde nada.</p>
      <ul className="versions">
        {revisions.map((r) => (
          <li key={r.seq} className={r.is_head ? "head" : ""}>
            <div><b>v{r.seq}</b> <span className={`tag ${r.actor}`}>{actor[r.actor] ?? r.actor}</span></div>
            <div className="label">{r.label}</div>
            <div className="muted">{new Date(r.created_at * 1000).toLocaleTimeString()}</div>
            {!r.is_head && <button className="btn small" onClick={() => restore(r.seq)}>Restaurar</button>}
          </li>
        ))}
      </ul>
    </Section>
  );
}

export function LeftPanel() {
  const [tab, setTab] = useState<Tab>("tools");
  return (
    <aside className="left">
      <div className="tabs">
        <button className={tab === "tools" ? "on" : ""} onClick={() => setTab("tools")}>Herramientas</button>
        <button className={tab === "style" ? "on" : ""} onClick={() => setTab("style")}>Estilos</button>
        <button className={tab === "versions" ? "on" : ""} onClick={() => setTab("versions")}>Versiones</button>
      </div>
      <div className="panel-scroll">
        {tab === "tools" && <ToolsTab />}
        {tab === "style" && <StyleTab />}
        {tab === "versions" && <VersionsTab />}
      </div>
    </aside>
  );
}
