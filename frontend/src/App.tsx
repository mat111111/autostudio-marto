import { useEffect } from "react";
import { AnalysisView } from "./components/AnalysisView";
import { Chat } from "./components/Chat";
import { Home } from "./components/Home";
import { LeftPanel } from "./components/LeftPanel";
import { Player } from "./components/Player";
import { Timeline } from "./components/Timeline";
import { TopBar } from "./components/TopBar";
import { useStore } from "./store";

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") return;
      const s = useStore.getState();
      if (s.view !== "editor" || !s.current || s.current.status !== "ready") return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); void (e.shiftKey ? s.redo() : s.undo()); return; }
      if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); void s.redo(); return; }
      if (mod) return;
      const frame = 1 / (s.current.project.output.fps || 30);
      switch (e.key) {
        case " ": e.preventDefault(); s.setPlaying(!s.playing); break;
        case "ArrowLeft": e.preventDefault(); s.seek(s.playhead - (e.shiftKey ? 1 : frame)); break;
        case "ArrowRight": e.preventDefault(); s.seek(s.playhead + (e.shiftKey ? 1 : frame)); break;
        case "Delete": case "Backspace": if (s.selection.id) { e.preventDefault(); void s.deleteSelection(); } break;
        case "s": case "S": void s.splitAtPlayhead(); break;
        case "z": case "Z": void s.addZoomAtPlayhead(1.3); break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export default function App() {
  const view = useStore((s) => s.view);
  const status = useStore((s) => s.current?.status);
  const id = useStore((s) => s.current?.id);
  const toast = useStore((s) => s.toast);
  useShortcuts();

  useEffect(() => { void useStore.getState().init(); }, []);

  // Mientras el backend analiza el video, se consulta su avance.
  useEffect(() => {
    if (status !== "analyzing") return;
    const t = setInterval(() => void useStore.getState().refreshCurrent(), 1500);
    return () => clearInterval(t);
  }, [status, id]);

  return (
    <>
      {view === "home" || !status ? <Home /> : (
        <div className="app">
          <TopBar />
          <LeftPanel />
          <main className="center">{status === "ready" ? <Player /> : <AnalysisView />}</main>
          <Chat />
          <section className="bottom"><Timeline /></section>
        </div>
      )}
      {toast && <div className="toast" onClick={() => useStore.setState({ toast: null })}>{toast}</div>}
    </>
  );
}
