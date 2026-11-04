import { useStore } from "../store";

const STAGES: Record<string, string> = {
  queued: "En cola…", proxy: "Preparando la vista previa", transcribing: "Transcribiendo el audio",
  tracking: "Siguiendo rostros para el reencuadre", editing: "Armando la edición automática",
};

export function AnalysisView() {
  const cur = useStore((s) => s.current)!;
  const job = cur.analysis_job;
  if (cur.status === "error" || job?.status === "failed") {
    return <div className="center-msg"><h3>El análisis falló</h3><div className="notice err">{cur.error || job?.error || "Error desconocido"}</div>
      <p className="muted">El video original no se modificó. Revisá los logs del worker.</p></div>;
  }
  const pct = Math.round((job?.progress ?? 0) * 100);
  return (
    <div className="center-msg">
      <h3>{STAGES[job?.stage ?? "queued"] ?? "Analizando…"}</h3>
      <div className="progress-box wide"><div className="bar"><div style={{ width: `${pct}%` }} /></div></div>
      <p className="muted">{pct}% · Transcripción, zooms y reencuadre se generan automáticamente.</p>
    </div>
  );
}
