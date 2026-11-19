// Engine throughput benchmark on synthetic 1080p frames: node tools/bench.mjs [width] [height]
import { createRequire } from 'node:module';
const E = createRequire(import.meta.url)('../src/engine.js');
const W = +(process.argv[2] || 1920), H = +(process.argv[3] || 1080);
function frame(off) {
  const d = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = x + off, l = 110 + 45 * Math.sin(u / 13) * Math.cos(y / 17) + 20 * Math.sin(u / 5.3 + y / 9) + ((x * 7 + y * 13 + off * 31) % 9) - 4;
    const j = (y * W + x) * 4; d[j] = d[j + 1] = d[j + 2] = l; d[j + 3] = 255;
  }
  return d;
}
const a = frame(0), b = frame(4), c = frame(8);
const params = { dust: 55, scratch: 40, denoise: 20, deflicker: 40, sharpen: 10, grain: 3 };
const job = { width: W, height: H, cur: b, refs: [a, c], params, frameIndex: 1 };
let t = performance.now();
const an = E.analyze(job);
const ta = performance.now() - t;
t = performance.now();
const r = E.render(job, an);
const tr = performance.now() - t;
console.log(`${W}x${H}: analyze ${ta.toFixed(0)} ms, render ${tr.toFixed(0)} ms, motion ${an.meanMotion.toFixed(2)} px, confidence ${an.motionConfidence.toFixed(2)}, defects ${r.stats.defects}`);
