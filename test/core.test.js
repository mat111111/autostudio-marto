import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as T from '../public/js/timeline.js';
import { cropRect, outputSize } from '../public/js/frame.js';
import { parseSrt, outputSrt, srtTime } from '../public/js/subs.js';
import { parseTime, fmt } from '../public/js/util.js';
import { buildGraph, atempoChain } from '../public/js/graph.js';
import { planOverlay } from '../public/js/overlay_plan.js';
import { initialState, sanitize } from '../public/js/store.js';
import { buildCopy, hashtags } from '../public/js/copy.js';

const clip = (s, e, sp = 1) => ({ id: 'c' + s, start: s, end: e, speed: sp, volume: 1 });

test('cutRange / keepRange / splitAt', () => {
  let c = [clip(0, 10)];
  c = T.cutRange(c, 3, 5);
  assert.deepEqual(c.map((x) => [x.start, x.end]), [[0, 3], [5, 10]]);
  assert.equal(T.outDuration(c), 8);
  assert.deepEqual(T.keepRange(c, 2, 6).map((x) => [x.start, x.end]), [[2, 3], [5, 6]]);
  assert.equal(T.splitAt([clip(0, 10)], 4).length, 2);
  assert.equal(T.splitAt([clip(0, 10)], 0.01).length, 1, 'no parte en el borde');
});

test('srcToOut / outToSrc con cortes y velocidad', () => {
  const c = [clip(0, 3), clip(5, 9, 2)];
  assert.equal(T.srcToOut(c, 4), null);
  assert.equal(T.srcToOut(c, 5), 3);
  assert.equal(T.srcToOut(c, 7), 4);
  assert.equal(T.outToSrc(c, 4), 7);
  assert.equal(T.outDuration(c), 5);
  assert.deepEqual(T.mapSpan(c, 2, 6), [2, 3.5]);
});

test('setSpeedRange parte en los bordes', () => {
  const c = T.setSpeedRange([clip(0, 10)], 2, 4, 2);
  assert.deepEqual(c.map((x) => [x.start, x.end, x.speed]), [[0, 2, 1], [2, 4, 2], [4, 10, 1]]);
});

test('buildSegments parte por zoom; el último zoom gana', () => {
  const segs = T.buildSegments({ clips: [clip(0, 10)], zooms: [{ start: 2, end: 4, scale: 1.5, cx: 0.5, cy: 0.5 }] });
  assert.deepEqual(segs.map((s) => [s.start, s.end, !!s.zoom]), [[0, 2, false], [2, 4, true], [4, 10, false]]);
  const z = T.carveZooms([{ id: 'a', start: 0, end: 10, scale: 1.5, cx: 0, cy: 0 }], 4, 6);
  assert.equal(z.length, 2);
});

test('cropRect: cover 16:9 -> 9:16, zoom y límites', () => {
  const r = cropRect(1920, 1080, 9 / 16, 1, 0.5, 0.5);
  assert.equal(Math.round(r.w), 608); assert.equal(r.h, 1080); assert.equal(Math.round(r.x), 656);
  const edge = cropRect(1920, 1080, 9 / 16, 1, 0, 0.5);
  assert.equal(edge.x, 0, 'no se sale por la izquierda');
  const z = cropRect(1920, 1080, 9 / 16, 2, 1, 1);
  assert.ok(Math.abs(z.x + z.w - 1920) < 1e-6 && Math.abs(z.y + z.h - 1080) < 1e-6);
  assert.deepEqual(outputSize('9:16', 720), { W: 720, H: 1280 });
  assert.deepEqual(outputSize('16:9', 720), { W: 1280, H: 720 });
});

test('SRT: parseo, escritura en tiempo de salida', () => {
  const subs = parseSrt('1\n00:00:01,000 --> 00:00:02,500\nHola <i>mundo</i>\n\n2\n00:00:06,000 --> 00:00:07,000\nChau\n');
  assert.equal(subs.length, 2);
  assert.equal(subs[0].text, 'Hola mundo');
  const out = outputSrt(subs, [clip(0, 3), clip(5, 9)]);
  assert.match(out, /00:00:01,000 --> 00:00:02,500/);
  assert.match(out, /00:00:04,000 --> 00:00:05,000/, 'el 2º cue se corre 2 s por el corte');
  assert.equal(srtTime(3661.5), '01:01:01,500');
});

test('parseTime / fmt', () => {
  assert.equal(parseTime('1:15.5'), 75.5);
  assert.equal(parseTime('00:01:15,500'), 75.5);
  assert.equal(parseTime('abc'), null);
  assert.equal(fmt(75.5), '01:15.500');
});

test('atempoChain', () => {
  assert.equal(atempoChain(1), '');
  assert.equal(atempoChain(3), 'atempo=2,atempo=1.5');
  assert.equal(atempoChain(0.25), 'atempo=0.5,atempo=0.5');
});

test('sanitize descarta basura y limita rangos', () => {
  const src = { name: 'a.mp4', duration: 10, width: 1280, height: 720, size: 1 };
  const st = sanitize({ clips: [{ start: -5, end: 99, speed: 50 }], subs: [{ start: 3, end: 2, text: 'x' }, { start: 1, end: 2, text: 'ok' }], overlays: [{ kind: 'image', assetId: 'nope', start: 0, end: 1 }], settings: { ratio: 'hack', res: 9 } }, src);
  assert.deepEqual([st.clips[0].start, st.clips[0].end, st.clips[0].speed], [0, 10, 4]);
  assert.equal(st.subs.length, 1);
  assert.equal(st.overlays.length, 0);
  assert.equal(st.settings.ratio, '9:16');
  assert.equal(st.settings.res, 720);
});

test('copy por plantillas + hashtags', () => {
  const c = buildCopy({ tema: 'la fotosíntesis', gancho: 'así convierte luz en azúcar', claves: 'biología, Ciencia; ciencia', cta: 'seguime' });
  assert.ok(c.titles.length >= 3);
  assert.deepEqual(hashtags('biología, Ciencia; ciencia'), ['#biologia', '#Ciencia']);
  assert.match(c.description, /#biologia/);
});

test('planOverlay: intervalos en tiempo de salida y salta cortes', () => {
  const st = initialState({ name: 'a', duration: 10, width: 1280, height: 720, size: 1 });
  st.clips = [clip(0, 3), clip(5, 10)];
  st.subs = [{ id: 's_1', start: 2, end: 6, text: 'hola' }];
  const plan = planOverlay(st);
  assert.ok(plan.some((p) => p.sig === 's_1'));
  assert.ok(Math.abs(plan[plan.length - 1].b - 8) < 1e-6);
});

// ---- Verificación contra un ffmpeg REAL (nativo): la sintaxis del grafo tiene que ser válida ----
const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

test('el filtergraph renderiza de verdad (ffmpeg nativo) y respeta duración', { skip: !hasFfmpeg }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'asm-'));
  const src = join(dir, 'in.mp4');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=12', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', src]);
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=3', join(dir, 'mus.wav')]);
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red@0.5:s=360x640:d=2:r=30,format=rgba', '-frames:v', '60', join(dir, 'ov.mov')]);

  const st = initialState({ name: 'in.mp4', duration: 12, width: 1280, height: 720, size: 1 });
  st.settings.res = 540;
  st.settings.denoise = true;
  st.settings.music.enabled = true;
  st.clips = T.setSpeedRange(T.cutRange(st.clips, 3, 5), 7, 9, 2); // 0-3, 5-7, 7-9(x2), 9-12 => 3+2+1+3 = 9 s
  st.zooms = [{ id: 'z1', start: 0.5, end: 2, scale: 1.8, cx: 0.7, cy: 0.4 }];
  for (const fit of ['cover', 'blur']) for (const duck of [true, false]) {
    st.settings.fit = fit; st.settings.music.duck = duck;
    const { graph, duration, W, H } = buildGraph(st, { hasAudio: true, overlayInput: 1, musicInput: 2 });
    assert.equal(duration, 9);
    const out = join(dir, `out-${fit}-${duck}.mp4`);
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', src, '-i', join(dir, 'ov.mov'), '-i', join(dir, 'mus.wav'), '-filter_complex', graph, '-map', '[vo]', '-map', '[ao]', '-t', String(duration), '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', out]);
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height:format=duration', '-of', 'json', out]).toString());
    const v = probe.streams.find((s) => s.codec_type === 'video');
    assert.deepEqual([v.width, v.height], [W, H]);
    assert.ok(probe.streams.some((s) => s.codec_type === 'audio'));
    assert.ok(Math.abs(+probe.format.duration - 9) < 0.35, `duración ${probe.format.duration} (${fit}/${duck})`);
  }
  // Sin audio de origen y sin overlay ni música
  const noAudio = join(dir, 'na.mp4');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=4', '-c:v', 'libx264', noAudio]);
  const s2 = initialState({ name: 'na.mp4', duration: 4, width: 640, height: 360, size: 1 });
  s2.settings.res = 540;
  const g = buildGraph(s2, { hasAudio: false });
  const o2 = join(dir, 'o2.mp4');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', noAudio, '-filter_complex', g.graph, '-map', '[vo]', '-map', '[ao]', '-t', String(g.duration), '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', o2]);
  assert.ok(existsSync(o2));
});

test('zoomState: efectos y coherencia con el rango', () => {
  const g = { cx: 0.5, cy: 0.5 };
  const z = { start: 2, end: 6, scale: 2, cx: 0.8, cy: 0.2, anim: 'in' };
  assert.equal(T.zoomState(null, 3, g).scale, 1);
  assert.equal(T.zoomState({ ...z, anim: 'static' }, 3, g).scale, 2);
  assert.ok(Math.abs(T.zoomState(z, 2, g).scale - 1) < 1e-9, 'acercar empieza en 1');
  assert.ok(Math.abs(T.zoomState(z, 6, g).scale - 2) < 1e-9, 'acercar termina en la escala');
  const mid = T.zoomState(z, 4, g);
  assert.ok(Math.abs(mid.scale - 1.5) < 1e-9 && Math.abs(mid.cx - 0.65) < 1e-9);
  assert.ok(Math.abs(T.zoomState({ ...z, anim: 'out' }, 2, g).scale - 2) < 1e-9);
  assert.ok(Math.abs(T.zoomState({ ...z, anim: 'inout' }, 4, g).scale - 2) < 1e-9, 'ida y vuelta: pico al medio');
  assert.ok(Math.abs(T.zoomState({ ...z, anim: 'inout' }, 6, g).scale - 1) < 1e-9);
  assert.ok(Math.abs(T.zoomState({ ...z, anim: 'punch' }, 2 + T.PUNCH_SECS, g).scale - 2) < 1e-9, 'golpe llega rápido');
  assert.equal(T.zoomState(z, 4, g, false).scale, 2, 'sin animar => valor final');
});

test('zoom animado en ffmpeg nativo: todos los efectos corren y un cuadro coincide con el zoom fijo equivalente', { skip: !hasFfmpeg }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'asz-'));
  const src = join(dir, 'in.mp4');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=6', '-c:v', 'libx264', '-crf', '10', '-pix_fmt', 'yuv420p', src]);
  const mk = (zoom, speed = 1) => {
    const st = initialState({ name: 'in.mp4', duration: 6, width: 1280, height: 720, size: 1 });
    st.settings.res = 540; st.settings.fps = 30; st.settings.denoise = false; st.settings.normalize = false;
    st.clips = [clip(0, 6, speed)];
    st.zooms = [zoom];
    return st;
  };
  const render = (st, name) => {
    const { graph, duration } = buildGraph(st, { hasAudio: false });
    const out = join(dir, name + '.mp4');
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', src, '-filter_complex', graph, '-map', '[vo]', '-map', '[ao]', '-t', String(duration), '-c:v', 'libx264', '-crf', '10', '-preset', 'ultrafast', '-c:a', 'aac', out]);
    return { out, duration };
  };
  const frameAt = (file, t, name) => { const p = join(dir, name + '.png'); execFileSync('ffmpeg', ['-y', '-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', p]); return p; };
  const getPsnr = (a, b) => {
    const r = spawnSync('ffmpeg', ['-i', a, '-i', b, '-lavfi', 'psnr', '-f', 'null', '-'], { encoding: 'utf8' });
    const m = /average:([\d.]+|inf)/.exec(r.stderr);
    return m[1] === 'inf' ? 99 : parseFloat(m[1]);
  };

  for (const anim of ['in', 'out', 'inout', 'punch']) {
    const r = render(mk({ id: 'z', start: 0, end: 4, scale: 2, cx: 0.7, cy: 0.4, anim }), 'anim-' + anim);
    assert.ok(existsSync(r.out), anim);
  }
  // 'in' a mitad del rango (t=2 s): zoom 1.5 centrado en (0.6, 0.45) ≡ zoom fijo equivalente
  const a = render(mk({ id: 'z', start: 0, end: 4, scale: 2, cx: 0.7, cy: 0.4, anim: 'in' }), 'a');
  const b = render(mk({ id: 'z', start: 0, end: 6, scale: 1.5, cx: 0.6, cy: 0.45, anim: 'static' }), 'b');
  const p = getPsnr(frameAt(a.out, 2, 'fa'), frameAt(b.out, 2, 'fb'));
  assert.ok(p > 24, `el cuadro animado difiere del fijo equivalente (PSNR ${p} dB)`);
  // con velocidad ×2 el efecto debe seguir al tiempo ORIGINAL: en t_out=1 s (orig 2 s) debe ser el mismo cuadro que sin velocidad en t=2
  const c = render(mk({ id: 'z', start: 0, end: 4, scale: 2, cx: 0.7, cy: 0.4, anim: 'in' }, 2), 'c');
  const pc = getPsnr(frameAt(c.out, 1, 'fc'), frameAt(a.out, 2, 'fa2'));
  assert.ok(pc > 22, `con velocidad ×2 el efecto se desfasó (PSNR ${pc} dB)`);
});

test('servidor: el motor precomprimido conserva COOP/COEP/CORP (sin ellos el worker multi-hilo se bloquea)', async () => {
  const { createApp, warmVendor } = await import('../server.js');
  await warmVendor();
  const srv = createApp().listen(0);
  try {
    const port = srv.address().port;
    for (const file of ['core-mt/ffmpeg-core.worker.js', 'core-mt/ffmpeg-core.js', 'core/ffmpeg-core.js']) {
      const raw = await fetch(`http://127.0.0.1:${port}/vendor/${file}`, { headers: { 'Accept-Encoding': 'identity' } });
      const gz = await fetch(`http://127.0.0.1:${port}/vendor/${file}`, { headers: { 'Accept-Encoding': 'gzip' } });
      for (const r of [raw, gz]) {
        assert.equal(r.status, 200, file);
        assert.equal(r.headers.get('cross-origin-embedder-policy'), 'require-corp', file);
        assert.equal(r.headers.get('cross-origin-opener-policy'), 'same-origin', file);
        assert.equal(r.headers.get('cross-origin-resource-policy'), 'same-origin', file);
      }
      assert.equal((await raw.text()).length, (await gz.text()).length, 'mismo contenido con y sin gzip: ' + file);
    }
  } finally { srv.close(); }
});
