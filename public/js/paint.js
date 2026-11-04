// Dibuja la capa de superposiciones (subtítulos, títulos, imágenes, tarjetas) sobre un canvas 2D.
// La MISMA función pinta la vista previa y los PNG que se mezclan en el render => WYSIWYG.
// Todas las medidas están en "px sobre un ancho de 1080" y se escalan con W/1080.

export const FONTS = {
  'Sans (Arial)': 'Arial, Helvetica, sans-serif',
  'Impact': 'Impact, "Arial Black", sans-serif',
  'Serif (Georgia)': 'Georgia, "Times New Roman", serif',
  'Mono': '"Courier New", monospace',
};

export function wrapText(ctx, text, maxW) {
  const lines = [];
  for (const para of String(text).split('\n')) {
    let cur = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const test = cur ? cur + ' ' + word : word;
      if (cur && ctx.measureText(test).width > maxW) { lines.push(cur); cur = word; } else cur = test;
    }
    lines.push(cur);
  }
  return lines;
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Bloque de texto centrado en (cx,cy) con contorno y caja opcional. */
export function drawText(ctx, text, o) {
  const { cx, cy, size, s, maxW, color = '#fff', outline = '#000', outlineW = 0.12, box = '', weight = 800, font = FONTS['Sans (Arial)'], upper = false } = o;
  const px = size * s;
  ctx.font = `${weight} ${px}px ${font}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  const t = upper ? String(text).toUpperCase() : String(text);
  const lines = wrapText(ctx, t, maxW);
  const lh = px * 1.18;
  const totalH = lines.length * lh;
  const widest = Math.max(...lines.map((l) => ctx.measureText(l).width), 0);
  if (box) {
    const pad = px * 0.35;
    ctx.fillStyle = box;
    roundRect(ctx, cx - widest / 2 - pad, cy - totalH / 2 - pad * 0.6, widest + pad * 2, totalH + pad * 1.2, px * 0.3);
    ctx.fill();
  }
  ctx.lineJoin = 'round';
  lines.forEach((l, i) => {
    const y = cy - totalH / 2 + lh * (i + 0.5);
    if (outline && outlineW > 0) {
      ctx.lineWidth = px * outlineW;
      ctx.strokeStyle = outline;
      ctx.strokeText(l, cx, y);
    }
    ctx.fillStyle = color;
    ctx.fillText(l, cx, y);
  });
  return { w: widest, h: totalH };
}

export function paintCard(ctx, W, H, card, s) {
  const accent = card.accent || '#ffd23f';
  const mx = W * 0.07;
  const pw = W - mx * 2;
  const pad = 54 * s;
  const innerW = pw - pad * 2;
  const body = String(card.body || '');
  const font = FONTS['Sans (Arial)'];
  const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);

  const items = [];
  const add = (text, size, color, weight = 600, gap = 0, italic = false) => items.push({ text, size, color, weight, gap, italic });
  switch (card.type) {
    case 'quote':
      add('“', 150, accent, 800);
      add(body, 54, '#fff', 600, -30, true);
      if (card.author) add('— ' + card.author, 38, accent, 700, 26);
      break;
    case 'definition':
      add('DEFINICIÓN', 28, accent, 800);
      add(card.title || '', 76, '#fff', 800, 6);
      add(body, 44, '#e8ecf5', 500, 22);
      break;
    case 'reference': {
      add('REFERENCIA', 28, accent, 800);
      const who = [card.author, card.year ? `(${card.year})` : ''].filter(Boolean).join(' ');
      add(`${who}${who ? '.' : ''} ${card.title || ''}${card.title ? '.' : ''}`.trim(), 46, '#fff', 700, 8);
      if (card.source) add(card.source, 38, '#c9d1e6', 500, 14, true);
      break;
    }
    case 'timeline':
    case 'diagram':
      if (card.title) add(card.title, 56, '#fff', 800, 0);
      break;
    default:
      add(body, 46, '#fff', 600);
  }

  ctx.save();
  let contentH = 0;
  const measured = items.map((it) => {
    ctx.font = `${it.italic ? 'italic ' : ''}${it.weight} ${it.size * s}px ${font}`;
    const ls = wrapText(ctx, it.text, innerW);
    contentH += ls.length * it.size * s * 1.22 + it.gap * s;
    return { ...it, ls };
  });

  const rowH = 96 * s;
  let extraH = 0;
  if (card.type === 'timeline') extraH = lines.length * rowH + (card.title ? 20 * s : 0);
  if (card.type === 'diagram') extraH = lines.length * (104 * s) + (card.title ? 20 * s : 0);
  const ph = contentH + extraH + pad * 2;
  const py = (card.y ?? 0.5) * H - ph / 2;

  ctx.fillStyle = 'rgba(14,17,28,0.93)';
  roundRect(ctx, mx, py, pw, ph, 36 * s);
  ctx.fill();
  ctx.fillStyle = accent;
  roundRect(ctx, mx, py + 36 * s, 10 * s, Math.max(4, ph - 72 * s), 5 * s);
  ctx.fill();

  let y = py + pad;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  for (const it of measured) {
    y += it.gap * s;
    ctx.font = `${it.italic ? 'italic ' : ''}${it.weight} ${it.size * s}px ${font}`;
    ctx.fillStyle = it.color;
    for (const l of it.ls) { ctx.fillText(l, mx + pad, y); y += it.size * s * 1.22; }
  }
  const fit = (txt, maxW) => { let tt = txt; while (tt.length > 1 && ctx.measureText(tt).width > maxW) tt = tt.slice(0, -2); return tt === txt ? txt : tt + '…'; };
  if (card.type === 'timeline') {
    y += card.title ? 20 * s : 0;
    const x0 = mx + pad + 14 * s;
    ctx.strokeStyle = accent; ctx.lineWidth = 4 * s;
    ctx.beginPath(); ctx.moveTo(x0, y + rowH * 0.5); ctx.lineTo(x0, y + rowH * (lines.length - 0.5)); ctx.stroke();
    lines.forEach((ln, i) => {
      const [lab, ...rest] = ln.includes('|') ? ln.split('|') : ['', ln];
      const cy = y + rowH * (i + 0.5);
      ctx.fillStyle = accent; ctx.beginPath(); ctx.arc(x0, cy, 12 * s, 0, 7); ctx.fill();
      ctx.textBaseline = 'middle';
      ctx.font = `800 ${34 * s}px ${font}`; ctx.fillStyle = accent;
      const label = fit(lab.trim(), innerW * 0.3);
      const lw = label ? ctx.measureText(label).width : 0;
      if (lw) ctx.fillText(label, x0 + 34 * s, cy);
      ctx.font = `500 ${36 * s}px ${font}`; ctx.fillStyle = '#fff';
      const tx = x0 + 34 * s + (lw ? lw + 22 * s : 0);
      ctx.fillText(fit(rest.join('|').trim(), mx + pw - pad - tx), tx, cy);
    });
  }
  if (card.type === 'diagram') {
    y += card.title ? 20 * s : 0;
    const bh = 70 * s;
    lines.forEach((ln, i) => {
      const top = y + i * 104 * s;
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      roundRect(ctx, mx + pad, top, innerW, bh, 16 * s); ctx.fill();
      ctx.strokeStyle = accent; ctx.lineWidth = 3 * s;
      roundRect(ctx, mx + pad, top, innerW, bh, 16 * s); ctx.stroke();
      ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
      ctx.font = `700 ${36 * s}px ${font}`; ctx.fillStyle = '#fff';
      ctx.fillText(fit(ln, innerW - 40 * s), mx + pad + innerW / 2, top + bh / 2);
      if (i < lines.length - 1) {
        const ax = mx + pad + innerW / 2; const ay = top + bh;
        ctx.fillStyle = accent; ctx.beginPath();
        ctx.moveTo(ax - 12 * s, ay + 8 * s); ctx.lineTo(ax + 12 * s, ay + 8 * s); ctx.lineTo(ax, ay + 28 * s); ctx.closePath(); ctx.fill();
      }
    });
  }
  ctx.restore();
}

const within = (it, t) => t >= it.start && t < it.end;

/** ids de lo visible en t (sirve para no re-generar PNG idénticos al exportar). */
export function visibleSignature(state, t) {
  const ids = [];
  for (const k of ['overlays', 'titles', 'subs']) for (const it of state[k]) if (within(it, t)) ids.push(it.id);
  if (state.subStyle && !state.subStyle.enabled) return ids.filter((id) => !id.startsWith('s_')).join(',');
  return ids.join(',');
}

export function paintOverlay(ctx, W, H, state, t, images, clear = true) {
  const s = W / 1080;
  if (clear) ctx.clearRect(0, 0, W, H);
  for (const o of state.overlays) {
    if (!within(o, t)) continue;
    ctx.save();
    ctx.globalAlpha = o.opacity ?? 1;
    if (o.kind === 'card') paintCard(ctx, W, H, o.card, s);
    else {
      const img = images?.get(o.assetId);
      if (img && img.width) {
        const w = (o.w ?? 0.4) * W;
        const hh = (w * img.height) / img.width;
        ctx.drawImage(img, (o.x ?? 0.5) * W - w / 2, (o.y ?? 0.5) * H - hh / 2, w, hh);
      }
    }
    ctx.restore();
  }
  for (const ti of state.titles) {
    if (!within(ti, t)) continue;
    drawText(ctx, ti.text, { cx: ti.x * W, cy: ti.y * H, size: ti.size, s, maxW: W * 0.88, color: ti.color, box: ti.bg, outline: ti.bg ? '' : '#000', weight: ti.weight || 800, font: FONTS[ti.font] });
  }
  const st = state.subStyle;
  if (st.enabled) {
    const cue = state.subs.find((c) => within(c, t));
    if (cue) drawText(ctx, cue.text, { cx: W / 2, cy: st.y * H, size: st.size, s, maxW: W * 0.86, color: st.color, outline: st.outline, box: st.box, upper: st.upper, font: FONTS[st.font] });
  }
}
