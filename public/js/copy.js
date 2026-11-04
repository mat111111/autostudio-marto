// Textos de publicación a partir de PLANTILLAS y de lo que escribe el usuario.
// No inventa datos: solo ordena y rellena lo que le das.
const clean = (s) => String(s || '').trim();
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

export function hashtags(raw, extra = []) {
  const seen = new Set();
  const out = [];
  for (const w of [...String(raw || '').split(/[,\n;]+/), ...extra]) {
    const t = clean(w).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, '');
    if (t && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); out.push('#' + t); }
  }
  return out;
}

/** f = { tema, gancho, publico, cta, claves, firma } */
export function buildCopy(f) {
  const tema = clean(f.tema), gancho = clean(f.gancho), pub = clean(f.publico), cta = clean(f.cta), firma = clean(f.firma);
  const titles = [];
  if (tema && gancho) titles.push(`${cap(tema)}: ${gancho}`);
  if (tema) titles.push(`Lo que nadie te explica sobre ${tema}`, `${cap(tema)} en 60 segundos`, `3 ideas clave sobre ${tema}`);
  if (tema && pub) titles.push(`${cap(tema)} para ${pub}`);
  const lines = [];
  if (gancho) lines.push(cap(gancho));
  if (tema) lines.push(`En este video: ${tema}${pub ? ', pensado para ' + pub : ''}.`);
  if (cta) lines.push(cap(cta));
  if (firma) lines.push(firma);
  const tags = hashtags(f.claves, tema ? [tema.split(/\s+/).slice(0, 2).join('')] : []);
  const description = [lines.join('\n\n'), tags.join(' ')].filter(Boolean).join('\n\n');
  return { titles, description, hashtags: tags };
}
