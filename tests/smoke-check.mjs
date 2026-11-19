// Fast static checks with no browser: node tests/smoke-check.mjs
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const html = read('index.html');
const failures = [];

if (!html.includes('<title>FrameRestore Studio 3.8</title>')) failures.push('title');
const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
for (const s of ['src/engine.js', 'src/io.js', 'src/app.js']) if (!scripts.includes(s)) failures.push(`missing script tag ${s}`);

for (const s of scripts) {
  try { new Function(read(s)); } catch (err) { failures.push(`${s}: ${err.message}`); }
}

// Every #id the app looks up must exist in the markup.
const app = read('src/app.js');
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const used = new Set([...app.matchAll(/\$\('#([\w-]+)'\)/g)].map((m) => m[1]));
for (const id of ['dust', 'maxSize', 'motionRange', 'scratch', 'scratchWidth', 'deflicker', 'denoise', 'exposure', 'contrast', 'saturation', 'sharpen', 'grain', 'motion', 'grainMatch', 'spatial', 'flow', 'irClean', 'stabilize', 'stabSmooth', 'stabZoom', 'stabMode', 'fade', 'chromaAlign', 'chromaLocal', 'colorize']) used.add(id);
for (const id of used) if (!ids.has(id)) failures.push(`#${id} is used by app.js but missing from index.html`);
for (const m of html.matchAll(/data-for="([^"]+)"/g)) if (!ids.has(m[1])) failures.push(`output for missing #${m[1]}`);

if (failures.length) {
  console.error('Smoke check failed:\n - ' + failures.join('\n - '));
  process.exit(1);
}
console.log(`FrameRestore Studio smoke check passed (${used.size} element ids, ${scripts.length} scripts).`);
