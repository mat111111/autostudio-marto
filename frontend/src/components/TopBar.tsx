import { useState } from "react";
import { useStore } from "../store";
import { ExportDialog } from "./ExportDialog";

export function TopBar() {
  const cur = useStore((s) => s.current)!;
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const close = useStore((s) => s.closeProject);
  const [exporting, setExporting] = useState(false);
  const ready = cur.status === "ready";
  return (
    <header className="topbar">
      <button className="btn small" onClick={close}>← Proyectos</button>
      <b className="logo">AutoStudio <span>AI</span></b>
      <span className="name">{cur.name}</span>
      <span className="badge" title="Versión actual">v{cur.head_seq}</span>
      <span className="spacer" />
      <button className="btn" disabled={!cur.can_undo} onClick={() => undo()} title="Ctrl+Z">↶ Deshacer</button>
      <button className="btn" disabled={!cur.can_redo} onClick={() => redo()} title="Ctrl+Shift+Z">↷ Rehacer</button>
      <button className="btn primary" disabled={!ready} onClick={() => setExporting(true)}>Exportar</button>
      {exporting && <ExportDialog onClose={() => setExporting(false)} />}
    </header>
  );
}
