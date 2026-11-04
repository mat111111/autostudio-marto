import { useEffect, useRef, useState } from "react";

/** Slider que solo confirma el cambio al soltar (evita decenas de versiones por un solo arrastre). */
export function Slider(p: { label: string; value: number; min: number; max: number; step: number;
                            onCommit: (v: number) => void; format?: (v: number) => string; disabled?: boolean }) {
  const [v, setV] = useState(p.value);
  useEffect(() => setV(p.value), [p.value]);
  const commit = () => { if (v !== p.value) p.onCommit(v); };
  return (
    <label className="field">
      <span>{p.label}<b>{p.format ? p.format(v) : v}</b></span>
      <input type="range" min={p.min} max={p.max} step={p.step} value={v} disabled={p.disabled}
             onChange={(e) => setV(parseFloat(e.target.value))} onPointerUp={commit} onKeyUp={commit} />
    </label>
  );
}

/** Selector de color: confirma 500 ms después del último cambio. */
export function ColorField(p: { label: string; value: string; onCommit: (v: string) => void; disabled?: boolean }) {
  const [v, setV] = useState(p.value);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => setV(p.value), [p.value]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <label className="field row">
      <span>{p.label}</span>
      <input type="color" value={v} disabled={p.disabled} onChange={(e) => {
        const next = e.target.value;
        setV(next);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => { if (next.toLowerCase() !== p.value.toLowerCase()) p.onCommit(next.toUpperCase()); }, 500);
      }} />
    </label>
  );
}

export function Toggle(p: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="check">
      <input type="checkbox" checked={p.checked} disabled={p.disabled} onChange={(e) => p.onChange(e.target.checked)} /> {p.label}
    </label>
  );
}
