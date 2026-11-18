import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const required = [
  '<title>FrameRestore Studio 2.0</title>',
  'id="mediaInput"',
  'id="sourceCanvas"',
  'id="workCanvas"',
  'analyzeAndRestore',
  'exportPNG',
  'exportProject',
  'exportSequence',
  'Temporal dust',
];

const missing = required.filter((token) => !source.includes(token));
if (missing.length) {
  console.error(`Smoke check failed; missing: ${missing.join(', ')}`);
  process.exit(1);
}

const scripts = [...source.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
if (scripts.length !== 1) {
  console.error(`Smoke check failed; expected one inline script, found ${scripts.length}`);
  process.exit(1);
}

try {
  new Function(scripts[0]);
} catch (error) {
  console.error(`JavaScript syntax check failed: ${error.message}`);
  process.exit(1);
}

console.log('FrameRestore Studio smoke check passed.');

