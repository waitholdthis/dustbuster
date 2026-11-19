/*
 * FrameRestore Studio restoration engine.
 *
 * Pure, dependency-free image processing that runs unchanged in a Web Worker,
 * on the main thread, or under Node for testing. Images are 16-bit RGBA
 * (Uint16Array, 0..65535; 8-bit input is promoted automatically). Analysis
 * planes are Float32Array luma on a 0..255 scale so thresholds read in
 * familiar 8-bit units while pixel math keeps full 16-bit precision.
 *
 * Pipeline per frame:
 *   analyze  : luma, hierarchical block motion estimation against up to two
 *              reference frames, refined to dense per-pixel optical flow
 *              (robust iterative Lucas-Kanade), motion-compensated warps, local
 *              brightness statistics. Expensive and cached by the caller.
 *   render   : temporal (or spatial) dust detection with hysteresis, defect
 *              labelling, review rejections and protect mask, temporal repair
 *              or inpainting, vertical scratch tracking and repair, temporal or
 *              edge-preserving denoise, local deflicker, tone/colour grade,
 *              unsharp mask, deterministic film grain. Larger holes are filled
 *              with multi-scale PatchMatch texture synthesis.
 */
(function (root, factory) {
  const api = factory();
  api.factorySource = factory.toString();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FRSEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function FRSEngineFactory() {
  'use strict';

  const VERSION = '3.8.0';
  const MAX_COMPONENTS_REPORTED = 4000;

  const DEFAULT_PARAMS = {
    dust: 50, maxSize: 32, spatial: 'auto', motion: true, motionRange: 24, flow: 'dense',
    scratch: 0, scratchWidth: 3, deflicker: 0, denoise: 10, grainMatch: true, irClean: 0, fade: 0, chromaAlign: false, chromaLocal: false, colorize: 0,
    exposure: 0, contrast: 0, saturation: 0, sharpen: 0, grain: 0,
  };

  function normalizeParams(p) {
    const o = Object.assign({}, DEFAULT_PARAMS, p || {});
    for (const k of Object.keys(DEFAULT_PARAMS)) {
      if (typeof DEFAULT_PARAMS[k] === 'number') o[k] = Number.isFinite(+o[k]) ? +o[k] : DEFAULT_PARAMS[k];
    }
    o.motion = o.motion !== false && o.motion !== 'false';
    o.chromaAlign = o.chromaAlign === true || o.chromaAlign === 'true';
    o.chromaLocal = o.chromaAlign && (o.chromaLocal === true || o.chromaLocal === 'true');
    o.grainMatch = o.grainMatch !== false && o.grainMatch !== 'false';
    if (!['auto', 'on', 'off'].includes(o.spatial)) o.spatial = 'auto';
    if (o.flow !== 'block') o.flow = 'dense';
    o.maxSize = Math.max(2, Math.min(256, Math.round(o.maxSize)));
    o.scratchWidth = Math.max(1, Math.min(12, Math.round(o.scratchWidth)));
    o.motionRange = Math.max(0, Math.min(96, Math.round(o.motionRange)));
    return o;
  }

  const ONE = 257; // one 8-bit code value in 16-bit units
  const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
  const clamp16 = (v) => (v < 0 ? 0 : v > 65535 ? 65535 : v);

  /** Promote 8-bit RGBA to 16-bit; 16-bit input is returned unchanged. */
  function toU16(a) {
    if (a instanceof Uint16Array) return a;
    const o = new Uint16Array(a.length);
    for (let i = 0; i < a.length; i++) o[i] = a[i] * ONE;
    return o;
  }
  /** Reduce 16-bit RGBA to 8-bit with rounding (for display and 8-bit export). */
  function to8(a) {
    const o = new Uint8ClampedArray(a.length);
    for (let i = 0; i < a.length; i++) o[i] = (a[i] + 128) / ONE;
    return o;
  }
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  // ---------------------------------------------------------------- basics
  function lumaOf(rgba, n) {
    const L = new Float32Array(n);
    const k = rgba instanceof Uint16Array ? 1 / ONE : 1;
    for (let i = 0, j = 0; i < n; i++, j += 4) L[i] = (0.2126 * rgba[j] + 0.7152 * rgba[j + 1] + 0.0722 * rgba[j + 2]) * k;
    return L;
  }

  /** Separable O(n) box blur on a float plane with clamped edges. */
  function boxBlur(src, w, h, r) {
    const out = new Float32Array(w * h);
    if (r < 1) { out.set(src); return out; }
    const tmp = new Float32Array(w * h), inv = 1 / (2 * r + 1);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += src[row + (k < 0 ? 0 : k >= w ? w - 1 : k)];
      for (let x = 0; x < w; x++) {
        tmp[row + x] = acc * inv;
        const add = x + r + 1, sub = x - r;
        acc += src[row + (add >= w ? w - 1 : add)] - src[row + (sub < 0 ? 0 : sub)];
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += tmp[(k < 0 ? 0 : k >= h ? h - 1 : k) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = acc * inv;
        const add = y + r + 1, sub = y - r;
        acc += tmp[(add >= h ? h - 1 : add) * w + x] - tmp[(sub < 0 ? 0 : sub) * w + x];
      }
    }
    return out;
  }

  /** van Herk / Gil-Werman running min or max over a 1-D window of 2r+1. */
  function runningExtreme1D(src, dst, len, offset, stride, r, isMax, gBuf, hBuf, line) {
    const k = 2 * r + 1, padded = len + 2 * r;
    const fill = isMax ? -Infinity : Infinity;
    for (let i = 0; i < padded; i++) {
      const s = i - r;
      line[i] = s < 0 || s >= len ? fill : src[offset + s * stride];
    }
    for (let i = 0; i < padded; i++) {
      const v = line[i];
      if (i % k === 0) gBuf[i] = v;
      else gBuf[i] = isMax ? (v > gBuf[i - 1] ? v : gBuf[i - 1]) : (v < gBuf[i - 1] ? v : gBuf[i - 1]);
    }
    for (let i = padded - 1; i >= 0; i--) {
      const v = line[i];
      if (i === padded - 1 || (i + 1) % k === 0) hBuf[i] = v;
      else hBuf[i] = isMax ? (v > hBuf[i + 1] ? v : hBuf[i + 1]) : (v < hBuf[i + 1] ? v : hBuf[i + 1]);
    }
    for (let x = 0; x < len; x++) {
      const a = hBuf[x], b = gBuf[x + 2 * r];
      dst[offset + x * stride] = isMax ? (a > b ? a : b) : (a < b ? a : b);
    }
  }

  function morph(src, w, h, r, isMax) {
    const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    const m = Math.max(w, h) + 2 * r + 2;
    const g = new Float32Array(m), hb = new Float32Array(m), line = new Float32Array(m);
    for (let y = 0; y < h; y++) runningExtreme1D(src, tmp, w, y * w, 1, r, isMax, g, hb, line);
    for (let x = 0; x < w; x++) runningExtreme1D(tmp, out, h, x, w, r, isMax, g, hb, line);
    return out;
  }

  function median(arr) {
    if (!arr.length) return 0;
    const a = Float32Array.from(arr).sort();
    return a[a.length >> 1];
  }

  /** Robust spatial noise estimate (Laplacian median absolute deviation). */
  function estimateNoise(L, w, h) {
    if (w < 3 || h < 3) return 0;
    const samples = [];
    const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 40000)));
    for (let y = 1; y < h - 1; y += step) for (let x = 1; x < w - 1; x += step) {
      const i = y * w + x;
      const lap = L[i] - 0.25 * (L[i - 1] + L[i + 1] + L[i - w] + L[i + w]);
      samples.push(Math.abs(lap));
    }
    return (1.4826 * median(samples)) / 1.118;
  }

  function hash3(x, y, s) {
    let hsh = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 2147483647);
    hsh = Math.imul(hsh ^ (hsh >>> 13), 1274126177);
    hsh ^= hsh >>> 16;
    return (hsh >>> 0) / 4294967296;
  }
  /** Deterministic approximately-Gaussian noise with unit variance. */
  function gauss3(x, y, s) {
    return (hash3(x, y, s) + hash3(x, y, s + 101) + hash3(x, y, s + 202) + hash3(x, y, s + 303) - 2) * 1.7320508;
  }

  // ---------------------------------------------------------------- histogram / scene cuts
  function histogram64(rgba, n) {
    const bins = new Float32Array(64), shift = rgba instanceof Uint16Array ? 1 / 1024 : 1 / 4;
    const step = n > 250000 ? 4 : 1;
    let count = 0;
    for (let i = 0; i < n; i += step) {
      const j = i * 4;
      const l = 0.2126 * rgba[j] + 0.7152 * rgba[j + 1] + 0.0722 * rgba[j + 2];
      bins[Math.min(63, (l * shift) | 0)]++;
      count++;
    }
    for (let i = 0; i < 64; i++) bins[i] /= count || 1;
    return bins;
  }

  /** Chi-square style distance between normalised histograms, 0 (same) .. 1. */
  function cutScore(a, b) {
    if (!a || !b) return 0;
    let d = 0;
    for (let i = 0; i < a.length; i++) { const s = a[i] + b[i]; if (s > 0) d += ((a[i] - b[i]) * (a[i] - b[i])) / s; }
    return d * 0.5;
  }

  // ---------------------------------------------------------------- motion
  function downsample(L, w, h) {
    const w2 = Math.max(1, w >> 1), h2 = Math.max(1, h >> 1), o = new Float32Array(w2 * h2);
    for (let y = 0; y < h2; y++) {
      const y0 = y * 2, y1 = Math.min(h - 1, y0 + 1);
      for (let x = 0; x < w2; x++) {
        const x0 = x * 2, x1 = Math.min(w - 1, x0 + 1);
        o[y * w2 + x] = (L[y0 * w + x0] + L[y0 * w + x1] + L[y1 * w + x0] + L[y1 * w + x1]) * 0.25;
      }
    }
    return { data: o, w: w2, h: h2 };
  }

  function blockSAD(cur, ref, w, h, x0, y0, bs, dx, dy, step, limit) {
    let s = 0;
    const x1 = Math.min(w, x0 + bs), y1 = Math.min(h, y0 + bs);
    for (let y = y0; y < y1; y += step) {
      let ry = y + dy; ry = ry < 0 ? 0 : ry >= h ? h - 1 : ry;
      const rrow = ry * w, crow = y * w;
      for (let x = x0; x < x1; x += step) {
        let rx = x + dx; rx = rx < 0 ? 0 : rx >= w ? w - 1 : rx;
        const d = cur[crow + x] - ref[rrow + rx];
        s += d < 0 ? -d : d;
      }
      if (s > limit) return s;
    }
    return s;
  }

  function medianField(v, bw, bh) {
    const out = new Float32Array(v.length), win = new Float32Array(9);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      let n = 0;
      for (let yy = Math.max(0, y - 1); yy <= Math.min(bh - 1, y + 1); yy++)
        for (let xx = Math.max(0, x - 1); xx <= Math.min(bw - 1, x + 1); xx++) win[n++] = v[yy * bw + xx];
      const s = win.subarray(0, n).sort();
      out[y * bw + x] = s[n >> 1];
    }
    return out;
  }

  /**
   * Hierarchical block matching (up to a 3-level pyramid, 16px blocks at full
   * resolution) with a motion-length penalty so flat areas prefer zero motion,
   * spatial predictor candidates during refinement, and vector median filtering.
   */
  /** Luma pyramid used by the block search (up to 3 levels, coarsest at least 64 px). */
  function motionLevels(curL, refL, w, h) {
    const levels = [{ c: curL, r: refL, w, h }];
    while (levels.length < 3) {
      const last = levels[levels.length - 1];
      if (last.w < 64 || last.h < 64) break;
      const c = downsample(last.c, last.w, last.h), r = downsample(last.r, last.w, last.h);
      levels.push({ c: c.data, r: r.data, w: c.w, h: c.h });
    }
    return levels;
  }

  function estimateMotion(curL, refL, w, h, range) {
    const B = 16, bw = Math.ceil(w / B), bh = Math.ceil(h / B), nb = bw * bh;
    const levels = motionLevels(curL, refL, w, h);
    let vx = new Float32Array(nb), vy = new Float32Array(nb);
    const top = levels.length - 1;
    {
      const lv = levels[top], scale = 1 << top, bs = Math.max(2, B / scale);
      const R = Math.max(1, Math.ceil(range / scale));
      for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
        const x0 = Math.min(lv.w - 1, Math.floor((bx * B) / scale)), y0 = Math.min(lv.h - 1, Math.floor((by * B) / scale));
        const count = Math.max(1, Math.min(bs, lv.w - x0) * Math.min(bs, lv.h - y0));
        const lambda = 0.35 * count;
        let best = blockSAD(lv.c, lv.r, lv.w, lv.h, x0, y0, bs, 0, 0, 1, Infinity), bdx = 0, bdy = 0;
        for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
          if (!dx && !dy) continue;
          const pen = lambda * (Math.abs(dx) + Math.abs(dy));
          if (pen >= best) continue;
          const s = blockSAD(lv.c, lv.r, lv.w, lv.h, x0, y0, bs, dx, dy, 1, best - pen) + pen;
          if (s < best) { best = s; bdx = dx; bdy = dy; }
        }
        vx[by * bw + bx] = bdx; vy[by * bw + bx] = bdy;
      }
      vx = medianField(vx, bw, bh); vy = medianField(vy, bw, bh);
    }
    const cost = new Float32Array(nb);
    const refine = (L, scaleUp) => {
      const lv = levels[L], scale = 1 << L, bs = B / scale, step = L === 0 ? 2 : 1;
      const px = Float32Array.from(vx, (v) => v * scaleUp), py = Float32Array.from(vy, (v) => v * scaleUp);
      for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
        const b = by * bw + bx;
        const x0 = Math.floor((bx * B) / scale), y0 = Math.floor((by * B) / scale);
        if (x0 >= lv.w || y0 >= lv.h) { vx[b] = px[b]; vy[b] = py[b]; continue; }
        const cx = Math.min(bs, lv.w - x0), cy = Math.min(bs, lv.h - y0);
        const count = Math.max(1, Math.ceil(cx / step) * Math.ceil(cy / step));
        const lambda = 0.15 * count;
        const evalv = (dx, dy, limit) => blockSAD(lv.c, lv.r, lv.w, lv.h, x0, y0, bs, dx, dy, step, limit) + lambda * (Math.abs(dx) + Math.abs(dy));
        const cands = [[px[b], py[b]], [0, 0]];
        if (bx > 0) cands.push([px[b - 1], py[b - 1]]);
        if (bx < bw - 1) cands.push([px[b + 1], py[b + 1]]);
        if (by > 0) cands.push([px[b - bw], py[b - bw]]);
        if (by < bh - 1) cands.push([px[b + bw], py[b + bw]]);
        let best = Infinity, bdx = 0, bdy = 0;
        for (const [dx, dy] of cands) { const s = evalv(dx, dy, best); if (s < best) { best = s; bdx = dx; bdy = dy; } }
        for (let iter = 0; iter < 3; iter++) {
          let moved = false; const cx0 = bdx, cy0 = bdy;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const s = evalv(cx0 + dx, cy0 + dy, best);
            if (s < best) { best = s; bdx = cx0 + dx; bdy = cy0 + dy; moved = true; }
          }
          if (!moved) break;
        }
        vx[b] = bdx; vy[b] = bdy;
        if (L === 0) cost[b] = (best - lambda * (Math.abs(bdx) + Math.abs(bdy))) / count;
      }
    };
    for (let L = top - 1; L >= 0; L--) refine(L, 2);
    if (top === 0) refine(0, 1);
    return finishField(vx, vy, cost, bw, bh, B);
  }

  /** Outlier repair, vector median and statistics shared by the CPU and GPU block searches. */
  function finishField(vx, vy, cost, bw, bh, B) {
    const nb = bw * bh;
    // Blocks that match poorly (occlusions, large dirt, heal holes) inherit the
    // median vector of reliable neighbours instead of keeping a random match.
    const sortedCost = Float32Array.from(cost).sort();
    const bad = Math.max(14, 3 * sortedCost[sortedCost.length >> 1]);
    for (let pass = 0; pass < 3; pass++) {
      let fixed = 0;
      const nx = Float32Array.from(vx), ny = Float32Array.from(vy);
      for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
        const b = by * bw + bx;
        if (cost[b] <= bad) continue;
        const xs = [], ys = [];
        for (let yy = Math.max(0, by - 2); yy <= Math.min(bh - 1, by + 2); yy++)
          for (let xx = Math.max(0, bx - 2); xx <= Math.min(bw - 1, bx + 2); xx++) {
            const o = yy * bw + xx;
            if (cost[o] <= bad) { xs.push(vx[o]); ys.push(vy[o]); }
          }
        if (xs.length >= 3) { nx[b] = median(xs); ny[b] = median(ys); cost[b] = bad; fixed++; }
      }
      vx = nx; vy = ny;
      if (!fixed) break;
    }
    vx = medianField(vx, bw, bh); vy = medianField(vy, bw, bh);
    let mag = 0, good = 0;
    for (let b = 0; b < nb; b++) { mag += Math.hypot(vx[b], vy[b]); if (cost[b] < 12) good++; }
    return { B, bw, bh, vx, vy, cost, meanMotion: mag / nb, confidence: good / nb };
  }

  /** Bilinear interpolation of block vectors into a dense per-pixel field. */
  function interpolateField(field, w, h) {
    const { B, bw, bh, vx, vy } = field, n = w * h, fx = new Float32Array(n), fy = new Float32Array(n);
    const bx0 = new Int32Array(w), bx1 = new Int32Array(w), tx = new Float32Array(w);
    for (let x = 0; x < w; x++) {
      const f = (x + 0.5) / B - 0.5, i0 = Math.floor(f);
      bx0[x] = Math.max(0, Math.min(bw - 1, i0)); bx1[x] = Math.max(0, Math.min(bw - 1, i0 + 1)); tx[x] = Math.max(0, Math.min(1, f - i0));
    }
    for (let y = 0; y < h; y++) {
      const f = (y + 0.5) / B - 0.5, j0 = Math.floor(f), ty = Math.max(0, Math.min(1, f - j0));
      const r0 = Math.max(0, Math.min(bh - 1, j0)) * bw, r1 = Math.max(0, Math.min(bh - 1, j0 + 1)) * bw;
      for (let x = 0; x < w; x++) {
        const a = r0 + bx0[x], b = r0 + bx1[x], c = r1 + bx0[x], d = r1 + bx1[x], t = tx[x], i = y * w + x;
        fx[i] = (vx[a] * (1 - t) + vx[b] * t) * (1 - ty) + (vx[c] * (1 - t) + vx[d] * t) * ty;
        fy[i] = (vy[a] * (1 - t) + vy[b] * t) * (1 - ty) + (vy[c] * (1 - t) + vy[d] * t) * ty;
      }
    }
    return { fx, fy };
  }

  /** Sample a float plane bilinearly at (x + fx, y + fy) for every pixel. */
  function warpPlane(L, fx, fy, w, h, out) {
    const W1 = w > 1 ? 1 : 0, H1 = h > 1 ? w : 0;
    for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) {
      let sx = x + fx[i], sy = y + fy[i];
      sx = sx < 0 ? 0 : sx > w - 1 ? w - 1 : sx; sy = sy < 0 ? 0 : sy > h - 1 ? h - 1 : sy;
      const ix = Math.max(0, Math.min(w - 2, Math.floor(sx))), iy = Math.max(0, Math.min(h - 2, Math.floor(sy)));
      const ax = W1 ? sx - ix : 0, ay = H1 ? sy - iy : 0, i00 = iy * w + ix;
      out[i] = (L[i00] * (1 - ax) + L[i00 + W1] * ax) * (1 - ay) + (L[i00 + H1] * (1 - ax) + L[i00 + H1 + W1] * ax) * ay;
    }
    return out;
  }

  /** Motion-compensated warp of a 16-bit reference with a dense flow field. */
  function warpDense(ref, refL, fx, fy, w, h) {
    const n = w * h, rgba = new Uint16Array(n * 4), L = new Float32Array(n);
    const W1 = w > 1 ? 1 : 0, H1 = h > 1 ? w : 0;
    for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) {
      let sx = x + fx[i], sy = y + fy[i];
      sx = sx < 0 ? 0 : sx > w - 1 ? w - 1 : sx; sy = sy < 0 ? 0 : sy > h - 1 ? h - 1 : sy;
      const ix = Math.max(0, Math.min(w - 2, Math.floor(sx))), iy = Math.max(0, Math.min(h - 2, Math.floor(sy)));
      const ax = W1 ? sx - ix : 0, ay = H1 ? sy - iy : 0;
      const i00 = iy * w + ix, i01 = i00 + W1, i10 = i00 + H1, i11 = i10 + W1;
      const w00 = (1 - ax) * (1 - ay), w01 = ax * (1 - ay), w10 = (1 - ax) * ay, w11 = ax * ay;
      const o = i * 4, a0 = i00 * 4, a1 = i01 * 4, a2 = i10 * 4, a3 = i11 * 4;
      rgba[o] = ref[a0] * w00 + ref[a1] * w01 + ref[a2] * w10 + ref[a3] * w11 + 0.5;
      rgba[o + 1] = ref[a0 + 1] * w00 + ref[a1 + 1] * w01 + ref[a2 + 1] * w10 + ref[a3 + 1] * w11 + 0.5;
      rgba[o + 2] = ref[a0 + 2] * w00 + ref[a1 + 2] * w01 + ref[a2 + 2] * w10 + ref[a3 + 2] * w11 + 0.5;
      rgba[o + 3] = 65535;
      L[i] = refL[i00] * w00 + refL[i01] * w01 + refL[i10] * w10 + refL[i11] * w11;
    }
    return { rgba, L };
  }

  /** Motion-compensated warp using a block field (kept for API compatibility). */
  function warp(ref, refL, field, w, h) {
    const { fx, fy } = interpolateField(field, w, h);
    return warpDense(toU16(ref), refL, fx, fy, w, h);
  }

  /**
   * Dense optical flow: robust iterative Lucas-Kanade refinement of the block
   * field. Each iteration warps the reference by the current flow, solves the
   * 2x2 structure-tensor system over a local window (box-filtered products),
   * and adds the update. Redescending residual weights (Geman-McClure) make
   * blotches, heal holes and occlusions contribute nothing, Tikhonov damping
   * keeps flat areas at their block-motion initialisation, and the total
   * correction is bounded so a bad window can never drag the flow far. Captures rotation, zoom, parallax
   * and sub-pixel motion that rigid 16px blocks cannot.
   */
  function denseFlow(curL, refL, w, h, field, opts) {
    const n = w * h, o = opts || {};
    const iters = o.iterations || 3, r = o.window || 4, lambda = o.lambda || 1.5, tau = o.tau || 10;
    const { fx, fy } = field.fx ? { fx: Float32Array.from(field.fx), fy: Float32Array.from(field.fy) } : interpolateField(field, w, h);
    if (w < 4 || h < 4) return { fx, fy };
    const fx0 = Float32Array.from(fx), fy0 = Float32Array.from(fy), maxDev = o.maxDeviation || 3;
    const Lw = new Float32Array(n), P = [0, 1, 2, 3, 4].map(() => new Float32Array(n));
    for (let it = 0; it < iters; it++) {
      warpPlane(refL, fx, fy, w, h, Lw);
      for (const q of P) q.fill(0);
      for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const gx = (Lw[i + 1] - Lw[i - 1]) * 0.5, gy = (Lw[i + w] - Lw[i - w]) * 0.5, et = Lw[i] - curL[i];
        const u = et / tau, q = 1 + u * u, wt = 1 / (q * q);
        P[0][i] = wt * gx * gx; P[1][i] = wt * gx * gy; P[2][i] = wt * gy * gy; P[3][i] = wt * gx * et; P[4][i] = wt * gy * et;
      }
      const B = P.map((q) => boxBlur(q, w, h, r));
      for (let i = 0; i < n; i++) {
        const a = B[0][i] + lambda, b = B[1][i], d = B[2][i] + lambda, det = a * d - b * b;
        if (det <= 1e-6) continue;
        let du = -(d * B[3][i] - b * B[4][i]) / det, dv = -(a * B[4][i] - b * B[3][i]) / det;
        du = du > 1 ? 1 : du < -1 ? -1 : du; dv = dv > 1 ? 1 : dv < -1 ? -1 : dv;
        fx[i] = Math.max(fx0[i] - maxDev, Math.min(fx0[i] + maxDev, fx[i] + du));
        fy[i] = Math.max(fy0[i] - maxDev, Math.min(fy0[i] + maxDev, fy[i] + dv));
      }
    }
    return { fx: boxBlur(fx, w, h, 1), fy: boxBlur(fy, w, h, 1) };
  }

  /**
   * Coarse-to-fine pyramidal Lucas-Kanade flow from zero motion: the same
   * robust solver as denseFlow run on a luma pyramid, each level starting
   * from the upsampled coarser result. No block search is needed, so the
   * whole computation maps onto the GPU. Reaches about ±3·2^(levels-1) px.
   */
  function pyramidFlow(curL, refL, w, h, opts) {
    const o = opts || {}, maxLevels = o.levels || 5;
    const pyr = [{ c: curL, r: refL, w, h }];
    while (pyr.length < maxLevels) {
      const L = pyr[pyr.length - 1];
      if (L.w < 48 || L.h < 48) break;
      const c = downsample(L.c, L.w, L.h), r = downsample(L.r, L.w, L.h);
      pyr.push({ c: c.data, r: r.data, w: c.w, h: c.h });
    }
    let fx = null, fy = null;
    for (let li = pyr.length - 1; li >= 0; li--) {
      const L = pyr[li], n = L.w * L.h, ix = new Float32Array(n), iy = new Float32Array(n);
      if (fx) {
        const P = pyr[li + 1];
        for (let y = 0; y < L.h; y++) for (let x = 0; x < L.w; x++) {
          const gx = Math.min(P.w - 1, Math.max(0, (x + 0.5) / 2 - 0.5)), gy = Math.min(P.h - 1, Math.max(0, (y + 0.5) / 2 - 0.5));
          const x0 = Math.min(P.w - 2, gx | 0), y0 = Math.min(P.h - 2, gy | 0), ax = gx - x0, ay = gy - y0, k = y0 * P.w + x0;
          ix[y * L.w + x] = 2 * ((fx[k] * (1 - ax) + fx[k + 1] * ax) * (1 - ay) + (fx[k + P.w] * (1 - ax) + fx[k + P.w + 1] * ax) * ay);
          iy[y * L.w + x] = 2 * ((fy[k] * (1 - ax) + fy[k + 1] * ax) * (1 - ay) + (fy[k + P.w] * (1 - ax) + fy[k + P.w + 1] * ax) * ay);
        }
      }
      const f = denseFlow(L.c, L.r, L.w, L.h, { fx: ix, fy: iy }, { iterations: li === pyr.length - 1 ? 6 : 3, maxDeviation: 3 });
      fx = f.fx; fy = f.fy;
    }
    return { fx, fy };
  }

  /** flowError for a block field, interpolating vectors only at the sample points. */
  function fieldError(curL, refL, field, w, h) {
    const { B, bw, bh, vx, vy } = field, st = 3, b = 8;
    let s0 = 0, c = 0;
    for (let y = b; y < h - b; y += st) for (let x = b; x < w - b; x += st) {
      const fx = (x + 0.5) / B - 0.5, fy = (y + 0.5) / B - 0.5, i0 = Math.floor(fx), j0 = Math.floor(fy);
      const tx = Math.max(0, Math.min(1, fx - i0)), ty = Math.max(0, Math.min(1, fy - j0));
      const a0 = Math.max(0, Math.min(bw - 1, i0)), a1 = Math.max(0, Math.min(bw - 1, i0 + 1)), r0 = Math.max(0, Math.min(bh - 1, j0)) * bw, r1 = Math.max(0, Math.min(bh - 1, j0 + 1)) * bw;
      const mvx = (vx[r0 + a0] * (1 - tx) + vx[r0 + a1] * tx) * (1 - ty) + (vx[r1 + a0] * (1 - tx) + vx[r1 + a1] * tx) * ty;
      const mvy = (vy[r0 + a0] * (1 - tx) + vy[r0 + a1] * tx) * (1 - ty) + (vy[r1 + a0] * (1 - tx) + vy[r1 + a1] * tx) * ty;
      let sx = x + mvx, sy = y + mvy;
      sx = sx < 0 ? 0 : sx > w - 1 ? w - 1 : sx; sy = sy < 0 ? 0 : sy > h - 1 ? h - 1 : sy;
      const ix = Math.min(w - 2, sx | 0), iy = Math.min(h - 2, sy | 0), ax = sx - ix, ay = sy - iy, j = iy * w + ix;
      s0 += Math.abs(curL[y * w + x] - ((refL[j] * (1 - ax) + refL[j + 1] * ax) * (1 - ay) + (refL[j + w] * (1 - ax) + refL[j + w + 1] * ax) * ay)); c++;
    }
    return c ? s0 / c : 0;
  }

  /** Mean absolute luma error of a flow, sampled on a sparse grid (no full-plane warp needed). */
  function flowError(curL, refL, fx, fy, w, h, border, step) {
    const b = border || 8, st = step || 3;
    let s = 0, c = 0;
    for (let y = b; y < h - b; y += st) for (let x = b; x < w - b; x += st) {
      const i = y * w + x;
      let sx = x + fx[i], sy = y + fy[i];
      sx = sx < 0 ? 0 : sx > w - 1 ? w - 1 : sx; sy = sy < 0 ? 0 : sy > h - 1 ? h - 1 : sy;
      const ix = Math.min(w - 2, sx | 0), iy = Math.min(h - 2, sy | 0), ax = sx - ix, ay = sy - iy, j = iy * w + ix;
      const v = (refL[j] * (1 - ax) + refL[j + 1] * ax) * (1 - ay) + (refL[j + w] * (1 - ax) + refL[j + w + 1] * ax) * ay;
      s += Math.abs(curL[i] - v); c++;
    }
    return c ? s / c : 0;
  }

  /** Mean absolute luma error between the current frame and a warped reference, ignoring a border. */
  function registrationError(curL, warpedL, w, h, border) {
    const b = border || 8;
    let s = 0, c = 0;
    for (let y = b; y < h - b; y++) for (let x = b; x < w - b; x++) { const i = y * w + x; s += Math.abs(curL[i] - warpedL[i]); c++; }
    return c ? s / c : 0;
  }

  // ---------------------------------------------------------------- local brightness
  function cellMeans(L, w, h, cs) {
    const gw = Math.ceil(w / cs), gh = Math.ceil(h / cs), sum = new Float64Array(gw * gh), cnt = new Uint32Array(gw * gh);
    const rowSum = new Float64Array(gw), colCell = new Int32Array(w), colCnt = new Uint32Array(gw);
    for (let x = 0; x < w; x++) { colCell[x] = (x / cs) | 0; colCnt[colCell[x]]++; }
    for (let y = 0; y < h; y++) {
      const gy = ((y / cs) | 0) * gw, row = y * w;
      rowSum.fill(0);
      for (let x = 0; x < w; x++) rowSum[colCell[x]] += L[row + x];
      for (let c = 0; c < gw; c++) { sum[gy + c] += rowSum[c]; cnt[gy + c] += colCnt[c]; }
    }
    const m = new Float32Array(gw * gh);
    for (let i = 0; i < m.length; i++) m[i] = sum[i] / (cnt[i] || 1);
    return { gw, gh, cs, m };
  }


  function smoothGrid(g, gw, gh) {
    const o = new Float32Array(g.length);
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      let s = 0, n = 0;
      for (let yy = Math.max(0, y - 1); yy <= Math.min(gh - 1, y + 1); yy++)
        for (let xx = Math.max(0, x - 1); xx <= Math.min(gw - 1, x + 1); xx++) { s += g[yy * gw + xx]; n++; }
      o[y * gw + x] = s / n;
    }
    return o;
  }

  function expandGrid(g, gw, gh, cs, w, h) {
    const out = new Float32Array(w * h);
    const gx0 = new Int32Array(w), gx1 = new Int32Array(w), tx = new Float32Array(w);
    for (let x = 0; x < w; x++) {
      const f = (x + 0.5) / cs - 0.5, i = Math.floor(f);
      gx0[x] = Math.max(0, Math.min(gw - 1, i)); gx1[x] = Math.max(0, Math.min(gw - 1, i + 1)); tx[x] = Math.max(0, Math.min(1, f - i));
    }
    for (let y = 0; y < h; y++) {
      const f = (y + 0.5) / cs - 0.5, j = Math.floor(f), ty = Math.max(0, Math.min(1, f - j));
      const r0 = Math.max(0, Math.min(gh - 1, j)) * gw, r1 = Math.max(0, Math.min(gh - 1, j + 1)) * gw;
      for (let x = 0; x < w; x++) {
        const t = tx[x];
        out[y * w + x] = (g[r0 + gx0[x]] * (1 - t) + g[r0 + gx1[x]] * t) * (1 - ty) + (g[r1 + gx0[x]] * (1 - t) + g[r1 + gx1[x]] * t) * ty;
      }
    }
    return out;
  }

  function gainGrid(num, den, lo, hi) {
    const g = new Float32Array(num.m.length);
    for (let i = 0; i < g.length; i++) g[i] = Math.max(lo, Math.min(hi, (num.m[i] + 4) / (den.m[i] + 4)));
    return smoothGrid(g, num.gw, num.gh);
  }

  /**
   * Unregistered cell gain for motion pre-normalisation. Cells whose ratio
   * departs strongly from the median (damage, heal holes, occlusion) take the
   * median instead, so they cannot distort the motion search around them.
   */
  function robustPreGain(curCells, refCells) {
    const n = curCells.m.length, r = new Float32Array(n);
    for (let c = 0; c < n; c++) r[c] = (curCells.m[c] + 4) / (refCells.m[c] + 4);
    const med = Math.max(0.5, Math.min(2, median(r)));
    for (let c = 0; c < n; c++) r[c] = Math.abs(r[c] / med - 1) > 0.15 ? med : Math.max(0.5, Math.min(2, r[c]));
    return smoothGrid(r, curCells.gw, curCells.gh);
  }

  /**
   * Scale a warped reference so its local brightness matches the current
   * frame. Gains are re-estimated over inlier pixels only, so blotches, heal
   * holes and occlusions in the current frame do not bias the match.
   * Returns the matched reference and its cell gain grid (cur / ref).
   */
  function brightnessMatch(ref, Lc, curCells, w, h) {
    const { gw, gh, cs } = curCells, cells = gw * gh;
    // Start from the median cell ratio: one damaged cell cannot bias the start.
    const refCells = cellMeans(ref.L, w, h, cs), ratios = [];
    for (let c = 0; c < cells; c++) ratios.push((curCells.m[c] + 4) / (refCells.m[c] + 4));
    let gain = new Float32Array(cells).fill(Math.max(0.5, Math.min(2, median(ratios))));
    const sumC = new Float64Array(cells), sumR = new Float64Array(cells), cnt = new Uint32Array(cells), tot = new Uint32Array(cells);
    const colCell = new Int32Array(w);
    for (let x = 0; x < w; x++) colCell[x] = (x / cs) | 0;
    const step = w * h > 1e6 ? 2 : 1; // inlier statistics on a sub-grid are plenty for cell means
    for (let iter = 0; iter < 3; iter++) {
      sumC.fill(0); sumR.fill(0); cnt.fill(0); tot.fill(0);
      for (let y = 0; y < h; y += step) {
        const gy = ((y / cs) | 0) * gw;
        for (let x = 0; x < w; x += step) {
          const i = y * w + x, c = gy + colCell[x], lc = Lc[i], lr = ref.L[i];
          tot[c]++;
          const d = lc - lr * gain[c];
          if (d > -(14 + 0.08 * lc) && d < 14 + 0.08 * lc) { sumC[c] += lc; sumR[c] += lr; cnt[c]++; }
        }
      }
      const next = new Float32Array(cells), ok = new Uint8Array(cells);
      for (let c = 0; c < cells; c++) if (cnt[c] > tot[c] * 0.25) { next[c] = Math.max(0.5, Math.min(2, (sumC[c] / cnt[c] + 4) / (sumR[c] / cnt[c] + 4))); ok[c] = 1; }
      // Cells without enough trustworthy pixels (large dirt, heal holes) borrow from valid neighbours.
      for (let pass = 0; pass < gw + gh; pass++) {
        let missing = 0;
        const snap = Uint8Array.from(ok);
        for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
          const c = y * gw + x;
          if (snap[c]) continue;
          let sum = 0, k = 0;
          for (let yy = Math.max(0, y - 1); yy <= Math.min(gh - 1, y + 1); yy++) for (let xx = Math.max(0, x - 1); xx <= Math.min(gw - 1, x + 1); xx++) if (snap[yy * gw + xx]) { sum += next[yy * gw + xx]; k++; }
          if (k) { next[c] = sum / k; ok[c] = 1; } else missing++;
        }
        if (!missing) break;
      }
      for (let c = 0; c < cells; c++) if (!ok[c]) next[c] = gain[c];
      gain = smoothGrid(next, gw, gh);
    }
    const g = expandGrid(gain, gw, gh, cs, w, h);
    const n = w * h, rgba = new Uint16Array(n * 4), L = new Float32Array(n), src = ref.rgba;
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const k = g[i];
      rgba[j] = clamp16(src[j] * k); rgba[j + 1] = clamp16(src[j + 1] * k); rgba[j + 2] = clamp16(src[j + 2] * k); rgba[j + 3] = 65535;
      L[i] = ref.L[i] * k;
    }
    return { rgba, L, gain };
  }

  // ---------------------------------------------------------------- detection
  /**
   * Grow strong seeds (2) into connected weak candidates (1). With maxSteps,
   * growth stops that many pixels from the nearest seed, so a blotch cannot
   * leak into surrounding texture. Returns a 0/1 mask.
   */
  function hysteresis(mask, w, h, maxSteps) {
    const n = w * h, out = new Uint8Array(n);
    let frontier = [];
    for (let i = 0; i < n; i++) if (mask[i] === 2) { out[i] = 1; frontier.push(i); }
    const limit = maxSteps || Infinity;
    for (let step = 0; step < limit && frontier.length; step++) {
      const next = [];
      for (const i of frontier) {
        const x = i % w, y = (i / w) | 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy; if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx; if (xx < 0 || xx >= w) continue;
            const j = yy * w + xx;
            if (!out[j] && mask[j]) { out[j] = 1; next.push(j); }
          }
        }
      }
      frontier = next;
    }
    return out;
  }

  /**
   * Spike-detection index with sign consistency (SDIp) plus a reference
   * agreement test: a pixel is a blotch only if it differs strongly, and in the
   * same direction, from both motion-compensated neighbours while those
   * neighbours agree with each other. Thresholds adapt to measured noise and to
   * edge strength in the references to suppress misregistration on edges.
   */
  function detectTemporal(Lc, La, Lb, w, h, sensitivity) {
    const n = w * h, s = Math.max(0, Math.min(1, sensitivity));
    const samples = [];
    const step = Math.max(1, Math.floor(n / 40000));
    for (let i = 0; i < n; i += step) samples.push(Math.abs(La[i] - Lb[i]));
    const sigma = (1.4826 * median(samples)) / Math.SQRT2;
    const t = 6 + 44 * (1 - s) + 2.5 * sigma, tLow = t * 0.5;
    const mask = new Uint8Array(n);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x, c = Lc[i], a = La[i], b = Lb[i];
      const ep = c - a, en = c - b;
      if (ep * en <= 0) continue;
      const m = Math.min(ep < 0 ? -ep : ep, en < 0 ? -en : en);
      if (m <= tLow) continue;
      const gr = Math.abs((La[i + 1] + Lb[i + 1]) - (La[i - 1] + Lb[i - 1])) * 0.5 + Math.abs((La[i + w] + Lb[i + w]) - (La[i - w] + Lb[i - w])) * 0.5;
      const tol = t + 0.35 * gr, agree = a > b ? a - b : b - a;
      if (m > tol && agree < Math.max(tol * 0.6, 12)) mask[i] = 2;
      else if (m > tLow + 0.2 * gr && agree < tol) mask[i] = 1;
    }
    return { mask: hysteresis(mask, w, h), threshold: t, sigma };
  }

  /** Morphological top-hat / black-hat blotch detector for single images. */
  function detectSpatial(Lc, w, h, sensitivity, maxSize) {
    const s = Math.max(0, Math.min(1, sensitivity));
    const r = Math.max(2, Math.min(12, Math.ceil(maxSize / 2)));
    const open = morph(morph(Lc, w, h, r, false), w, h, r, true);
    const close = morph(morph(Lc, w, h, r, true), w, h, r, false);
    const n = w * h, hat = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const white = Lc[i] - open[i], black = close[i] - Lc[i];
      hat[i] = white > black ? white : black;
    }
    // Texture activity: the average hat response around each pixel. Isolated
    // blotches stand far above it; busy texture does not.
    const activity = boxBlur(hat, w, h, Math.max(6, 2 * r));
    const t = 8 + 30 * (1 - s), k = 1.2 + 2 * (1 - s);
    const mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const v = hat[i], tol = t + k * activity[i];
      if (v > tol) mask[i] = 2; else if (v > tol * 0.6) mask[i] = 1;
    }
    return { mask: hysteresis(mask, w, h, 3), threshold: t, sigma: estimateNoise(Lc, w, h) };
  }

  function labelComponents(mask, w, h) {
    const n = w * h, labels = new Int32Array(n), stack = new Int32Array(n), comps = [];
    for (let s = 0; s < n; s++) {
      if (!mask[s] || labels[s]) continue;
      const id = comps.length + 1;
      let sp = 0, minX = w, minY = h, maxX = 0, maxY = 0, area = 0, sx = 0, sy = 0;
      labels[s] = id; stack[sp++] = s;
      while (sp) {
        const i = stack[--sp], x = i % w, y = (i / w) | 0;
        area++; sx += x; sy += y;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy; if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx; if (xx < 0 || xx >= w) continue;
            const j = yy * w + xx;
            if (mask[j] && !labels[j]) { labels[j] = id; stack[sp++] = j; }
          }
        }
      }
      comps.push({ id, x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, area, cx: sx / area, cy: sy / area });
    }
    return { labels, comps };
  }

  function dilate(mask, w, h, block) {
    const out = new Uint8Array(mask.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i]) continue;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx; if (xx < 0 || xx >= w) continue;
          const j = yy * w + xx;
          if (!block || !block[j]) out[j] = 1;
        }
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- repair
  /**
   * Onion-peel inpainting: fills the mask from its boundary inward using
   * distance-weighted known neighbours, relaxes the interior, then re-injects
   * grain measured around the hole so repairs do not look smeared.
   */
  function inpaint(rgba, mask, w, h, grainMatch, seed) {
    const idx = [];
    for (let i = 0; i < mask.length; i++) if (mask[i]) idx.push(i);
    if (!idx.length) return 0;
    const known = new Uint8Array(w * h).fill(1);
    for (const i of idx) known[i] = 0;
    const queued = new Uint8Array(w * h);
    let frontier = [];
    for (const i of idx) {
      const x = i % w, y = (i / w) | 0;
      let edge = false;
      for (let dy = -1; dy <= 1 && !edge; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < w && yy < h && known[yy * w + xx]) { edge = true; break; }
      }
      if (edge) { frontier.push(i); queued[i] = 1; }
    }
    if (!frontier.length) return 0;
    const vals = [];
    while (frontier.length) {
      vals.length = 0;
      for (const i of frontier) {
        const x = i % w, y = (i / w) | 0;
        let r = 0, g = 0, b = 0, ws = 0;
        for (let dy = -2; dy <= 2; dy++) {
          const yy = y + dy; if (yy < 0 || yy >= h) continue;
          for (let dx = -2; dx <= 2; dx++) {
            const xx = x + dx; if ((!dx && !dy) || xx < 0 || xx >= w) continue;
            const j = yy * w + xx;
            if (!known[j]) continue;
            const wt = 1 / (dx * dx + dy * dy), o = j * 4;
            r += rgba[o] * wt; g += rgba[o + 1] * wt; b += rgba[o + 2] * wt; ws += wt;
          }
        }
        vals.push(ws ? [r / ws, g / ws, b / ws] : null);
      }
      let progressed = false;
      for (let k = 0; k < frontier.length; k++) {
        const i = frontier[k], v = vals[k];
        if (v) { const o = i * 4; rgba[o] = v[0]; rgba[o + 1] = v[1]; rgba[o + 2] = v[2]; known[i] = 1; progressed = true; }
      }
      if (!progressed) break;
      const next = [];
      for (let k = 0; k < frontier.length; k++) {
        const i = frontier[k];
        if (!known[i]) { next.push(i); continue; }
        const x = i % w, y = (i / w) | 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const j = yy * w + xx;
          if (!known[j] && !queued[j]) { queued[j] = 1; next.push(j); }
        }
      }
      frontier = next;
    }
    for (let it = 0; it < 3; it++) for (const i of idx) {
      const x = i % w, y = (i / w) | 0;
      if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
      const o = i * 4;
      for (let ch = 0; ch < 3; ch++)
        rgba[o + ch] = 0.4 * rgba[o + ch] + 0.15 * (rgba[o + ch - 4] + rgba[o + ch + 4] + rgba[o + ch - w * 4] + rgba[o + ch + w * 4]);
    }
    if (grainMatch) addLocalGrain(rgba, mask, idx, w, h, seed);
    return idx.length;
  }

  /** Measure grain in a ring around the masked region and add matching noise inside it. */
  function addLocalGrain(rgba, mask, idx, w, h, seed) {
    let minX = w, minY = h, maxX = 0, maxY = 0;
    for (const i of idx) {
      const x = i % w, y = (i / w) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const pad = 4, x0 = Math.max(1, minX - pad), x1 = Math.min(w - 2, maxX + pad), y0 = Math.max(1, minY - pad), y1 = Math.min(h - 2, maxY + pad);
    const samples = [];
    const lum = (q) => (0.2126 * rgba[q] + 0.7152 * rgba[q + 1] + 0.0722 * rgba[q + 2]) / ONE;
    const stride = Math.max(1, Math.floor(Math.sqrt(((x1 - x0 + 1) * (y1 - y0 + 1)) / 20000)));
    for (let y = y0; y <= y1; y += stride) for (let x = x0; x <= x1; x += stride) {
      const i = y * w + x;
      if (mask[i] || mask[i - 1] || mask[i + 1] || mask[i - w] || mask[i + w]) continue;
      const o = i * 4;
      samples.push(Math.abs(lum(o) - 0.25 * (lum(o - 4) + lum(o + 4) + lum(o - w * 4) + lum(o + w * 4))));
    }
    if (samples.length < 8) return;
    const sigma = Math.min(18, (1.4826 * median(samples)) / 1.118);
    if (sigma < 0.4) return;
    for (const i of idx) {
      const x = i % w, y = (i / w) | 0, nz = gauss3(x, y, seed) * sigma * ONE, o = i * 4;
      rgba[o] = clamp16(rgba[o] + nz); rgba[o + 1] = clamp16(rgba[o + 1] + nz); rgba[o + 2] = clamp16(rgba[o + 2] + nz);
    }
  }

  /**
   * Multi-scale PatchMatch inpainting: expectation-maximisation patch voting
   * (Wexler, Shechtman & Irani) with randomised nearest-neighbour search
   * (Barnes et al.). Synthesises real texture and grain from the surroundings,
   * so larger holes do not come out smeared. `fill` marks pixels to replace;
   * `avoid` marks damaged pixels that must not be used as source material.
   */
  function inpaintPatch(rgba, fill, w, h, seed, avoid) {
    let minX = w, minY = h, maxX = -1, maxY = -1, count = 0;
    for (let i = 0; i < fill.length; i++) if (fill[i]) {
      const x = i % w, y = (i / w) | 0; count++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (!count) return 0;
    const R = 3, holeDim = Math.max(maxX - minX + 1, maxY - minY + 1);
    const margin = Math.max(14, Math.ceil(holeDim * 1.25));
    const X0 = Math.max(0, minX - margin), Y0 = Math.max(0, minY - margin), X1 = Math.min(w - 1, maxX + margin), Y1 = Math.min(h - 1, maxY + margin);
    const cw = X1 - X0 + 1, ch = Y1 - Y0 + 1;
    if (cw < 2 * R + 3 || ch < 2 * R + 3) return 0;
    let rnd = (seed * 2654435761) >>> 0 || 1;
    const random = () => { rnd ^= rnd << 13; rnd ^= rnd >>> 17; rnd ^= rnd << 5; return (rnd >>> 0) / 4294967296; };

    // level 0 planes
    const base = { w: cw, h: ch, img: new Float32Array(cw * ch * 3), m: new Uint8Array(cw * ch), a: new Uint8Array(cw * ch) };
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const gi = (Y0 + y) * w + X0 + x, li = y * cw + x;
      base.img[li * 3] = rgba[gi * 4]; base.img[li * 3 + 1] = rgba[gi * 4 + 1]; base.img[li * 3 + 2] = rgba[gi * 4 + 2];
      base.m[li] = fill[gi] ? 1 : 0; base.a[li] = avoid && avoid[gi] ? 1 : 0;
    }
    const levels = [base];
    while (levels.length < 6) {
      const L = levels[levels.length - 1];
      if (holeDim / (1 << (levels.length - 1)) <= 2 * R + 1 || L.w < 8 * R || L.h < 8 * R) break;
      const nw = L.w >> 1, nh = L.h >> 1, n2 = { w: nw, h: nh, img: new Float32Array(nw * nh * 3), m: new Uint8Array(nw * nh), a: new Uint8Array(nw * nh) };
      for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
        let r = 0, g = 0, b = 0, k = 0, anyM = 0, anyA = 0;
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
          const si = (y * 2 + dy) * L.w + x * 2 + dx;
          if (L.m[si]) anyM = 1; else { r += L.img[si * 3]; g += L.img[si * 3 + 1]; b += L.img[si * 3 + 2]; k++; }
          if (L.a[si]) anyA = 1;
        }
        const di = y * nw + x;
        n2.m[di] = anyM; n2.a[di] = anyA;
        if (k) { n2.img[di * 3] = r / k; n2.img[di * 3 + 1] = g / k; n2.img[di * 3 + 2] = b / k; }
      }
      levels.push(n2);
    }

    // Drop coarse levels too small to offer real source patches.
    const validCount = (L) => {
      let c = 0;
      for (let y = R; y < L.h - R; y++) for (let x = R; x < L.w - R; x++) {
        let ok = true;
        for (let dy = -R; dy <= R && ok; dy++) for (let dx = -R; dx <= R; dx++) { const i = (y + dy) * L.w + x + dx; if (L.m[i] || L.a[i]) { ok = false; break; } }
        if (ok && ++c >= 40) return c;
      }
      return c;
    };
    while (levels.length > 1 && validCount(levels[levels.length - 1]) < 40) levels.pop();
    // coarsest level initialisation: diffuse known values inward
    {
      const L = levels[levels.length - 1], tmp = new Uint16Array(L.w * L.h * 4), mk = new Uint8Array(L.w * L.h);
      for (let i = 0; i < L.w * L.h; i++) { tmp[i * 4] = L.img[i * 3]; tmp[i * 4 + 1] = L.img[i * 3 + 1]; tmp[i * 4 + 2] = L.img[i * 3 + 2]; mk[i] = L.m[i]; }
      inpaint(tmp, mk, L.w, L.h, false, seed);
      for (let i = 0; i < L.w * L.h; i++) if (L.m[i]) { L.img[i * 3] = tmp[i * 4]; L.img[i * 3 + 1] = tmp[i * 4 + 1]; L.img[i * 3 + 2] = tmp[i * 4 + 2]; }
    }

    let prevMap = null, prevW = 0;
    for (let li = levels.length - 1; li >= 0; li--) {
      const L = levels[li], lw = L.w, lh = L.h, img = L.img, m = L.m;
      if (li < levels.length - 1) {
        const C = levels[li + 1];
        for (let y = 0; y < lh; y++) for (let x = 0; x < lw; x++) {
          const i = y * lw + x;
          if (!m[i]) continue;
          const ci = Math.min(C.h - 1, y >> 1) * C.w + Math.min(C.w - 1, x >> 1);
          img[i * 3] = C.img[ci * 3]; img[i * 3 + 1] = C.img[ci * 3 + 1]; img[i * 3 + 2] = C.img[ci * 3 + 2];
        }
      }
      // integral image of unusable pixels (hole or avoid) to test source validity in O(1)
      const S = new Int32Array((lw + 1) * (lh + 1));
      for (let y = 0; y < lh; y++) {
        let row = 0;
        for (let x = 0; x < lw; x++) { row += m[y * lw + x] || L.a[y * lw + x] ? 1 : 0; S[(y + 1) * (lw + 1) + x + 1] = S[y * (lw + 1) + x + 1] + row; }
      }
      const valid = (x, y) => x >= R && y >= R && x < lw - R && y < lh - R &&
        S[(y + R + 1) * (lw + 1) + x + R + 1] - S[(y - R) * (lw + 1) + x + R + 1] - S[(y + R + 1) * (lw + 1) + x - R] + S[(y - R) * (lw + 1) + x - R] === 0;
      const sources = [];
      for (let y = R; y < lh - R; y++) for (let x = R; x < lw - R; x++) if (valid(x, y)) sources.push(y * lw + x);
      if (!sources.length) return inpaint(rgba, fill, w, h, true, seed);
      // targets: patch centres (clamped inside the level) whose patch touches the hole
      const isT = new Uint8Array(lw * lh);
      for (let y = 0; y < lh; y++) for (let x = 0; x < lw; x++) if (m[y * lw + x])
        for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
          const tx = Math.max(R, Math.min(lw - 1 - R, x + dx)), ty = Math.max(R, Math.min(lh - 1 - R, y + dy));
          isT[ty * lw + tx] = 1;
        }
      const targets = [];
      for (let i = 0; i < lw * lh; i++) if (isT[i]) targets.push(i);
      const nnf = new Int32Array(targets.length), dist = new Float64Array(targets.length), map = new Int32Array(lw * lh).fill(-1);
      targets.forEach((t, k) => { map[t] = k; });
      const patchDist = (t, s2, limit) => {
        let d = 0;
        const tx = t % lw, ty = (t / lw) | 0, sx = s2 % lw, sy = (s2 / lw) | 0;
        for (let dy = -R; dy <= R; dy++) {
          let a = ((ty + dy) * lw + tx - R) * 3, b = ((sy + dy) * lw + sx - R) * 3;
          for (let k = 0; k < (2 * R + 1) * 3; k++, a++, b++) { const e = img[a] - img[b]; d += e * e; }
          if (d > limit) return d;
        }
        return d;
      };
      for (let k = 0; k < targets.length; k++) {
        const t = targets[k], tx = t % lw, ty = (t / lw) | 0;
        let s0 = -1;
        if (prevMap) {
          const ck = prevMap[Math.min((lh >> 1) - 1, ty >> 1) * prevW + Math.min(prevW - 1, tx >> 1)];
          if (ck >= 0) {
            const cs = prevMap.src[ck], sx = (cs % prevW) * 2 + (tx & 1), sy = ((cs / prevW) | 0) * 2 + (ty & 1);
            if (valid(sx, sy)) s0 = sy * lw + sx;
          }
        }
        nnf[k] = s0 >= 0 ? s0 : sources[(random() * sources.length) | 0];
      }
      const emIters = li === levels.length - 1 ? 6 : li === 0 ? 2 : 3;
      const acc = new Float64Array(lw * lh * 3), wsum = new Float64Array(lw * lh);
      for (let em = 0; em < emIters; em++) {
        for (let k = 0; k < targets.length; k++) dist[k] = patchDist(targets[k], nnf[k], Infinity);
        for (let pm = 0; pm < 4; pm++) {
          const fwd = pm % 2 === 0, step = fwd ? 1 : -1;
          for (let q = fwd ? 0 : targets.length - 1; fwd ? q < targets.length : q >= 0; q += step) {
            const t = targets[q], tx = t % lw, ty = (t / lw) | 0;
            for (const [nx, ny] of [[tx - step, ty], [tx, ty - step]]) {
              const nk = nx >= 0 && ny >= 0 && nx < lw && ny < lh ? map[ny * lw + nx] : -1;
              if (nk < 0) continue;
              const ns = nnf[nk], sx = (ns % lw) + (tx - nx), sy = ((ns / lw) | 0) + (ty - ny);
              if (!valid(sx, sy)) continue;
              const cand = sy * lw + sx, d = patchDist(t, cand, dist[q]);
              if (d < dist[q]) { dist[q] = d; nnf[q] = cand; }
            }
            let rad = Math.max(lw, lh);
            const bx = nnf[q] % lw, by = (nnf[q] / lw) | 0;
            while (rad >= 1) {
              const sx = Math.round(bx + (random() * 2 - 1) * rad), sy = Math.round(by + (random() * 2 - 1) * rad);
              if (valid(sx, sy)) { const cand = sy * lw + sx, d = patchDist(t, cand, dist[q]); if (d < dist[q]) { dist[q] = d; nnf[q] = cand; } }
              rad >>= 1;
            }
          }
        }
        // vote
        const sorted = Float64Array.from(dist).sort(), sigma2 = 2 * (sorted[Math.floor(sorted.length * 0.75)] / ((2 * R + 1) ** 2 * 3) + 1);
        acc.fill(0); wsum.fill(0);
        for (let k = 0; k < targets.length; k++) {
          const t = targets[k], s2 = nnf[k], tx = t % lw, ty = (t / lw) | 0, sx = s2 % lw, sy = (s2 / lw) | 0;
          const wt = Math.exp(-(dist[k] / ((2 * R + 1) ** 2 * 3)) / sigma2) + 1e-12;
          for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
            const pi = (ty + dy) * lw + tx + dx;
            if (!m[pi]) continue;
            const si = ((sy + dy) * lw + sx + dx) * 3;
            acc[pi * 3] += img[si] * wt; acc[pi * 3 + 1] += img[si + 1] * wt; acc[pi * 3 + 2] += img[si + 2] * wt; wsum[pi] += wt;
          }
        }
        for (let i = 0; i < lw * lh; i++) if (m[i] && wsum[i] > 0) { img[i * 3] = acc[i * 3] / wsum[i]; img[i * 3 + 1] = acc[i * 3 + 1] / wsum[i]; img[i * 3 + 2] = acc[i * 3 + 2] / wsum[i]; }
      }
      prevMap = map; prevMap.src = nnf; prevW = lw;
    }
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const li = y * cw + x;
      if (!base.m[li]) continue;
      const gi = ((Y0 + y) * w + X0 + x) * 4;
      rgba[gi] = clamp16(base.img[li * 3] + 0.5); rgba[gi + 1] = clamp16(base.img[li * 3 + 1] + 0.5); rgba[gi + 2] = clamp16(base.img[li * 3 + 2] + 0.5);
    }
    return count;
  }

  /**
   * Route each hole to the right filler: specks smaller than a patch use the
   * fast onion-peel fill with grain matching; larger holes use PatchMatch
   * texture synthesis, never sampling from other unrepaired holes.
   */
  function inpaintSmart(rgba, mask, w, h, grainMatch, seed) {
    const { labels, comps } = labelComponents(mask, w, h);
    if (!comps.length) return 0;
    const large = comps.filter((c) => Math.max(c.w, c.h) >= 8);
    let total = 0;
    if (large.length < comps.length) {
      const small = new Uint8Array(mask.length), isLarge = new Uint8Array(comps.length + 1);
      for (const c of large) isLarge[c.id] = 1;
      for (let i = 0; i < mask.length; i++) if (labels[i] && !isLarge[labels[i]]) small[i] = 1;
      total += inpaint(rgba, small, w, h, grainMatch, seed);
    }
    if (large.length) {
      const pending = new Uint8Array(mask.length);
      for (const c of large) for (let y = c.y; y < c.y + c.h; y++) for (let x = c.x; x < c.x + c.w; x++) { const i = y * w + x; if (labels[i] === c.id) pending[i] = 1; }
      for (const c of large.sort((a, b) => a.area - b.area)) {
        const fill = new Uint8Array(mask.length);
        for (let y = c.y; y < c.y + c.h; y++) for (let x = c.x; x < c.x + c.w; x++) { const i = y * w + x; if (labels[i] === c.id) { fill[i] = 1; pending[i] = 0; } }
        total += inpaintPatch(rgba, fill, w, h, seed + c.id, pending);
      }
    }
    return total;
  }

  // ---------------------------------------------------------------- scratches
  /**
   * Vertical line-scratch tracker. The frame is split into horizontal bands;
   * in each band, columns whose horizontal high-pass response is strong,
   * sign-consistent across rows, narrow and locally maximal become candidates.
   * Candidates are linked band to band (allowing drift) and chains spanning a
   * sufficient fraction of the frame are accepted. Scratches from the previous
   * frame lower the threshold nearby, giving frame-to-frame tracking.
   */
  function detectScratches(L, w, h, sensitivity, maxWidth, prior) {
    if (w < 16 || h < 16) return [];
    const s = Math.max(0, Math.min(1, sensitivity));
    const k = Math.max(2, maxWidth + 1);
    const nb = Math.max(6, Math.min(24, Math.round(h / 48)));
    const bandH = h / nb, T = 3 + 22 * (1 - s);
    const priorX = (prior || []).map((p) => p.x);
    const nearPrior = (x) => priorX.some((px) => Math.abs(px - x) <= 4);
    const bands = [];
    const S = new Float32Array(w), P = new Uint32Array(w), N = new Uint32Array(w);
    for (let b = 0; b < nb; b++) {
      const y0 = Math.floor(b * bandH), y1 = Math.min(h, Math.floor((b + 1) * bandH));
      const rows = Math.max(1, y1 - y0);
      S.fill(0); P.fill(0); N.fill(0);
      for (let y = y0; y < y1; y++) {
        const row = y * w;
        for (let x = k; x < w - k; x++) {
          const hp = L[row + x] - 0.5 * (L[row + x - k] + L[row + x + k]);
          S[x] += hp;
          if (hp > T * 0.5) P[x]++; else if (hp < -T * 0.5) N[x]++;
        }
      }
      const cands = [];
      for (let x = k; x < w - k; x++) S[x] /= rows;
      for (let x = k; x < w - k; x++) {
        const v = S[x], a = Math.abs(v);
        if (a < (nearPrior(x) ? T * 0.65 : T)) continue;
        if ((v > 0 ? P[x] : N[x]) / rows < 0.55) continue;
        let isMax = true;
        for (let d = -k; d <= k && isMax; d++) {
          if (!d) continue;
          const xx = x + d; if (xx < k || xx >= w - k) continue;
          const o = Math.abs(S[xx]);
          if (o > a || (o === a && d < 0)) isMax = false;
        }
        if (!isMax) continue;
        let l = x, r = x;
        while (l - 1 >= k && Math.sign(S[l - 1]) === Math.sign(v) && Math.abs(S[l - 1]) > a * 0.5) l--;
        while (r + 1 < w - k && Math.sign(S[r + 1]) === Math.sign(v) && Math.abs(S[r + 1]) > a * 0.5) r++;
        const width = r - l + 1;
        if (width > maxWidth) continue;
        cands.push({ x: (l + r) / 2, width, sign: Math.sign(v), strength: a, y0, y1, band: b });
      }
      bands.push(cands);
    }
    const chains = [];
    for (let b = 0; b < nb; b++) {
      for (const c of bands[b]) {
        let best = null, bd = Infinity;
        for (const ch of chains) {
          const last = ch.points[ch.points.length - 1];
          if (b - last.band > 2 || ch.sign !== c.sign || last.band === b) continue;
          const d = Math.abs(last.x - c.x);
          if (d <= 3 && d < bd) { bd = d; best = ch; }
        }
        if (best) best.points.push(c);
        else chains.push({ sign: c.sign, points: [c] });
      }
    }
    const minBands = Math.max(3, Math.ceil(nb * 0.3));
    return chains.filter((c) => c.points.length >= minBands).map((c) => {
      const xs = c.points.map((p) => p.x);
      return {
        x: xs.reduce((a, v) => a + v, 0) / xs.length,
        width: Math.max(...c.points.map((p) => p.width)),
        sign: c.sign,
        y0: c.points[0].y0, y1: c.points[c.points.length - 1].y1,
        strength: c.points.reduce((a, p) => a + p.strength, 0) / c.points.length,
        points: c.points.map((p) => ({ x: p.x, y0: p.y0, y1: p.y1, width: p.width })),
      };
    });
  }

  function repairScratches(rgba, w, h, scratches, protect, grainSigma, seed) {
    let changed = 0;
    for (const sc of scratches) {
      const pts = sc.points;
      for (let p = 0; p < pts.length; p++) {
        const a = pts[p], b = pts[Math.min(pts.length - 1, p + 1)];
        const yEnd = p < pts.length - 1 ? b.y0 : a.y1;
        const ca = (a.y0 + a.y1) / 2, cb = (b.y0 + b.y1) / 2;
        for (let y = a.y0; y < yEnd; y++) {
          const t = cb > ca ? Math.max(0, Math.min(1, (y - ca) / (cb - ca))) : 0;
          const xc = Math.round(a.x * (1 - t) + b.x * t), half = Math.ceil(Math.max(a.width, b.width) / 2);
          const xl = xc - half - 1, xr = xc + half + 1;
          if (xl < 1 || xr > w - 2) continue;
          if (protect && protect[y * w + xc]) continue;
          const lo = (y * w + xl) * 4, ro = (y * w + xr) * 4;
          const left = [0, 1, 2].map((c) => (rgba[lo + c] + rgba[lo - 4 + c]) / 2);
          const right = [0, 1, 2].map((c) => (rgba[ro + c] + rgba[ro + 4 + c]) / 2);
          for (let x = xl + 1; x < xr; x++) {
            const u = (x - xl) / (xr - xl), o = (y * w + x) * 4;
            const nz = grainSigma ? gauss3(x, y, seed + 7) * grainSigma * ONE : 0;
            for (let c = 0; c < 3; c++) rgba[o + c] = clamp16(left[c] * (1 - u) + right[c] * u + nz);
            changed++;
          }
        }
      }
    }
    return changed;
  }

  // ---------------------------------------------------------------- denoise
  /** Motion-compensated temporal averaging with per-pixel similarity weights. */
  function denoiseTemporal(rgba, refs, w, h, strength) {
    const n = w * h, L = lumaOf(rgba, n);
    const sigma = 2 + 0.22 * strength, inv = 1 / (2 * sigma * sigma);
    const out = new Uint16Array(rgba);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      let r = rgba[j], g = rgba[j + 1], b = rgba[j + 2], ws = 1;
      for (const ref of refs) {
        const d = L[i] - ref.L[i], wt = Math.exp(-d * d * inv);
        if (wt < 0.01) continue;
        r += ref.rgba[j] * wt; g += ref.rgba[j + 1] * wt; b += ref.rgba[j + 2] * wt; ws += wt;
      }
      out[j] = r / ws + 0.5; out[j + 1] = g / ws + 0.5; out[j + 2] = b / ws + 0.5;
    }
    return out;
  }

  /** 5x5 luma-guided bilateral filter with a range-weight lookup table. */
  function denoiseSpatial(rgba, w, h, strength) {
    const n = w * h, L = lumaOf(rgba, n), out = new Uint16Array(rgba);
    const sr = 3 + 0.3 * strength, rw = new Float32Array(256);
    for (let d = 0; d < 256; d++) rw[d] = Math.exp(-(d * d) / (2 * sr * sr));
    const offs = [], sws = [];
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { offs.push(dy * w + dx); sws.push(Math.exp(-(dx * dx + dy * dy) / 4.5)); }
    const mix = Math.min(1, strength / 50);
    for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
      const i = y * w + x, c = L[i];
      let r = 0, g = 0, b = 0, ws = 0;
      for (let k = 0; k < 25; k++) {
        const j = i + offs[k];
        let d = L[j] - c; d = d < 0 ? -d : d;
        const wt = sws[k] * rw[d > 255 ? 255 : d | 0], o = j * 4;
        r += rgba[o] * wt; g += rgba[o + 1] * wt; b += rgba[o + 2] * wt; ws += wt;
      }
      const o = i * 4;
      out[o] = rgba[o] * (1 - mix) + (r / ws) * mix; out[o + 1] = rgba[o + 1] * (1 - mix) + (g / ws) * mix; out[o + 2] = rgba[o + 2] * (1 - mix) + (b / ws) * mix;
    }
    return out;
  }

  // ---------------------------------------------------------------- grade / finish
  function toneLUT(exposure, contrast) {
    const lut = new Uint16Array(65536), f = Math.pow(2, exposure / 25), c = contrast / 50;
    for (let v = 0; v < 65536; v++) {
      let x = Math.pow(Math.pow(v / 65535, 2.2) * f, 1 / 2.2);
      x = 0.5 + (x - 0.5) * (1 + c);
      lut[v] = Math.round(clamp16(x * 65535));
    }
    return lut;
  }

  function grade(rgba, n, p) {
    if (!p.exposure && !p.contrast && !p.saturation) return;
    const lut = toneLUT(p.exposure, p.contrast), sat = 1 + p.saturation / 100;
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      let r = lut[rgba[j]], g = lut[rgba[j + 1]], b = lut[rgba[j + 2]];
      if (sat !== 1) { const l = 0.2126 * r + 0.7152 * g + 0.0722 * b; r = l + (r - l) * sat; g = l + (g - l) * sat; b = l + (b - l) * sat; }
      rgba[j] = clamp16(r); rgba[j + 1] = clamp16(g); rgba[j + 2] = clamp16(b);
    }
  }

  /** Unsharp mask on luma with a small noise threshold. */
  function sharpen(rgba, w, h, amount) {
    if (amount <= 0) return;
    const n = w * h, L = lumaOf(rgba, n), blur = boxBlur(boxBlur(L, w, h, 1), w, h, 1), k = amount / 50;
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      let d = L[i] - blur[i];
      if (d > -1.5 && d < 1.5) continue;
      d *= k * ONE;
      rgba[j] = clamp16(rgba[j] + d); rgba[j + 1] = clamp16(rgba[j + 1] + d); rgba[j + 2] = clamp16(rgba[j + 2] + d);
    }
  }

  /** Deterministic, luminance-weighted, two-scale film grain. */
  function addGrain(rgba, w, h, amount, seed) {
    if (amount <= 0) return;
    const sigma = amount * 0.6;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const j = (y * w + x) * 4;
      const l = (0.2126 * rgba[j] + 0.7152 * rgba[j + 1] + 0.0722 * rgba[j + 2]) / 65535;
      const nz = (gauss3(x, y, seed) * 0.6 + gauss3(x >> 1, y >> 1, seed + 17) * 0.4) * sigma * ONE * (0.35 + 2.6 * l * (1 - l));
      rgba[j] = clamp16(rgba[j] + nz); rgba[j + 1] = clamp16(rgba[j + 1] + nz); rgba[j + 2] = clamp16(rgba[j + 2] + nz);
    }
  }

  // ---------------------------------------------------------------- pipeline
  /**
   * job: { width, height, cur, refs:[RGBA 8- or 16-bit], params, frameIndex }
   * Returns the cacheable analysis consumed by render().
   */
  /**
   * Clean a neighbour before it is used to rebuild a frame: its line
   * scratches and spatially detectable dirt would otherwise be carried into
   * the rebuilt frame (a static scratch would even be doubled by the warp).
   */
  function cleanForInterpolation(rgba, w, h, p) {
    if (!(p.scratch > 0) && !(p.dust > 0)) return rgba;
    const n = w * h, out = new Uint16Array(rgba), L = lumaOf(out, n);
    if (p.dust > 0) {
      const det = detectSpatial(L, w, h, p.dust / 100, Math.min(p.maxSize, 24));
      if (det.mask.some((v) => v)) inpaintSmart(out, dilate(det.mask, w, h, null), w, h, p.grainMatch, 17);
    }
    if (p.scratch > 0) repairScratches(out, w, h, detectScratches(L, w, h, p.scratch / 100, p.scratchWidth, null), null, 0, 23);
    return out;
  }

  /**
   * Motion-compensated frame interpolation: rebuild a missing or destroyed
   * frame halfway between its neighbours. Dense flow from prev to next is
   * estimated (brightness-normalised), then both neighbours are warped half
   * way along it and averaged.
   */
  function interpolateFrame(prev, next, w, h, params) {
    const n = w * h, p = normalizeParams(params);
    const Lp = lumaOf(prev, n), Ln0 = lumaOf(next, n);
    const cs = Math.max(16, Math.round(Math.max(w, h) / 12));
    const pc = cellMeans(Lp, w, h, cs);
    const pre = expandGrid(robustPreGain(pc, cellMeans(Ln0, w, h, cs)), pc.gw, pc.gh, cs, w, h);
    const Ln = new Float32Array(n);
    for (let i = 0; i < n; i++) Ln[i] = Ln0[i] * pre[i];
    const field = estimateMotion(Lp, Ln, w, h, Math.max(8, p.motionRange));
    let flow = interpolateField(field, w, h);
    if (p.flow === 'dense') flow = denseFlow(Lp, Ln, w, h, flow);
    const hx = new Float32Array(n), hy = new Float32Array(n), mx = new Float32Array(n), my = new Float32Array(n);
    for (let i = 0; i < n; i++) { hx[i] = flow.fx[i] * 0.5; hy[i] = flow.fy[i] * 0.5; mx[i] = -hx[i]; my[i] = -hy[i]; }
    const a = warpDense(prev, Lp, mx, my, w, h).rgba, b = warpDense(next, Ln0, hx, hy, w, h).rgba;
    const out = new Uint16Array(n * 4);
    for (let j = 0; j < out.length; j += 4) {
      out[j] = (a[j] + b[j] + 1) >> 1; out[j + 1] = (a[j + 1] + b[j + 1] + 1) >> 1; out[j + 2] = (a[j + 2] + b[j + 2] + 1) >> 1; out[j + 3] = 65535;
    }
    return out;
  }

  /**
   * Global camera / gate motion between two frames as a similarity transform
   * about the frame centre: ref(c + s·R(θ)(x − c) + t) ≈ cur(x). Fitted to the
   * block motion field by iteratively reweighted least squares that discards
   * poorly matched and outlying blocks (moving objects).
   */
  function globalMotion(curL, refL, w, h, range) {
    const field = estimateMotion(curL, refL, w, h, range || 24);
    const { B, bw, bh, vx, vy, cost } = field, cx = w / 2, cy = h / 2;
    const pts = [];
    for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
      const b = by * bw + bx, x = Math.min(w - 1, bx * B + B / 2) - cx, y = Math.min(h - 1, by * B + B / 2) - cy;
      if (bx === 0 || by === 0 || bx === bw - 1 || by === bh - 1) continue;
      pts.push({ x, y, u: x + vx[b], v: y + vy[b], wt: 1 / (1 + cost[b] / 6) });
    }
    let a = 1, bb = 0, tx = 0, ty = 0;
    for (let it = 0; it < 6 && pts.length >= 3; it++) {
      // weighted least squares for u = a x - b y + tx, v = b x + a y + ty
      let S = 0, Sx = 0, Sy = 0, Su = 0, Sv = 0, Sxx = 0, Sxu = 0, Syv = 0, Sxv = 0, Syu = 0;
      for (const q of pts) {
        if (!q.wt) continue;
        const k = q.wt;
        S += k; Sx += k * q.x; Sy += k * q.y; Su += k * q.u; Sv += k * q.v;
        Sxx += k * (q.x * q.x + q.y * q.y); Sxu += k * q.x * q.u; Syv += k * q.y * q.v; Sxv += k * q.x * q.v; Syu += k * q.y * q.u;
      }
      if (S <= 0) break;
      const mx = Sx / S, my = Sy / S, mu = Su / S, mv = Sv / S;
      const varr = Sxx / S - mx * mx - my * my;
      if (varr <= 1e-9) { a = 1; bb = 0; tx = mu - mx; ty = mv - my; break; }
      a = ((Sxu + Syv) / S - (mx * mu + my * mv)) / varr;
      bb = ((Sxv - Syu) / S - (mx * mv - my * mu)) / varr;
      tx = mu - (a * mx - bb * my); ty = mv - (bb * mx + a * my);
      const res = pts.map((q) => Math.hypot(a * q.x - bb * q.y + tx - q.u, bb * q.x + a * q.y + ty - q.v));
      const med = median(res), lim = Math.max(0.75, 2.5 * med);
      pts.forEach((q, k) => { q.wt = res[k] > lim ? 0 : q.wt > 0 ? 1 / (1 + res[k]) : 0; });
    }
    const inliers = pts.filter((q) => q.wt > 0).length;
    // Sub-pixel refinement: robust Gauss-Newton on intensities for the four similarity parameters.
    const ref = refineSimilarity(curL, refL, w, h, { a, bb, tx, ty });
    // accept the refinement only if it stays near the block fit (it is a local optimiser)
    if (Math.hypot(ref.tx - tx, ref.ty - ty) < 2.5 && Math.abs(Math.hypot(ref.a, ref.bb) - Math.hypot(a, bb)) < 0.02) ({ a, bb, tx, ty } = ref);
    return { tx, ty, angle: Math.atan2(bb, a), scale: Math.hypot(a, bb), inliers, blocks: pts.length };
  }

  /**
   * Direct image alignment: minimise sum w(e)·(ref(T(x)) − cur(x))² over the
   * similarity T(x) = c + [a −b; b a](x − c) + t, starting from the block fit.
   * Gradients come from the warped reference; Geman-McClure weights ignore
   * moving objects and blotches. Gives sub-pixel (≈0.05 px) global motion.
   */
  function refineSimilarity(curL, refL, w, h, init) {
    let { a, bb, tx, ty } = init;
    const cx = w / 2, cy = h / 2, step = Math.max(1, Math.round(Math.sqrt((w * h) / 60000))), m = 8;
    const sample = (x, y) => {
      if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return NaN;
      const ix = Math.min(w - 2, x | 0), iy = Math.min(h - 2, y | 0), ax = x - ix, ay = y - iy, i = iy * w + ix;
      return (refL[i] * (1 - ax) + refL[i + 1] * ax) * (1 - ay) + (refL[i + w] * (1 - ax) + refL[i + w + 1] * ax) * ay;
    };
    for (let it = 0; it < 8; it++) {
      const H = new Float64Array(16), g = new Float64Array(4);
      const res = [];
      for (let y = m; y < h - m; y += step) for (let x = m; x < w - m; x += step) {
        const dx = x - cx, dy = y - cy, u = cx + a * dx - bb * dy + tx, v = cy + bb * dx + a * dy + ty;
        const r0 = sample(u, v);
        if (Number.isNaN(r0)) continue;
        res.push(Math.abs(r0 - curL[y * w + x]));
      }
      const tau = Math.max(2, 2.5 * median(res));
      for (let y = m; y < h - m; y += step) for (let x = m; x < w - m; x += step) {
        const dx = x - cx, dy = y - cy, u = cx + a * dx - bb * dy + tx, v = cy + bb * dx + a * dy + ty;
        const r0 = sample(u, v), gu = (sample(u + 1, v) - sample(u - 1, v)) / 2, gv = (sample(u, v + 1) - sample(u, v - 1)) / 2;
        if (Number.isNaN(r0) || Number.isNaN(gu) || Number.isNaN(gv)) continue;
        const e = r0 - curL[y * w + x], q = 1 + (e / tau) ** 2, wt = 1 / (q * q);
        // d(u,v)/d(tx, ty, a, b)
        const J = [gu, gv, gu * dx + gv * dy, -gu * dy + gv * dx];
        for (let r = 0; r < 4; r++) { g[r] += wt * J[r] * e; for (let c = 0; c < 4; c++) H[r * 4 + c] += wt * J[r] * J[c]; }
      }
      // normalise the a/b columns (they scale with distance from centre) and solve
      const d = solve4(H, g);
      if (!d) break;
      tx -= d[0]; ty -= d[1]; a -= d[2]; bb -= d[3];
      if (Math.abs(d[0]) + Math.abs(d[1]) < 1e-3 && Math.abs(d[2]) + Math.abs(d[3]) < 1e-6) break;
    }
    return { a, bb, tx, ty };
  }

  /** Solve the 4x4 system H x = g by Gaussian elimination with partial pivoting (null if singular). */
  function solve4(H, g) {
    const A = [0, 1, 2, 3].map((r) => [H[r * 4], H[r * 4 + 1], H[r * 4 + 2], H[r * 4 + 3], g[r]]);
    for (let c = 0; c < 4; c++) {
      let p = c;
      for (let r = c + 1; r < 4; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
      if (Math.abs(A[p][c]) < 1e-12) return null;
      [A[c], A[p]] = [A[p], A[c]];
      for (let r = 0; r < 4; r++) if (r !== c) { const f = A[r][c] / A[c][c]; for (let k = c; k < 5; k++) A[r][k] -= f * A[c][k]; }
    }
    return A.map((row, r) => row[4] / row[r]);
  }

  /**
   * Resample 16-bit RGBA through a similarity transform about the centre:
   * output(x) = input(c + e^{logScale}·R(angle)·(x − c)/zoom + (tx, ty)).
   * Edges outside the source are filled by edge replication.
   */
  function transformRGBA(rgba, w, h, t) {
    const n = w * h, out = new Uint16Array(n * 4), cx = (w - 1) / 2, cy = (h - 1) / 2;
    const sc = Math.exp(t.logScale || 0) / (t.zoom || 1), ca = Math.cos(t.angle || 0) * sc, sa = Math.sin(t.angle || 0) * sc;
    const W1 = w > 1 ? 1 : 0, H1 = h > 1 ? w : 0;
    for (let y = 0, i = 0; y < h; y++) {
      const dy = y - cy;
      for (let x = 0; x < w; x++, i++) {
        const dx = x - cx;
        let sx = cx + ca * dx - sa * dy + (t.tx || 0), sy = cy + sa * dx + ca * dy + (t.ty || 0);
        sx = sx < 0 ? 0 : sx > w - 1 ? w - 1 : sx; sy = sy < 0 ? 0 : sy > h - 1 ? h - 1 : sy;
        const ix = Math.max(0, Math.min(w - 2, Math.floor(sx))), iy = Math.max(0, Math.min(h - 2, Math.floor(sy)));
        const ax = W1 ? sx - ix : 0, ay = H1 ? sy - iy : 0, i00 = (iy * w + ix) * 4, o = i * 4;
        const w00 = (1 - ax) * (1 - ay), w01 = ax * (1 - ay), w10 = (1 - ax) * ay, w11 = ax * ay, r = W1 * 4, d = H1 * 4;
        for (let c = 0; c < 3; c++) out[o + c] = rgba[i00 + c] * w00 + rgba[i00 + r + c] * w01 + rgba[i00 + d + c] * w10 + rgba[i00 + d + r + c] * w11 + 0.5;
        out[o + 3] = 65535;
      }
    }
    return out;
  }

  /**
   * Turn per-frame global motions into stabilising corrections.
   * motions[f] = globalMotion(frame f, frame f-1) (motions[0] ignored); a new
   * shot starts wherever cuts has f. Returns per-frame { tx, ty, angle, logScale }
   * corrections for transformRGBA. mode 'smooth' keeps intended camera moves
   * (Gaussian path, sigma in frames); 'lock' holds each shot still.
   */
/**
   * Camera path inside a shot: path[k] maps frame (start + k) into the shot's
   * first frame, as a similarity about the centre { tx, ty, angle, logScale }.
   * motions[f] maps frame f into frame f-1 (from the clip scan).
   */
  function motionPath(motions, start, end) {
    const path = [{ tx: 0, ty: 0, angle: 0, logScale: 0 }];
    for (let f = start + 1; f <= end; f++) {
      const prev = path[path.length - 1], m = motions[f] || { tx: 0, ty: 0, angle: 0, scale: 1 };
      const c = Math.cos(prev.angle) * Math.exp(prev.logScale), sn = Math.sin(prev.angle) * Math.exp(prev.logScale);
      path.push({ tx: prev.tx + c * m.tx - sn * m.ty, ty: prev.ty + sn * m.tx + c * m.ty, angle: prev.angle + m.angle, logScale: prev.logScale + Math.log(m.scale || 1) });
    }
    return path;
  }
  /** Transform taking coordinates in frame `cur` to frame `src`, both given by their paths (P_src⁻¹ ∘ P_cur). */
  function relativeTransform(Pcur, Psrc) {
    const dx = Pcur.tx - Psrc.tx, dy = Pcur.ty - Psrc.ty, c = Math.cos(-Psrc.angle) * Math.exp(-Psrc.logScale), sn = Math.sin(-Psrc.angle) * Math.exp(-Psrc.logScale);
    return { tx: c * dx - sn * dy, ty: sn * dx + c * dy, angle: Pcur.angle - Psrc.angle, logScale: Pcur.logScale - Psrc.logScale };
  }

  /**
   * Persistent-defect removal (gate hair, burnt-in subtitles, logos, wires).
   * A defect fixed on screen hides different scene content in every frame
   * once the camera moves, so the hidden pixels are fetched from other frames
   * through the camera path (nearest usable frames first). Each source is
   * level-matched to the current frame on a ring around the region so the
   * patch is seamless. Pixels no frame can reveal are returned for
   * texture synthesis.
   * sources: [{ rgba, t }] where t maps current-frame coordinates into that source.
   */
/**
   * Find the actual defect pixels inside a repair region. A defect is fixed
   * on screen while the scene moves, so in most other frames it either
   * disagrees with the motion-compensated scene, or still matches the same
   * screen position (a uniform defect larger than the camera motion). Clean,
   * textured pixels do neither. Majority vote over sources, then a 1 px margin.
   */
  function refineDefectMask(cur, w, h, region, sources) {
    const n = w * h, votes = new Uint8Array(n), seen = new Uint8Array(n), cx = (w - 1) / 2, cy = (h - 1) / 2;
    const L = (a, j) => 0.2126 * a[j] + 0.7152 * a[j + 1] + 0.0722 * a[j + 2];
    for (const src of sources) {
      const t = src.t, sc = Math.exp(t.logScale || 0), ca = Math.cos(t.angle || 0) * sc, sa = Math.sin(t.angle || 0) * sc, diffs = [], vals = [], stat = [];
      for (let i = 0; i < n; i++) {
        if (!region[i]) continue;
        const x = i % w, y = (i / w) | 0, dx = x - cx, dy = y - cy;
        const sx = cx + ca * dx - sa * dy + (t.tx || 0), sy = cy + sa * dx + ca * dy + (t.ty || 0);
        if (sx < 0 || sy < 0 || sx > w - 1 || sy > h - 1) continue;
        const ix = Math.min(w - 2, sx | 0), iy = Math.min(h - 2, sy | 0), ax = sx - ix, ay = sy - iy, j = (iy * w + ix) * 4;
        const v = (L(src.rgba, j) * (1 - ax) + L(src.rgba, j + 4) * ax) * (1 - ay) + (L(src.rgba, j + w * 4) * (1 - ax) + L(src.rgba, j + w * 4 + 4) * ax) * ay;
        const d = Math.abs(L(cur, i * 4) - v) / 257, ds = Math.abs(L(cur, i * 4) - L(src.rgba, i * 4)) / 257;
        diffs.push(d); vals.push([i, d, ds]); stat.push(ds);
      }
      if (!vals.length) continue;
      const sigma = 1.4826 * median(diffs), thr = Math.max(10, 4 * sigma), still = Math.max(3, 1.5 * sigma);
      const moved = Math.hypot(t.tx || 0, t.ty || 0) >= 2;
      for (const [i, d, ds] of vals) { seen[i]++; if (d > thr || (moved && ds < still)) votes[i]++; }
    }
    const m = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (region[i] && (seen[i] ? votes[i] * 2 > seen[i] : true)) m[i] = 1;
    const grown = dilate(m, w, h, null);
    for (let i = 0; i < n; i++) if (!region[i]) grown[i] = 0;
    return grown;
  }

    function fillFromFrames(cur, w, h, mask, sources, opts) {
    const o = opts || {}, keepClean = o.keepClean !== false;
    const n = w * h, out = new Uint16Array(cur), left = Uint8Array.from(mask), cx = (w - 1) / 2, cy = (h - 1) / 2;
    const cand = new Float32Array(n * 3), has = new Uint8Array(n);
    const ring = [];
    const grown = dilate(dilate(dilate(mask, w, h, null), w, h, null), w, h, null);
    for (let i = 0; i < n; i++) if (grown[i] && !mask[i]) ring.push(i);
    let sigma = 0;
    for (const src of sources) {
      const t = src.t, sc = Math.exp(t.logScale || 0), ca = Math.cos(t.angle || 0) * sc, sa = Math.sin(t.angle || 0) * sc;
      const map = (x, y) => { const dx = x - cx, dy = y - cy; return [cx + ca * dx - sa * dy + (t.tx || 0), cy + sa * dx + ca * dy + (t.ty || 0)]; };
      const sample = (sx, sy, c) => {
        const ix = Math.max(0, Math.min(w - 2, Math.floor(sx))), iy = Math.max(0, Math.min(h - 2, Math.floor(sy))), ax = sx - ix, ay = sy - iy, j = (iy * w + ix) * 4 + c;
        return (src.rgba[j] * (1 - ax) + src.rgba[j + 4] * ax) * (1 - ay) + (src.rgba[j + w * 4] * (1 - ax) + src.rgba[j + w * 4 + 4] * ax) * ay;
      };
      // usable: inside the source frame and not covered by the defect there
      const usable = (sx, sy) => {
        if (sx < 0 || sy < 0 || sx > w - 1 || sy > h - 1) return false;
        const rx = Math.round(sx), ry = Math.round(sy), m = src.mask || mask; // a tracked defect sits elsewhere in each source
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = rx + dx, yy = ry + dy; if (xx >= 0 && yy >= 0 && xx < w && yy < h && m[yy * w + xx]) return false; }
        return true;
      };
      // level match on the ring, and the ring's residual noise for the clean-pixel test
      const off = [0, 0, 0], diffs = [];
      let k = 0;
      for (const i of ring) {
        const [sx, sy] = map(i % w, (i / w) | 0);
        if (!usable(sx, sy)) continue;
        for (let c = 0; c < 3; c++) off[c] += cur[i * 4 + c] - sample(sx, sy, c);
        k++;
      }
      if (k) for (let c = 0; c < 3; c++) off[c] /= k;
      for (const i of ring) {
        const [sx, sy] = map(i % w, (i / w) | 0);
        if (usable(sx, sy)) diffs.push(Math.abs(cur[i * 4 + 1] - sample(sx, sy, 1) - off[1]) / 257);
      }
      if (diffs.length) sigma = Math.max(sigma, 1.4826 * median(diffs));
      for (let i = 0; i < n; i++) {
        if (!left[i]) continue;
        const [sx, sy] = map(i % w, (i / w) | 0);
        if (!usable(sx, sy)) continue;
        for (let c = 0; c < 3; c++) cand[i * 3 + c] = sample(sx, sy, c) + off[c];
        has[i] = 1; left[i] = 0;
      }
      if (!left.some((v) => v)) break;
    }
    // Replace only pixels that really differ from the revealed scene (plus a 1 px margin);
    // clean pixels inside a generous region keep their own grain and detail.
    const thr = Math.max(8, 4 * sigma) * 257, bad = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (!has[i]) continue;
      if (!keepClean) { bad[i] = 1; continue; }
      const l0 = 0.2126 * cur[i * 4] + 0.7152 * cur[i * 4 + 1] + 0.0722 * cur[i * 4 + 2], l1 = 0.2126 * cand[i * 3] + 0.7152 * cand[i * 3 + 1] + 0.0722 * cand[i * 3 + 2];
      if (Math.abs(l0 - l1) > thr) bad[i] = 1;
    }
    const replace = keepClean ? dilate(bad, w, h, null) : bad;
    let filled = 0, replaced = 0;
    for (let i = 0; i < n; i++) {
      if (!has[i]) continue;
      filled++;
      if (!replace[i]) continue;
      for (let c = 0; c < 3; c++) out[i * 4 + c] = clamp16(cand[i * 3 + c] + 0.5);
      replaced++;
    }
    return { rgba: out, filled, replaced, remaining: left };
  }


    function stabilizationPlan(motions, cuts, opts) {
    const o = opts || {}, N = motions.length, sigma = Math.max(0.5, o.smoothing || 12), k = o.strength == null ? 1 : o.strength;
    const path = [], out = new Array(N);
    let start = 0;
    // Exact correction input = P⁻¹(Q(x)) for path P and target Q (both similarity transforms about the centre).
    const correction = (P, Q) => {
      const dx = Q.tx - P.tx, dy = Q.ty - P.ty, c = Math.cos(-P.angle) * Math.exp(-P.logScale), sn = Math.sin(-P.angle) * Math.exp(-P.logScale);
      return { tx: c * dx - sn * dy, ty: sn * dx + c * dy, angle: Q.angle - P.angle, logScale: Q.logScale - P.logScale };
    };
    const flush = (end) => {
      const seg = path.slice(start, end);
      if (!seg.length) return;
      seg.forEach((P, i) => {
        const Q = { tx: 0, ty: 0, angle: 0, logScale: 0 };
        if (o.mode === 'lock') {
          for (const q of seg) for (const key in Q) Q[key] += q[key] / seg.length;
        } else {
          let ws = 0;
          const r = Math.ceil(sigma * 3);
          for (let j = Math.max(0, i - r); j <= Math.min(seg.length - 1, i + r); j++) {
            const wt = Math.exp(-((j - i) ** 2) / (2 * sigma * sigma));
            ws += wt;
            for (const key in Q) Q[key] += seg[j][key] * wt;
          }
          for (const key in Q) Q[key] /= ws;
        }
        const target = {};
        for (const key in Q) target[key] = P[key] + (Q[key] - P[key]) * k;
        out[start + i] = correction(P, target);
      });
    };
    for (let f = 0; f < N; f++) {
      if (f === 0 || (cuts && cuts.has(f)) || !motions[f]) {
        if (f > 0) flush(f);
        start = f;
        path.push({ tx: 0, ty: 0, angle: 0, logScale: 0 });
        continue;
      }
      const prev = path[f - 1], m = motions[f];
      // Compose: frame f maps into frame f-1 by m, frame f-1 into the shot origin by prev.
      const c = Math.cos(prev.angle) * Math.exp(prev.logScale), sn = Math.sin(prev.angle) * Math.exp(prev.logScale);
      path.push({ tx: prev.tx + c * m.tx - sn * m.ty, ty: prev.ty + sn * m.tx + c * m.ty, angle: prev.angle + m.angle, logScale: prev.logScale + Math.log(m.scale || 1) });
    }
    flush(N);
    return out;
  }

  /**
   * Click&Fix: find the defect under a click using the cached analysis, with
   * much higher sensitivity than the automatic pass but only inside the
   * brush circle. Returns indices of pixels to repair.
   */
  function localDetect(an, x, y, r) {
    const w = an.width, h = an.height, x0 = Math.max(1, Math.floor(x - r)), x1 = Math.min(w - 2, Math.ceil(x + r)), y0 = Math.max(1, Math.floor(y - r)), y1 = Math.min(h - 2, Math.ceil(y + r));
    if (x1 < x0 || y1 < y0) return new Int32Array(0);
    const cw = x1 - x0 + 1, ch = y1 - y0 + 1, mask = new Uint8Array(cw * ch), r2 = r * r;
    const inside = (xx, yy) => (xx - x) ** 2 + (yy - y) ** 2 <= r2;
    let found = 0;
    if (an.refs.length >= 2) {
      const La = an.refs[0].matched.L, Lb = an.refs[1].matched.L, Lc = an.Lc;
      const diffs = [];
      for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) { const i = yy * w + xx; diffs.push(Math.abs(La[i] - Lb[i])); }
      const t = Math.max(6, 3 * (1.4826 * median(diffs)) / Math.SQRT2);
      for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) {
        if (!inside(xx, yy)) continue;
        const i = yy * w + xx, ep = Lc[i] - La[i], en = Lc[i] - Lb[i];
        if (ep * en <= 0) continue;
        const m = Math.min(Math.abs(ep), Math.abs(en));
        if (m > t && Math.abs(La[i] - Lb[i]) < Math.max(10, m * 0.6)) { mask[(yy - y0) * cw + xx - x0] = 1; found++; }
      }
    }
    if (!found) {
      const pad = Math.ceil(r), sx0 = Math.max(0, x0 - pad), sy0 = Math.max(0, y0 - pad), sx1 = Math.min(w - 1, x1 + pad), sy1 = Math.min(h - 1, y1 + pad);
      const sw = sx1 - sx0 + 1, sh = sy1 - sy0 + 1, crop = new Float32Array(sw * sh);
      for (let yy = 0; yy < sh; yy++) crop.set(an.Lc.subarray((sy0 + yy) * w + sx0, (sy0 + yy) * w + sx0 + sw), yy * sw);
      const det = detectSpatial(crop, sw, sh, 0.9, Math.min(48, Math.ceil(r * 2)));
      for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) if (inside(xx, yy) && det.mask[(yy - sy0) * sw + xx - sx0]) { mask[(yy - y0) * cw + xx - x0] = 1; found++; }
    }
    if (!found) {
      // Nothing measurable: repair a small disc at the click, as the operator asked.
      const rr = Math.max(1.5, r * 0.5) ** 2;
      for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) if ((xx - x) ** 2 + (yy - y) ** 2 <= rr) mask[(yy - y0) * cw + xx - x0] = 1;
    }
    const grown = dilate(mask, cw, ch, null), idx = [];
    for (let yy = 0; yy < ch; yy++) for (let xx = 0; xx < cw; xx++) if (grown[yy * cw + xx] && inside(xx + x0, yy + y0)) idx.push((yy + y0) * w + xx + x0);
    return Int32Array.from(idx);
  }

  // ---------------------------------------------------------------- colour restoration
  /**
   * Downsampled single-channel structure plane: gradient magnitude, locally
   * normalised. Edges line up across dye records even where the records are
   * anti-correlated (a saturated colour is bright in one, dark in another).
   */
  function normalizedChannel(rgba, w, h, c, ds) {
    const sw = Math.floor(w / ds), sh = Math.floor(h / ds), P = new Float32Array(sw * sh), k = 1 / (257 * ds * ds);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
      let v = 0;
      for (let yy = 0; yy < ds; yy++) for (let xx = 0; xx < ds; xx++) v += rgba[((y * ds + yy) * w + x * ds + xx) * 4 + c];
      P[y * sw + x] = v * k;
    }
    const Gm = new Float32Array(P.length);
    for (let y = 1; y < sh - 1; y++) for (let x = 1; x < sw - 1; x++) { const i = y * sw + x; Gm[i] = Math.hypot(P[i + 1] - P[i - 1], P[i + sw] - P[i - sw]); }
    P.set(boxBlur(Gm, sw, sh, 1));
    const mean = boxBlur(P, sw, sh, 8), sq = new Float32Array(P.length);
    for (let i = 0; i < P.length; i++) sq[i] = P[i] * P[i];
    const msq = boxBlur(sq, sw, sh, 8), out = new Float32Array(P.length);
    for (let i = 0; i < P.length; i++) { const sd = Math.sqrt(Math.max(0, msq[i] - mean[i] * mean[i])); out[i] = 128 + ((P[i] - mean[i]) / (sd + 2)) * 30; }
    return { P: out, w: sw, h: sh };
  }

  /**
   * Colour-separation registration: similarity transforms (shift, rotation,
   * scale) that bring the red and blue records onto the green one. Fixes
   * misregistered three-strip separations, shrunken records and lateral
   * chromatic aberration. Returned transforms map green coordinates into
   * each channel: channel(T(x)) ≈ green(x).
   */
  function estimateChannelAlignment(rgba, w, h, local) {
    const ds = Math.max(1, Math.ceil(Math.max(w, h) / 960));
    const G = normalizedChannel(rgba, w, h, 1, ds), R = normalizedChannel(rgba, w, h, 0, ds), Bc = normalizedChannel(rgba, w, h, 2, ds);
    const fit = (C) => {
      const m = globalMotion(G.P, C.P, G.w, G.h, 12), t = { tx: m.tx * ds, ty: m.ty * ds, angle: m.angle, scale: m.scale, inliers: m.inliers };
      if (local) {
        // Local dewarp: dense flow between the globally aligned record and green
        // (on structure planes) captures non-uniform shrinkage and warping.
        const sw = G.w, sh = G.h, cx = sw / 2, cy = sh / 2, ca = Math.cos(m.angle) * m.scale, sa = Math.sin(m.angle) * m.scale;
        const fx = new Float32Array(sw * sh), fy = new Float32Array(sw * sh);
        for (let y = 0, i = 0; y < sh; y++) for (let x = 0; x < sw; x++, i++) { const dx = x - cx, dy = y - cy; fx[i] = cx + ca * dx - sa * dy + m.tx - x; fy[i] = cy + sa * dx + ca * dy + m.ty - y; }
        const flow = denseFlow(G.P, C.P, sw, sh, { fx, fy }, { iterations: 6, window: 6, maxDeviation: 6 });
        // keep only the local part (dense minus global), in full-resolution pixels
        for (let i = 0; i < sw * sh; i++) { flow.fx[i] = (flow.fx[i] - fx[i]) * ds; flow.fy[i] = (flow.fy[i] - fy[i]) * ds; }
        t.local = { fx: boxBlur(flow.fx, sw, sh, 3), fy: boxBlur(flow.fy, sw, sh, 3), w: sw, h: sh, ds };
      }
      return t;
    };
    return { r: fit(R), b: fit(Bc) };
  }

  function alignChannels(rgba, w, h, al) {
    const out = new Uint16Array(rgba), cx = w / 2, cy = h / 2;
    const W1 = w > 1 ? 4 : 0, H1 = h > 1 ? w * 4 : 0;
    for (const [c, t] of [[0, al.r], [2, al.b]]) {
      if (!t || (!t.local && Math.abs(t.tx) < 0.02 && Math.abs(t.ty) < 0.02 && Math.abs(t.angle) < 1e-5 && Math.abs(t.scale - 1) < 1e-5)) continue;
      const ca = Math.cos(t.angle) * t.scale, sa = Math.sin(t.angle) * t.scale, lf = t.local;
      const localAt = (x, y) => {
        if (!lf) return [0, 0];
        const gx = Math.min(lf.w - 1, Math.max(0, (x + 0.5) / lf.ds - 0.5)), gy = Math.min(lf.h - 1, Math.max(0, (y + 0.5) / lf.ds - 0.5));
        const x0 = Math.min(lf.w - 2, gx | 0), y0 = Math.min(lf.h - 2, gy | 0), ax = gx - x0, ay = gy - y0, k = y0 * lf.w + x0;
        const bil = (F) => (F[k] * (1 - ax) + F[k + 1] * ax) * (1 - ay) + (F[k + lf.w] * (1 - ax) + F[k + lf.w + 1] * ax) * ay;
        return [bil(lf.fx), bil(lf.fy)];
      };
      for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) {
        const [lx, ly] = localAt(x, y), dx = x + lx - cx, dy = y + ly - cy;
        let sx = cx + ca * dx - sa * dy + t.tx, sy = cy + sa * dx + ca * dy + t.ty;
        sx = sx < 0 ? 0 : sx > w - 1 ? w - 1 : sx; sy = sy < 0 ? 0 : sy > h - 1 ? h - 1 : sy;
        const ix = Math.max(0, Math.min(w - 2, Math.floor(sx))), iy = Math.max(0, Math.min(h - 2, Math.floor(sy)));
        const ax = sx - ix, ay = sy - iy, j = (iy * w + ix) * 4 + c;
        out[i * 4 + c] = (rgba[j] * (1 - ax) + rgba[j + W1] * ax) * (1 - ay) + (rgba[j + H1] * (1 - ax) + rgba[j + H1 + W1] * ax) * ay + 0.5;
      }
    }
    return out;
  }

  /** 256-bin histograms of R, G and B (concatenated), sampled every `step` pixels. */
  function channelHistograms(rgba, n, step) {
    const hist = new Float64Array(768), st = Math.max(1, step || 1);
    for (let i = 0; i < n; i += st) { const j = i * 4; hist[rgba[j] >> 8]++; hist[256 + (rgba[j + 1] >> 8)]++; hist[512 + (rgba[j + 2] >> 8)]++; }
    return hist;
  }

  /**
   * Faded-film analysis: per-channel black and white points (robust
   * percentiles) restore the dye range lost to fading, and per-channel gamma
   * brings the channel midtones together, removing the colour cast (e.g. the
   * magenta cast of faded cyan and yellow dyes) without touching neutral tones.
   */
  function fadeLevels(hist, opts) {
    const o = opts || {}, loP = o.low == null ? 0.004 : o.low, hiP = o.high == null ? 0.996 : o.high;
    const lo = [], hi = [], med = [];
    for (let c = 0; c < 3; c++) {
      let total = 0;
      for (let b = 0; b < 256; b++) total += hist[c * 256 + b];
      const pct = (q) => { let acc = 0; for (let b = 0; b < 256; b++) { acc += hist[c * 256 + b]; if (acc >= q * total) return (b + 0.5) * 257; } return 65535; };
      lo.push(pct(loP)); hi.push(Math.max(pct(hiP), pct(loP) + 2570)); med.push(pct(0.5));
    }
    const stretched = med.map((m, c) => Math.max(0.02, Math.min(0.98, (m - lo[c]) / (hi[c] - lo[c]))));
    const target = Math.exp(stretched.reduce((a, v) => a + Math.log(v), 0) / 3);
    const gamma = stretched.map((m) => Math.max(0.4, Math.min(2.5, Math.log(target) / Math.log(m))));
    return { lo, hi, gamma };
  }

  function applyLevels(rgba, n, lv, strength) {
    const k = Math.max(0, Math.min(1, strength == null ? 1 : strength));
    const luts = [0, 1, 2].map((c) => {
      const lut = new Uint16Array(65536), lo = lv.lo[c], span = Math.max(1, lv.hi[c] - lo), g = lv.gamma[c];
      for (let v = 0; v < 65536; v++) {
        const x = Math.max(0, Math.min(1, (v - lo) / span)), y = Math.pow(x, g) * 65535;
        lut[v] = clamp16(v + (y - v) * k + 0.5);
      }
      return lut;
    });
    for (let i = 0, j = 0; i < n; i++, j += 4) { rgba[j] = luts[0][rgba[j]]; rgba[j + 1] = luts[1][rgba[j + 1]]; rgba[j + 2] = luts[2][rgba[j + 2]]; }
  }

  // ---------------------------------------------------------------- colourisation
  /** Multi-source Dijkstra on the pixel grid; step cost 1 + lambda·|ΔY| (geodesic distance). */
  function geodesicDistance(Y, w, h, seeds, lambda) {
    const n = w * h, dist = new Float64Array(n).fill(Infinity); // 64-bit: must compare exactly with the heap keys
    let cap = Math.max(1024, seeds.length * 4), keys = new Float64Array(cap), vals = new Int32Array(cap), size = 0;
    const push = (k, v) => {
      if (size === cap) { cap *= 2; const nk = new Float64Array(cap), nv = new Int32Array(cap); nk.set(keys); nv.set(vals); keys = nk; vals = nv; }
      let i = size++;
      while (i > 0) { const p = (i - 1) >> 1; if (keys[p] <= k) break; keys[i] = keys[p]; vals[i] = vals[p]; i = p; }
      keys[i] = k; vals[i] = v;
    };
    const pop = () => {
      const v = vals[0], lk = keys[--size], lv = vals[size];
      let i = 0;
      for (;;) { let c = 2 * i + 1; if (c >= size) break; if (c + 1 < size && keys[c + 1] < keys[c]) c++; if (keys[c] >= lk) break; keys[i] = keys[c]; vals[i] = vals[c]; i = c; }
      keys[i] = lk; vals[i] = lv;
      return v;
    };
    for (const s0 of seeds) { dist[s0] = 0; push(0, s0); }
    while (size) {
      const d0 = keys[0], i = pop();
      if (d0 > dist[i]) continue;
      const x = i % w, yc = Y[i];
      const relax = (j) => { const nd = d0 + 1 + lambda * Math.abs(Y[j] - yc); if (nd < dist[j]) { dist[j] = nd; push(nd, j); } };
      if (x > 0) relax(i - 1);
      if (x < w - 1) relax(i + 1);
      if (i >= w) relax(i - w);
      if (i < n - w) relax(i + w);
    }
    return dist;
  }

  /**
   * Geodesic chrominance blending (Yatziv & Sapiro, "Fast image and video
   * colorization using chrominance blending"). Hint colours are clustered;
   * each cluster's geodesic distance map (cost grows across luminance edges)
   * weights its chroma by d^-b. Sparse scribbles flood their own regions and
   * do not bleed across edges. Solved at ≤960 px and upsampled (chroma is
   * low-frequency); hint pixels stay exact.
   * Y: luma 0..1; hints: { u, v, m } (Float32 chroma, Uint8 mask).
   */
  function propagateChroma(Y, w, h, hints, opts) {
    const o = opts || {}, lambda = o.lambda || 1500, b = o.power || 4;
    const ds = Math.max(1, Math.ceil(Math.max(w, h) / 960)), sw = Math.ceil(w / ds), sh = Math.ceil(h / ds), sn = sw * sh;
    const sY = new Float32Array(sn), su = new Float32Array(sn), sv = new Float32Array(sn), sm = new Uint8Array(sn), cnt = new Float32Array(sn), hc = new Float32Array(sn);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, j = ((y / ds) | 0) * sw + ((x / ds) | 0);
      sY[j] += Y[i]; cnt[j]++;
      if (hints.m[i]) { su[j] += hints.u[i]; sv[j] += hints.v[i]; hc[j]++; }
    }
    for (let j = 0; j < sn; j++) { sY[j] /= cnt[j] || 1; if (hc[j]) { su[j] /= hc[j]; sv[j] /= hc[j]; sm[j] = 1; } }
    const clusters = new Map();
    for (let j = 0; j < sn; j++) if (sm[j]) {
      const key = `${Math.round(su[j] / 0.03)},${Math.round(sv[j] / 0.03)}`;
      let c = clusters.get(key);
      if (!c) { c = { u: 0, v: 0, k: 0, seeds: [] }; clusters.set(key, c); }
      c.u += su[j]; c.v += sv[j]; c.k++; c.seeds.push(j);
    }
    const U = new Float32Array(sn), V = new Float32Array(sn), Wt = new Float32Array(sn);
    for (const c of clusters.values()) {
      const cu = c.u / c.k, cv = c.v / c.k, d = geodesicDistance(sY, sw, sh, c.seeds, lambda);
      for (let j = 0; j < sn; j++) { const wt = Math.pow(d[j] + 1, -b); U[j] += wt * cu; V[j] += wt * cv; Wt[j] += wt; }
    }
    for (let j = 0; j < sn; j++) if (Wt[j] > 0) { U[j] /= Wt[j]; V[j] /= Wt[j]; }
    const u = new Float32Array(w * h), v = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const fy = Math.min(sh - 1, Math.max(0, (y + 0.5) / ds - 0.5)), y0 = Math.floor(fy), y1 = Math.min(sh - 1, y0 + 1), ay = fy - y0;
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (hints.m[i]) { u[i] = hints.u[i]; v[i] = hints.v[i]; continue; }
        const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) / ds - 0.5)), x0 = Math.floor(fx), x1 = Math.min(sw - 1, x0 + 1), ax = fx - x0;
        const a = y0 * sw + x0, bb = y0 * sw + x1, c = y1 * sw + x0, d = y1 * sw + x1;
        u[i] = (U[a] * (1 - ax) + U[bb] * ax) * (1 - ay) + (U[c] * (1 - ax) + U[d] * ax) * ay;
        v[i] = (V[a] * (1 - ax) + V[bb] * ax) * (1 - ay) + (V[c] * (1 - ax) + V[d] * ax) * ay;
      }
    }
    return { u, v };
  }

  /** Chroma (BT.709 Cb/Cr, 0-centred) of an RGB triple in 0..1. */
  function rgbToChroma(r, g, b) { const y = 0.2126 * r + 0.7152 * g + 0.0722 * b; return [(b - y) / 1.8556, (r - y) / 1.5748]; }

  /**
   * Colourise (or re-colour) a frame from sparse hints while keeping its
   * luminance: result = Y of the frame + propagated chroma, mixed with the
   * frame's own chroma by `strength`.
   */
  function colorizeFrame(rgba, w, h, hints, strength) {
    const n = w * h, Y = new Float32Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) Y[i] = (0.2126 * rgba[j] + 0.7152 * rgba[j + 1] + 0.0722 * rgba[j + 2]) / 65535;
    const { u, v } = propagateChroma(Y, w, h, hints);
    const k = Math.max(0, Math.min(1, strength == null ? 1 : strength));
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const r0 = rgba[j] / 65535, g0 = rgba[j + 1] / 65535, b0 = rgba[j + 2] / 65535, y = Y[i];
      const [cu, cv] = rgbToChroma(r0, g0, b0), U = cu + (u[i] - cu) * k, V = cv + (v[i] - cv) * k;
      const r = y + 1.5748 * V, b = y + 1.8556 * U, g = (y - 0.2126 * r - 0.0722 * b) / 0.7152;
      rgba[j] = clamp16(r * 65535 + 0.5); rgba[j + 1] = clamp16(g * 65535 + 0.5); rgba[j + 2] = clamp16(b * 65535 + 0.5);
    }
  }

  // ---------------------------------------------------------------- clip assessment
  /**
   * Damaged-frame detection for a clip scan. For each frame, compare it with
   * the average of its motion-compensated neighbours (brightness-normalised so
   * flicker is ignored). A frame that disagrees with both neighbours while they
   * agree with each other is a splice, burn, tear or missing-frame candidate.
   * smalls: per-frame luma at low resolution; shifts[f]: translation mapping
   * frame f into frame f-1 at that resolution (from the scan); cuts: shot starts.
   */
  function frameOutliers(smalls, w, h, shifts, cuts) {
    const N = smalls.length, scores = new Float32Array(N), diffs = new Float32Array(N), b = 2;
    const sample = (L, x, y) => {
      x = x < 0 ? 0 : x > w - 1 ? w - 1 : x; y = y < 0 ? 0 : y > h - 1 ? h - 1 : y;
      const ix = Math.min(w - 2, x | 0), iy = Math.min(h - 2, y | 0), ax = x - ix, ay = y - iy, i = iy * w + ix;
      return (L[i] * (1 - ax) + L[i + 1] * ax) * (1 - ay) + (L[i + w] * (1 - ax) + L[i + w + 1] * ax) * ay;
    };
    // Each frame is normalised to zero mean and unit contrast, so flicker and flashes are not damage.
    const stats = (L) => { let s0 = 0, s1 = 0; for (const v of L) { s0 += v; s1 += v * v; } const m = s0 / L.length; return [m, Math.sqrt(Math.max(1e-6, s1 / L.length - m * m))]; };
    for (let f = 1; f < N - 1; f++) {
      if ((cuts && (cuts.has(f) || cuts.has(f + 1))) || !smalls[f - 1] || !smalls[f + 1]) continue;
      const tp = shifts[f] || { tx: 0, ty: 0 }, tn = shifts[f + 1] || { tx: 0, ty: 0 };
      const C = smalls[f], P = smalls[f - 1], Nx = smalls[f + 1];
      const [mc, sc] = stats(C), [mp, sp] = stats(P), [mn, sn] = stats(Nx), k = (sc + sp + sn) / 3;
      let dc = 0, dpn = 0, cnt = 0;
      for (let y = b; y < h - b; y++) for (let x = b; x < w - b; x++) {
        const p = ((sample(P, x + tp.tx, y + tp.ty) - mp) / sp) * k, q = ((sample(Nx, x - tn.tx, y - tn.ty) - mn) / sn) * k, c = ((C[y * w + x] - mc) / sc) * k;
        dc += Math.abs(c - (p + q) / 2); dpn += Math.abs(p - q); cnt++;
      }
      dc /= cnt; dpn /= cnt;
      diffs[f] = dc; scores[f] = dc / (dpn / 2 + 1.5);
    }
    return { scores, diffs, suspects: [...scores.keys()].filter((f) => scores[f] > 3 && diffs[f] > 4) };
  }

  // ---------------------------------------------------------------- keyframed parameters
  /**
   * Parameter animation. keys: [{ frame, params }] sorted by frame. Numeric
   * parameters interpolate linearly or with a Catmull-Rom curve (clamped
   * between the bracketing keys so curves never overshoot a setting);
   * non-numeric parameters hold the previous key's value.
   */
  function interpolateKeyframes(keys, i, mode) {
    if (!keys || !keys.length) return null;
    if (i <= keys[0].frame) return Object.assign({}, keys[0].params);
    const last = keys[keys.length - 1];
    if (i >= last.frame) return Object.assign({}, last.params);
    let k = 0;
    while (k < keys.length - 2 && keys[k + 1].frame <= i) k++;
    const a = keys[k], b = keys[k + 1], t = (i - a.frame) / (b.frame - a.frame), out = {};
    const p0 = keys[Math.max(0, k - 1)], p3 = keys[Math.min(keys.length - 1, k + 2)];
    for (const key of Object.keys(a.params)) {
      const va = a.params[key], vb = b.params[key];
      if (typeof va !== 'number' || typeof vb !== 'number') { out[key] = va; continue; }
      if (mode === 'smooth') {
        const v0 = typeof p0.params[key] === 'number' ? p0.params[key] : va, v3 = typeof p3.params[key] === 'number' ? p3.params[key] : vb;
        const t2 = t * t, t3 = t2 * t;
        const v = 0.5 * (2 * va + (-v0 + vb) * t + (2 * v0 - 5 * va + 4 * vb - v3) * t2 + (-v0 + 3 * va - 3 * vb + v3) * t3);
        out[key] = Math.max(Math.min(va, vb), Math.min(Math.max(va, vb), v));
      } else out[key] = va + (vb - va) * t;
    }
    return out;
  }

  /** Luma, brightness pre-normalisation and block motion for every reference (CPU). */
  function motionPrep(job, opts) {
    const defer = opts && opts.deferMotion;
    const w = job.width, h = job.height, n = w * h, p = normalizeParams(job.params);
    const replaced = job.replace && job.refs && job.refs.length === 2;
    let cur = replaced ? interpolateFrame(cleanForInterpolation(toU16(job.refs[0]), w, h, p), cleanForInterpolation(toU16(job.refs[1]), w, h, p), w, h, p) : toU16(job.cur), chroma = null;
    if (p.chromaAlign) { chroma = estimateChannelAlignment(cur, w, h, p.chromaLocal); cur = alignChannels(cur, w, h, chroma); }
    const Lc = lumaOf(cur, n);
    const cs = Math.max(16, Math.round(Math.max(w, h) / 12));
    const curCells = cellMeans(Lc, w, h, cs);
    const refs = [];
    for (const ref0 of (job.refs || []).filter(Boolean)) {
      let ref = toU16(ref0);
      if (p.chromaAlign) ref = alignChannels(ref, w, h, estimateChannelAlignment(ref, w, h, p.chromaLocal));
      const Lr = lumaOf(ref, n);
      if (p.motion && p.motionRange > 0) {
        // Normalise local brightness first so flicker does not corrupt motion search.
        const pre = expandGrid(robustPreGain(curCells, cellMeans(Lr, w, h, cs)), curCells.gw, curCells.gh, cs, w, h);
        const Ln = new Float32Array(n);
        for (let i = 0; i < n; i++) Ln[i] = Lr[i] * pre[i];
        if (defer) { refs.push({ ref, Lr, Ln, field: null, init: null, deferred: true }); continue; }
        const field = estimateMotion(Lc, Ln, w, h, p.motionRange);
        refs.push({ ref, Lr, Ln, field, init: interpolateField(field, w, h) });
      } else refs.push({ ref, Lr });
    }
    return { p, cur, Lc, cs, curCells, refs, chroma };
  }

  /**
   * Full CPU analysis, or the remainder of a GPU-assisted one when `pre`
   * carries { prep, flows } computed elsewhere.
   */
  function analyze(job, pre) {
    const t0 = now(), w = job.width, h = job.height, n = w * h;
    const prep = (pre && pre.prep) || motionPrep(job), p = prep.p;
    const refs = [];
    let conf = 0, motion = 0, regBlock = 0, regDense = 0;
    prep.refs.forEach((r, k) => {
      let warped;
      if (r.field) {
        let flow = r.init;
        if (p.flow === 'dense') {
          regBlock += flow ? flowError(prep.Lc, r.Ln, flow.fx, flow.fy, w, h) : fieldError(prep.Lc, r.Ln, r.field, w, h);
          flow = pre && pre.flows ? pre.flows[k] : denseFlow(prep.Lc, r.Ln, w, h, flow);
          regDense += flowError(prep.Lc, r.Ln, flow.fx, flow.fy, w, h);
        }
        warped = warpDense(r.ref, r.Lr, flow.fx, flow.fy, w, h);
        conf += r.field.confidence; motion += r.field.meanMotion;
      } else warped = { rgba: r.ref, L: r.Lr };
      const matched = brightnessMatch(warped, prep.Lc, prep.curCells, w, h);
      refs.push({ matched, field: r.field ? { meanMotion: r.field.meanMotion, confidence: r.field.confidence } : null });
    });
    const motionOn = refs.length && p.motion && p.motionRange > 0;
    return {
      width: w, height: h, Lc: prep.Lc, curCells: prep.curCells, refs, cur: prep.cur, chroma: prep.chroma,
      motionConfidence: motionOn ? conf / refs.length : null,
      meanMotion: motionOn ? motion / refs.length : 0,
      registration: motionOn && p.flow === 'dense' ? { block: regBlock / refs.length, dense: regDense / refs.length } : null,
      accel: pre && pre.flows ? 'gpu' : 'cpu', gpuMs: pre && pre.gpuMs,
      ms: now() - t0 + ((pre && pre.prepMs) || 0),
    };
  }

  /** Analysis with the dense-flow solve on the GPU when an accelerator is available. */
  async function analyzeAsync(job, accel) {
    const p = normalizeParams(job.params);
    if (!accel || accel.lost || !p.motion || p.motionRange <= 0 || p.flow !== 'dense' || !accel.fits(job.width, job.height)) return analyze(job);
    const t0 = now(), prep = motionPrep(job, { deferMotion: !!accel.motionFlow }), prepMs = now() - t0, flows = [];
    const g0 = now();
    try {
      for (const r of prep.refs) {
        if (r.deferred) { const mf = await accel.motionFlow(prep.Lc, r.Ln, job.width, job.height, p.motionRange); r.field = mf.field; flows.push(mf.flow); }
        else flows.push(await accel.denseFlow(prep.Lc, r.Ln, job.width, job.height, r.init));
      }
    } catch (err) {
      accel.lost = true;
      return analyze(job);
    }
    return analyze(job, { prep, flows, gpuMs: now() - g0, prepMs: prepMs + now() - g0 });
  }

  // ---------------------------------------------------------------- WebGPU acceleration
  const WGSL_COMMON = `
struct Params { w: u32, h: u32, r: i32, planes: u32, dir: u32, tau: f32, lambda: f32, maxDev: f32 };
@group(0) @binding(0) var<uniform> p: Params;
`;
  const WGSL_BLOCK = `
struct M { lw: u32, lh: u32, bw: u32, bh: u32, B: u32, scale: u32, bs: u32, R: i32, step: u32, isL0: u32, scaleUp: f32, pad: u32 };
@group(0) @binding(0) var<uniform> m: M;
@group(0) @binding(1) var<storage, read> cur: array<f32>;
@group(0) @binding(2) var<storage, read> refp: array<f32>; // 'ref' is reserved in WGSL
fn sad(x0: i32, y0: i32, bs: i32, dx: i32, dy: i32, step: i32, limit: f32) -> f32 {
  let w = i32(m.lw); let h = i32(m.lh);
  let x1 = min(w, x0 + bs); let y1 = min(h, y0 + bs);
  var s = 0.0;
  for (var y = y0; y < y1; y += step) {
    let ry = clamp(y + dy, 0, h - 1);
    for (var x = x0; x < x1; x += step) { let rx = clamp(x + dx, 0, w - 1); s += abs(cur[y * w + x] - refp[ry * w + rx]); }
    if (s > limit) { return s; }
  }
  return s;
}
`;
  const WGSL_SEARCH = WGSL_BLOCK + `
@group(0) @binding(3) var<storage, read_write> outv: array<vec2<f32>>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  let b = g.x;
  if (b >= m.bw * m.bh) { return; }
  let bx = b % m.bw; let by = b / m.bw;
  let x0 = i32(min(m.lw - 1u, (bx * m.B) / m.scale)); let y0 = i32(min(m.lh - 1u, (by * m.B) / m.scale));
  let bs = i32(m.bs);
  let count = f32(max(1, min(bs, i32(m.lw) - x0) * min(bs, i32(m.lh) - y0)));
  let lambda = 0.35 * count;
  var best = sad(x0, y0, bs, 0, 0, 1, 3.0e38); var bdx = 0; var bdy = 0;
  for (var dy = -m.R; dy <= m.R; dy++) {
    for (var dx = -m.R; dx <= m.R; dx++) {
      if (dx == 0 && dy == 0) { continue; }
      let pen = lambda * f32(abs(dx) + abs(dy));
      if (pen >= best) { continue; }
      let s = sad(x0, y0, bs, dx, dy, 1, best - pen) + pen;
      if (s < best) { best = s; bdx = dx; bdy = dy; }
    }
  }
  outv[b] = vec2<f32>(f32(bdx), f32(bdy));
}`;
  const WGSL_REFINE = WGSL_BLOCK + `
@group(0) @binding(3) var<storage, read> prev: array<vec2<f32>>;
@group(0) @binding(4) var<storage, read_write> outv: array<vec2<f32>>;
@group(0) @binding(5) var<storage, read_write> cost: array<f32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  let b = g.x;
  if (b >= m.bw * m.bh) { return; }
  let bx = i32(b % m.bw); let by = i32(b / m.bw); let bw = i32(m.bw); let bh = i32(m.bh);
  let x0 = (bx * i32(m.B)) / i32(m.scale); let y0 = (by * i32(m.B)) / i32(m.scale);
  let pv = prev[b] * m.scaleUp;
  if (x0 >= i32(m.lw) || y0 >= i32(m.lh)) { outv[b] = pv; return; }
  let bs = i32(m.bs); let step = i32(m.step);
  let cx = min(bs, i32(m.lw) - x0); let cy = min(bs, i32(m.lh) - y0);
  let count = f32(max(1, ((cx + step - 1) / step) * ((cy + step - 1) / step)));
  let lambda = 0.15 * count;
  var cands: array<vec2<i32>, 6>;
  var nc = 0;
  cands[nc] = vec2<i32>(i32(pv.x), i32(pv.y)); nc++;
  cands[nc] = vec2<i32>(0, 0); nc++;
  if (bx > 0) { let q = prev[b - 1u] * m.scaleUp; cands[nc] = vec2<i32>(i32(q.x), i32(q.y)); nc++; }
  if (bx < bw - 1) { let q = prev[b + 1u] * m.scaleUp; cands[nc] = vec2<i32>(i32(q.x), i32(q.y)); nc++; }
  if (by > 0) { let q = prev[b - m.bw] * m.scaleUp; cands[nc] = vec2<i32>(i32(q.x), i32(q.y)); nc++; }
  if (by < bh - 1) { let q = prev[b + m.bw] * m.scaleUp; cands[nc] = vec2<i32>(i32(q.x), i32(q.y)); nc++; }
  var best = 3.0e38; var bdx = 0; var bdy = 0;
  for (var k = 0; k < nc; k++) {
    let c = cands[k]; let pen = lambda * f32(abs(c.x) + abs(c.y));
    let s = sad(x0, y0, bs, c.x, c.y, step, best) + pen;
    if (s < best) { best = s; bdx = c.x; bdy = c.y; }
  }
  for (var it = 0; it < 3; it++) {
    var moved = false; let cx0 = bdx; let cy0 = bdy;
    for (var dy = -1; dy <= 1; dy++) {
      for (var dx = -1; dx <= 1; dx++) {
        if (dx == 0 && dy == 0) { continue; }
        let tx = cx0 + dx; let ty = cy0 + dy; let pen = lambda * f32(abs(tx) + abs(ty));
        let s = sad(x0, y0, bs, tx, ty, step, best) + pen;
        if (s < best) { best = s; bdx = tx; bdy = ty; moved = true; }
      }
    }
    if (!moved) { break; }
  }
  outv[b] = vec2<f32>(f32(bdx), f32(bdy));
  if (m.isL0 == 1u) { cost[b] = (best - lambda * f32(abs(bdx) + abs(bdy))) / count; }
}`;
  const WGSL_INTERP = `
struct M { lw: u32, lh: u32, bw: u32, bh: u32, B: u32, scale: u32, bs: u32, R: i32, step: u32, isL0: u32, scaleUp: f32, pad: u32 };
@group(0) @binding(0) var<uniform> m: M;
@group(0) @binding(1) var<storage, read> vecs: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read_write> flow: array<f32>;
@group(0) @binding(3) var<storage, read_write> flow0: array<f32>;
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= m.lw || g.y >= m.lh) { return; }
  let n = m.lw * m.lh; let i = g.y * m.lw + g.x; let Bf = f32(m.B);
  let fx = (f32(g.x) + 0.5) / Bf - 0.5; let fy = (f32(g.y) + 0.5) / Bf - 0.5;
  let i0 = floor(fx); let j0 = floor(fy);
  let tx = clamp(fx - i0, 0.0, 1.0); let ty = clamp(fy - j0, 0.0, 1.0);
  let bwm = i32(m.bw) - 1; let bhm = i32(m.bh) - 1;
  let a0 = u32(clamp(i32(i0), 0, bwm)); let a1 = u32(clamp(i32(i0) + 1, 0, bwm));
  let r0 = u32(clamp(i32(j0), 0, bhm)) * m.bw; let r1 = u32(clamp(i32(j0) + 1, 0, bhm)) * m.bw;
  let v = (vecs[r0 + a0] * (1.0 - tx) + vecs[r0 + a1] * tx) * (1.0 - ty) + (vecs[r1 + a0] * (1.0 - tx) + vecs[r1 + a1] * tx) * ty;
  flow[i] = v.x; flow[n + i] = v.y; flow0[i] = v.x; flow0[n + i] = v.y;
}`;
  const WGSL = {
    warp: WGSL_COMMON + `
@group(0) @binding(1) var<storage, read> src: array<f32>;
@group(0) @binding(2) var<storage, read> flow: array<f32>;
@group(0) @binding(3) var<storage, read_write> dst: array<f32>;
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= p.w || g.y >= p.h) { return; }
  let n = p.w * p.h; let i = g.y * p.w + g.x;
  let W = f32(p.w); let H = f32(p.h);
  let sx = clamp(f32(g.x) + flow[i], 0.0, W - 1.0);
  let sy = clamp(f32(g.y) + flow[n + i], 0.0, H - 1.0);
  let ix = u32(clamp(floor(sx), 0.0, max(W - 2.0, 0.0)));
  let iy = u32(clamp(floor(sy), 0.0, max(H - 2.0, 0.0)));
  let ax = select(0.0, sx - f32(ix), p.w > 1u);
  let ay = select(0.0, sy - f32(iy), p.h > 1u);
  let W1 = select(0u, 1u, p.w > 1u); let H1 = select(0u, p.w, p.h > 1u);
  let i00 = iy * p.w + ix;
  dst[i] = (src[i00] * (1.0 - ax) + src[i00 + W1] * ax) * (1.0 - ay) + (src[i00 + H1] * (1.0 - ax) + src[i00 + H1 + W1] * ax) * ay;
}`,
    products: WGSL_COMMON + `
@group(0) @binding(1) var<storage, read> lw: array<f32>;
@group(0) @binding(2) var<storage, read> cur: array<f32>;
@group(0) @binding(3) var<storage, read_write> prod: array<f32>;
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= p.w || g.y >= p.h) { return; }
  let n = p.w * p.h; let i = g.y * p.w + g.x;
  var a = 0.0; var b = 0.0; var c = 0.0; var d = 0.0; var e = 0.0;
  if (g.x >= 1u && g.y >= 1u && g.x + 1u < p.w && g.y + 1u < p.h) {
    let gx = (lw[i + 1u] - lw[i - 1u]) * 0.5;
    let gy = (lw[i + p.w] - lw[i - p.w]) * 0.5;
    let et = lw[i] - cur[i];
    let u = et / p.tau; let q = 1.0 + u * u; let wt = 1.0 / (q * q);
    a = wt * gx * gx; b = wt * gx * gy; c = wt * gy * gy; d = wt * gx * et; e = wt * gy * et;
  }
  prod[i] = a; prod[n + i] = b; prod[2u * n + i] = c; prod[3u * n + i] = d; prod[4u * n + i] = e;
}`,
    blur: WGSL_COMMON + `
@group(0) @binding(1) var<storage, read> src: array<f32>;
@group(0) @binding(2) var<storage, read_write> dst: array<f32>;
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= p.w || g.y >= p.h || g.z >= p.planes) { return; }
  let n = p.w * p.h; let base = g.z * n;
  var s = 0.0;
  for (var k = -p.r; k <= p.r; k++) {
    if (p.dir == 0u) {
      let xx = u32(clamp(i32(g.x) + k, 0, i32(p.w) - 1));
      s += src[base + g.y * p.w + xx];
    } else {
      let yy = u32(clamp(i32(g.y) + k, 0, i32(p.h) - 1));
      s += src[base + yy * p.w + g.x];
    }
  }
  dst[base + g.y * p.w + g.x] = s / f32(2 * p.r + 1);
}`,
    solve: WGSL_COMMON + `
@group(0) @binding(1) var<storage, read> B: array<f32>;
@group(0) @binding(2) var<storage, read_write> flow: array<f32>;
@group(0) @binding(3) var<storage, read> flow0: array<f32>;
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= p.w || g.y >= p.h) { return; }
  let n = p.w * p.h; let i = g.y * p.w + g.x;
  let a = B[i] + p.lambda; let b = B[n + i]; let d = B[2u * n + i] + p.lambda;
  let det = a * d - b * b;
  if (det <= 1e-6) { return; }
  let du = clamp(-(d * B[3u * n + i] - b * B[4u * n + i]) / det, -1.0, 1.0);
  let dv = clamp(-(a * B[4u * n + i] - b * B[3u * n + i]) / det, -1.0, 1.0);
  flow[i] = clamp(flow[i] + du, flow0[i] - p.maxDev, flow0[i] + p.maxDev);
  flow[n + i] = clamp(flow[n + i] + dv, flow0[n + i] - p.maxDev, flow0[n + i] + p.maxDev);
}`,
  };

  /**
   * Create a WebGPU accelerator for the dense optical-flow solver, or null when
   * WebGPU is unavailable. Works on the main thread and in Web Workers.
   */
  async function createGPU() {
    try {
      const nav = typeof navigator !== 'undefined' ? navigator : null;
      if (!nav || !nav.gpu) return null;
      const adapter = await nav.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) return null;
      const L = adapter.limits;
      const device = await adapter.requestDevice({ requiredLimits: { maxStorageBufferBindingSize: L.maxStorageBufferBindingSize, maxBufferSize: L.maxBufferSize } });
      const info = adapter.info || {};
      const accel = {
        lost: false,
        name: [info.vendor, info.architecture, info.description].filter(Boolean).join(' ') || 'WebGPU',
        fallback: !!adapter.isFallbackAdapter,
        fits: (w, h) => w * h * 5 * 4 <= Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize),
        destroy: () => { accel.lost = true; device.destroy(); },
      };
      device.lost.then(() => { accel.lost = true; });
      const U = GPUBufferUsage;
      const pipes = {};
      device.pushErrorScope('validation');
      for (const [k, code] of Object.entries(Object.assign({}, WGSL, { bsearch: WGSL_SEARCH, brefine: WGSL_REFINE, binterp: WGSL_INTERP })))
        pipes[k] = device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code }), entryPoint: 'main' } });
      const shaderError = await device.popErrorScope();
      if (shaderError) throw new Error('WebGPU shader validation failed: ' + shaderError.message); // fall back to the CPU
      let bufs = null;
      const ensure = (w, h) => {
        if (bufs && bufs.w === w && bufs.h === h) return bufs;
        if (bufs) for (const b of Object.values(bufs)) if (b && b.destroy) b.destroy();
        const n = w * h, mk = (len, usage) => device.createBuffer({ size: len * 4, usage });
        const S = U.STORAGE | U.COPY_DST | U.COPY_SRC;
        bufs = {
          w, h, cur: mk(n, S), ref: mk(n, S), flow: mk(2 * n, S), flow0: mk(2 * n, S), lw: mk(n, S),
          prod: mk(5 * n, S), tmp: mk(5 * n, S), out: mk(2 * n, S), read: mk(2 * n, U.MAP_READ | U.COPY_DST),
        };
        return bufs;
      };
      const params = (w, h, r, planes, dir) => {
        const b = device.createBuffer({ size: 32, usage: U.UNIFORM | U.COPY_DST });
        const ab = new ArrayBuffer(32), u = new Uint32Array(ab), i = new Int32Array(ab), f = new Float32Array(ab);
        u[0] = w; u[1] = h; i[2] = r; u[3] = planes; u[4] = dir; f[5] = 10; f[6] = 1.5; f[7] = 3;
        device.queue.writeBuffer(b, 0, ab);
        return b;
      };
      const bind = (pipe, uni, ...buffers) => device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: uni } }, ...buffers.map((b, k) => ({ binding: k + 1, resource: { buffer: b } }))] });
      // Lucas-Kanade refinement on buffers already holding cur/ref luma and the initial flow.
      const runLK = async (w, h, opts) => {
        const o = opts || {}, iters = o.iterations || 3, r = o.window || 4, n = w * h, B = ensure(w, h);
        const pBase = params(w, h, 0, 1, 0), pH5 = params(w, h, r, 5, 0), pV5 = params(w, h, r, 5, 1), pH2 = params(w, h, 1, 2, 0), pV2 = params(w, h, 1, 2, 1);
        const gx = Math.ceil(w / 16), gy = Math.ceil(h / 16);
        const enc = device.createCommandEncoder(), pass = enc.beginComputePass();
        const run = (pipe, group, z) => { pass.setPipeline(pipe); pass.setBindGroup(0, group); pass.dispatchWorkgroups(gx, gy, z || 1); };
        const gWarp = bind(pipes.warp, pBase, B.ref, B.flow, B.lw), gProd = bind(pipes.products, pBase, B.lw, B.cur, B.prod);
        const gBH = bind(pipes.blur, pH5, B.prod, B.tmp), gBV = bind(pipes.blur, pV5, B.tmp, B.prod), gSolve = bind(pipes.solve, pBase, B.prod, B.flow, B.flow0);
        for (let it = 0; it < iters; it++) { run(pipes.warp, gWarp); run(pipes.products, gProd); run(pipes.blur, gBH, 5); run(pipes.blur, gBV, 5); run(pipes.solve, gSolve); }
        run(pipes.blur, bind(pipes.blur, pH2, B.flow, B.tmp), 2); run(pipes.blur, bind(pipes.blur, pV2, B.tmp, B.out), 2);
        pass.end();
        enc.copyBufferToBuffer(B.out, 0, B.read, 0, 2 * n * 4);
        device.queue.submit([enc.finish()]);
        await B.read.mapAsync(GPUMapMode.READ);
        const res = new Float32Array(B.read.getMappedRange().slice(0));
        B.read.unmap();
        for (const b of [pBase, pH5, pV5, pH2, pV2]) b.destroy();
        return { fx: res.subarray(0, n), fy: res.subarray(n, 2 * n) };
      };
      accel.denseFlow = async (curL, refL, w, h, init, opts) => {
        const n = w * h, B = ensure(w, h), f0 = new Float32Array(2 * n);
        f0.set(init.fx, 0); f0.set(init.fy, n);
        device.queue.writeBuffer(B.cur, 0, curL); device.queue.writeBuffer(B.ref, 0, refL);
        device.queue.writeBuffer(B.flow, 0, f0); device.queue.writeBuffer(B.flow0, 0, f0);
        return runLK(w, h, opts);
      };
      const mUniform = (vals) => {
        const b = device.createBuffer({ size: 48, usage: U.UNIFORM | U.COPY_DST }), ab = new ArrayBuffer(48), u = new Uint32Array(ab), i = new Int32Array(ab), f = new Float32Array(ab);
        u[0] = vals.lw; u[1] = vals.lh; u[2] = vals.bw; u[3] = vals.bh; u[4] = vals.B; u[5] = vals.scale || 1; u[6] = vals.bs || 1; i[7] = vals.R || 0; u[8] = vals.step || 1; u[9] = vals.isL0 ? 1 : 0; f[10] = vals.scaleUp || 1;
        device.queue.writeBuffer(b, 0, ab);
        return b;
      };
      const readBack = async (buf, bytes) => {
        const rb = device.createBuffer({ size: bytes, usage: U.MAP_READ | U.COPY_DST }), enc = device.createCommandEncoder();
        enc.copyBufferToBuffer(buf, 0, rb, 0, bytes); device.queue.submit([enc.finish()]);
        await rb.mapAsync(GPUMapMode.READ);
        const out = new Float32Array(rb.getMappedRange().slice(0)); rb.unmap(); rb.destroy();
        return out;
      };
      /**
       * Block search (same algorithm as estimateMotion: full search at the
       * coarsest level, candidate refinement below), vector field expansion and
       * Lucas-Kanade refinement, all on the GPU. Only the median filtering and
       * outlier repair of the small block field run on the CPU.
       */
      accel.motionFlow = async (curL, refL, w, h, range) => {
        const Bk = 16, bw = Math.ceil(w / Bk), bh = Math.ceil(h / Bk), nb = bw * bh, BB = ensure(w, h), S = U.STORAGE | U.COPY_DST | U.COPY_SRC;
        const levels = motionLevels(curL, refL, w, h), top = levels.length - 1, temp = [];
        device.queue.writeBuffer(BB.cur, 0, curL); device.queue.writeBuffer(BB.ref, 0, refL);
        const lb = levels.map((lv, k) => {
          if (k === 0) return { c: BB.cur, r: BB.ref, w: lv.w, h: lv.h };
          const c = device.createBuffer({ size: lv.c.length * 4, usage: S }), r = device.createBuffer({ size: lv.r.length * 4, usage: S });
          device.queue.writeBuffer(c, 0, lv.c); device.queue.writeBuffer(r, 0, lv.r); temp.push(c, r);
          return { c, r, w: lv.w, h: lv.h };
        });
        const vA = device.createBuffer({ size: nb * 8, usage: S }), vB = device.createBuffer({ size: nb * 8, usage: S }), cst = device.createBuffer({ size: nb * 4, usage: S });
        temp.push(vA, vB, cst);
        const groups = Math.ceil(nb / 64);
        // coarsest level: exhaustive search
        {
          const lv = lb[top], scale = 1 << top, uni = mUniform({ lw: lv.w, lh: lv.h, bw, bh, B: Bk, scale, bs: Math.max(2, Bk / scale), R: Math.max(1, Math.ceil(range / scale)) });
          temp.push(uni);
          const enc = device.createCommandEncoder(), pass = enc.beginComputePass();
          pass.setPipeline(pipes.bsearch); pass.setBindGroup(0, bind(pipes.bsearch, uni, lv.c, lv.r, vA)); pass.dispatchWorkgroups(groups); pass.end();
          device.queue.submit([enc.finish()]);
        }
        let v = await readBack(vA, nb * 8), vx = new Float32Array(nb), vy = new Float32Array(nb);
        for (let b = 0; b < nb; b++) { vx[b] = v[b * 2]; vy[b] = v[b * 2 + 1]; }
        vx = medianField(vx, bw, bh); vy = medianField(vy, bw, bh);
        const inter = new Float32Array(nb * 2);
        for (let b = 0; b < nb; b++) { inter[b * 2] = vx[b]; inter[b * 2 + 1] = vy[b]; }
        device.queue.writeBuffer(vA, 0, inter);
        // finer levels: candidate refinement (ping-pong)
        {
          const enc = device.createCommandEncoder(), pass = enc.beginComputePass();
          let src = vA, dst = vB;
          const steps = top > 0 ? Array.from({ length: top }, (_, k) => [top - 1 - k, 2]) : [[0, 1]];
          for (const [L, up] of steps) {
            const lv = lb[L], scale = 1 << L, uni = mUniform({ lw: lv.w, lh: lv.h, bw, bh, B: Bk, scale, bs: Bk / scale, step: L === 0 ? 2 : 1, isL0: L === 0, scaleUp: up });
            temp.push(uni);
            pass.setPipeline(pipes.brefine); pass.setBindGroup(0, bind(pipes.brefine, uni, lv.c, lv.r, src, dst, cst)); pass.dispatchWorkgroups(groups);
            [src, dst] = [dst, src];
          }
          pass.end(); device.queue.submit([enc.finish()]);
          v = await readBack(src, nb * 8);
        }
        const cost = await readBack(cst, nb * 4);
        for (let b = 0; b < nb; b++) { vx[b] = v[b * 2]; vy[b] = v[b * 2 + 1]; }
        const field = finishField(vx, vy, cost, bw, bh, Bk);
        for (let b = 0; b < nb; b++) { inter[b * 2] = field.vx[b]; inter[b * 2 + 1] = field.vy[b]; }
        device.queue.writeBuffer(vA, 0, inter);
        {
          const uni = mUniform({ lw: w, lh: h, bw, bh, B: Bk }), enc = device.createCommandEncoder(), pass = enc.beginComputePass();
          temp.push(uni);
          pass.setPipeline(pipes.binterp); pass.setBindGroup(0, bind(pipes.binterp, uni, vA, BB.flow, BB.flow0)); pass.dispatchWorkgroups(Math.ceil(w / 16), Math.ceil(h / 16)); pass.end();
          device.queue.submit([enc.finish()]);
        }
        const flow = await runLK(w, h);
        for (const b of temp) b.destroy();
        return { field, flow };
      };
      return accel;
    } catch (err) {
      return null;
    }
  }

  /**
   * job additionally carries: protect (Uint8Array|null), force (Uint8Array|null,
   * manual heal mask), reject ([{x,y}] review rejections), prior (scratches of
   * the previous frame), globalGain (clip-level deflicker ratio).
   */
  function render(job, an) {
    const t0 = now(), w = job.width, h = job.height, n = w * h;
    const p = normalizeParams(job.params);
    const seed = ((job.frameIndex | 0) * 7919 + 13) | 0;
    const out = new Uint16Array(an.cur || toU16(job.cur));
    const protect = job.protect && job.protect.length === n ? job.protect : null;
    const temporal = an.refs.length >= 2;
    const stats = {
      mode: 'none', defects: 0, rejected: 0, repairedPixels: 0, healedPixels: 0, scratches: 0, flicker: 0,
      threshold: null, noise: null, motionConfidence: an.motionConfidence, meanMotion: an.meanMotion, refs: an.refs.length, registration: an.registration || null,
    };
    const components = [];
    const noise = estimateNoise(an.Lc, w, h);
    stats.noise = noise;
    const grainSigma = p.grainMatch ? Math.min(14, noise) : 0;

    // 1. dust & dirt
    let repairMask = null, useInpaint = !temporal;
    if (p.dust > 0) {
      let det = null;
      if (temporal) {
        det = detectTemporal(an.Lc, an.refs[0].matched.L, an.refs[1].matched.L, w, h, p.dust / 100);
        stats.mode = 'temporal';
        if (p.spatial === 'on') {
          const sp = detectSpatial(an.Lc, w, h, p.dust / 100, Math.min(p.maxSize, 24));
          for (let i = 0; i < n; i++) if (sp.mask[i]) det.mask[i] = 1;
          stats.mode = 'temporal+spatial';
        }
      } else if (p.spatial !== 'off') {
        det = detectSpatial(an.Lc, w, h, p.dust / 100, Math.min(p.maxSize, 24));
        stats.mode = 'spatial';
      }
      if (det) {
        stats.threshold = det.threshold;
        if (protect) for (let i = 0; i < n; i++) if (protect[i]) det.mask[i] = 0;
        const { labels, comps } = labelComponents(det.mask, w, h);
        const rejectedIds = new Set();
        for (const pt of job.reject || []) {
          const x = Math.round(pt.x), y = Math.round(pt.y);
          for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx >= 0 && yy >= 0 && xx < w && yy < h && labels[yy * w + xx]) rejectedIds.add(labels[yy * w + xx]);
          }
        }
        const valid = new Uint8Array(comps.length + 1);
        for (const c of comps) {
          if (c.w > p.maxSize || c.h > p.maxSize) continue;
          let pol = 0;
          const ci = Math.min(n - 1, Math.round(c.cy) * w + Math.round(c.cx));
          if (temporal) pol = an.Lc[ci] - (an.refs[0].matched.L[ci] + an.refs[1].matched.L[ci]) / 2;
          const rejected = rejectedIds.has(c.id);
          if (rejected) stats.rejected++; else { stats.defects++; valid[c.id] = 1; }
          if (components.length < MAX_COMPONENTS_REPORTED)
            components.push({ x: c.x, y: c.y, w: c.w, h: c.h, area: c.area, cx: c.cx, cy: c.cy, polarity: pol > 0 ? 'light' : pol < 0 ? 'dark' : '', rejected });
        }
        const core = new Uint8Array(n);
        for (let i = 0; i < n; i++) if (labels[i] && valid[labels[i]]) core[i] = 1;
        repairMask = dilate(core, w, h, protect);
      }
    }
    // Infrared dirt channel (alpha of RGBA scans): opaque dirt blocks infrared light.
    stats.irPixels = 0;
    if (p.irClean > 0) {
      const cur16 = an.cur, samples = [];
      for (let i = 0; i < n; i += 97) samples.push(cur16[i * 4 + 3]);
      const med = median(samples);
      const hasIR = samples.some((v) => v < 65000);
      if (hasIR) {
        const s = p.irClean / 100, thr = med * (1 - (0.45 - 0.35 * s)), ir = new Uint8Array(n);
        for (let i = 0; i < n; i++) if (cur16[i * 4 + 3] < thr && !(protect && protect[i])) ir[i] = 1;
        let grown = dilate(ir, w, h, protect);
        if (s > 0.6) grown = dilate(grown, w, h, protect);
        if (!repairMask) repairMask = new Uint8Array(n);
        for (let i = 0; i < n; i++) if (grown[i] && !repairMask[i]) { repairMask[i] = 1; stats.irPixels++; }
      }
    }
    // Manual heal strokes are forced defects, repaired with the same machinery.
    const force = job.force && job.force.length === n ? job.force : null;
    if (force) {
      if (!repairMask) repairMask = new Uint8Array(n);
      for (let i = 0; i < n; i++) if (force[i]) { repairMask[i] = 1; stats.healedPixels++; }
      if (job.healMode === 'spatial') useInpaint = true;
    }
    if (repairMask) {
      if (!useInpaint) {
        const A = an.refs[0].matched.rgba, Bm = an.refs[1].matched.rgba;
        const comp = grainSigma * 0.55;
        for (let i = 0; i < n; i++) {
          if (!repairMask[i]) continue;
          const j = i * 4, nz = comp ? gauss3(i % w, (i / w) | 0, seed + 3) * comp * ONE : 0;
          out[j] = clamp16((A[j] + Bm[j]) * 0.5 + nz);
          out[j + 1] = clamp16((A[j + 1] + Bm[j + 1]) * 0.5 + nz);
          out[j + 2] = clamp16((A[j + 2] + Bm[j + 2]) * 0.5 + nz);
          stats.repairedPixels++;
        }
      } else {
        stats.repairedPixels += inpaintSmart(out, repairMask, w, h, p.grainMatch, seed);
      }
    }

    // Pixels the operator wants synthesised from surroundings (e.g. unrevealed parts of a persistent defect).
    if (job.inpaint && job.inpaint.length === n && job.inpaint.some((v) => v)) stats.repairedPixels += inpaintSmart(out, job.inpaint, w, h, p.grainMatch, seed + 5);

    // 2. scratches
    let scratches = [];
    if (p.scratch > 0) {
      scratches = detectScratches(an.Lc, w, h, p.scratch / 100, p.scratchWidth, job.prior);
      stats.scratches = scratches.length;
      stats.repairedPixels += repairScratches(out, w, h, scratches, protect, grainSigma * 0.8, seed);
    }

    // 3. denoise
    let result = out;
    if (p.denoise > 0) {
      if (an.refs.length) result = denoiseTemporal(out, an.refs.map((r) => r.matched), w, h, p.denoise);
      else result = denoiseSpatial(out, w, h, p.denoise);
    }

    // 4. deflicker: local gain toward the neighbours' brightness or a clip-level target
    if (p.deflicker > 0 && (an.refs.length || job.globalGain)) {
      const k = p.deflicker / 100, cells = an.curCells;
      let grid;
      if (an.refs.length) {
        // Each matched reference stores gain = cur/ref; the deflicker target is ref/cur.
        grid = new Float32Array(cells.m.length);
        for (const r of an.refs) for (let i = 0; i < grid.length; i++) grid[i] += 1 / r.matched.gain[i] / an.refs.length;
        for (let i = 0; i < grid.length; i++) grid[i] = Math.max(0.67, Math.min(1.5, grid[i]));
        if (job.globalGain) {
          let mean = 0;
          for (let i = 0; i < grid.length; i++) mean += grid[i];
          mean /= grid.length;
          for (let i = 0; i < grid.length; i++) grid[i] = (grid[i] / mean) * job.globalGain;
        }
      } else {
        grid = new Float32Array(cells.m.length).fill(job.globalGain);
      }
      let dev = 0;
      for (let i = 0; i < grid.length; i++) { grid[i] = 1 + (grid[i] - 1) * k; dev += Math.abs(grid[i] - 1); }
      stats.flicker = (dev / grid.length) * 100;
      const g = expandGrid(grid, cells.gw, cells.gh, cells.cs, w, h);
      for (let i = 0, j = 0; i < n; i++, j += 4) { const s = g[i]; result[j] = clamp16(result[j] * s); result[j + 1] = clamp16(result[j + 1] * s); result[j + 2] = clamp16(result[j + 2] * s); }
    }

    // 4b. faded-colour restoration: per-channel levels and gamma (shot-level when the app supplies them)
    if (p.fade > 0) {
      const lv = job.levels || fadeLevels(channelHistograms(result, n, 3));
      applyLevels(result, n, lv, p.fade / 100);
      stats.fade = lv;
    }
    if (p.colorize > 0 && job.colorHints && job.colorHints.m && job.colorHints.m.length === n) { colorizeFrame(result, w, h, job.colorHints, p.colorize / 100); stats.colorized = true; }
    if (an.chroma) stats.chroma = { r: [an.chroma.r.tx, an.chroma.r.ty], b: [an.chroma.b.tx, an.chroma.b.ty] };

    // 5. grade, sharpen, grain
    grade(result, n, p);
    sharpen(result, w, h, p.sharpen);
    addGrain(result, w, h, p.grain, seed + 1000);
    for (let j = 3; j < result.length; j += 4) result[j] = 65535;

    // Motion confidence at quarter resolution: disagreement between the two
    // motion-compensated neighbours (high = unreliable motion, e.g. occlusion).
    let confidence = null;
    if (temporal) {
      const cw = Math.ceil(w / 4), ch = Math.ceil(h / 4), cd = new Uint8Array(cw * ch), La = an.refs[0].matched.L, Lb = an.refs[1].matched.L;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x, c = (y >> 2) * cw + (x >> 2), d = Math.abs(La[i] - Lb[i]); if (d > cd[c]) cd[c] = Math.min(255, d * 4); }
      confidence = { width: cw, height: ch, data: cd };
    }
    stats.analysisMs = an.ms || 0;
    stats.accel = an.accel || 'cpu';
    stats.gpuMs = an.gpuMs || null;
    stats.ms = now() - t0 + stats.analysisMs;
    return {
      data: result, width: w, height: h, components, confidence,
      scratches: scratches.map((s) => ({ x: s.x, width: s.width, y0: s.y0, y1: s.y1, sign: s.sign, points: s.points })),
      stats,
    };
  }

  function process(job) { return render(job, analyze(job)); }

  // ---------------------------------------------------------------- worker
  function workerMain(scope, E) {
    const cache = new Map(), frames = new Map();
    // Frames are cached by key so consecutive jobs only ship the frames this
    // worker has not seen; the main thread mirrors this LRU exactly.
    const useFrame = (key, data, limit) => {
      if (data) { frames.delete(key); frames.set(key, data); while (frames.size > limit) frames.delete(frames.keys().next().value); return data; }
      const v = frames.get(key);
      if (!v) throw new Error(`frame ${key} missing from worker cache`);
      frames.delete(key); frames.set(key, v);
      return v;
    };
    let accel = null, useGPU = false, ready = Promise.resolve();
    let queue = Promise.resolve();
    scope.onmessage = (ev) => {
      const m = ev.data;
      queue = queue.then(() => handle(m));
    };
    async function handle(m) {
      try {
        if (m.type === 'init') {
          useGPU = !!m.gpu;
          if (useGPU && !accel) { ready = E.createGPU().then((a) => { accel = a; }); await ready; }
          scope.postMessage({ id: m.id, ok: true, result: { gpu: accel && !accel.lost ? accel.name : null, fallback: accel ? accel.fallback : false } });
          return;
        }
        if (m.type === 'gpu') { useGPU = !!m.on; if (useGPU && !accel) { accel = await E.createGPU(); } scope.postMessage({ id: m.id, ok: true, result: { gpu: useGPU && accel && !accel.lost ? accel.name : null } }); return; }
        if (m.type === 'reset') { cache.clear(); frames.clear(); scope.postMessage({ id: m.id, ok: true }); return; }
        if (m.type === 'clickFix') {
          const an = cache.get(m.analysisKey);
          const idx = an ? E.localDetect(an, m.x, m.y, m.r) : null;
          scope.postMessage({ id: m.id, ok: true, result: idx ? { idx } : { missing: true } }, idx ? [idx.buffer] : []);
          return;
        }
        if (m.type === 'globalMotion') {
          scope.postMessage({ id: m.id, ok: true, result: E.globalMotion(m.cur, m.ref, m.w, m.h, m.range) });
          return;
        }
        if (m.type === 'transform') {
          const out = E.transformRGBA(m.data, m.w, m.h, m.t);
          scope.postMessage({ id: m.id, ok: true, result: out }, [out.buffer]);
          return;
        }
        if (m.type === 'flowBench') {
          const r = {};
          const n = m.w * m.h, t0 = E.now();
          const cpu = E.denseFlow(m.curL, m.refL, m.w, m.h, m.init);
          r.cpuMs = E.now() - t0;
          if (accel && !accel.lost) {
            await accel.denseFlow(m.curL, m.refL, m.w, m.h, m.init);
            const t1 = E.now(), gpu = await accel.denseFlow(m.curL, m.refL, m.w, m.h, m.init);
            r.gpuMs = E.now() - t1;
            let mx = 0, mean = 0;
            for (let i = 0; i < n; i++) { const d = Math.max(Math.abs(gpu.fx[i] - cpu.fx[i]), Math.abs(gpu.fy[i] - cpu.fy[i])); mean += d; if (d > mx) mx = d; }
            r.maxDiff = mx; r.meanDiff = mean / n;
          }
          scope.postMessage({ id: m.id, ok: true, result: r });
          return;
        }
        if (m.type === 'process') {
          if (m.frameKeys) {
            const fk = m.frameKeys, lim = m.frameCacheSize || 6;
            m.job.cur = useFrame(fk.cur, m.job.cur, lim);
            m.job.refs = fk.refs.map((k, i) => useFrame(k, m.job.refs[i], lim));
          }
          let an = m.analysisKey ? cache.get(m.analysisKey) : null;
          if (!an) {
            an = useGPU && accel && !accel.lost ? await E.analyzeAsync(m.job, accel) : E.analyze(m.job);
            if (m.analysisKey) { cache.set(m.analysisKey, an); while (cache.size > (m.cacheSize || 3)) cache.delete(cache.keys().next().value); }
          } else an = Object.assign({}, an, { ms: 0 });
          const r = E.render(m.job, an);
          scope.postMessage({ id: m.id, ok: true, result: r }, [r.data.buffer]);
        }
      } catch (err) {
        scope.postMessage({ id: m.id, ok: false, error: String((err && err.stack) || err) });
      }
    }
  }

  return {
    VERSION, DEFAULT_PARAMS, normalizeParams, toU16, to8,
    lumaOf, boxBlur, morph, estimateNoise, histogram64, cutScore,
    estimateMotion, motionLevels, finishField, fieldError, interpolateField, warp, warpDense, warpPlane, denseFlow, pyramidFlow, registrationError, flowError, cellMeans, brightnessMatch,
    detectTemporal, detectSpatial, labelComponents, inpaint, inpaintPatch, inpaintSmart,
    detectScratches, repairScratches, denoiseTemporal, denoiseSpatial,
    toneLUT, grade, sharpen, addGrain,
    motionPrep, analyze, analyzeAsync, createGPU, render, process, workerMain, now,
    interpolateFrame, globalMotion, transformRGBA, stabilizationPlan, localDetect,
    motionPath, relativeTransform, fillFromFrames, refineDefectMask, geodesicDistance, propagateChroma, rgbToChroma, colorizeFrame,
    estimateChannelAlignment, alignChannels, channelHistograms, fadeLevels, applyLevels, frameOutliers, interpolateKeyframes,
  };
});
