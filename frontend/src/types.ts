// Espejo del documento del backend (backend/app/core/models.py). Todos los tiempos: segundos del video ORIGINAL.
export interface Word { text: string; start: number; end: number; highlight: boolean }
export interface Caption { id: string; start: number; end: number; words: Word[] }
export type CaptionAnimation = "none" | "pop" | "karaoke";
export interface CaptionStyle {
  preset: string; font: string; font_size: number; bold: boolean; uppercase: boolean;
  color: string; highlight_color: string; keyword_color: string; outline_color: string;
  outline_width: number; shadow: number; box: boolean; box_color: string; box_opacity: number;
  position_y: number; animation: CaptionAnimation;
}
export interface Zoom {
  id: string; start: number; end: number; scale: number; ease_in: number; ease_out: number;
  center_x: number | null; center_y: number | null;
}
export interface Keyframe { t: number; x: number; y: number }
export interface Reframe { mode: "face_track" | "center" | "fixed"; fixed_x: number; fixed_y: number; keyframes: Keyframe[] }
export interface Source {
  path: string; filename: string; duration: number; width: number; height: number; fps: number;
  has_audio: boolean; sha256: string; proxy_path: string | null;
}
export interface Project {
  schema_version: number; id: string; name: string; source: Source;
  trim: { start: number; end: number };
  output: { width: number; height: number; fps: number };
  transcript: { language: string; words: Word[] };
  captions: Caption[]; caption_style: CaptionStyle; zooms: Zoom[]; reframe: Reframe;
}

export interface Job {
  id: string; project_id: string; kind: string; status: "queued" | "running" | "done" | "failed";
  progress: number; stage: string; error: string | null;
}
export interface ProjectState {
  id: string; name: string; status: "analyzing" | "ready" | "error"; error: string | null;
  head_seq: number; can_undo: boolean; can_redo: boolean; project: Project; analysis_job: Job | null;
}
export interface ProjectSummary { id: string; name: string; status: string; head_seq: number; created_at: number; updated_at: number }
export interface OpItem { name: string; params: Record<string, unknown> }
export interface OpResult { op: string; ok: boolean; message: string; error: string }
export interface ChatMessage { role: "user" | "model"; text: string; ops: OpResult[]; created_at: number }
export interface Revision { seq: number; parent_seq: number | null; label: string; actor: string; created_at: number; is_head: boolean }
export interface ExportInfo { id: string; revision_seq: number; path: string | null; job: Job }
export interface ExportOptions { resolution: "1080p" | "4k"; burn_subtitles: boolean; enhance_audio: boolean; high_quality_scaling: boolean }
