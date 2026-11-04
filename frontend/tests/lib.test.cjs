const test = require("node:test");
const assert = require("node:assert/strict");
const vectors = require("./camera_vectors.json");
const { cameraAt } = require("../dist-lib/lib/camera.js");
const { clampSpan, captionAt, activeWordIndex, tickSteps } = require("../dist-lib/lib/timeline.js");

test("el preview calcula la misma cámara que el render (Python)", () => {
  let n = 0;
  for (const c of vectors.cases) {
    for (const s of c.samples) {
      const r = cameraAt(c.project, s.t);
      for (const k of ["x", "y", "w", "h"]) {
        assert.ok(Math.abs(r[k] - s[k]) < 1e-9, `t=${s.t} ${k}: js=${r[k]} py=${s[k]}`);
      }
      n++;
    }
  }
  assert.ok(n > 300);
});

test("clampSpan no pisa vecinos ni sale del video", () => {
  const spans = [{ id: "a", start: 1, end: 3 }, { id: "b", start: 5, end: 7 }, { id: "c", start: 9, end: 10 }];
  const b = { start: 5, end: 7 };
  assert.deepEqual(clampSpan(spans, "b", "move", b, -10, 30, 0.3), { start: 3, end: 5 });
  assert.deepEqual(clampSpan(spans, "b", "move", b, +10, 30, 0.3), { start: 7, end: 9 });
  assert.deepEqual(clampSpan(spans, "b", "l", b, 10, 30, 0.3), { start: 6.7, end: 7 });
  assert.deepEqual(clampSpan(spans, "b", "r", b, 10, 30, 0.3), { start: 5, end: 9 });
  assert.deepEqual(clampSpan(spans, "c", "r", { start: 9, end: 10 }, 99, 12, 0.3), { start: 9, end: 12 });
});

test("subtítulo y palabra activa", () => {
  const cap = { id: "x", start: 1, end: 3, words: [
    { text: "a", start: 1, end: 1.5, highlight: false }, { text: "b", start: 1.6, end: 2, highlight: false },
    { text: "c", start: 2.2, end: 2.8, highlight: false }] };
  assert.equal(captionAt([cap], 2).id, "x");
  assert.equal(captionAt([cap], 3), null);
  assert.equal(activeWordIndex(cap, 1.0), 0);
  assert.equal(activeWordIndex(cap, 1.7), 1);
  assert.equal(activeWordIndex(cap, 2.9), 2);
});

test("marcas de la regla", () => {
  assert.equal(tickSteps(100).major, 1);
  assert.ok(tickSteps(5).major >= 15);
});
