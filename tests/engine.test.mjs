// Quality tests for the restoration engine on synthetic footage with known defects.
// Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const E = require('../src/engine.js');
// The engine works in 16-bit; these quality tests compare at 8-bit precision.
const run = (job) => { const r = E.process(job); r.data16 = r.data; r.data = E.to8(r.data); return r; };

const W = 256, H = 160;

function rand(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

/** Textured scene sampled with a camera offset, plus per-frame grain. */
function scene(offX, offY, frame, { gain = 1, grain = 3 } = {}) {
  const data = new Uint8ClampedArray(W * H * 4), r = rand(1000 + frame);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = x + offX, v = y + offY;
    const base = 110 + 45 * Math.sin(u / 13) * Math.cos(v / 17) + 30 * Math.sin((u + 2 * v) / 29) + 20 * Math.sin(u / 5.3 + Math.cos(v / 7));
    const nz = (r() + r() + r() - 1.5) * 2 * grain;
    const l = (base + nz) * gain, j = (y * W + x) * 4;
    data[j] = l * 1.04; data[j + 1] = l; data[j + 2] = l * 0.92; data[j + 3] = 255;
  }
  return data;
}

function addBlobs(data, count, seed, minR = 1.5, maxR = 4, delta = 0) {
  const r = rand(seed), blobs = [];
  for (let k = 0; k < count; k++) {
    const cx = 12 + r() * (W - 24), cy = 12 + r() * (H - 24), rad = minR + r() * (maxR - minR), dark = r() < 0.6;
    blobs.push({ cx, cy, rad, dark });
    for (let y = Math.floor(cy - rad); y <= Math.ceil(cy + rad); y++) for (let x = Math.floor(cx - rad); x <= Math.ceil(cx + rad); x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 > rad * rad) continue;
      const j = (y * W + x) * 4;
      if (delta) { const d = dark ? -delta : delta; data[j] += d; data[j + 1] += d; data[j + 2] += d; }
      else { const v = dark ? 18 : 238; data[j] = v; data[j + 1] = v; data[j + 2] = v; }
    }
  }
  return blobs;
}

function job(cur, refs, params, extra = {}) {
  return Object.assign({ width: W, height: H, cur, refs, params, frameIndex: 5 }, extra);
}

function blobError(out, clean, blobs) {
  let err = 0, n = 0;
  for (const b of blobs) for (let y = Math.floor(b.cy - b.rad); y <= Math.ceil(b.cy + b.rad); y++) for (let x = Math.floor(b.cx - b.rad); x <= Math.ceil(b.cx + b.rad); x++) {
    if ((x - b.cx) ** 2 + (y - b.cy) ** 2 > b.rad * b.rad) continue;
    const j = (y * W + x) * 4; err += Math.abs(out[j + 1] - clean[j + 1]); n++;
  }
  return err / n;
}

function hit(comps, b) {
  return comps.some((c) => !c.rejected && b.cx >= c.x - 2 && b.cx <= c.x + c.w + 2 && b.cy >= c.y - 2 && b.cy <= c.y + c.h + 2);
}

const pan = (f) => [f * 3, f * 1.5 | 0];
const prev = scene(...pan(4), 4), next = scene(...pan(6), 6), clean = scene(...pan(5), 5);

test('motion-compensated temporal detection finds dust on a panning shot without false alarms', () => {
  const cur = new Uint8ClampedArray(clean);
  const blobs = addBlobs(cur, 25, 7);
  const r = run(job(cur, [prev, next], { dust: 55, denoise: 0, maxSize: 32 }));
  const found = blobs.filter((b) => hit(r.components, b)).length;
  const falseAlarms = r.components.filter((c) => !blobs.some((b) => b.cx >= c.x - 2 && b.cx <= c.x + c.w + 2 && b.cy >= c.y - 2 && b.cy <= c.y + c.h + 2)).length;
  assert.equal(r.stats.mode, 'temporal');
  assert.ok(found >= 23, `recall ${found}/25`);
  assert.ok(falseAlarms <= 2, `false alarms ${falseAlarms}`);
  const before = blobError(cur, clean, blobs), after = blobError(r.data, clean, blobs);
  assert.ok(after < before * 0.2, `blob error ${before.toFixed(1)} -> ${after.toFixed(1)}`);
});

test('motion compensation is what makes subtle dust detectable on fast camera moves', () => {
  const fast = (f) => [f * 9, f * 4];
  const p = scene(...fast(4), 4), q = scene(...fast(6), 6), cur = scene(...fast(5), 5);
  const blobs = addBlobs(cur, 25, 7, 2, 4, 55);
  const withMc = run(job(cur, [p, q], { dust: 55, denoise: 0 }));
  const noMc = run(job(cur, [p, q], { dust: 55, denoise: 0, motion: false }));
  const recall = (r) => blobs.filter((b) => hit(r.components, b)).length;
  assert.ok(withMc.stats.motionConfidence > 0.8, `confidence ${withMc.stats.motionConfidence}`);
  assert.ok(Math.abs(withMc.stats.meanMotion - Math.hypot(9, 4)) < 1.5, `motion ${withMc.stats.meanMotion}`);
  assert.ok(recall(withMc) >= 22, `recall with MC ${recall(withMc)}`);
  assert.ok(recall(withMc) > recall(noMc) + 8, `recall with MC ${recall(withMc)} vs without ${recall(noMc)}`);
});

test('dust is still found on a flickering frame', () => {
  const cur = scene(...pan(5), 5, { gain: 1.2 });
  const blobs = addBlobs(cur, 20, 31);
  const r = run(job(cur, [prev, next], { dust: 55, denoise: 0 }));
  assert.ok(r.stats.motionConfidence > 0.8, `confidence ${r.stats.motionConfidence}`);
  assert.ok(blobs.filter((b) => hit(r.components, b)).length >= 18);
  assert.ok(r.components.length <= 22, `components ${r.components.length}`);
});

test('clean, static footage is left essentially untouched', () => {
  const a = scene(0, 0, 1), b = scene(0, 0, 2), c = scene(0, 0, 3);
  const r = run(job(b, [a, c], { dust: 60, denoise: 0 }));
  let diff = 0;
  for (let i = 0; i < b.length; i += 4) diff += Math.abs(r.data[i + 1] - b[i + 1]);
  assert.ok(diff / (W * H) < 0.15, `mean change ${diff / (W * H)}`);
});

test('global flicker does not trigger dust detection, and deflicker corrects it', () => {
  const bright = scene(...pan(5), 5, { gain: 1.25 });
  const r = run(job(bright, [prev, next], { dust: 55, denoise: 0, deflicker: 100 }));
  assert.ok(r.components.length <= 3, `components ${r.components.length}`);
  const mean = (d) => { let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i + 1]; return s / (W * H); };
  assert.ok(Math.abs(mean(r.data) - mean(clean)) < Math.abs(mean(bright) - mean(clean)) * 0.25, `means ${mean(bright)} -> ${mean(r.data)} target ${mean(clean)}`);
  assert.ok(r.stats.flicker > 5);
});

test('review rejections and protect mask keep a defect untouched', () => {
  const cur = new Uint8ClampedArray(clean);
  const blobs = addBlobs(cur, 6, 11, 2.5, 3.5);
  const b0 = blobs[0], b1 = blobs[1];
  const protect = new Uint8Array(W * H);
  for (let y = Math.floor(b1.cy) - 6; y <= Math.floor(b1.cy) + 6; y++) for (let x = Math.floor(b1.cx) - 6; x <= Math.floor(b1.cx) + 6; x++) protect[y * W + x] = 1;
  const r = run(job(cur, [prev, next], { dust: 55, denoise: 0 }, { reject: [{ x: b0.cx, y: b0.cy }], protect }));
  const j0 = (Math.round(b0.cy) * W + Math.round(b0.cx)) * 4, j1 = (Math.round(b1.cy) * W + Math.round(b1.cx)) * 4;
  assert.equal(r.data[j0 + 1], cur[j0 + 1], 'rejected defect must be preserved');
  assert.equal(r.data[j1 + 1], cur[j1 + 1], 'protected defect must be preserved');
  assert.equal(r.stats.rejected, 1);
  assert.ok(r.components.some((c) => c.rejected));
});

test('spatial detection and inpainting clean a still image', () => {
  const cur = scene(0, 0, 9, { grain: 2 });
  const ref = new Uint8ClampedArray(cur);
  const blobs = addBlobs(cur, 15, 21, 1.5, 3);
  const r = run(job(cur, [], { dust: 60, denoise: 0, maxSize: 16 }));
  assert.equal(r.stats.mode, 'spatial');
  const found = blobs.filter((b) => hit(r.components, b)).length;
  assert.ok(found >= 12, `recall ${found}/15`);
  assert.ok(r.components.length <= found + 4, `components ${r.components.length}`);
  assert.ok(blobError(r.data, ref, blobs) < blobError(cur, ref, blobs) * 0.3);
});

test('manual heal mask is repaired temporally', () => {
  const cur = new Uint8ClampedArray(clean);
  const force = new Uint8Array(W * H);
  for (let y = 60; y < 90; y++) for (let x = 100; x < 140; x++) { force[y * W + x] = 1; const j = (y * W + x) * 4; cur[j] = cur[j + 1] = cur[j + 2] = 0; }
  const r = run(job(cur, [prev, next], { dust: 0, denoise: 0, grainMatch: false }, { force }));
  let err = 0;
  for (let y = 60; y < 90; y++) for (let x = 100; x < 140; x++) { const j = (y * W + x) * 4; err += Math.abs(r.data[j + 1] - clean[j + 1]); }
  assert.ok(err / 1200 < 5, `heal error ${err / 1200}`); // grain-level residual; the hole started ~110 levels off
  assert.equal(r.stats.healedPixels, 1200);
});

test('scratch tracker finds and repairs a vertical line scratch', () => {
  const cur = new Uint8ClampedArray(clean);
  for (let y = 0; y < H; y++) { const x0 = 140 + Math.round(Math.sin(y / 40)); for (let x = x0; x < x0 + 2; x++) { const j = (y * W + x) * 4; cur[j] = cur[j + 1] = cur[j + 2] = 245; } }
  const r = run(job(cur, [], { dust: 0, denoise: 0, scratch: 60, scratchWidth: 3, grainMatch: false }));
  assert.equal(r.scratches.length, 1, JSON.stringify(r.scratches.map((s) => s.x)));
  assert.ok(Math.abs(r.scratches[0].x - 140.5) <= 2);
  let before = 0, after = 0;
  for (let y = 0; y < H; y++) for (let x = 139; x < 143; x++) { const j = (y * W + x) * 4; before += Math.abs(cur[j + 1] - clean[j + 1]); after += Math.abs(r.data[j + 1] - clean[j + 1]); }
  assert.ok(after < before * 0.25, `scratch error ${before} -> ${after}`);
  const none = run(job(clean, [], { dust: 0, denoise: 0, scratch: 60 }));
  assert.equal(none.scratches.length, 0, 'no scratches on clean texture');
});

test('scene cut score separates cuts from motion', () => {
  const n = W * H;
  const other = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < n; i++) { const v = 30 + (i % 50); other[i * 4] = other[i * 4 + 1] = other[i * 4 + 2] = v; other[i * 4 + 3] = 255; }
  const same = E.cutScore(E.histogram64(prev, n), E.histogram64(next, n));
  const cut = E.cutScore(E.histogram64(prev, n), E.histogram64(other, n));
  assert.ok(same < 0.1, `same-shot score ${same}`);
  assert.ok(cut > 0.4, `cut score ${cut}`);
});

test('temporal denoise reduces grain without blurring structure', () => {
  const noisyCur = scene(...pan(5), 5, { grain: 8 }), smooth = scene(...pan(5), 5, { grain: 0 });
  const p = scene(...pan(4), 4, { grain: 8 }), q = scene(...pan(6), 6, { grain: 8 });
  const r = run(job(noisyCur, [p, q], { dust: 0, denoise: 50 }));
  const err = (d) => { let s = 0; for (let i = 0; i < d.length; i += 4) s += Math.abs(d[i + 1] - smooth[i + 1]); return s / (W * H); };
  assert.ok(err(r.data) < err(noisyCur) * 0.8, `noise ${err(noisyCur)} -> ${err(r.data)}`);
});

test('grade, sharpen and grain behave and stay deterministic', () => {
  const lut = E.toneLUT(25, 0);
  assert.ok(lut[128] > 160 && lut[0] === 0, 'one stop up brightens midtones');
  const a = run(job(clean, [], { dust: 0, denoise: 0, sharpen: 40, grain: 10 }));
  const b = run(job(clean, [], { dust: 0, denoise: 0, sharpen: 40, grain: 10 }));
  assert.deepEqual(a.data, b.data);
  const flat = new Uint8ClampedArray(W * H * 4).fill(128);
  const s = run(job(flat, [], { dust: 0, denoise: 0, sharpen: 100 }));
  assert.ok(s.data.every((v, i) => (i % 4 === 3 ? v === 255 : v === 128)), 'sharpen must not change flat areas');
});

test('box blur, morphology and labelling primitives are correct', () => {
  const w = 9, h = 7, src = new Float32Array(w * h);
  src[3 * w + 4] = 90;
  const b = E.boxBlur(src, w, h, 1);
  assert.ok(Math.abs(b[3 * w + 4] - 10) < 1e-4 && Math.abs(b[2 * w + 3] - 10) < 1e-4 && b[0] === 0);
  const mx = E.morph(src, w, h, 1, true);
  assert.equal(mx[2 * w + 5], 90); assert.equal(mx[1 * w + 4], 0);
  const mask = new Uint8Array(w * h); mask[0] = mask[1] = mask[w * h - 1] = 1;
  const { comps } = E.labelComponents(mask, w, h);
  assert.equal(comps.length, 2); assert.equal(comps[0].area, 2);
});

// ---------------------------------------------------------------- 3.1 upgrades

/** Scene sampled through a rotation + zoom about the frame centre. */
function rotatedScene(angleDeg, zoom, frame, grain = 4) {
  const data = new Uint8ClampedArray(W * H * 4), r = rand(500 + frame), a = (angleDeg * Math.PI) / 180;
  const cx = W / 2, cy = H / 2, ca = Math.cos(a) / zoom, sa = Math.sin(a) / zoom;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = cx + (x - cx) * ca - (y - cy) * sa, v = cy + (x - cx) * sa + (y - cy) * ca;
    const base = 110 + 45 * Math.sin(u / 13) * Math.cos(v / 17) + 30 * Math.sin((u + 2 * v) / 29) + 20 * Math.sin(u / 5.3 + Math.cos(v / 7));
    const l = base + (r() + r() + r() - 1.5) * grain, j = (y * W + x) * 4;
    data[j] = l; data[j + 1] = l; data[j + 2] = l; data[j + 3] = 255;
  }
  return data;
}

test('dense optical flow registers rotation and zoom far better than rigid blocks', () => {
  const cur = rotatedScene(0, 1, 1, 0), ref = rotatedScene(2.5, 1.03, 2, 0), n = W * H; // grain-free: measure registration, not noise
  const Lc = E.lumaOf(cur, n), Lr = E.lumaOf(ref, n);
  const field = E.estimateMotion(Lc, Lr, W, H, 24);
  const block = E.interpolateField(field, W, H);
  const dense = E.denseFlow(Lc, Lr, W, H, block);
  const err = (f) => E.registrationError(Lc, E.warpPlane(Lr, f.fx, f.fy, W, H, new Float32Array(n)), W, H, 12);
  const eBlock = err(block), eDense = err(dense);
  assert.ok(eDense < eBlock * 0.7, `registration error block ${eBlock.toFixed(2)} vs dense ${eDense.toFixed(2)}`);
  assert.ok(eDense < 1.5, `dense error ${eDense.toFixed(2)} should be near zero on clean frames`);
});

test('dense flow cuts false alarms on a rotating, zooming shot', () => {
  const prevR = rotatedScene(-2, 0.98, 3), curR = rotatedScene(0, 1, 4), nextR = rotatedScene(2, 1.02, 5);
  const blocky = run(job(curR, [prevR, nextR], { dust: 60, denoise: 0, flow: 'block' }));
  const dense = run(job(curR, [prevR, nextR], { dust: 60, denoise: 0, flow: 'dense' }));
  assert.ok(dense.stats.registration.dense < dense.stats.registration.block, JSON.stringify(dense.stats.registration));
  assert.ok(dense.stats.repairedPixels <= blocky.stats.repairedPixels, `false repairs dense ${dense.stats.repairedPixels} vs block ${blocky.stats.repairedPixels}`);
  assert.ok(dense.components.length <= 3, `dense false alarms ${dense.components.length}`);
});

test('PatchMatch synthesises texture in a large hole far better than diffusion', () => {
  const w = 160, h = 120, img = new Uint16Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = ((x + y) % 12 < 6 ? 200 : 60) * 257, j = (y * w + x) * 4;
    img[j] = img[j + 1] = img[j + 2] = v; img[j + 3] = 65535;
  }
  const mask = new Uint8Array(w * h);
  for (let y = 45; y < 75; y++) for (let x = 60; x < 95; x++) mask[y * w + x] = 1;
  const holeErr = (a) => { let e = 0, c = 0; for (let i = 0; i < mask.length; i++) if (mask[i]) { e += Math.abs(a[i * 4] - img[i * 4]) / 257; c++; } return e / c; };
  const diff = new Uint16Array(img); for (let i = 0; i < mask.length; i++) if (mask[i]) diff[i * 4] = diff[i * 4 + 1] = diff[i * 4 + 2] = 0;
  const pm = new Uint16Array(diff);
  E.inpaint(diff, mask, w, h, false, 1);
  const filled = E.inpaintPatch(pm, mask, w, h, 1);
  assert.equal(filled, 35 * 30);
  const eDiff = holeErr(diff), ePM = holeErr(pm);
  assert.ok(ePM < eDiff * 0.35, `hole error diffusion ${eDiff.toFixed(1)} vs PatchMatch ${ePM.toFixed(1)}`);
});

test('inpaintSmart routes specks to the fast fill and holes to PatchMatch', () => {
  const cur = scene(0, 0, 3, { grain: 2 }), img = E.toU16(cur), mask = new Uint8Array(W * H);
  mask[50 * W + 50] = 1; mask[50 * W + 51] = 1;
  for (let y = 80; y < 100; y++) for (let x = 120; x < 140; x++) mask[y * W + x] = 1;
  const before = new Uint16Array(img);
  for (let i = 0; i < mask.length; i++) if (mask[i]) img[i * 4] = img[i * 4 + 1] = img[i * 4 + 2] = 0;
  assert.equal(E.inpaintSmart(img, mask, W, H, true, 5), 402);
  let e = 0; for (let i = 0; i < mask.length; i++) if (mask[i]) e += Math.abs(img[i * 4 + 1] - before[i * 4 + 1]) / 257;
  assert.ok(e / 402 < 25, `mean hole error ${(e / 402).toFixed(1)}`);
});

test('16-bit pipeline preserves gradations an 8-bit pipeline would band', () => {
  const w = 1024, h = 4, img = new Uint16Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const j = (y * w + x) * 4, v = 20000 + x * 4; img[j] = img[j + 1] = img[j + 2] = v; img[j + 3] = 65535; }
  const r = E.process({ width: w, height: h, cur: img, refs: [], params: { dust: 0, denoise: 0, exposure: 20, contrast: 25 } });
  assert.ok(r.data instanceof Uint16Array);
  const levels = new Set(); for (let x = 0; x < w; x++) levels.add(r.data[(w + x) * 4]);
  assert.ok(levels.size > 900, `distinct output levels ${levels.size}`);
  let mono = true; for (let x = 1; x < w; x++) if (r.data[(w + x) * 4] < r.data[(w + x - 1) * 4]) mono = false;
  assert.ok(mono, 'graded ramp stays monotonic');
  assert.equal(E.to8(new Uint16Array([65535, 0, 32896, 257]))[2], 128);
});

// ---------------------------------------------------------------- 3.2 high-end tools

/** Frame sampled from the textured scene through a similarity transform about the centre. */
function shaken(tx, ty, angleDeg, scale, frame, grain = 2) {
  const data = new Uint16Array(W * H * 4), r = rand(900 + frame), a = (angleDeg * Math.PI) / 180, cx = (W - 1) / 2, cy = (H - 1) / 2;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const dx = x - cx, dy = y - cy;
    const u = cx + scale * (Math.cos(a) * dx - Math.sin(a) * dy) + tx, v = cy + scale * (Math.sin(a) * dx + Math.cos(a) * dy) + ty;
    const base = 110 + 45 * Math.sin(u / 13) * Math.cos(v / 17) + 30 * Math.sin((u + 2 * v) / 29) + 20 * Math.sin(u / 5.3 + Math.cos(v / 7));
    const l = (base + (r() + r() + r() - 1.5) * grain) * 257, j = (y * W + x) * 4;
    data[j] = data[j + 1] = data[j + 2] = Math.max(0, Math.min(65535, l)); data[j + 3] = 65535;
  }
  return data;
}

test('motion-compensated interpolation rebuilds a destroyed frame far better than blending', () => {
  const fast = (f) => [f * 8, f * 3]; // fast, grain-free pan: blending ghosts badly here
  const a = E.toU16(scene(...fast(4), 4, { grain: 0 })), b = E.toU16(scene(...fast(6), 6, { grain: 0 })), truth = scene(...fast(5), 5, { grain: 0 });
  const mid = E.to8(E.interpolateFrame(a, b, W, H, {}));
  const blend = new Uint8ClampedArray(truth.length);
  for (let i = 0; i < blend.length; i++) blend[i] = (a[i] + b[i]) / 2 / 257;
  const err = (d) => { let e = 0, c = 0; for (let y = 10; y < H - 10; y++) for (let x = 10; x < W - 10; x++) { const j = (y * W + x) * 4 + 1; e += Math.abs(d[j] - truth[j]); c++; } return e / c; };
  assert.ok(err(mid) < 4, `interpolation error ${err(mid).toFixed(2)}`);
  assert.ok(err(mid) < err(blend) * 0.35, `interpolation ${err(mid).toFixed(2)} vs blend ${err(blend).toFixed(2)}`);
  // through the pipeline: a replaced frame ignores its own (destroyed) pixels
  const burnt = new Uint16Array(W * H * 4).fill(65535);
  const r = run(job(burnt, [a, b], { dust: 0, denoise: 0 }, { replace: true }));
  assert.ok(err(r.data) < 4, `replaced frame error ${err(r.data).toFixed(2)}`);
});

test('global motion recovers shift, rotation and zoom between frames', () => {
  const n = W * H, ref = E.lumaOf(shaken(0, 0, 0, 1, 1), n), cur = E.lumaOf(shaken(3.4, -2.2, 0.8, 1.01, 2), n);
  const g = E.globalMotion(cur, ref, W, H, 24);
  assert.ok(Math.abs(g.tx - 3.4) < 0.3 && Math.abs(g.ty + 2.2) < 0.3, `translation ${g.tx.toFixed(2)}, ${g.ty.toFixed(2)}`);
  assert.ok(Math.abs((g.angle * 180) / Math.PI - 0.8) < 0.1, `angle ${((g.angle * 180) / Math.PI).toFixed(3)}°`);
  assert.ok(Math.abs(g.scale - 1.01) < 0.004, `scale ${g.scale.toFixed(4)}`);
});

test('stabilisation removes gate weave while lock mode holds the shot', () => {
  const N = 12, jit = [], n = W * H;
  const rr = rand(77);
  for (let f = 0; f < N; f++) jit.push([(rr() - 0.5) * 6, (rr() - 0.5) * 6, (rr() - 0.5) * 0.6]);
  const frames = jit.map(([tx, ty, ang], f) => shaken(tx, ty, ang, 1, f));
  const motions = frames.map((fr, f) => (f ? E.globalMotion(E.lumaOf(fr, n), E.lumaOf(frames[f - 1], n), W, H, 24) : null));
  const plan = E.stabilizationPlan(motions, new Set(), { mode: 'lock', strength: 1 });
  const out = frames.map((fr, f) => E.lumaOf(E.transformRGBA(fr, W, H, plan[f]), n));
  let before = 0, after = 0;
  for (let f = 1; f < N; f++) {
    const m0 = E.globalMotion(E.lumaOf(frames[f], n), E.lumaOf(frames[f - 1], n), W, H, 24), m1 = E.globalMotion(out[f], out[f - 1], W, H, 24);
    before += Math.hypot(m0.tx, m0.ty); after += Math.hypot(m1.tx, m1.ty);
  }
  assert.ok(after / (N - 1) < 0.35, `residual weave ${(after / (N - 1)).toFixed(2)} px/frame (was ${(before / (N - 1)).toFixed(2)})`);
  const cutPlan = E.stabilizationPlan(motions, new Set([6]), { mode: 'lock' });
  assert.equal(cutPlan.length, N);
});

test('infrared dirt channel removes dirt that is nearly invisible in RGB', () => {
  const cur = E.toU16(scene(...pan(5), 5)), clean = new Uint16Array(cur);
  for (let y = 70; y < 76; y++) for (let x = 120; x < 126; x++) { const j = (y * W + x) * 4; cur[j] -= 6 * 257; cur[j + 1] -= 6 * 257; cur[j + 2] -= 6 * 257; }
  for (let i = 0; i < W * H; i++) cur[i * 4 + 3] = 60000;
  for (let y = 70; y < 76; y++) for (let x = 120; x < 126; x++) cur[(y * W + x) * 4 + 3] = 9000;
  const prevU = E.toU16(prev), nextU = E.toU16(next);
  const off = run(job(cur, [prevU, nextU], { dust: 50, denoise: 0, grainMatch: false }));
  const on = run(job(cur, [prevU, nextU], { dust: 50, denoise: 0, irClean: 50, grainMatch: false }));
  assert.ok(on.stats.irPixels >= 36 && on.stats.irPixels < 120, `IR pixels ${on.stats.irPixels}`);
  const err = (d) => { let e = 0; for (let y = 70; y < 76; y++) for (let x = 120; x < 126; x++) e += Math.abs(d[(y * W + x) * 4 + 1] - clean[(y * W + x) * 4 + 1] / 257); return e / 36; };
  assert.ok(err(on.data) < err(off.data) * 0.6, `IR repair error ${err(on.data).toFixed(2)} vs ${err(off.data).toFixed(2)}`);
  assert.equal(on.data16[3], 65535, 'IR never leaks into output alpha');
});

test('Click&Fix finds a faint defect the automatic pass missed', () => {
  const cur = new Uint8ClampedArray(clean);
  for (let y = 98; y <= 102; y++) for (let x = 58; x <= 62; x++) { const j = (y * W + x) * 4; cur[j] -= 20; cur[j + 1] -= 20; cur[j + 2] -= 20; }
  const an = E.analyze(job(cur, [prev, next], { dust: 30 }));
  const auto = E.render(job(cur, [prev, next], { dust: 30, denoise: 0 }), an);
  assert.ok(!auto.components.some((c) => c.x <= 60 && c.x + c.w >= 60 && c.y <= 100 && c.y + c.h >= 100), 'automatic pass leaves the faint spot');
  const idx = E.localDetect(an, 60, 100, 9);
  const hits = [...idx].filter((i) => { const x = i % W, y = (i / W) | 0; return x >= 58 && x <= 62 && y >= 98 && y <= 102; }).length;
  assert.ok(hits >= 20, `covered ${hits}/25 defect pixels`);
  assert.ok(idx.length < 120, `stayed local: ${idx.length} of 254 brush pixels`);
});

// ---------------------------------------------------------------- 3.3 colour, assessment, keyframes

/** Colourful scene: the three records share edges but have different densities, like real dye layers. */
function colourScene(shift) {
  const sh = shift || {}, data = new Uint16Array(W * H * 4);
  const f = (u, v) => 0.5 + 0.3 * Math.sin(u / 11) * Math.cos(v / 13) + 0.15 * Math.sin((u + v) / 7);
  const at = (c, x, y) => { const t = sh[c] || { tx: 0, ty: 0, angle: 0 }, a = t.angle || 0, cx = W / 2, cy = H / 2, dx = x - cx, dy = y - cy; return [cx + Math.cos(a) * dx - Math.sin(a) * dy + t.tx, cy + Math.sin(a) * dx + Math.cos(a) * dy + t.ty]; };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const j = (y * W + x) * 4, [ru, rv] = at('r', x, y), [gu, gv] = at('g', x, y), [bu, bv] = at('b', x, y);
    data[j] = Math.min(65535, f(ru, rv) * 52000 + 4000); data[j + 1] = Math.min(65535, f(gu, gv) * 40000 + 9000); data[j + 2] = Math.min(65535, (1 - f(bu, bv)) * 30000 + 15000); data[j + 3] = 65535;
  }
  return data;
}

test('colour-separation registration aligns misregistered red and blue records', () => {
  const truth = colourScene(), bad = colourScene({ r: { tx: 1.6, ty: -0.9 }, b: { tx: -1.2, ty: 0.7, angle: 0.004 } });
  const al = E.estimateChannelAlignment(bad, W, H);
  // the transform reported for a channel undoes its misregistration
  assert.ok(Math.abs(al.r.tx + 1.6) < 0.3 && Math.abs(al.r.ty - 0.9) < 0.3, `red ${al.r.tx.toFixed(2)}, ${al.r.ty.toFixed(2)}`);
  assert.ok(Math.abs(al.b.tx - 1.2) < 0.3 && Math.abs(al.b.ty + 0.7) < 0.3, `blue ${al.b.tx.toFixed(2)}, ${al.b.ty.toFixed(2)}`);
  const fixed = E.alignChannels(bad, W, H, al);
  const err = (d, c) => { let e = 0, k = 0; for (let y = 12; y < H - 12; y++) for (let x = 12; x < W - 12; x++) { const j = (y * W + x) * 4 + c; e += Math.abs(d[j] - truth[j]) / 257; k++; } return e / k; };
  for (const c of [0, 2]) assert.ok(err(fixed, c) < err(bad, c) * 0.3, `channel ${c}: ${err(bad, c).toFixed(2)} -> ${err(fixed, c).toFixed(2)}`);
});

test('fade restoration recovers the dye range and removes the colour cast', () => {
  const orig = colourScene(), faded = new Uint16Array(orig);
  for (let j = 0; j < faded.length; j += 4) {
    const r = orig[j] / 65535, g = orig[j + 1] / 65535, b = orig[j + 2] / 65535;
    faded[j] = (0.25 + 0.7 * r) * 65535; faded[j + 1] = (0.08 + 0.5 * Math.pow(g, 1.3)) * 65535; faded[j + 2] = (0.12 + 0.55 * b) * 65535;
  }
  const lv = E.fadeLevels(E.channelHistograms(faded, W * H, 1)), fixed = new Uint16Array(faded);
  E.applyLevels(fixed, W * H, lv, 1);
  const lv0 = E.fadeLevels(E.channelHistograms(orig, W * H, 1)), ref = new Uint16Array(orig);
  E.applyLevels(ref, W * H, lv0, 1); // the same normalisation applied to the unfaded print is the target
  const err = (d) => { let e = 0; for (let j = 0; j < d.length; j += 4) for (let c = 0; c < 3; c++) e += Math.abs(d[j + c] - ref[j + c]) / 257; return e / (W * H * 3); };
  assert.ok(err(fixed) < err(faded) * 0.25, `fade error ${err(faded).toFixed(1)} -> ${err(fixed).toFixed(1)}`);
  const r = E.process({ width: W, height: H, cur: faded, refs: [], params: { dust: 0, denoise: 0, fade: 100 } });
  assert.ok(r.stats.fade && r.stats.fade.gamma.length === 3);
});

test('damaged-frame detection flags a burnt frame but not cuts or flicker', () => {
  const sw = 96, sh = 60, N = 12, smalls = [], shifts = [];
  const scn = (f, other) => { const L = new Float32Array(sw * sh); for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) { const u = x + f * 1.5; L[y * sw + x] = other ? 60 + 40 * Math.cos(x / 3) * Math.sin(y / 4) : 110 + 40 * Math.sin(u / 6) * Math.cos(y / 7); } return L; };
  for (let f = 0; f < N; f++) {
    let L = scn(f, f >= 8);
    if (f === 4) { L = L.map((v, i) => (((i % sw) - 40) ** 2 + (((i / sw) | 0) - 30) ** 2 < 200 ? 250 : v)); } // burn
    if (f === 6) L = L.map((v) => v * 1.4); // flash (flicker)
    smalls.push(L);
    shifts.push(f ? { tx: 1.5, ty: 0 } : null);
  }
  const res = E.frameOutliers(smalls, sw, sh, shifts, new Set([8]));
  assert.deepEqual(res.suspects, [4], `scores ${Array.from(res.scores, (v) => v.toFixed(1)).join(' ')}`);
});

test('keyframes interpolate linearly or smoothly and hold non-numeric values', () => {
  const keys = [{ frame: 0, params: { dust: 20, spatial: 'auto' } }, { frame: 10, params: { dust: 60, spatial: 'on' } }, { frame: 20, params: { dust: 30, spatial: 'off' } }];
  assert.equal(E.interpolateKeyframes(keys, 5, 'linear').dust, 40);
  assert.equal(E.interpolateKeyframes(keys, 5, 'linear').spatial, 'auto');
  assert.equal(E.interpolateKeyframes(keys, 25, 'linear').dust, 30);
  for (let i = 0; i <= 20; i++) { const v = E.interpolateKeyframes(keys, i, 'smooth').dust; assert.ok(v >= 20 && v <= 60, `frame ${i}: ${v}`); }
  const s5 = E.interpolateKeyframes(keys, 5, 'smooth').dust;
  assert.ok(s5 > 20 && s5 < 60);
  assert.equal(E.interpolateKeyframes(keys, 10, 'smooth').dust, 60);
});

// ---------------------------------------------------------------- 3.5 persistent defects
test('persistent defects (gate hair, subtitles) are filled from frames the camera revealed', () => {
  const N = 9, n = W * H, frames = [], clean = [];
  const mask = new Uint8Array(n);
  for (let y = 40; y < 120; y++) { const x = Math.round(70 + 10 * Math.sin(y / 12)); for (let d = -1; d <= 1; d++) mask[y * W + x + d] = 1; } // hair
  for (let y = 130; y < 146; y++) for (let x = 90; x < 170; x++) mask[y * W + x] = 1; // subtitle bar
  for (let f = 0; f < N; f++) {
    const c = E.toU16(scene(f * 4, f * 2, f)), d = new Uint16Array(c);
    for (let i = 0; i < n; i++) if (mask[i]) { d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = 6000; }
    clean.push(c); frames.push(d);
  }
  const motions = frames.map((fr, f) => (f ? E.globalMotion(E.lumaOf(fr, n), E.lumaOf(frames[f - 1], n), W, H, 24) : null));
  const path = E.motionPath(motions, 0, N - 1), i = 4;
  const order = [3, 5, 2, 6, 1, 7, 0, 8];
  const sources = order.map((j) => ({ rgba: frames[j], t: E.relativeTransform(path[i], path[j]) }));
  const r = E.fillFromFrames(frames[i], W, H, mask, sources);
  let total = 0, err = 0, revealed = 0, left = 0;
  for (let k = 0; k < n; k++) if (mask[k]) { total++; if (r.remaining[k]) { left++; continue; } revealed++; err += Math.abs(r.rgba[k * 4 + 1] - clean[i][k * 4 + 1]) / 257; }
  // the camera moves at most 16 px across, 8 px down: the hair is fully revealed, the middle of the
  // 16 px subtitle bar can never be, and must be handed back for synthesis
  assert.ok(r.filled > total * 0.85, `filled ${r.filled}/${total}`);
  assert.equal(left, total - r.filled);
  assert.ok(err / revealed < 4, `mean error in the revealed region ${(err / revealed).toFixed(2)}`);
  // a static camera reveals nothing: everything is left for texture synthesis
  const still = E.fillFromFrames(frames[i], W, H, mask, [{ rgba: frames[i], t: { tx: 0, ty: 0, angle: 0, logScale: 0 } }]);
  assert.equal(still.filled, 0);
  const job2 = { width: W, height: H, cur: frames[i], refs: [], params: { dust: 0, denoise: 0 }, inpaint: mask };
  const syn = E.process(job2);
  let synErr = 0; for (let k = 0; k < n; k++) if (mask[k]) synErr += Math.abs(syn.data[k * 4 + 1] - clean[i][k * 4 + 1]) / 257;
  assert.ok(synErr / total < 25, `texture-synthesis fallback error ${(synErr / total).toFixed(1)}`);
});

// ---------------------------------------------------------------- 3.6 colourisation
test('colourisation floods regions from sparse hints and stops at edges, keeping luminance', () => {
  const w = 160, h = 120, n = w * h, rgba = new Uint16Array(n * 4), truthU = new Float32Array(n), truthV = new Float32Array(n);
  const inDisc = (x, y) => (x - 55) ** 2 + (y - 60) ** 2 < 30 ** 2;
  const red = [0.75, 0.2, 0.15], blue = [0.25, 0.4, 0.8];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = inDisc(x, y) ? red : blue, tex = 0.03 * Math.sin(x / 3) * Math.cos(y / 4);
    const yv = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] + tex, i = y * w + x;
    rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = yv * 65535; rgba[i * 4 + 3] = 65535; // grey print
    [truthU[i], truthV[i]] = E.rgbToChroma(...c);
  }
  const hints = { u: new Float32Array(n), v: new Float32Array(n), m: new Uint8Array(n) };
  const scribble = (x0, y0, len, c) => { const [u, v] = E.rgbToChroma(...c); for (let k = 0; k < len; k++) { const i = (y0 + (k % 3)) * w + x0 + k; hints.u[i] = u; hints.v[i] = v; hints.m[i] = 1; } };
  scribble(45, 58, 20, red); scribble(110, 30, 30, blue); scribble(100, 100, 30, blue);
  const lumaBefore = E.lumaOf(rgba, n);
  E.colorizeFrame(rgba, w, h, hints, 1);
  let err = 0, cnt = 0, lumaErr = 0;
  const lumaAfter = E.lumaOf(rgba, n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, edge = Math.abs(Math.hypot(x - 55, y - 60) - 30) < 3;
    const [u, v] = E.rgbToChroma(rgba[i * 4] / 65535, rgba[i * 4 + 1] / 65535, rgba[i * 4 + 2] / 65535);
    if (!edge) { err += Math.hypot(u - truthU[i], v - truthV[i]); cnt++; }
    lumaErr += Math.abs(lumaAfter[i] - lumaBefore[i]);
  }
  const ru = E.rgbToChroma(...red), bu = E.rgbToChroma(...blue), span = Math.hypot(ru[0] - bu[0], ru[1] - bu[1]);
  assert.ok(err / cnt < span * 0.08, `chroma error ${(err / cnt).toFixed(4)} vs red/blue separation ${span.toFixed(3)}`);
  assert.ok(lumaErr / n < 0.6, `luminance preserved (mean change ${(lumaErr / n).toFixed(2)} of 255)`);
});

// ---------------------------------------------------------------- 3.7 local dewarp
test('local separation dewarp fixes non-uniform record warping that a global fit cannot', () => {
  const warp = (x, y) => ({ tx: 1.6 * Math.sin((2 * Math.PI * x) / W), ty: 1.2 * Math.cos((2 * Math.PI * y) / H), angle: 0 });
  const truth = colourScene(), bad = new Uint16Array(truth);
  const f = (u, v) => 0.5 + 0.3 * Math.sin(u / 11) * Math.cos(v / 13) + 0.15 * Math.sin((u + v) / 7);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const d = warp(x, y); bad[(y * W + x) * 4] = Math.min(65535, f(x + d.tx, y + d.ty) * 52000 + 4000); }
  const err = (d) => { let e = 0, k = 0; for (let y = 12; y < H - 12; y++) for (let x = 12; x < W - 12; x++) { const j = (y * W + x) * 4; e += Math.abs(d[j] - truth[j]) / 257; k++; } return e / k; };
  const globalOnly = E.alignChannels(bad, W, H, E.estimateChannelAlignment(bad, W, H, false));
  const local = E.alignChannels(bad, W, H, E.estimateChannelAlignment(bad, W, H, true));
  console.log(`  dewarp: warp error ${err(bad).toFixed(2)} -> global ${err(globalOnly).toFixed(2)} -> local ${err(local).toFixed(2)}`);
  assert.ok(err(local) < err(bad) * 0.45 && err(local) < err(globalOnly) * 0.55, `warp error ${err(bad).toFixed(2)} -> global ${err(globalOnly).toFixed(2)} -> local ${err(local).toFixed(2)}`);
});
