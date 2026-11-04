import { create } from "zustand";
import * as api from "./api";
import { round3 } from "./lib/format";
import { captionAt } from "./lib/timeline";
import type { ChatMessage, OpItem, ProjectState, ProjectSummary, Revision } from "./types";

type SelKind = "caption" | "zoom";
interface Selection { kind: SelKind | null; id: string | null }

interface State {
  view: "home" | "editor";
  projects: ProjectSummary[];
  current: ProjectState | null;
  geminiReady: boolean;
  backendOk: boolean;

  playhead: number;
  playing: boolean;
  seekNonce: number;
  trimOnly: boolean;
  selection: Selection;
  pxPerSec: number;

  revisions: Revision[];
  chat: ChatMessage[];
  chatBusy: boolean;
  toast: string | null;

  init: () => Promise<void>;
  loadProjects: () => Promise<void>;
  openProject: (id: string) => Promise<void>;
  closeProject: () => void;
  upload: (file: File, onProgress: (f: number) => void) => Promise<void>;
  refreshCurrent: () => Promise<void>;

  applyOps: (ops: OpItem[], label: string) => Promise<boolean>;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  loadRevisions: () => Promise<void>;
  restore: (seq: number) => Promise<void>;

  seek: (t: number) => void;
  setPlayhead: (t: number) => void;
  setPlaying: (p: boolean) => void;
  setTrimOnly: (v: boolean) => void;
  select: (kind: SelKind | null, id: string | null) => void;
  setPxPerSec: (v: number) => void;

  sendChat: (message: string) => Promise<void>;
  showToast: (msg: string) => void;

  addZoomAtPlayhead: (scale: number) => Promise<void>;
  zoomSelectedCaption: (scale: number) => Promise<void>;
  splitAtPlayhead: () => Promise<void>;
  deleteSelection: () => Promise<void>;
  setTrimFromPlayhead: (edge: "start" | "end") => Promise<void>;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;

export const useStore = create<State>()((set, get) => ({
  view: "home",
  projects: [],
  current: null,
  geminiReady: false,
  backendOk: true,

  playhead: 0,
  playing: false,
  seekNonce: 0,
  trimOnly: true,
  selection: { kind: null, id: null },
  pxPerSec: 40,

  revisions: [],
  chat: [],
  chatBusy: false,
  toast: null,

  showToast: (msg) => {
    clearTimeout(toastTimer);
    set({ toast: msg });
    toastTimer = setTimeout(() => set({ toast: null }), 6000);
  },

  init: async () => {
    try {
      const h = await api.health();
      set({ geminiReady: h.gemini_configured, backendOk: true });
      await get().loadProjects();
    } catch (e) {
      set({ backendOk: false });
      get().showToast(api.errorMessage(e));
    }
  },

  loadProjects: async () => {
    try { set({ projects: await api.listProjects() }); } catch (e) { get().showToast(api.errorMessage(e)); }
  },

  openProject: async (id) => {
    try {
      const [state, chat] = await Promise.all([api.getProject(id), api.chatHistory(id)]);
      set({ current: state, chat, view: "editor", playhead: state.project.trim.start, playing: false,
            selection: { kind: null, id: null }, revisions: [] });
    } catch (e) { get().showToast(api.errorMessage(e)); }
  },

  closeProject: () => {
    set({ view: "home", current: null, playing: false, chat: [], revisions: [] });
    void get().loadProjects();
  },

  upload: async (file, onProgress) => {
    const state = await api.uploadProject(file, onProgress);
    set({ current: state, chat: [], view: "editor", playhead: 0, playing: false, selection: { kind: null, id: null } });
  },

  refreshCurrent: async () => {
    const cur = get().current;
    if (!cur) return;
    try { set({ current: await api.getProject(cur.id) }); } catch (e) { get().showToast(api.errorMessage(e)); }
  },

  applyOps: async (ops, label) => {
    const cur = get().current;
    if (!cur) return false;
    try {
      set({ current: await api.applyOps(cur.id, ops, label, cur.head_seq) });
      return true;
    } catch (e) {
      get().showToast(api.errorMessage(e));
      await get().refreshCurrent(); // vuelve al estado real del servidor
      return false;
    }
  },

  undo: async () => {
    const cur = get().current;
    if (!cur || !cur.can_undo) return;
    try { set({ current: await api.undo(cur.id) }); } catch (e) { get().showToast(api.errorMessage(e)); }
  },
  redo: async () => {
    const cur = get().current;
    if (!cur || !cur.can_redo) return;
    try { set({ current: await api.redo(cur.id) }); } catch (e) { get().showToast(api.errorMessage(e)); }
  },
  loadRevisions: async () => {
    const cur = get().current;
    if (!cur) return;
    try { set({ revisions: await api.revisions(cur.id) }); } catch (e) { get().showToast(api.errorMessage(e)); }
  },
  restore: async (seq) => {
    const cur = get().current;
    if (!cur) return;
    try { set({ current: await api.restore(cur.id, seq) }); } catch (e) { get().showToast(api.errorMessage(e)); }
  },

  seek: (t) => {
    const cur = get().current;
    const dur = cur?.project.source.duration ?? 0;
    set((s) => ({ playhead: Math.min(Math.max(t, 0), dur), seekNonce: s.seekNonce + 1 }));
  },
  setPlayhead: (t) => set({ playhead: t }),   // lo usa el reproductor mientras reproduce (sin forzar seek)
  setPlaying: (p) => set({ playing: p }),
  setTrimOnly: (v) => set({ trimOnly: v }),
  select: (kind, id) => set({ selection: { kind, id } }),
  setPxPerSec: (v) => set({ pxPerSec: Math.min(Math.max(v, 8), 600) }),

  sendChat: async (message) => {
    const cur = get().current;
    if (!cur || get().chatBusy) return;
    const { selection, playhead } = get();
    const sel = selection.kind === "caption" ? { caption_ids: [selection.id] }
      : selection.kind === "zoom" ? { zoom_id: selection.id } : undefined;
    set((s) => ({ chatBusy: true, chat: [...s.chat, { role: "user", text: message, ops: [], created_at: Date.now() / 1000 }] }));
    try {
      const r = await api.sendChat(cur.id, { message, playhead, selection: sel });
      set((s) => ({
        current: { ...r }, // el backend devuelve el estado completo del proyecto junto con la respuesta
        chat: [...s.chat, { role: "model", text: r.reply, ops: r.results, created_at: Date.now() / 1000 }],
      }));
    } catch (e) {
      set((s) => ({ chat: [...s.chat, { role: "model", text: "⚠ " + api.errorMessage(e), ops: [], created_at: Date.now() / 1000 }] }));
      await get().refreshCurrent();
    } finally {
      set({ chatBusy: false });
    }
  },

  addZoomAtPlayhead: async (scale) => {
    const cur = get().current;
    if (!cur) return;
    const start = round3(get().playhead);
    const end = round3(Math.min(start + 2, cur.project.source.duration));
    await get().applyOps([{ name: "add_zoom", params: { start, end, scale } }], "Agregar zoom");
  },
  zoomSelectedCaption: async (scale) => {
    const { selection } = get();
    if (selection.kind !== "caption" || !selection.id) return;
    await get().applyOps([{ name: "add_zoom_on_caption", params: { caption_id: selection.id, scale } }], "Zoom en subtítulo");
  },
  splitAtPlayhead: async () => {
    const cur = get().current;
    if (!cur) return;
    const t = get().playhead;
    const cap = captionAt(cur.project.captions, t);
    if (!cap) { get().showToast("Ubicá el cursor dentro de un subtítulo para dividirlo."); return; }
    await get().applyOps([{ name: "split_caption", params: { caption_id: cap.id, at: round3(t) } }], "Dividir subtítulo");
  },
  deleteSelection: async () => {
    const { selection } = get();
    if (!selection.id) return;
    const op: OpItem = selection.kind === "caption"
      ? { name: "delete_caption", params: { caption_id: selection.id } }
      : { name: "remove_zoom", params: { zoom_id: selection.id } };
    if (await get().applyOps([op], selection.kind === "caption" ? "Eliminar subtítulo" : "Eliminar zoom")) {
      set({ selection: { kind: null, id: null } });
    }
  },
  setTrimFromPlayhead: async (edge) => {
    const cur = get().current;
    if (!cur) return;
    const t = round3(get().playhead);
    const { start, end } = cur.project.trim;
    await get().applyOps([{ name: "set_trim", params: edge === "start" ? { start: t, end } : { start, end: t } }], "Recortar");
  },
}));
