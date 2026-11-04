import { useEffect, useState } from "react";
import * as api from "../api";
import { useStore } from "../store";
import type { ExportOptions, Job } from "../types";
import { Toggle } from "./Controls";

export function ExportDialog({ onClose }: { onClose: () => void }) {
  const cur = useStore((s) => s.current)!;
  const [opts, setOpts] = useState<ExportOptions>({ resolution: "1080p", burn_subtitles: true, enhance_audio: false, high_quality_scaling: false });
  const [exportId, setExportId] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!exportId) return;
    let stop = false;
    const poll = async () => {
      try {
        const e = await api.getExport(exportId);
        if (stop) return;
        setJob(e.job);
        if (e.job.status === "queued" || e.job.status === "running") setTimeout(poll, 1000);
      } catch (err) { if (!stop) setError(api.errorMessage(err)); }
    };
    void poll();
    return () => { stop = true; };
  }, [exportId]);

  const start = async () => {
    setError(null);
    try { setExportId((await api.startExport(cur.id, opts)).export_id); } catch (e) { setError(api.errorMessage(e)); }
  };
  const running = !!exportId && (!job || job.status === "queued" || job.status === "running");
  const done = job?.status === "done";
  const stageLabel: Record<string, string> = { Renderizando: "Renderizando video", ready: "Listo" };

  return (
    <div className="modal-back" onClick={() => !running && onClose()}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Exportar</h3>
        <p className="muted">Se exporta la versión v{cur.head_seq} (recorte {cur.project.trim.start.toFixed(1)}–{cur.project.trim.end.toFixed(1)} s), 9:16, MP4 + subtítulos SRT.</p>
        {!exportId && (
          <>
            <label className="field row"><span>Resolución</span>
              <select className="input" value={opts.resolution} onChange={(e) => setOpts({ ...opts, resolution: e.target.value as ExportOptions["resolution"] })}>
                <option value="1080p">1080 × 1920 (Full HD)</option>
                <option value="4k">2160 × 3840 (4K, más lento)</option>
              </select>
            </label>
            <Toggle label="Quemar subtítulos en el video" checked={opts.burn_subtitles} onChange={(v) => setOpts({ ...opts, burn_subtitles: v })} />
            <Toggle label="Mejorar voz (filtro de ruido y volumen parejo)" checked={opts.enhance_audio} onChange={(v) => setOpts({ ...opts, enhance_audio: v })} />
            <Toggle label="Escalado de alta calidad (más lento)" checked={opts.high_quality_scaling} onChange={(v) => setOpts({ ...opts, high_quality_scaling: v })} />
          </>
        )}
        {exportId && job && (
          <div className="progress-box">
            <div className="bar"><div style={{ width: `${Math.round(job.progress * 100)}%` }} /></div>
            <div className="muted">{job.status === "failed" ? "Falló" : stageLabel[job.stage] ?? job.stage} · {Math.round(job.progress * 100)}%</div>
          </div>
        )}
        {(error || job?.error) && <div className="notice err">{error || job?.error}</div>}
        <div className="modal-actions">
          {done && exportId && (
            <>
              <a className="btn primary" href={api.exportDownloadUrl(exportId)} download>Descargar MP4</a>
              <a className="btn" href={api.exportDownloadUrl(exportId, "srt")} download>Descargar SRT</a>
            </>
          )}
          {!exportId && <button className="btn primary" onClick={start}>Iniciar exportación</button>}
          <button className="btn" disabled={running} onClick={onClose}>{done ? "Cerrar" : "Cancelar"}</button>
        </div>
      </div>
    </div>
  );
}
