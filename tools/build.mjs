// Inlines src/*.js into one portable HTML file: node tools/build.mjs
// Output: dist/framerestore-studio.html (open directly in Chrome or Edge).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
let html = readFileSync(join(root, 'index.html'), 'utf8');
let count = 0;
html = html.replace(/<script src="(src\/[\w.-]+\.js)"><\/script>/g, (_, rel) => {
  const code = readFileSync(join(root, rel), 'utf8').replace(/<\/script/gi, '<\\/script');
  count++;
  return `<script>/* ${rel} */\n${code}\n</script>`;
});
if (count !== 3) throw new Error(`Expected to inline 3 scripts, inlined ${count}`);
mkdirSync(join(root, 'dist'), { recursive: true });
const out = join(root, 'dist', 'framerestore-studio.html');
writeFileSync(out, html);
console.log(`Wrote ${out} (${(Buffer.byteLength(html) / 1024).toFixed(1)} KB)`);
