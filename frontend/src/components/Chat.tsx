import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";

const SUGGESTIONS = [
  "Hacé un zoom en esta frase",
  "Agrandá los subtítulos y resaltá las palabras importantes",
  "Aplicá una estética más sobria y editorial",
  "Convertí este video en un Reel de 45 segundos",
];

export function Chat() {
  const chat = useStore((s) => s.chat);
  const busy = useStore((s) => s.chatBusy);
  const send = useStore((s) => s.sendChat);
  const undo = useStore((s) => s.undo);
  const cur = useStore((s) => s.current);
  const ready = useStore((s) => s.geminiReady);
  const selection = useStore((s) => s.selection);
  const [text, setText] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [chat.length, busy]);

  const canChat = ready && cur?.status === "ready";
  const submit = () => {
    const m = text.trim();
    if (!m || busy || !canChat) return;
    setText("");
    void send(m);
  };
  const lastModel = chat.map((m) => m.role).lastIndexOf("model");

  return (
    <aside className="right">
      <div className="chat-head">
        <b>Director de edición</b>
        <span className="muted">Gemini</span>
      </div>
      {!ready && <div className="notice">Gemini no está configurado. Definí <code>GEMINI_API_KEY</code> en el backend y reinicialo.</div>}
      <div className="messages">
        {chat.length === 0 && (
          <div className="empty">
            <p>Pedile cambios en lenguaje natural. Se ejecutan sobre la línea de tiempo y podés deshacerlos.</p>
            {SUGGESTIONS.map((s) => <button key={s} className="chip" disabled={!canChat} onClick={() => setText(s)}>{s}</button>)}
          </div>
        )}
        {chat.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            <div className="bubble">{m.text}</div>
            {m.ops.length > 0 && (
              <ul className="ops">
                {m.ops.map((o, j) => <li key={j} className={o.ok ? "ok" : "err"}>{o.ok ? "✓ " + o.message : "✕ " + o.error}</li>)}
              </ul>
            )}
            {i === lastModel && m.ops.some((o) => o.ok) && cur?.can_undo && (
              <button className="btn small" onClick={() => undo()}>Deshacer estos cambios</button>
            )}
          </div>
        ))}
        {busy && <div className="msg model"><div className="bubble typing">Editando…</div></div>}
        <div ref={endRef} />
      </div>
      <div className="composer">
        {selection.id && <div className="muted ctx">Contexto: {selection.kind === "caption" ? "subtítulo" : "zoom"} seleccionado + posición del cursor</div>}
        <textarea className="input" rows={2} value={text} disabled={!canChat} placeholder="Ej.: eliminá el zoom del segundo 35"
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }} />
        <button className="btn primary" disabled={!canChat || busy || !text.trim()} onClick={submit}>Enviar</button>
      </div>
    </aside>
  );
}
