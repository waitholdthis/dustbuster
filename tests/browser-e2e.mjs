// End-to-end test in headless Chrome/Edge via the DevTools protocol.
// Run: node tests/browser-e2e.mjs   (CHROME_PATH overrides browser discovery;
// FRS_PAGE=dist/framerestore-studio.html tests the single-file build; FRS_NO_GPU=1 forces the CPU path)
// Generates a panning PNG sequence with known dust and a scratch (and an H.264
// clip when ffmpeg is available), drives the real UI, and checks the results.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const IOnode = createRequire(import.meta.url)('../src/io.js');

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const work = mkdtempSync(join(tmpdir(), 'frs-e2e-'));
const shotDir = process.env.FRS_SHOTS || work;
const W = 320, H = 200, FRAMES = 6, DUST_FRAME = 2;

// ---------------------------------------------------------------- fixtures
function crcTable() { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; }
const CRC = crcTable();
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function png(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  const chunk = (type, data) => { const b = Buffer.alloc(12 + data.length); b.writeUInt32BE(data.length, 0); b.write(type, 4, 'ascii'); data.copy(b, 8); b.writeUInt32BE(crc32(b.subarray(4, 8 + data.length)), 8 + data.length); return b; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const blobs = [];
function frameRGB(f) {
  const b = Buffer.alloc(W * H * 3);
  let s = 77 + f * 101;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = x + f * 3, v = y + f;
    const l = 115 + 45 * Math.sin(u / 13) * Math.cos(v / 17) + 30 * Math.sin((u + 2 * v) / 29) + 18 * Math.sin(u / 5.3 + Math.cos(v / 7)) + (rnd() - 0.5) * 6;
    const j = (y * W + x) * 3; b[j] = Math.max(0, Math.min(255, l * 1.05)); b[j + 1] = Math.max(0, Math.min(255, l)); b[j + 2] = Math.max(0, Math.min(255, l * 0.9));
  }
  if (f === DUST_FRAME) {
    for (let k = 0; k < 14; k++) {
      const cx = 30 + ((k * 73) % 260), cy = 25 + ((k * 47) % 150), r = 2 + (k % 3), v = k % 2 ? 20 : 240;
      blobs.push({ cx, cy, r });
      for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) { const j = (y * W + x) * 3; b[j] = b[j + 1] = b[j + 2] = v; }
    }
  }
  for (let y = 0; y < H; y++) { const j = (y * W + 250) * 3; b[j] = b[j + 1] = b[j + 2] = 235; }
  return b;
}
const seqFiles = [];
for (let f = 0; f < FRAMES; f++) { const p = join(work, `scan_${String(f + 1).padStart(4, '0')}.png`); writeFileSync(p, png(W, H, frameRGB(f))); seqFiles.push(p); }
let videoPath = null;
try {
  execFileSync('ffmpeg', ['-v', 'error', '-framerate', '24', '-i', join(work, 'scan_%04d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '12', '-y', join(work, 'clip.mp4')]);
  videoPath = join(work, 'clip.mp4');
} catch { console.log('ffmpeg unavailable: skipping video import check'); }

// ---------------------------------------------------------------- browser
function findBrowser() {
  const c = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);
  return c.find((p) => existsSync(p));
}
const browserPath = findBrowser();
if (!browserPath) { console.log('No Chrome/Edge found; skipping browser test'); process.exit(0); }
const profile = join(work, 'profile'), downloads = join(work, 'downloads');
const proc = spawn(browserPath, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--allow-file-access-from-files', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
let port;
for (let i = 0; i < 100 && !port; i++) { await new Promise((r) => setTimeout(r, 100)); try { port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch { /* not yet */ } }
if (!port) throw new Error('Browser did not start');
const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let seq = 0; const waiting = new Map(), errors = [], consoleLines = [];
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && waiting.has(msg.id)) { const { res, rej } = waiting.get(msg.id); waiting.delete(msg.id); msg.error ? rej(new Error(msg.error.message)) : res(msg.result); }
  if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
  if (msg.method === 'Runtime.consoleAPICalled') { const line = msg.params.args.map((a) => a.value ?? a.description).join(' '); consoleLines.push(`${msg.params.type}: ${line}`); if (msg.params.type === 'error') errors.push(line); }
};
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; waiting.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
const waitFor = async (expr, label, timeout = 30000) => { const t0 = Date.now(); for (;;) { const v = await evaluate(expr).catch(() => false); if (v) return v; if (Date.now() - t0 > timeout) throw new Error(`Timed out waiting for ${label}`); await new Promise((r) => setTimeout(r, 100)); } };
const shot = async (name) => { const { data } = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(shotDir, name), Buffer.from(data, 'base64')); };
const key = async (k, code, mods = 0) => { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, modifiers: mods, windowsVirtualKeyCode: k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0 }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, modifiers: mods }); };
const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', Object.assign({ type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 }, extra));
const imageToScreen = (x, y) => evaluate(`(() => { const s = FRS.state, r = document.querySelector('#displayCanvas').getBoundingClientRect(); return [r.left + s.panX + ${x} * s.zoom, r.top + s.panY + ${y} * s.zoom]; })()`);
const setFiles = async (selector, files) => { const { root: doc } = await send('DOM.getDocument'); const { nodeId } = await send('DOM.querySelector', { nodeId: doc.nodeId, selector }); await send('DOM.setFileInputFiles', { nodeId, files }); };

const results = [];
const check = async (name, fn) => { try { await fn(); results.push(['PASS', name]); } catch (err) { results.push(['FAIL', name, err.message]); } };

try {
  await send('Runtime.enable'); await send('Page.enable'); await send('DOM.enable');
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true }).catch(() => send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads }));
  await send('Page.navigate', { url: pathToFileURL(join(root, process.env.FRS_PAGE || 'index.html')).href });
  await waitFor('!!window.FRS', 'app boot');
  if (process.env.FRS_NO_GPU) await evaluate(`FRS.engine.ready.then(async () => { const c = document.querySelector('#useGPU'); if (c.checked) { c.checked = false; await FRS.engine.setGPU(false); } })`);

  await check('engine runs in a background worker from file://', async () => {
    assert.equal(await evaluate('FRS.engine.mode'), 'worker');
  });

  let gpu = null;
  await check('worker GPU optical flow matches the CPU solver (when WebGPU is present)', async () => {
    gpu = await evaluate('FRS.engine.ready.then(() => FRS.engine.gpuName)');
    if (!gpu) { console.log('  (no WebGPU device: GPU parity skipped)'); return; }
    const r = await evaluate(`(async () => {
      const E = FRS.E, W = 640, H = 360, n = W * H;
      const mk = (ang, z) => { const L = new Float32Array(n), a = ang * Math.PI / 180, ca = Math.cos(a) / z, sa = Math.sin(a) / z; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const u = 320 + (x - 320) * ca - (y - 180) * sa, v = 180 + (x - 320) * sa + (y - 180) * ca; L[y * W + x] = 110 + 45 * Math.sin(u / 13) * Math.cos(v / 17) + 20 * Math.sin(u / 5.3 + v / 9); } return L; };
      const curL = mk(0, 1), refL = mk(1.5, 1.02), init = E.interpolateField(E.estimateMotion(curL, refL, W, H, 24), W, H);
      return FRS.engine.flowBench({ curL, refL, w: W, h: H, init });
    })()`);
    assert.ok(r.maxDiff < 0.01, `GPU vs CPU flow max difference ${r.maxDiff}`);
    console.log(`  GPU ${gpu}: dense flow ${r.gpuMs.toFixed(1)} ms vs CPU ${r.cpuMs.toFixed(1)} ms at 640x360`);
  });

  await check('GPU block search reproduces the CPU block search exactly', async () => {
    if (!gpu) { console.log('  (no WebGPU device: block-search parity skipped)'); return; }
    const r = await evaluate(`(async () => {
      const E = FRS.E, W = 960, H = 540, n = W * H, acc = await E.createGPU();
      const mk = (dx, dy, a0) => { const L = new Float32Array(n), a = a0 * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const u = W / 2 + (x - W / 2) * ca - (y - H / 2) * sa + dx, v = H / 2 + (x - W / 2) * sa + (y - H / 2) * ca + dy; L[y * W + x] = 110 + 45 * Math.sin(u / 13) * Math.cos(v / 17) + 20 * Math.sin(u / 5.3 + v / 9) + ((x * 7 + y * 13) % 5) - 2; } return L; };
      const cur = mk(0, 0, 0), ref = mk(11, -5, 1);
      const cpu = E.estimateMotion(cur, ref, W, H, 24), g = await acc.motionFlow(cur, ref, W, H, 24), cflow = E.denseFlow(cur, ref, W, H, E.interpolateField(cpu, W, H));
      let same = 0; for (let b = 0; b < cpu.vx.length; b++) if (cpu.vx[b] === g.field.vx[b] && cpu.vy[b] === g.field.vy[b]) same++;
      let md = 0; for (let i = 0; i < n; i += 5) md = Math.max(md, Math.abs(cflow.fx[i] - g.flow.fx[i]), Math.abs(cflow.fy[i] - g.flow.fy[i]));
      acc.destroy();
      return { same: same / cpu.vx.length, md };
    })()`);
    assert.ok(r.same > 0.995, `identical block vectors ${(r.same * 100).toFixed(2)}%`);
    assert.ok(r.md < 0.01, `flow difference ${r.md}`);
  });

  await check('imports a PNG sequence and restores the dusty frame temporally', async () => {
    await setFiles('#mediaInput', seqFiles.slice().reverse());
    await waitFor(`FRS.state.source && FRS.state.total === ${FRAMES}`, 'sequence import');
    await evaluate(`FRS.setParams({ dust: 55, scratch: 60, scratchWidth: 3, denoise: 0 })`);
    await evaluate(`FRS.goToFrame(${DUST_FRAME})`);
    await evaluate(`FRS.state.results.clear(); FRS.requestProcess()`);
    await waitFor(`FRS.state.shown && FRS.state.shown.frame === ${DUST_FRAME} && FRS.state.shown.valid && !FRS.state.processing`, 'restoration', 60000);
    const st = await evaluate('FRS.state.shown.res.stats');
    assert.equal(st.mode, 'temporal');
    assert.ok(st.defects >= 12 && st.defects <= 20, `defects ${st.defects}`);
    assert.equal(st.scratches, 1, `scratches ${st.scratches}`);
    assert.ok(st.motionConfidence > 0.8, `motion confidence ${st.motionConfidence}`);
    assert.ok(st.registration && st.registration.dense <= st.registration.block + 0.05, JSON.stringify(st.registration));
    if (gpu) assert.equal(st.accel, 'gpu', 'analysis ran on the GPU');
    assert.ok(await evaluate('FRS.state.shown.res.data instanceof Uint16Array'), '16-bit result');
    const refs = await evaluate('FRS.state.shown.res.refs');
    assert.deepEqual(refs, [DUST_FRAME - 1, DUST_FRAME + 1]);
    await shot('01-restored.png');
  });

  await check('Review tool rejects a repair when its defect is clicked', async () => {
    await key('d', 'KeyD');
    const c = await evaluate('FRS.state.shown.res.components.slice().sort((a,b)=>b.area-a.area)[0]');
    const [x, y] = await imageToScreen(c.cx, c.cy);
    await mouse('mousePressed', x, y); await mouse('mouseReleased', x, y);
    await waitFor('FRS.state.shown.valid && FRS.state.shown.res.stats.rejected === 1 && !FRS.state.processing', 'rejection', 30000);
    await evaluate("document.querySelector('[data-view=defects]').click()");
    await shot('02-defects-review.png');
  });

  await check('Heal stroke is repaired, and undo removes it', async () => {
    await key('h', 'KeyH');
    const [x0, y0] = await imageToScreen(60, 100), [x1, y1] = await imageToScreen(110, 104);
    await mouse('mousePressed', x0, y0);
    for (let k = 1; k <= 8; k++) await mouse('mouseMoved', x0 + ((x1 - x0) * k) / 8, y0 + ((y1 - y0) * k) / 8);
    await mouse('mouseReleased', x1, y1);
    await waitFor(`FRS.state.heal.has(${DUST_FRAME}) && FRS.state.shown.valid && FRS.state.shown.res.stats.healedPixels > 200 && !FRS.state.processing`, 'heal', 30000);
    await key('z', 'KeyZ', 2);
    await waitFor(`!FRS.state.heal.has(${DUST_FRAME}) && FRS.state.shown.valid && FRS.state.shown.res.stats.healedPixels === 0 && !FRS.state.processing`, 'undo heal', 30000);
  });

  await check('Clone and paint strokes land in the paint layer', async () => {
    await key('p', 'KeyP');
    const [x, y] = await imageToScreen(200, 60);
    await mouse('mousePressed', x, y); await mouse('mouseMoved', x + 20, y + 5); await mouse('mouseReleased', x + 20, y + 5);
    assert.ok(await evaluate(`FRS.state.paint.has(${DUST_FRAME})`));
    const alpha = await evaluate(`FRS.state.paint.get(${DUST_FRAME}).getContext('2d').getImageData(200, 60, 1, 1).data[3]`);
    assert.ok(alpha > 200, `paint alpha ${alpha}`);
  });

  await check('Renders the full sequence to a valid ZIP of PNG frames', async () => {
    await key('v', 'KeyV');
    const disabled = await evaluate("document.querySelector('#exportZipBtn').disabled");
    assert.equal(disabled, false, 'ZIP button enabled');
    await evaluate("window.__renderLog = []; new MutationObserver(() => window.__renderLog.push(document.querySelector('#footerMessage').textContent)).observe(document.querySelector('#footerMessage'), { childList: true, characterData: true, subtree: true }); document.querySelector('#exportZipBtn').click()");
    try {
      await waitFor(`window.__renderLog.some((m) => m.startsWith('Render complete'))`, 'render', 120000);
    } catch (err) { throw new Error(err.message + ' · messages: ' + JSON.stringify(await evaluate('window.__renderLog.slice(-6)'))); }
    let zipName;
    for (let i = 0; i < 50 && !zipName; i++) { await new Promise((r) => setTimeout(r, 100)); zipName = existsSync(downloads) && readdirSync(downloads).find((f) => f.endsWith('.zip')); }
    assert.ok(zipName, 'zip downloaded');
    const zip = readFileSync(join(downloads, zipName)), eocd = zip.length - 22;
    assert.equal(zip.readUInt32LE(eocd), 0x06054b50);
    assert.equal(zip.readUInt16LE(eocd + 10), FRAMES);
    let cd = zip.readUInt32LE(eocd + 16), names = [];
    for (let k = 0; k < FRAMES; k++) {
      const nameLen = zip.readUInt16LE(cd + 28), local = zip.readUInt32LE(cd + 42), size = zip.readUInt32LE(cd + 24), crc = zip.readUInt32LE(cd + 16);
      names.push(zip.toString('utf8', cd + 46, cd + 46 + nameLen));
      const ln = zip.readUInt16LE(local + 26), data = zip.subarray(local + 30 + ln, local + 30 + ln + size);
      assert.equal(crc32(data), crc, 'crc'); assert.equal(data.readUInt32BE(0), 0x89504e47, 'png signature');
      assert.equal(data[24], 16, 'default render is 16-bit PNG');
      cd += 46 + nameLen;
    }
    assert.equal(names[0], 'scan_restored_000001.png');
  });

  const renderTo = async (fmt, ext) => {
    await evaluate(`(() => {
      const s = document.querySelector('#exportFormat'); s.value = '${fmt}'; s.dispatchEvent(new Event('change'));
      window.__renderLog = [];
      if (!window.__obs) { window.__obs = new MutationObserver(() => window.__renderLog.push(document.querySelector('#footerMessage').textContent)); window.__obs.observe(document.querySelector('#footerMessage'), { childList: true, characterData: true, subtree: true }); }
      document.querySelector('#exportZipBtn').click();
    })()`);
    await waitFor(`window.__renderLog.some((m) => m.startsWith('Render complete') || m.startsWith('Render failed'))`, `${fmt} render`, 180000);
    const failed = await evaluate(`window.__renderLog.find((m) => m.startsWith('Render failed')) || ''`);
    assert.equal(failed, '', failed);
    let name;
    for (let i = 0; i < 80 && !name; i++) { await new Promise((r) => setTimeout(r, 100)); name = readdirSync(downloads).find((f) => f.endsWith(ext)); }
    assert.ok(name, `${ext} downloaded`);
    await new Promise((r) => setTimeout(r, 300));
    return join(downloads, name);
  };
  const probe = (file) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,nb_read_frames,pix_fmt', '-of', 'json', file]).toString()).streams[0];

  if (videoPath) await check('Renders H.264 MP4 and VP9 WebM that ffmpeg decodes cleanly', async () => {
    for (const [fmt, ext, codec] of [['mp4', '.mp4', 'h264'], ['webm', '.webm', 'vp9']]) {
      const file = await renderTo(fmt, ext), st = probe(file);
      assert.equal(st.codec_name, codec); assert.equal(+st.nb_read_frames, FRAMES, `${fmt} frames`);
      assert.equal(st.width, W); assert.equal(st.height, H);
      execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', file, '-f', 'null', '-']);
    }
  });

  if (videoPath) await check('Renders 10-bit DPX, 16-bit TIFF and OpenEXR sequences that ffmpeg reads', async () => {
    for (const [fmt, pix] of [['dpx10', 'gbrp10'], ['tiff16', 'rgb48'], ['exr', 'gbrpf16']]) {
      for (const f of readdirSync(downloads).filter((x) => x.endsWith('.zip'))) { try { rmSync(join(downloads, f)); } catch { /* held by the browser */ } }
      const zipFile = await renderTo(fmt, '.zip'), zip = readFileSync(zipFile), eocd = zip.length - 22;
      assert.equal(zip.readUInt16LE(eocd + 10), FRAMES);
      const cd = zip.readUInt32LE(eocd + 16), size = zip.readUInt32LE(cd + 24), local = zip.readUInt32LE(cd + 42), ln = zip.readUInt16LE(local + 26);
      const nameLen = zip.readUInt16LE(cd + 28), fname = zip.toString('utf8', cd + 46, cd + 46 + nameLen);
      const out = join(downloads, 'probe_' + fname);
      writeFileSync(out, zip.subarray(local + 30 + ln, local + 30 + ln + size));
      const st = probe(out);
      assert.equal(st.width, W); assert.ok(String(st.pix_fmt).startsWith(pix), `${fmt} pix_fmt ${st.pix_fmt}`);
    }
    await evaluate(`(() => { const s = document.querySelector('#exportFormat'); s.value = 'png16'; s.dispatchEvent(new Event('change')); })()`);
  });

  await check('Saves a project containing edits, reviews and settings', async () => {
    await evaluate("document.querySelector('#saveProjectBtn').click()");
    let name;
    for (let i = 0; i < 50 && !name; i++) { await new Promise((r) => setTimeout(r, 100)); name = readdirSync(downloads).find((f) => f.endsWith('.frs3.json')); }
    const p = JSON.parse(readFileSync(join(downloads, name), 'utf8'));
    assert.equal(p.format, 3); assert.equal(p.params.scratch, 60);
    assert.ok(p.rejects[DUST_FRAME] && p.rejects[DUST_FRAME].length === 1, 'rejection saved');
    assert.ok(p.paint[DUST_FRAME] && p.paint[DUST_FRAME].startsWith('data:image/png'), 'paint saved');
  });

  await check('HTML report exports', async () => {
    await evaluate("document.querySelector('#exportReportBtn').click()");
    let name;
    for (let i = 0; i < 50 && !name; i++) { await new Promise((r) => setTimeout(r, 100)); name = readdirSync(downloads).find((f) => f.endsWith('_report.html')); }
    const html = readFileSync(join(downloads, name), 'utf8');
    assert.ok(html.includes('Per-frame log') && html.includes('data:image/jpeg'));
  });

  if (videoPath) await check('Imports an H.264 clip, detects 24 fps, and restores it', async () => {
    await setFiles('#mediaInput', [videoPath]);
    await waitFor(`FRS.state.source && FRS.state.source.kind === 'video' && FRS.state.shown && !FRS.state.processing`, 'video import', 60000);
    const fps = await evaluate('FRS.state.fps'), total = await evaluate('FRS.state.total');
    assert.equal(fps, 24); assert.equal(total, FRAMES);
    await evaluate(`FRS.goToFrame(${DUST_FRAME})`);
    await waitFor(`FRS.state.shown.frame === ${DUST_FRAME} && FRS.state.shown.valid && !FRS.state.processing`, 'video restore', 60000);
    const st = await evaluate('FRS.state.shown.res.stats');
    assert.equal(st.mode, 'temporal'); assert.ok(st.defects >= 10, `video defects ${st.defects}`);
    await shot('03-video.png');
  });

  await check('A single still image is restored with spatial detection', async () => {
    await setFiles('#mediaInput', [seqFiles[DUST_FRAME]]);
    await waitFor(`FRS.state.source && FRS.state.source.kind === 'image' && FRS.state.shown && FRS.state.shown.valid && !FRS.state.processing`, 'still import', 60000);
    const st = await evaluate('FRS.state.shown.res.stats');
    assert.equal(st.mode, 'spatial'); assert.ok(st.defects >= 8, `still defects ${st.defects}`);
  });

  if (videoPath) await check('Imports a 10-bit DPX sequence', async () => {
    execFileSync('ffmpeg', ['-v', 'error', '-i', join(work, 'scan_%04d.png'), '-pix_fmt', 'gbrp10le', '-y', join(work, 'f_%04d.dpx')]);
    const dpx = readdirSync(work).filter((f) => f.endsWith('.dpx')).map((f) => join(work, f));
    assert.equal(dpx.length, FRAMES);
    await setFiles('#mediaInput', dpx);
    await waitFor(`FRS.state.source && FRS.state.source.format === 'DPX' && FRS.state.total === ${FRAMES} && FRS.state.shown`, 'dpx import', 60000);
    assert.ok((await evaluate("document.querySelector('#sourceInfo').textContent")).includes('10-bit'));
    const fine = await evaluate(`(() => { const d = FRS.state.raw.peek(0) || FRS.state.raw.peek(${DUST_FRAME}); let k = 0; for (let i = 0; i < d.length; i += 4) if (d[i] % 257) k++; return k; })()`);
    assert.ok(fine > 1000, `10-bit code values survive in the 16-bit pipeline (${fine} non-8-bit samples)`);
    await evaluate(`FRS.goToFrame(${DUST_FRAME})`);
    await waitFor(`FRS.state.shown.frame === ${DUST_FRAME} && FRS.state.shown.valid && !FRS.state.processing`, 'dpx restore', 60000);
    const st = await evaluate('FRS.state.shown.res.stats');
    assert.equal(st.mode, 'temporal'); assert.ok(st.defects >= 12, `dpx defects ${st.defects}`);
  });

  // ---------------------------------------------------------------- high-end tools (3.2)
  const restoreSeq = async () => {
    await setFiles('#mediaInput', seqFiles);
    await waitFor(`FRS.state.source && FRS.state.source.format === 'PNG' && FRS.state.total === ${FRAMES} && FRS.state.shown`, 'sequence re-import', 60000);
    await evaluate(`FRS.setParams({ dust: 55, scratch: 60, scratchWidth: 3, denoise: 0, stabilize: 0 })`);
    await evaluate(`FRS.goToFrame(${DUST_FRAME})`);
    await waitFor(`FRS.state.shown.frame === ${DUST_FRAME} && FRS.state.shown.valid && !FRS.state.processing`, 'restore', 60000);
  };
  const pixel = (x, y) => evaluate(`FRS.state.shown.res.data[(${y} * ${W} + ${x}) * 4 + 1] / 257`);
  const settle = (label) => waitFor(`FRS.state.shown && FRS.state.shown.valid && !FRS.state.processing`, label, 60000);

  await check('Click&Fix repairs a defect the operator points at', async () => {
    await restoreSeq();
    const b = blobs[0];
    await evaluate(`FRS.state.rejects.set(${DUST_FRAME}, [{ x: ${b.cx}, y: ${b.cy} }]); FRS.state.versions.set(${DUST_FRAME}, 99); FRS.requestProcess()`);
    await settle('rejection');
    const before = await pixel(b.cx, b.cy);
    assert.ok(before > 200, `rejected blob kept (${before})`);
    await key('x', 'KeyX');
    const [x, y] = await imageToScreen(b.cx, b.cy);
    await mouse('mousePressed', x, y); await mouse('mouseReleased', x, y);
    await waitFor(`FRS.state.heal.has(${DUST_FRAME}) && FRS.state.shown.valid && FRS.state.shown.res.stats.healedPixels > 0 && !FRS.state.processing`, 'click&fix', 60000);
    const after = await pixel(b.cx, b.cy);
    assert.ok(after < 190, `Click&Fix repaired the blob (${before} -> ${after})`);
  });

  await check('History brush brings back the original under the stroke', async () => {
    const b = blobs[2];
    const repaired = await pixel(b.cx, b.cy);
    await key('y', 'KeyY');
    const [x, y] = await imageToScreen(b.cx, b.cy);
    await mouse('mousePressed', x, y); await mouse('mouseMoved', x + 2, y + 1); await mouse('mouseReleased', x + 2, y + 1);
    await waitFor(`FRS.state.revert.has(${DUST_FRAME}) && FRS.state.shown.valid && !FRS.state.processing`, 'history brush', 60000);
    const reverted = await pixel(b.cx, b.cy);
    assert.ok(Math.abs(reverted - 240) < 3 && Math.abs(repaired - 240) > 30, `history brush ${repaired.toFixed(0)} -> ${reverted.toFixed(0)}`);
    await key('z', 'KeyZ', 2);
    await waitFor(`!FRS.state.revert.has(${DUST_FRAME}) && FRS.state.shown.valid && !FRS.state.processing`, 'undo history', 60000);
  });

  await check('Rebuild frame replaces a destroyed frame by interpolation', async () => {
    await key('j', 'KeyJ');
    await waitFor(`FRS.state.replaced.has(${DUST_FRAME}) && FRS.state.shown.valid && !FRS.state.processing`, 'rebuild', 60000);
    const b = blobs[4], v = await pixel(b.cx, b.cy);
    assert.ok(v > 60 && v < 200, `rebuilt frame has no dust at the blob (${v.toFixed(0)})`);
    assert.deepEqual(await evaluate('FRS.state.shown.res.refs'), [DUST_FRAME - 1, DUST_FRAME + 1]);
    await key('z', 'KeyZ', 2);
    await waitFor(`!FRS.state.replaced.has(${DUST_FRAME}) && FRS.state.shown.valid && !FRS.state.processing`, 'undo rebuild', 60000);
  });

  await check('Scan measures camera motion and lock stabilisation cancels it', async () => {
    await evaluate(`document.querySelector('#scanBtn').click()`);
    await waitFor(`FRS.state.scan && FRS.state.scan.motions && !FRS.state.rendering`, 'scan', 120000);
    const m = await evaluate('FRS.state.scan.motions[3]');
    assert.ok(Math.abs(m.tx - 3) < 0.4 && Math.abs(m.ty - 1) < 0.4, `measured pan ${m.tx.toFixed(2)}, ${m.ty.toFixed(2)} (true 3, 1)`);
    await evaluate(`FRS.setParams({ stabilize: 100, stabMode: 'lock', stabZoom: 0 }); document.querySelector('#stabilize').dispatchEvent(new Event('input'))`);
    const residual = await evaluate(`(() => {
      const E = FRS.E, n = ${W * H}, out = [2, 3].map((f) => E.lumaOf(E.transformRGBA(FRS.state.raw.peek(f), ${W}, ${H}, FRS.stabCorrection(f)), n));
      const g = E.globalMotion(out[1], out[0], ${W}, ${H}, 24); return Math.hypot(g.tx, g.ty);
    })()`);
    assert.ok(residual < 0.5, `motion left after lock stabilisation ${residual.toFixed(2)} px`);
    await key('6', 'Digit6'); await key('7', 'Digit7'); await key('1', 'Digit1');
    await evaluate(`FRS.setParams({ stabilize: 0 }); document.querySelector('#stabilize').dispatchEvent(new Event('input'))`);
  });

  await check('Per-shot settings: a split shot keeps its own parameters', async () => {
    await evaluate(`FRS.goToFrame(4)`); await settle('frame 4');
    await key('s', 'KeyS');
    assert.ok(await evaluate('FRS.state.splits.has(4)'));
    await evaluate(`document.querySelector('#shotCustom').click()`);
    await evaluate(`{ const d = document.querySelector('#dust'); d.value = 12; d.dispatchEvent(new Event('input')); d.dispatchEvent(new Event('change')); }`);
    assert.equal(await evaluate('FRS.paramsFor(5).dust'), 12);
    assert.equal(await evaluate('FRS.paramsFor(1).dust'), 55);
    await evaluate(`FRS.goToFrame(1)`); await settle('frame 1');
    assert.equal(await evaluate(`+document.querySelector('#dust').value`), 55, 'sliders follow the shot');
    await evaluate(`FRS.goToFrame(${DUST_FRAME})`); await settle('back');
  });

  await check('A tracked protect region shields an object from repair', async () => {
    const b = blobs[0];
    await evaluate(`FRS.state.rejects.delete(${DUST_FRAME}); FRS.state.heal.delete(${DUST_FRAME}); FRS.state.versions.set(${DUST_FRAME}, 500); FRS.requestProcess()`);
    await settle('clean slate');
    assert.ok((await pixel(b.cx, b.cy)) < 200, 'blob repaired before protection');
    await key('g', 'KeyG');
    const [x0, y0] = await imageToScreen(b.cx - 10, b.cy - 10), [x1, y1] = await imageToScreen(b.cx + 10, b.cy + 10);
    await mouse('mousePressed', x0, y0); await mouse('mouseMoved', (x0 + x1) / 2, (y0 + y1) / 2); await mouse('mouseMoved', x1, y1); await mouse('mouseReleased', x1, y1);
    await waitFor('FRS.state.rois.length === 1', 'region created');
    await settle('protected');
    assert.ok((await pixel(b.cx, b.cy)) > 230, 'protected blob left untouched');
    await evaluate(`document.querySelector('#roiList button[data-act=track]').click()`);
    await waitFor('FRS.state.rois[0].track.size >= 2 && !FRS.state.rendering', 'tracking', 60000);
    const pos = await evaluate(`FRS.state.rois[0].track.get(${DUST_FRAME - 1})`);
    assert.ok(Math.abs(pos.x - (b.cx - 10 + 3)) <= 2, `region followed the pan: x ${pos.x} (expected ~${b.cx - 7})`);
    await shot('04-region.png');
  });

  await check('Infrared channel of an RGBA TIFF sequence cleans dirt', async () => {
    const irFiles = [];
    for (let f = 0; f < 4; f++) {
      const rgb = frameRGB(f), w = W, h = H, raw = Buffer.alloc(w * h * 4);
      for (let i = 0; i < w * h; i++) { raw[i * 4] = rgb[i * 3]; raw[i * 4 + 1] = rgb[i * 3 + 1]; raw[i * 4 + 2] = rgb[i * 3 + 2]; raw[i * 4 + 3] = 235; }
      if (f === 1) for (let y = 100; y < 106; y++) for (let x = 60; x < 66; x++) { const i = y * w + x; raw[i * 4 + 3] = 25; for (let c = 0; c < 3; c++) raw[i * 4 + c] = Math.max(0, raw[i * 4 + c] - 10); }
      const entries = [[256, 4, 1, w], [257, 4, 1, h], [258, 3, 1, 8], [259, 3, 1, 1], [262, 3, 1, 2], [273, 4, 1, 0], [277, 3, 1, 4], [278, 4, 1, h], [279, 4, 1, raw.length], [338, 3, 1, 0]];
      const dataOff = 8 + 2 + entries.length * 12 + 4, buf = Buffer.alloc(dataOff + raw.length);
      buf.write('II', 0); buf.writeUInt16LE(42, 2); buf.writeUInt32LE(8, 4); buf.writeUInt16LE(entries.length, 8);
      entries.forEach(([tag, type, n, v], k) => { const e = 10 + k * 12; buf.writeUInt16LE(tag, e); buf.writeUInt16LE(type, e + 2); buf.writeUInt32LE(n, e + 4); const val = tag === 273 ? dataOff : v; if (type === 3) buf.writeUInt16LE(val, e + 8); else buf.writeUInt32LE(val, e + 8); });
      raw.copy(buf, dataOff);
      const fp = join(work, `ir_${f}.tif`); writeFileSync(fp, buf); irFiles.push(fp);
    }
    await setFiles('#mediaInput', irFiles);
    await waitFor(`FRS.state.source && FRS.state.source.infrared && FRS.state.total === 4 && FRS.state.shown`, 'IR import', 60000);
    assert.equal(await evaluate(`document.querySelector('#irClean').disabled`), false);
    await evaluate(`FRS.setParams({ irClean: 60, dust: 20 }); document.querySelector('#irClean').dispatchEvent(new Event('input'))`);
    await evaluate(`FRS.goToFrame(1)`);
    await waitFor(`FRS.state.shown.frame === 1 && FRS.state.shown.valid && !FRS.state.processing && FRS.state.shown.res.stats.irPixels > 0`, 'IR clean', 60000);
    const irPx = await evaluate('FRS.state.shown.res.stats.irPixels');
    assert.ok(irPx >= 36 && irPx < 150, `IR-cleaned pixels ${irPx}`);
  });

  // ---------------------------------------------------------------- 3.3: keyframes, colour, assessment
  await check('Keyframes animate settings across a shot', async () => {
    await restoreSeq();
    await evaluate(`FRS.goToFrame(1)`); await settle('frame 1');
    await evaluate(`{ const d = document.querySelector('#dust'); d.value = 20; d.dispatchEvent(new Event('input')); d.dispatchEvent(new Event('change')); }`);
    await key('k', 'KeyK');
    await evaluate(`FRS.goToFrame(4)`); await settle('frame 4');
    await evaluate(`{ const d = document.querySelector('#dust'); d.value = 80; d.dispatchEvent(new Event('input')); d.dispatchEvent(new Event('change')); }`);
    assert.equal(await evaluate('FRS.state.keys.get(0).length'), 2, 'editing an animated shot sets a key');
    const mid = await evaluate('FRS.paramsFor(2).dust'), a = await evaluate('FRS.paramsFor(1).dust'), b = await evaluate('FRS.paramsFor(4).dust');
    assert.equal(a, 20); assert.equal(b, 80); assert.ok(mid > 20 && mid < 80, `frame 3 dust ${mid}`);
    await evaluate(`FRS.goToFrame(2)`); await settle('frame 2');
    assert.equal(+(await evaluate(`document.querySelector('#dust').value`)), Math.round(mid), 'sliders show the animated value');
    await key('z', 'KeyZ', 2); await key('z', 'KeyZ', 2);
    assert.equal(await evaluate('FRS.state.keys.size'), 0, 'undo removes the keys');
  });

  await check('Colour registration and fade restoration run in the pipeline', async () => {
    await evaluate(`FRS.setParams({ chromaAlign: true, fade: 60, dust: 55 }); document.querySelector('#fade').dispatchEvent(new Event('input'))`);
    await evaluate(`FRS.state.results.clear(); FRS.requestProcess()`);
    await waitFor(`FRS.state.shown.valid && !FRS.state.processing && FRS.state.shown.res.stats.chroma && FRS.state.shown.res.stats.fade`, 'colour', 60000);
    const c = await evaluate('FRS.state.shown.res.stats.chroma');
    assert.ok(Math.abs(c.r[0]) < 0.3 && Math.abs(c.b[1]) < 0.3, `registered fixture needs no shift: ${JSON.stringify(c)}`);
    await evaluate(`FRS.setParams({ chromaAlign: false, fade: 0 }); document.querySelector('#fade').dispatchEvent(new Event('input'))`);
  });

  await check('Scan flags a burnt frame and rebuilds it in one click', async () => {
    const files = [];
    for (let f = 0; f < 8; f++) {
      const rgb = frameRGB(f + 10);
      if (f === 4) for (let y = 40; y < 150; y++) for (let x = 90; x < 230; x++) if ((x - 160) ** 2 / 4900 + (y - 95) ** 2 / 3000 < 1) { const j = (y * W + x) * 3; rgb[j] = 250; rgb[j + 1] = 240; rgb[j + 2] = 200; }
      const fp = join(work, `burn_${String(f).padStart(3, '0')}.png`); writeFileSync(fp, png(W, H, rgb)); files.push(fp);
    }
    await setFiles('#mediaInput', files);
    await waitFor(`FRS.state.source && FRS.state.total === 8 && FRS.state.shown`, 'burn import', 60000);
    await evaluate(`document.querySelector('#scanBtn').click()`);
    await waitFor(`FRS.state.scan && FRS.state.scan.suspects && !FRS.state.rendering`, 'scan', 120000);
    assert.deepEqual(await evaluate('FRS.state.scan.suspects'), [4]);
    assert.ok((await evaluate(`document.querySelector('#assessment').textContent`)).includes('damaged'));
    await evaluate(`document.querySelector('#rebuildSuspectsBtn').click()`);
    assert.ok(await evaluate('FRS.state.replaced.has(4)'));
    await evaluate(`FRS.goToFrame(4)`);
    await waitFor(`FRS.state.shown.frame === 4 && FRS.state.shown.valid && !FRS.state.processing`, 'rebuilt', 60000);
    const v = await evaluate(`FRS.state.shown.res.data[(95 * ${W} + 160) * 4 + 1] / 257`);
    assert.ok(v < 220, `burn removed by the rebuild (${v.toFixed(0)})`);
    const sc = await evaluate(`(() => { const d = FRS.state.shown.res.data, at = (x) => d[(100 * ${W} + x) * 4 + 1] / 257; return [at(246), at(250), at(254)]; })()`);
    assert.ok(Math.abs(sc[1] - (sc[0] + sc[2]) / 2) < 25, `no scratch carried into the rebuilt frame: ${sc.map((x) => x.toFixed(0)).join(', ')}`);
    await shot('05-assessment.png');
  });

  if (videoPath) await check('Batch queue renders two clips unattended with their own projects', async () => {
    for (const f of readdirSync(downloads)) { try { rmSync(join(downloads, f), { force: true }); } catch { /* the browser may hold a file */ } }
    // clip 1: the burnt sequence (frame 5 rebuilt) as MP4
    await evaluate(`(() => { const s = document.querySelector('#exportFormat'); s.value = 'mp4'; s.dispatchEvent(new Event('change')); })()`);
    await evaluate('FRS.addToQueue()');
    // clip 2: the dusty PNG sequence as an 8-bit PNG ZIP
    await restoreSeq();
    await evaluate(`(() => { const s = document.querySelector('#exportFormat'); s.value = 'png8'; s.dispatchEvent(new Event('change')); })()`);
    await evaluate('FRS.addToQueue()');
    assert.equal(await evaluate('FRS.state.queue.length'), 2);
    await evaluate('FRS.runQueue()');
    await waitFor(`!FRS.state.queueRunning && FRS.state.queue.every((q) => q.status !== 'queued' && q.status !== 'loading' && q.status !== 'rendering')`, 'queue', 300000);
    assert.deepEqual(await evaluate('FRS.state.queue.map((q) => q.status)'), ['done', 'done']);
    let mp4, zip;
    for (let i = 0; i < 80 && !(mp4 && zip); i++) { await new Promise((r) => setTimeout(r, 100)); const l = readdirSync(downloads); mp4 = l.find((f) => f.endsWith('.mp4')); zip = l.find((f) => f.endsWith('.zip')); }
    assert.ok(mp4 && zip, `queue outputs: ${readdirSync(downloads).join(', ')}`);
    assert.equal(+probe(join(downloads, mp4)).nb_read_frames, 8);
    const all = execFileSync('ffmpeg', ['-v', 'error', '-i', join(downloads, mp4), '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 26 });
    const v = all[4 * W * H * 3 + (95 * W + 160) * 3 + 1];
    assert.ok(v < 220, `the queued project's rebuilt frame stayed rebuilt in the video (${v})`);
  });

  await check('Repair regions remove a gate hair and a burnt-in subtitle using revealed frames', async () => {
    const files = [], N = 9, hairX = (y) => Math.round(70 + 10 * Math.sin(y / 12));
    const isDefect = (x, y) => (y >= 40 && y < 120 && Math.abs(x - hairX(y)) <= 1) || (y >= 160 && y < 172 && x >= 120 && x < 200);
    for (let f = 0; f < N; f++) {
      const rgb = frameRGB(f + 30);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (isDefect(x, y)) { const j = (y * W + x) * 3; const v = y >= 160 ? 245 : 15; rgb[j] = rgb[j + 1] = rgb[j + 2] = v; }
      const fp = join(work, `hair_${String(f).padStart(3, '0')}.png`); writeFileSync(fp, png(W, H, rgb)); files.push(fp);
    }
    await setFiles('#mediaInput', files);
    await waitFor(`FRS.state.source && FRS.state.total === ${N} && FRS.state.shown`, 'hair import', 60000);
    await evaluate(`FRS.setParams({ dust: 50, scratch: 0, denoise: 0 })`);
    await evaluate(`document.querySelector('#scanBtn').click()`);
    await waitFor(`FRS.state.scan && FRS.state.scan.motions && !FRS.state.rendering`, 'scan', 120000);
    await evaluate(`FRS.goToFrame(4)`); await settle('frame 4');
    await evaluate(`document.querySelector('#regionKind').value = 'repair'`);
    await key('g', 'KeyG');
    for (const [x0, y0, x1, y1] of [[56, 36, 84, 124], [116, 156, 204, 176]]) {
      const [a, b] = await imageToScreen(x0, y0), [c, d] = await imageToScreen(x1, y1);
      await mouse('mousePressed', a, b); await mouse('mouseMoved', (a + c) / 2, (b + d) / 2); await mouse('mouseMoved', c, d); await mouse('mouseReleased', c, d);
    }
    await waitFor('FRS.state.rois.length === 2 && FRS.state.rois.every((r) => r.kind === "repair")', 'repair regions');
    await waitFor(`FRS.state.shown.frame === 4 && FRS.state.shown.valid && !FRS.state.processing`, 'repair', 120000);
    const truth = frameRGB(4 + 30);
    const err = await evaluate(`(() => { const d = FRS.state.shown.res.data, pts = ${JSON.stringify([[hairX(60), 60], [hairX(90), 90], [hairX(110), 110], [130, 165], [160, 166], [190, 168]])}; return pts.map(([x, y]) => d[(y * ${W} + x) * 4 + 1] / 257); })()`);
    const want = [[hairX(60), 60], [hairX(90), 90], [hairX(110), 110], [130, 165], [160, 166], [190, 168]].map(([x, y]) => truth[(y * W + x) * 3 + 1]);
    const worst = Math.max(...err.map((v, k) => Math.abs(v - want[k])));
    assert.ok(worst < 30, `repaired ${err.map((v) => v.toFixed(0)).join(',')} vs clean ${want.join(',')}`);
    const fill = await evaluate('FRS.fillRepairs(4, FRS.state.raw.peek(4)).then((f) => f.sources)');
    assert.ok(fill >= 1, 'pixels came from other frames');
    const regionErr = await evaluate(`(() => { const d = FRS.state.shown.res.data, t = ${JSON.stringify(Array.from(truth))}; const out = []; for (const [x0, y0, x1, y1] of [[56, 36, 84, 124], [116, 156, 204, 176]]) { let e = 0, k = 0; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { e += Math.abs(d[(y * ${W} + x) * 4 + 1] / 257 - t[(y * ${W} + x) * 3 + 1]); k++; } out.push(e / k); } return out; })()`);
    console.log('  repair-region mean error vs clean frame:', regionErr.map((v) => v.toFixed(2)).join(', '));
    // hair: fully revealed by the pan -> near grain level; subtitle: its centre is never revealed
    // by ±12 px of horizontal / ±4 px of vertical camera motion, so part of it is synthesised
    assert.ok(regionErr[0] < 2 && regionErr[1] < 8, `region errors ${regionErr.map((v) => v.toFixed(2)).join(', ')}`);
    await key('v', 'KeyV'); await key('6', 'Digit6');
    await shot('06-repair-regions.png');
  });

  await check('Colour brush hints colourise the shot while keeping luminance', async () => {
    await restoreSeq();
    await evaluate(`FRS.setParams({ colorize: 100, dust: 55 }); document.querySelector('#colorize').dispatchEvent(new Event('input'))`);
    await key('q', 'KeyQ');
    const stroke = async (color, x0, y0, x1, y1) => {
      await evaluate(`{ const c = document.querySelector('#paintColor'); c.value = '${color}'; }`);
      const [a, b] = await imageToScreen(x0, y0), [c, d] = await imageToScreen(x1, y1);
      await mouse('mousePressed', a, b);
      for (let k = 1; k <= 6; k++) await mouse('mouseMoved', a + ((c - a) * k) / 6, b + ((d - b) * k) / 6);
      await mouse('mouseReleased', c, d);
    };
    await stroke('#d02818', 40, 60, 90, 70);
    await stroke('#1840d0', 220, 140, 290, 150);
    assert.equal(await evaluate('FRS.state.hints.size'), 1);
    await waitFor(`FRS.state.shown.valid && !FRS.state.processing && FRS.state.shown.res.stats.colorized`, 'colourise', 60000);
    const px = (x, y) => evaluate(`(() => { const d = FRS.state.shown.res.data, j = (${y} * ${W} + ${x}) * 4; return [d[j], d[j + 1], d[j + 2]].map((v) => v / 257); })()`);
    const near = await px(60, 90), far = await px(250, 170);
    assert.ok(near[0] > near[2] + 15, `near the red hint is red: ${near.map((v) => v.toFixed(0))}`);
    assert.ok(far[2] > far[0] + 15, `near the blue hint is blue: ${far.map((v) => v.toFixed(0))}`);
    const lumaErr = await evaluate(`(() => { const d = FRS.state.shown.res.data, r = FRS.state.raw.peek(${DUST_FRAME}); let e = 0, k = 0; for (let y = 20; y < 180; y += 7) for (let x = 20; x < 300; x += 7) { const j = (y * ${W} + x) * 4, l = (q) => 0.2126 * q[j] + 0.7152 * q[j + 1] + 0.0722 * q[j + 2]; e += Math.abs(l(d) - l(r)) / 257; k++; } return e / k; })()`);
    assert.ok(lumaErr < 6, `luminance kept (mean change ${lumaErr.toFixed(2)}, includes dust repair)`);
    await evaluate(`FRS.goToFrame(${DUST_FRAME + 1})`);
    await waitFor(`FRS.state.shown.frame === ${DUST_FRAME + 1} && FRS.state.shown.valid && !FRS.state.processing && FRS.state.shown.res.stats.colorized`, 'propagated', 60000);
    const other = await px(60, 90);
    assert.ok(other[0] > other[2] + 15, `hints carried to the next frame: ${other.map((v) => v.toFixed(0))}`);
    await shot('07-colourise.png');
    await evaluate(`FRS.setParams({ colorize: 0 }); document.querySelector('#colorize').dispatchEvent(new Event('input'))`);
    await key('v', 'KeyV');
  });

  await check('Cineon log DPX scans are decoded to display and written back as log', async () => {
    const { toLog } = IOnode.cineonLUTs(), files = [];
    for (let f = 0; f < 3; f++) {
      const rgb = frameRGB(f), d = new Uint16Array(W * H * 4);
      for (let i = 0; i < W * H; i++) { for (let c = 0; c < 3; c++) d[i * 4 + c] = toLog[rgb[i * 3 + c] * 257]; d[i * 4 + 3] = 65535; }
      const fp = join(work, `log_${f}.dpx`); writeFileSync(fp, IOnode.encodeDPX(W, H, d, { log: true })); files.push(fp);
    }
    await setFiles('#mediaInput', files);
    await waitFor(`FRS.state.source && FRS.state.source.format === 'DPX' && FRS.state.total === 3 && FRS.state.shown`, 'log import', 60000);
    assert.equal(await evaluate('FRS.state.source.transfer'), 'cineon', 'printing-density header detected');
    const shown = await evaluate(`(() => { const d = FRS.state.raw.peek(0); return [d[(50 * ${W} + 50) * 4 + 1], d[(120 * ${W} + 200) * 4 + 1]].map((v) => v / 257); })()`);
    const want = [frameRGB(0)[(50 * W + 50) * 3 + 1], frameRGB(0)[(120 * W + 200) * 3 + 1]];
    assert.ok(shown.every((v, k) => Math.abs(v - want[k]) < 3), `log decoded to display: ${shown.map((v) => v.toFixed(1))} vs ${want}`);
    for (const f of readdirSync(downloads)) { try { rmSync(join(downloads, f), { force: true }); } catch { /* held */ } }
    await evaluate(`(() => { const s = document.querySelector('#exportFormat'); s.value = 'dpx10'; s.dispatchEvent(new Event('change')); FRS.setParams({ dust: 0, denoise: 0 }); })()`);
    await evaluate(`FRS.state.results.clear(); FRS.requestProcess()`);
    await settle('log restore');
    await evaluate(`document.querySelector('#exportPngBtn').click()`);
    let name;
    for (let i = 0; i < 80 && !name; i++) { await new Promise((r) => setTimeout(r, 100)); name = readdirSync(downloads).find((f) => f.endsWith('.dpx')); }
    const b = readFileSync(join(downloads, name)), back = IOnode.decodeDPX(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
    assert.equal(back.transfer, 1, 'exported DPX keeps printing density');
    const v = back.data[(50 * W + 50) * 4 + 1], orig = toLog[frameRGB(0)[(50 * W + 50) * 3 + 1] * 257];
    assert.ok(Math.abs(v - orig) < 400, `log code value preserved: ${v} vs ${orig}`);
    await evaluate(`(() => { const s = document.querySelector('#exportFormat'); s.value = 'png16'; s.dispatchEvent(new Event('change')); })()`);
  });

  await check('no uncaught page errors', async () => { assert.deepEqual(errors, []); });
} finally {
  for (const r of results) console.log(r.join(' | '));
  if (process.env.FRS_VERBOSE) console.log(consoleLines.join('\n'));
  ws.close(); proc.kill();
  await new Promise((r) => setTimeout(r, 500));
  if (!process.env.FRS_SHOTS) try { rmSync(work, { recursive: true, force: true }); } catch { /* browser may still hold files */ }
}
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(failed ? `${failed} browser check(s) failed` : 'All browser checks passed');
process.exit(failed ? 1 : 0);
