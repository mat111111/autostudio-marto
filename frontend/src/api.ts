import type { ChatMessage, ExportInfo, ExportOptions, Job, OpItem, OpResult, ProjectState, ProjectSummary, Revision } from "./types";

export class ApiError extends Error {
  status: number;
  detail: unknown;
  constructor(status: number, detail: unknown, message: string) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

/** Convierte las distintas formas de error del backend en un texto legible. */
function messageFrom(status: number, body: unknown): string {
  if (typeof body === "string" && body) return body;
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (typeof detail === "string") return detail;
  const errors = (detail as { errors?: OpResult[] } | undefined)?.errors;
  if (errors?.length) return errors.map((e) => e.error).join(" ");
  if (Array.isArray(detail)) return detail.map((d: { msg?: string }) => d.msg ?? "").join(" ");
  return `Error ${status}`;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch("/api" + path, init);
  } catch {
    throw new ApiError(0, null, "No se pudo conectar con el servidor. ¿Está corriendo el backend?");
  }
  if (!res.ok) {
    const text = await res.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* texto plano */ }
    throw new ApiError(res.status, body, messageFrom(res.status, body));
  }
  return (await res.json()) as T;
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
export const proxyUrl = (pid: string) => `/api/projects/${pid}/media/proxy`;
export const exportDownloadUrl = (eid: string, kind: "video" | "srt" = "video") => `/api/exports/${eid}/download?kind=${kind}`;

export type ChatResponse = ProjectState & { reply: string; results: OpResult[]; revision: number | null };

export const health = () => req<{ ok: boolean; ffmpeg: boolean; gemini_configured: boolean }>("/health");
export const listProjects = () => req<ProjectSummary[]>("/projects");
export const getProject = (pid: string) => req<ProjectState>(`/projects/${pid}`);
export const applyOps = (pid: string, ops: OpItem[], label: string, expectedHead: number) =>
  req<ProjectState>(`/projects/${pid}/ops`, json("POST", { ops, label, expected_head: expectedHead }));
export const undo = (pid: string) => req<ProjectState>(`/projects/${pid}/undo`, json("POST"));
export const redo = (pid: string) => req<ProjectState>(`/projects/${pid}/redo`, json("POST"));
export const revisions = (pid: string) => req<Revision[]>(`/projects/${pid}/revisions`);
export const restore = (pid: string, seq: number) => req<ProjectState>(`/projects/${pid}/revisions/${seq}/restore`, json("POST"));
export const chatHistory = (pid: string) => req<ChatMessage[]>(`/projects/${pid}/chat`);
export const sendChat = (pid: string, body: { message: string; playhead: number; selection?: Record<string, unknown> }) =>
  req<ChatResponse>(`/projects/${pid}/chat`, json("POST", body));
export const startExport = (pid: string, o: ExportOptions) =>
  req<{ export_id: string; job_id: string; revision: number }>(`/projects/${pid}/exports`, json("POST", o));
export const getExport = (eid: string) => req<ExportInfo & { job: Job }>(`/exports/${eid}`);

/** Subida con progreso (fetch no expone el progreso de subida; XHR sí). */
export function uploadProject(file: File, onProgress: (frac: number) => void): Promise<ProjectState> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/projects");
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onerror = () => reject(new ApiError(0, null, "No se pudo conectar con el servidor."));
    xhr.onload = () => {
      let body: unknown = xhr.responseText;
      try { body = JSON.parse(xhr.responseText); } catch { /* texto plano */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as ProjectState);
      else reject(new ApiError(xhr.status, body, messageFrom(xhr.status, body)));
    };
    const form = new FormData();
    form.append("file", file);
    xhr.send(form);
  });
}
