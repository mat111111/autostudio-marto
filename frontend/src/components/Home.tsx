import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../api";
import { useStore } from "../store";

const STATUS: Record<string, string> = { analyzing: "Analizando…", ready: "Listo", error: "Con error" };

export function Home() {
  const projects = useStore((s) => s.projects);
  const open = useStore((s) => s.openProject);
  const upload = useStore((s) => s.upload);
  const backendOk = useStore((s) => s.backendOk);
  const toast = useStore((s) => s.showToast);
  const input = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [over, setOver] = useState(false);

  useEffect(() => {
    const id = setInterval(() => void useStore.getState().loadProjects(), 4000);
    return () => clearInterval(id);
  }, []);

  const go = async (file: File | undefined) => {
    if (!file) return;
    if (!/\.(mp4|mov)$/i.test(file.name)) { toast("Formato no soportado. Subí un archivo MP4 o MOV."); return; }
    setProgress(0);
    try { await upload(file, setProgress); } catch (e) { toast(errorMessage(e)); } finally { setProgress(null); }
  };

  return (
    <main className="home">
      <h1>AutoStudio <span>AI</span></h1>
      <p className="muted">Subí un video sin editar y obtené un Reel listo para ajustar con el director de edición.</p>
      {!backendOk && <div className="notice err">No hay conexión con el backend (http://localhost:8000).</div>}
      <div className={`drop${over ? " over" : ""}`} onClick={() => input.current?.click()}
           onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
           onDrop={(e) => { e.preventDefault(); setOver(false); void go(e.dataTransfer.files[0]); }}>
        {progress === null ? <><b>Arrastrá un video acá</b><span>o hacé clic para elegir · MP4 o MOV</span></> : (
          <div className="progress-box"><div className="bar"><div style={{ width: `${Math.round(progress * 100)}%` }} /></div>
            <span>Subiendo… {Math.round(progress * 100)}%</span></div>
        )}
        <input ref={input} type="file" accept=".mp4,.mov,video/mp4,video/quicktime" hidden onChange={(e) => void go(e.target.files?.[0])} />
      </div>
      {projects.length > 0 && <h3>Proyectos</h3>}
      <div className="project-list">
        {projects.map((p) => (
          <button key={p.id} className="project-card" onClick={() => open(p.id)}>
            <b>{p.name}</b>
            <span className={`status ${p.status}`}>{STATUS[p.status] ?? p.status}</span>
            <span className="muted">{new Date(p.updated_at * 1000).toLocaleString()}</span>
          </button>
        ))}
      </div>
    </main>
  );
}
