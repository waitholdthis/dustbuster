/* FrameRestore Studio 3.8 application shell. */
(() => {
  'use strict';
  const E = window.FRSEngine, IO = window.FRSIO;
  const $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];

  // ------------------------------------------------------------------ constants
  const NUM_PARAMS = ['dust', 'maxSize', 'motionRange', 'scratch', 'scratchWidth', 'deflicker', 'denoise', 'exposure', 'contrast', 'saturation', 'sharpen', 'grain', 'irClean', 'stabilize', 'stabSmooth', 'stabZoom', 'fade', 'colorize'];
  const BOOL_PARAMS = ['motion', 'grainMatch', 'chromaAlign', 'chromaLocal'];
  const SELECT_PARAMS = ['spatial', 'flow', 'stabMode'];
  const OUTPUT_PARAMS = ['stabilize', 'stabSmooth', 'stabZoom', 'stabMode']; // applied at output, not by the restoration engine
  const FPS_STANDARD = [16, 18, 23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60];
  const CUT_THRESHOLD = 0.3;
  const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'avif', 'tif', 'tiff', 'dpx', 'exr'];
  const VIDEO_EXT = ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'ogv', 'avi'];
  const BASE = { dust: 50, maxSize: 32, spatial: 'auto', flow: 'dense', motion: true, motionRange: 24, scratch: 0, scratchWidth: 3, deflicker: 0, denoise: 10, grainMatch: true, exposure: 0, contrast: 0, saturation: 0, sharpen: 0, grain: 0, irClean: 0, stabilize: 0, stabSmooth: 15, stabZoom: 3, stabMode: 'smooth', fade: 0, chromaAlign: false, chromaLocal: false, colorize: 0 };
  const STILL_FORMATS = { png16: { ext: 'png', label: 'PNG 16-bit' }, tiff16: { ext: 'tif', label: 'TIFF 16-bit' }, dpx10: { ext: 'dpx', label: 'DPX 10-bit' }, exr: { ext: 'exr', label: 'OpenEXR half (linear)' }, png8: { ext: 'png', label: 'PNG 8-bit' } };
  const VIDEO_FORMATS = { mp4: { ext: 'mp4', label: 'MP4 (H.264)', mime: 'video/mp4' }, webm: { ext: 'webm', label: 'WebM (VP9)', mime: 'video/webm' } };
  const VIDEO_BPP = { standard: 0.1, high: 0.25, master: 0.6 };
  const PRESETS = {
    balanced: {},
    gentle: { dust: 38, maxSize: 24, denoise: 6, deflicker: 25 },
    dirty: { dust: 70, maxSize: 64, scratch: 45, deflicker: 45, denoise: 22, sharpen: 8 },
    scratched: { dust: 55, maxSize: 40, scratch: 75, scratchWidth: 5, denoise: 12 },
    nitrate: { dust: 60, maxSize: 48, deflicker: 85, denoise: 35, grain: 5, scratch: 30 },
    color: { dust: 45, denoise: 12, exposure: 4, contrast: 8, saturation: 22, sharpen: 12 },
    still: { dust: 50, maxSize: 16, spatial: 'on', denoise: 8, sharpen: 6 },
  };

  // ------------------------------------------------------------------ helpers
  class LRU {
    constructor(limit) { this.limit = limit; this.map = new Map(); }
    get(k) { if (!this.map.has(k)) return undefined; const v = this.map.get(k); this.map.delete(k); this.map.set(k, v); return v; }
    peek(k) { return this.map.get(k); }
    set(k, v) { this.map.delete(k); this.map.set(k, v); while (this.map.size > this.limit) this.map.delete(this.map.keys().next().value); }
    has(k) { return this.map.has(k); }
    delete(k) { this.map.delete(k); }
    clear() { this.map.clear(); }
    keys() { return [...this.map.keys()]; }
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));
  const escapeHtml = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (n, l = 6) => String(n).padStart(l, '0');
  const isTyping = (e) => { const t = e.target; return t && (t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && !['range', 'checkbox', 'button', 'color'].includes(t.type)) || t.isContentEditable); };
  const store = {
    get(k, d) { try { const v = localStorage.getItem('frs3:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('frs3:' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };
  function makeCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  function ctx2d(c) { return c.getContext('2d', { willReadFrequently: true }); }
  /** Draw RGBA data on a canvas; 16-bit frames are reduced to 8-bit for display only. */
  function putData(canvas, data, w, h) {
    const d8 = data instanceof Uint16Array ? E.to8(data) : data instanceof Uint8ClampedArray ? data : new Uint8ClampedArray(data);
    if (data instanceof Uint16Array) for (let j = 3; j < d8.length; j += 4) d8[j] = 255; // alpha may carry the infrared layer
    ctx2d(canvas).putImageData(new ImageData(d8, w, h), 0, 0);
  }
  function download(blob, name) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  // ------------------------------------------------------------------ frame sources
  class VideoSource {
    constructor(file) {
      this.kind = 'video'; this.name = file.name; this.file = file; this.format = (IO.extension(file.name) || 'video').toUpperCase();
      this.video = document.createElement('video'); this.video.muted = true; this.video.playsInline = true; this.video.preload = 'auto';
      this.url = URL.createObjectURL(file); this.queue = Promise.resolve();
    }
    async open() {
      const v = this.video;
      v.src = this.url;
      await new Promise((res, rej) => {
        v.onloadeddata = res;
        v.onerror = () => rej(new Error(`This browser cannot decode ${this.name}. Try MP4 (H.264) or WebM, or an image sequence.`));
      });
      if (!v.videoWidth) throw new Error(`${this.name} has no video track`);
      this.width = v.videoWidth; this.height = v.videoHeight; this.duration = v.duration;
      this.canvas = makeCanvas(this.width, this.height); this.ctx = ctx2d(this.canvas);
      this.detectedFps = await this.detectFps();
    }
    async detectFps() {
      const v = this.video;
      if (!('requestVideoFrameCallback' in v) || !(this.duration > 0.3)) return null;
      const times = [];
      try {
        let finish;
        const done = new Promise((r) => { finish = r; });
        const cb = (_now, meta) => { times.push(meta.mediaTime); if (times.length >= 16) finish(); else v.requestVideoFrameCallback(cb); };
        v.requestVideoFrameCallback(cb);
        await v.play();
        await Promise.race([done, sleep(2500)]);
      } catch { /* autoplay refused or decode issue: fall back to manual fps */ } finally {
        v.pause();
        await this.seekTo(0);
      }
      const d = [];
      for (let i = 1; i < times.length; i++) { const dt = times[i] - times[i - 1]; if (dt > 0.004) d.push(dt); }
      if (d.length < 5) return null;
      d.sort((a, b) => a - b);
      const fps = 1 / d[Math.floor(d.length * 0.3)];
      const snap = FPS_STANDARD.find((f) => Math.abs(f - fps) / f < 0.025);
      return snap || Math.round(fps * 1000) / 1000;
    }
    setFps(f) { this.fps = f; this.total = Math.max(1, Math.floor(this.duration * f + 1e-3)); }
    seekTo(t) {
      const v = this.video;
      return new Promise((res) => {
        if (Math.abs(v.currentTime - t) < 1e-5 && v.readyState >= 2) { res(); return; }
        const done = () => { v.removeEventListener('seeked', done); clearTimeout(timer); res(); };
        const timer = setTimeout(done, 4000);
        v.addEventListener('seeked', done);
        v.currentTime = t;
      });
    }
    getFrame(i) {
      const job = this.queue.then(async () => {
        await this.seekTo(Math.min(Math.max(0, this.duration - 1e-3), (i + 0.5) / this.fps));
        this.ctx.drawImage(this.video, 0, 0, this.width, this.height);
        return E.toU16(this.ctx.getImageData(0, 0, this.width, this.height).data);
      });
      this.queue = job.catch(() => {});
      return job;
    }
    close() { this.video.removeAttribute('src'); this.video.load(); URL.revokeObjectURL(this.url); }
  }

  class SequenceSource {
    constructor(files) {
      this.files = [...files].sort((a, b) => IO.naturalCompare(a.name, b.name));
      this.kind = this.files.length > 1 ? 'sequence' : 'image';
      this.total = this.files.length;
      const first = this.files[0].name, last = this.files[this.files.length - 1].name;
      this.name = this.kind === 'image' ? first : `${first} … ${last}`;
      this.format = (IO.extension(first) || 'image').toUpperCase();
      this.fps = 24; this.detectedFps = null;
    }
    async open() {
      const first = await this.decode(0);
      this.width = first.width; this.height = first.height; this.bitDepth = first.bitDepth || 8; this.first = first; this.infrared = !!first.infrared; this.linear = !!first.linear;
      this.logHeader = first.format === 'DPX' && first.transfer === 1; // printing density
      this.setTransfer('auto');
    }
    async decode(i) {
      const f = this.files[i], ext = IO.extension(f.name);
      if (ext === 'dpx') return IO.decodeDPX(await f.arrayBuffer());
      if (ext === 'exr') return IO.decodeEXR(await f.arrayBuffer());
      if (ext === 'tif' || ext === 'tiff') {
        try { return IO.decodeTIFF(await f.arrayBuffer()); } catch (err) {
          try { return await this.decodeBrowser(f); } catch { throw new Error(`${f.name}: ${err.message}`); }
        }
      }
      return this.decodeBrowser(f);
    }
    async decodeBrowser(f) {
      let bmp;
      try { bmp = await createImageBitmap(f); } catch { throw new Error(`Cannot decode ${f.name}`); }
      const c = makeCanvas(bmp.width, bmp.height), x = ctx2d(c);
      x.drawImage(bmp, 0, 0); if (bmp.close) bmp.close();
      return { width: c.width, height: c.height, data: E.toU16(x.getImageData(0, 0, c.width, c.height).data) };
    }
    setFps(f) { this.fps = f; }
    /** 'auto' | 'display' | 'cineon': how stored code values map into the display-referred working space. */
    setTransfer(mode) {
      this.transferMode = mode;
      this.transfer = mode === 'auto' ? (this.logHeader ? 'cineon' : 'display') : mode;
      if (this.transfer === 'cineon' && !SequenceSource.luts) SequenceSource.luts = IO.cineonLUTs();
    }
    async getFrame(i) {
      let r;
      if (i === 0 && this.first) { r = this.first; this.first = null; } else r = await this.decode(i);
      if (this.transfer === 'cineon') r = Object.assign({}, r, { data: IO.applyLUT16(r.data, SequenceSource.luts.toDisplay) });
      if (r.width !== this.width || r.height !== this.height) {
        const src = makeCanvas(r.width, r.height); putData(src, r.data, r.width, r.height);
        const dst = makeCanvas(this.width, this.height), x = ctx2d(dst);
        x.drawImage(src, 0, 0, this.width, this.height);
        return E.toU16(x.getImageData(0, 0, this.width, this.height).data);
      }
      return r.data;
    }
    close() {}
  }

  // ------------------------------------------------------------------ engine bridge (worker pool, GPU, main-thread fallback)
  const engine = {
    workers: [], seq: 0, pending: new Map(), cache: new Map(), mode: 'main', gpuName: null, gpuWanted: true, mainAccel: null, src: null,
    frameCacheSize: 6,
    spawn() {
      if (!this.src) this.src = URL.createObjectURL(new Blob([`const FRSEngine=(${E.factorySource})();\n(${E.workerMain.toString()})(self, FRSEngine);`], { type: 'text/javascript' }));
      const w = new Worker(this.src);
      w.onmessage = (e) => {
        const p = this.pending.get(e.data.id);
        if (!p) return;
        this.pending.delete(e.data.id);
        if (e.data.ok) p.resolve(e.data.result); else p.reject(new Error(e.data.error));
      };
      w.onerror = (e) => { if (e.preventDefault) e.preventDefault(); this.fallback(`Worker failed (${e.message || 'blocked'}); using main thread`); };
      w.frames = new LRU(this.frameCacheSize); // mirror of the worker's frame cache
      this.workers.push(w);
      return this.workers.length - 1;
    },
    send(k, msg) {
      const id = ++this.seq;
      return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject, msg }); this.workers[k].postMessage(Object.assign({ id }, msg)); });
    },
    async init() {
      this.gpuWanted = store.get('gpu', true);
      try {
        const k = this.spawn(); this.mode = 'worker';
        const r = await this.send(k, { type: 'init', gpu: this.gpuWanted });
        this.gpuName = r.gpu;
      } catch (err) { this.fallback('Background worker unavailable; processing on the main thread'); }
      this.badge();
    },
    async ensurePool(n) {
      if (this.mode !== 'worker') return 1;
      while (this.workers.length < n) { const k = this.spawn(); await this.send(k, { type: 'init', gpu: this.gpuWanted }); }
      this.badge();
      return this.workers.length;
    },
    trimPool() { while (this.workers.length > 1) this.workers.pop().terminate(); this.badge(); },
    async setGPU(on) {
      this.gpuWanted = on; store.set('gpu', on);
      if (this.mode === 'worker') {
        const rs = await Promise.all(this.workers.map((_, k) => this.send(k, { type: 'gpu', on })));
        this.gpuName = rs[0] && rs[0].gpu;
      } else {
        this.mainAccel = on ? this.mainAccel || await E.createGPU() : null;
        this.gpuName = this.mainAccel ? this.mainAccel.name : null;
      }
      this.cache.clear();
      this.badge();
    },
    fallback(reason) {
      for (const w of this.workers) { try { w.terminate(); } catch { /* ignore */ } }
      this.workers = []; this.mode = 'main';
      const waiting = [...this.pending.values()]; this.pending.clear();
      for (const p of waiting) if (p.msg.type === 'process') this.runMain(p.msg).then(p.resolve, p.reject); else p.resolve({});
      if (reason) console.warn(reason);
      if (this.gpuWanted) E.createGPU().then((a) => { this.mainAccel = a; this.gpuName = a ? a.name : null; this.badge(); });
      this.badge();
    },
    badge() {
      const parts = [this.mode === 'worker' ? 'Background engine' : 'Main-thread engine', this.gpuName ? `GPU ${this.gpuName}` : 'CPU'];
      if (this.workers.length > 1) parts.push(`${this.workers.length} workers`);
      $('#engineBadge').textContent = parts.join(' · ');
      const info = $('#accelInfo');
      if (info) info.textContent = this.gpuName ? `Optical flow on ${this.gpuName}.` : this.gpuWanted ? 'No WebGPU device available; using the CPU.' : 'GPU off; using the CPU.';
    },
    async runMain(msg) {
      await sleep(0);
      let an = msg.analysisKey ? this.cache.get(msg.analysisKey) : null;
      if (!an) {
        an = this.mainAccel ? await E.analyzeAsync(msg.job, this.mainAccel) : E.analyze(msg.job);
        if (msg.analysisKey) { this.cache.set(msg.analysisKey, an); while (this.cache.size > 3) this.cache.delete(this.cache.keys().next().value); }
      } else an = Object.assign({}, an, { ms: 0 });
      return E.render(msg.job, an);
    },
    /** frameKeys: { cur, refs } identifies frames so each worker receives a frame only once. */
    process(job, analysisKey, k = 0, frameKeys = null) {
      if (!this.workers.length) return this.runMain({ type: 'process', job, analysisKey });
      const idx = Math.min(k, this.workers.length - 1), w = this.workers[idx];
      let msg = { type: 'process', job, analysisKey };
      if (frameKeys) {
        const ship = (key, data) => { const has = w.frames.has(key); w.frames.set(key, true); return has ? null : data; };
        const slim = Object.assign({}, job, { cur: ship(frameKeys.cur, job.cur), refs: frameKeys.refs.map((key, i) => ship(key, job.refs[i])) });
        msg = { type: 'process', job: slim, analysisKey, frameKeys, frameCacheSize: this.frameCacheSize };
      }
      return this.send(idx, msg);
    },
    async clickFix(analysisKey, x, y, r) {
      if (!this.workers.length) { const an = this.cache.get(analysisKey); return an ? { idx: E.localDetect(an, x, y, r) } : { missing: true }; }
      return this.send(0, { type: 'clickFix', analysisKey, x, y, r });
    },
    globalMotion(cur, ref, w, h) {
      if (!this.workers.length) return Promise.resolve(E.globalMotion(cur, ref, w, h, 24));
      return this.send(0, { type: 'globalMotion', cur, ref, w, h, range: 24 });
    },
    flowBench(m) { return this.workers.length ? this.send(0, Object.assign({ type: 'flowBench' }, m)) : Promise.resolve({}); },
    reset() { this.cache.clear(); this.workers.forEach((w, k) => { w.frames.clear(); this.send(k, { type: 'reset' }).catch(() => {}); }); },
  };

  // ------------------------------------------------------------------ state
  const S = {
    source: null, gen: 0, w: 0, h: 0, total: 0, fps: 24, frame: 0,
    raw: new LRU(8), hist: new Map(), results: new LRU(6), prior: new Map(), log: new Map(),
    paint: new Map(), heal: new Map(), rejects: new Map(), versions: new Map(), pins: [],
    protect: null, protectVersion: 0,
    view: 'restored', tool: 'pan', zoom: 1, panX: 0, panY: 0, fitMode: true, split: 0.5,
    inMark: null, outMark: null, scan: null,
    undo: [], redo: [], history: [], lastParams: null,
    navToken: 0, processing: false, processAgain: false, rendering: false, cancel: false, playing: false,
    pointer: null, mouse: null, spaceDown: false, spaceUsed: false, flip: false, cloneSrc: null, cloneOffset: null,
    pendingProject: null,
    queue: [], queueSeq: 0, queueRunning: false, fillCache: new LRU(4), hints: new Map(), hintPix: new Map(),
    globalParams: null, shotParams: new Map(), splits: new Set(), bounds: [0], replaced: new Set(), keys: new Map(), keyMode: 'smooth', keysBefore: null, levelsCache: new Map(),
    revert: new Map(), rois: [], selectedRoi: null, roiSeq: 0, stabCache: new Map(), outputDirty: true,
  };

  // canvases
  const display = $('#displayCanvas'), dctx = display.getContext('2d');
  let origCanvas, resultCanvas, compCanvas, diffCanvas, protectCanvas, strokeCanvas, strokeBase;
  let diffDirty = true;

  // ------------------------------------------------------------------ UI basics
  function setMessage(msg, progress) {
    $('#footerMessage').textContent = msg;
    if (progress !== undefined) $('#progressBar').style.width = Math.max(0, Math.min(100, progress)) + '%';
  }
  function log(label) {
    S.history.unshift(`${new Date().toLocaleTimeString()} · ${label}`);
    S.history = S.history.slice(0, 60);
    $('#history').innerHTML = S.history.map((x) => `<li>${escapeHtml(x)}</li>`).join('');
  }
  function setBusy(on, text) { $('#busy').classList.toggle('hidden', !on); if (text) $('#busy').textContent = text; }

  function getParams() {
    const p = {};
    for (const id of NUM_PARAMS) p[id] = +$('#' + id).value;
    for (const id of BOOL_PARAMS) p[id] = $('#' + id).checked;
    for (const id of SELECT_PARAMS) p[id] = $('#' + id).value;
    return p;
  }
  function setParams(p) {
    for (const id of NUM_PARAMS) if (p[id] !== undefined && Number.isFinite(+p[id])) $('#' + id).value = p[id];
    for (const id of BOOL_PARAMS) if (p[id] !== undefined) $('#' + id).checked = !!p[id];
    for (const id of SELECT_PARAMS) if (p[id] !== undefined) $('#' + id).value = p[id];
    syncOutputs();
  }
  function syncOutputs() {
    for (const o of $$('output[data-for]')) o.value = $('#' + o.dataset.for).value;
    $('#motionRange').disabled = !$('#motion').checked;
    $('#chromaLocal').disabled = !$('#chromaAlign').checked;
  }
  // ---- shots & per-shot settings
  function rebuildBounds() {
    const b = new Set([0, ...S.splits]);
    if (S.scan) for (const c of S.scan.cuts) b.add(c);
    S.bounds = [...b].filter((f) => f < Math.max(1, S.total)).sort((x, y) => x - y);
    S.stabCache.clear();
  }
  function shotStart(i) { let s0 = 0; for (const b of S.bounds) { if (b <= i) s0 = b; else break; } return s0; }
  function shotEnd(i) { for (const b of S.bounds) if (b > i) return b - 1; return Math.max(0, S.total - 1); }
  function shotIndex(i) { return S.bounds.filter((b) => b <= i).length; }
  /** Effective settings for frame i: the shot's own settings if it has them, otherwise the clip's. */
  function baseParamsFor(i) { return Object.assign({}, BASE, S.globalParams || {}, S.shotParams.get(shotStart(i)) || {}); }
  function shotKeys(i) { const k = S.keys.get(shotStart(i)); return k && k.length ? k : null; }
  function paramsFor(i) {
    const keys = shotKeys(i);
    if (keys) return Object.assign(baseParamsFor(i), E.interpolateKeyframes(keys, i, S.keyMode));
    if (S.source && shotStart(i) === shotStart(S.frame)) return getParams();
    return baseParamsFor(i);
  }
  const snapshotKeys = () => [...S.keys.entries()].map(([k, list]) => [k, list.map((q) => ({ frame: q.frame, params: Object.assign({}, q.params) }))]);
  function setKey(frame, params) {
    const start = shotStart(frame), list = (S.keys.get(start) || []).filter((q) => q.frame !== frame);
    list.push({ frame, params: Object.assign({}, params) });
    list.sort((a, b) => a.frame - b.frame);
    S.keys.set(start, list);
  }
  function toggleKey() {
    if (!S.source) return;
    const f = S.frame, start = shotStart(f), list = S.keys.get(start) || [], has = list.some((q) => q.frame === f);
    pushUndo({ type: 'keys', before: snapshotKeys(), label: has ? 'Remove keyframe' : 'Add keyframe' });
    if (has) { const rest = list.filter((q) => q.frame !== f); if (rest.length) S.keys.set(start, rest); else S.keys.delete(start); }
    else setKey(f, getParams());
    afterKeysChanged();
    log(`${has ? 'Removed' : 'Added'} keyframe at frame ${f + 1}`);
  }
  function jumpKey(dir) {
    const all = [...S.keys.values()].flat().map((q) => q.frame).sort((a, b) => a - b);
    const target = dir > 0 ? all.find((f) => f > S.frame) : [...all].reverse().find((f) => f < S.frame);
    if (target !== undefined) goToFrame(target);
  }
  function afterKeysChanged() {
    S.stabCache.clear(); S.outputDirty = true;
    for (const k of S.keys.keys()) for (let f = k; f <= shotEnd(k); f++) S.results.delete(f);
    updateKeyUI(); drawScan();
    if (shotKeys(S.frame)) { setParams(paramsFor(S.frame)); S.lastParams = getParams(); }
    requestProcess();
  }
  function updateKeyUI() {
    if (!S.source) return;
    const list = S.keys.get(shotStart(S.frame)) || [], at = list.some((q) => q.frame === S.frame);
    $('#keyBtn').textContent = at ? '◆ Remove key' : '◇ Add key';
    $('#keyBtn').classList.toggle('active', at);
    $('#keyInfo').textContent = list.length ? `${list.length} key${list.length > 1 ? 's' : ''} in this shot · edits set a key here` : 'No keys: settings are constant over the shot';
  }
  function engineParams(p) { const o = Object.assign({}, p); for (const k of OUTPUT_PARAMS) delete o[k]; return o; }
  /** Store the sliders into the scope they belong to (this shot, or the whole clip). */
  function storeParamsFromUI() {
    const p = getParams(), start = shotStart(S.frame);
    if (shotKeys(S.frame)) { if (!S.keysBefore) S.keysBefore = snapshotKeys(); setKey(S.frame, p); updateKeyUI(); drawScan(); }
    else if (S.shotParams.has(start)) S.shotParams.set(start, p); else { S.globalParams = p; store.set('params', p); }
    S.stabCache.clear(); S.outputDirty = true; S.levelsCache.clear();
  }
  function loadShotParams() {
    const start = shotStart(S.frame), own = S.shotParams.get(start);
    setParams(shotKeys(S.frame) ? paramsFor(S.frame) : Object.assign({}, BASE, own || S.globalParams || {}));
    S.lastParams = getParams();
    $('#shotCustom').checked = !!own;
    $('#shotLabel').textContent = S.source ? `Shot ${shotIndex(S.frame)} of ${S.bounds.length} · frames ${start + 1}–${shotEnd(S.frame) + 1}` : '—';
    S.loadedShot = start;
  }

  function enableUI(on) {
    for (const id of ['restoreBtn', 'firstBtn', 'prevBtn', 'playBtn', 'nextBtn', 'frameSlider', 'frameInput', 'markInBtn', 'markOutBtn', 'exportPngBtn', 'exportFolderBtn', 'exportZipBtn', 'exportReportBtn', 'saveProjectBtn', 'fpsSelect', 'scanBtn', 'clearFrameEditsBtn', 'queueAddBtn'])
      $('#' + id).disabled = !on;
    const single = S.total <= 1;
    for (const id of ['firstBtn', 'prevBtn', 'playBtn', 'nextBtn', 'frameSlider', 'frameInput', 'markInBtn', 'markOutBtn', 'scanBtn']) if (single) $('#' + id).disabled = true;
    $('#fpsSelect').disabled = !on || S.source.kind === 'image';
    $('#transferSelect').disabled = !on || !S.source.setTransfer;
    if (S.source && S.source.transferMode) $('#transferSelect').value = S.source.transferMode;
    updateExportUI();
    $('#clearProtectBtn').disabled = !S.protect;
  }

  // ------------------------------------------------------------------ import
  async function importFiles(fileList) {
    const files = [...fileList].filter((f) => !f.name.startsWith('.'));
    if (!files.length) return false;
    const ext = (f) => IO.extension(f.name);
    const videos = files.filter((f) => f.type.startsWith('video/') || VIDEO_EXT.includes(ext(f)));
    const images = files.filter((f) => f.type.startsWith('image/') || IMAGE_EXT.includes(ext(f)));
    let source;
    if (images.length && (images.length > 1 || !videos.length)) source = new SequenceSource(images);
    else if (videos.length) source = new VideoSource(videos[0]);
    else { setMessage('No supported video or image files were selected'); return false; }
    setMessage(`Opening ${source.name}…`, 5); setBusy(true, 'Opening…');
    try {
      await source.open();
    } catch (err) {
      setBusy(false); setMessage(err.message, 0); if (source.close) source.close(); return false;
    }
    if (S.source && S.source.close) S.source.close();
    S.gen++; S.source = source; S.w = source.width; S.h = source.height;
    const fps = source.detectedFps || (store.get('fps', 24));
    source.setFps(fps); S.fps = fps; S.total = source.total;
    const bytes = S.w * S.h * 8; // 16-bit RGBA
    S.raw = new LRU(Math.max(5, Math.min(48, Math.floor(450e6 / bytes))));
    S.results = new LRU(Math.max(3, Math.min(12, Math.floor(160e6 / bytes))));
    S.hist.clear(); S.prior.clear(); S.log.clear(); S.paint.clear(); S.heal.clear(); S.rejects.clear(); S.versions.clear(); S.pins = [];
    S.protect = null; S.protectVersion++; S.scan = null; S.inMark = S.outMark = null; S.undo = []; S.redo = []; S.cloneSrc = null;
    S.fillCache = new LRU(4); S.hints = new Map(); S.hintPix = new Map();
    S.splits = new Set(); S.shotParams = new Map(); S.replaced = new Set(); S.revert = new Map(); S.rois = []; S.selectedRoi = null; S.stabCache.clear(); S.keys = new Map(); S.levelsCache.clear(); renderAssessment();
    S.total = source.total || S.total; rebuildBounds(); S.loadedShot = -1; renderRoiList();
    $('#irClean').disabled = !source.infrared; $('#irHint').textContent = source.infrared ? 'Infrared channel found: dirt shows as dark in IR.' : 'Needs RGBA DPX/TIFF scans with an infrared channel.';
    engine.reset();
    origCanvas = makeCanvas(S.w, S.h); resultCanvas = makeCanvas(S.w, S.h); compCanvas = makeCanvas(S.w, S.h);
    diffCanvas = makeCanvas(S.w, S.h); protectCanvas = makeCanvas(S.w, S.h); strokeCanvas = makeCanvas(S.w, S.h); strokeBase = makeCanvas(S.w, S.h);
    $('#fpsSelect').value = source.detectedFps && FPS_STANDARD.includes(source.detectedFps) ? 'auto' : String(fps);
    if (![...$('#fpsSelect').options].some((o) => o.value === $('#fpsSelect').value)) $('#fpsSelect').value = 'auto';
    $('#frameSlider').max = S.total - 1; $('#frameInput').max = S.total; $('#totalLabel').textContent = '/ ' + S.total;
    $('#emptyState').classList.add('hidden');
    $('#mediaStatus').textContent = source.name; $('#mediaStatus').title = source.name;
    $('#mSize').textContent = `${S.w}×${S.h}`;
    updateSourceInfo();
    enableUI(true); updateUndoButtons(); updateRangeLabel();
    log(`Imported ${source.name} (${S.total} frame${S.total > 1 ? 's' : ''}, ${S.w}×${S.h})`);
    setBusy(false);
    fitView();
    if (S.pendingProject) await applyProject(S.pendingProject, true);
    await goToFrame(S.pendingProject && S.pendingProject.media ? S.pendingProject.media.frame || 0 : 0);
    S.pendingProject = null;
    setMessage(`Loaded ${source.name}`, 0);
    return true;
  }

  function updateSourceInfo() {
    const s = S.source; if (!s) return;
    const parts = [`${s.format}`, `${S.w}×${S.h}`];
    if (s.bitDepth && s.bitDepth > 8) parts.push(`${s.bitDepth}-bit (shown 8-bit)`);
    if (s.infrared) parts.push('infrared channel');
    if (s.linear) parts.push('linear EXR, converted with a 2.2 curve');
    if (s.transfer === 'cineon') parts.push('Cineon log → display');
    if (s.kind !== 'image') parts.push(`${S.total} frames @ ${S.fps} fps${s.detectedFps ? ' (detected)' : ''}`);
    $('#sourceInfo').textContent = parts.join(' · ');
  }

  async function readDroppedEntries(items) {
    const out = [];
    const walk = async (entry) => {
      if (entry.isFile) out.push(await new Promise((res, rej) => entry.file(res, rej)));
      else if (entry.isDirectory) {
        const reader = entry.createReader();
        for (;;) {
          const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
          if (!batch.length) break;
          for (const e of batch) await walk(e);
        }
      }
    };
    for (const it of items) { const e = it.webkitGetAsEntry && it.webkitGetAsEntry(); if (e) await walk(e); }
    return out;
  }

  // ------------------------------------------------------------------ frames & references
  async function getRaw(i) {
    const gen = S.gen;
    let d = S.raw.get(i);
    if (!d) {
      d = await S.source.getFrame(i);
      if (gen !== S.gen) throw new Error('stale');
      S.raw.set(i, d);
    }
    if (!S.hist.has(i)) S.hist.set(i, E.histogram64(d, S.w * S.h));
    return d;
  }
  async function isCut(a, b) {
    if (a < 0 || b >= S.total) return true;
    if (S.scan) return S.scan.cuts.has(b);
    await getRaw(a); await getRaw(b);
    return E.cutScore(S.hist.get(a), S.hist.get(b)) > CUT_THRESHOLD;
  }
  const canRebuild = (i) => i > 0 && i < S.total - 1;
  async function pickRefs(i) {
    if (S.total < 2) return [];
    if (S.replaced.has(i) && canRebuild(i)) return [i - 1, i + 1]; // rebuilt from both neighbours, by definition
    const usable = (j) => j >= 0 && j < S.total && !S.replaced.has(j); // a destroyed frame is never a reference
    const prevOK = usable(i - 1) && !(await isCut(i - 1, i));
    const nextOK = usable(i + 1) && !(await isCut(i, i + 1));
    if (prevOK && nextOK) return [i - 1, i + 1];
    if (nextOK) return usable(i + 2) && !(await isCut(i + 1, i + 2)) ? [i + 1, i + 2] : [i + 1];
    if (prevOK) return usable(i - 2) && !(await isCut(i - 2, i - 1)) ? [i - 1, i - 2] : [i - 1];
    return [];
  }

  // ---- protect regions (tracked ROIs) and the per-frame history brush
  function roiRectAt(roi, i) {
    if (i < roi.shotStart || i > roi.shotEnd) return null;
    if (roi.keys.has(i)) return roi.keys.get(i);
    if (roi.track.has(i)) return roi.track.get(i);
    let lo = null, hi = null;
    for (const m of [roi.keys, roi.track]) for (const f of m.keys()) {
      if (f < i && (lo === null || f > lo)) lo = f;
      if (f > i && (hi === null || f < hi)) hi = f;
    }
    const get = (f) => roi.keys.get(f) || roi.track.get(f);
    if (lo === null) return get(hi);
    if (hi === null) return get(lo);
    const a = get(lo), b = get(hi), t = (i - lo) / (hi - lo);
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, w: a.w + (b.w - a.w) * t, h: a.h + (b.h - a.h) * t };
  }
  /** Shot-level fade analysis (one correction per shot, so it cannot flicker). Needs the clip scan. */
  function levelsFor(i) {
    if (!S.scan || !S.scan.chist) return null;
    const start = shotStart(i), end = shotEnd(i);
    if (!S.levelsCache.has(start)) {
      const sum = new Float64Array(768);
      for (let f = start; f <= end; f++) { const h = S.scan.chist[f]; if (h) for (let k = 0; k < 768; k++) sum[k] += h[k]; }
      S.levelsCache.set(start, E.fadeLevels(sum));
    }
    return S.levelsCache.get(start);
  }
  function protectFor(i) {
    const rects = S.rois.map((r) => roiRectAt(r, i)).filter(Boolean), rev = S.revert.get(i);
    if (!rects.length && !rev) return S.protect;
    const m = S.protect ? Uint8Array.from(S.protect) : new Uint8Array(S.w * S.h);
    for (const r of rects) {
      const x0 = Math.max(0, Math.floor(r.x)), y0 = Math.max(0, Math.floor(r.y)), x1 = Math.min(S.w - 1, Math.ceil(r.x + r.w)), y1 = Math.min(S.h - 1, Math.ceil(r.y + r.h));
      for (let y = y0; y <= y1; y++) m.fill(1, y * S.w + x0, y * S.w + x1 + 1);
    }
    if (rev) for (let k = 0; k < m.length; k++) if (rev[k]) m[k] = 1;
    return m;
  }
  function globalGainFor(i, p) {
    if (!S.scan || !p.deflicker) return null;
    const m = S.scan.means;
    let s = 0, n = 0;
    for (let k = i; k >= Math.max(0, i - 6); k--) { s += m[k]; n++; if (S.scan.cuts.has(k)) break; }
    for (let k = i + 1; k <= Math.min(S.total - 1, i + 6); k++) { if (S.scan.cuts.has(k)) break; s += m[k]; n++; }
    return Math.max(0.67, Math.min(1.5, (s / n + 4) / (m[i] + 4)));
  }
  function resultKey(i, p) {
    return JSON.stringify([engineParams(p || paramsFor(i)), $('#healMode').value, S.protectVersion, S.versions.get(i) || 0, !!S.scan, S.replaced.has(i)]);
  }
  function bumpVersion(i) { S.versions.set(i, (S.versions.get(i) || 0) + 1); }

  function rectMask(rects) {
    const m = new Uint8Array(S.w * S.h);
    for (const r of rects) {
      const x0 = Math.max(0, Math.floor(r.x)), y0 = Math.max(0, Math.floor(r.y)), x1 = Math.min(S.w - 1, Math.ceil(r.x + r.w)), y1 = Math.min(S.h - 1, Math.ceil(r.y + r.h));
      for (let y = y0; y <= y1; y++) m.fill(1, y * S.w + x0, y * S.w + x1 + 1);
    }
    return m;
  }
  const repairRects = (i) => S.rois.filter((r) => r.kind === 'repair').map((r) => roiRectAt(r, i)).filter(Boolean);
  /**
   * Remove persistent defects in frame i: pixels hidden under repair regions
   * are fetched from frames of the same shot that the camera moved past
   * (nearest first), then whatever no frame reveals is synthesised.
   */
  async function fillRepairs(i, raw) {
    const rects = repairRects(i);
    if (!rects.length) return null;
    const key = JSON.stringify([S.gen, S.protectVersion, !!(S.scan && S.scan.motions)]), hit = S.fillCache.get(i);
    if (hit && hit.key === key) return hit;
    const region = rectMask(rects), start = shotStart(i), end = shotEnd(i);
    let rgba = raw, mask = region, remaining = region, used = 0;
    if (S.scan && S.scan.motions && end > start) {
      const path = E.motionPath(S.scan.motions, start, end), cands = [];
      for (let d = 1; d <= end - start; d++) { if (i - d >= start) cands.push(i - d); if (i + d <= end) cands.push(i + d); }
      const sourceFor = async (j) => ({ j, rgba: await getRaw(j), t: E.relativeTransform(path[i - start], path[j - start]) });
      // 1. find the real defect pixels inside the drawn regions (votes over a few revealing frames)
      const probe = [];
      for (const j of cands) {
        const t = E.relativeTransform(path[i - start], path[j - start]);
        if (Math.hypot(t.tx, t.ty) >= 2) probe.push(await sourceFor(j));
        if (probe.length >= 5) break;
      }
      if (probe.length >= 2) mask = E.refineDefectMask(raw, S.w, S.h, region, probe);
      remaining = mask;
      // 2. fill those pixels from the nearest frames that reveal them; the defect sits at the same
      //    place on screen (shifted with the region when it is tracked) in every source
      const shift = (j) => {
        const a = repairRects(i), b = repairRects(j);
        if (a.length !== b.length) return mask;
        const m = new Uint8Array(S.w * S.h);
        a.forEach((ra, k) => {
          const dx = Math.round(b[k].x - ra.x), dy = Math.round(b[k].y - ra.y);
          for (let y = Math.max(0, Math.floor(ra.y)); y <= Math.min(S.h - 1, Math.ceil(ra.y + ra.h)); y++) for (let x = Math.max(0, Math.floor(ra.x)); x <= Math.min(S.w - 1, Math.ceil(ra.x + ra.w)); x++) {
            if (!mask[y * S.w + x]) continue;
            const xx = x + dx, yy = y + dy;
            if (xx >= 0 && yy >= 0 && xx < S.w && yy < S.h) m[yy * S.w + xx] = 1;
          }
        });
        return m;
      };
      for (const j of cands.slice(0, 24)) {
        if (!remaining.some((v) => v)) break;
        const src = await sourceFor(j);
        const r = E.fillFromFrames(rgba, S.w, S.h, remaining, [{ rgba: src.rgba, t: src.t, mask: shift(j) }], { keepClean: false });
        if (r.filled) { rgba = r.rgba; remaining = r.remaining; used++; }
      }
    }
    const left = remaining.some((v) => v) ? remaining : null;
    const out = { key, rgba, inpaint: left, sources: used };
    S.fillCache.set(i, out);
    return out;
  }

  /** Colour hints changed on frame f: every frame of its shot must be re-coloured. */
  function hintsChanged(f) {
    S.hintPix.delete(f);
    for (let k = shotStart(f); k <= shotEnd(f); k++) { bumpVersion(k); S.results.delete(k); }
    S.outputDirty = true;
  }
  /** Sparse list of hint pixels on frame f: [index, u, v, ...] (cached). */
  function hintPixels(f) {
    if (S.hintPix.has(f)) return S.hintPix.get(f);
    const layer = S.hints.get(f), list = [];
    if (layer) {
      const d = ctx2d(layer).getImageData(0, 0, S.w, S.h).data;
      for (let i = 0; i < S.w * S.h; i++) if (d[i * 4 + 3] > 128) { const [u, v] = E.rgbToChroma(d[i * 4] / 255, d[i * 4 + 1] / 255, d[i * 4 + 2] / 255); list.push(i, u, v); }
    }
    S.hintPix.set(f, list);
    return list;
  }
  /**
   * Colour hints for frame i: the nearest hinted frames of the same shot,
   * carried along the camera path (or held still without a scan). Hints on
   * nearer frames win where they overlap.
   */
  function colorHintsFor(i) {
    const start = shotStart(i), end = shotEnd(i), frames = [...S.hints.keys()].filter((f) => f >= start && f <= end && hintPixels(f).length);
    if (!frames.length) return null;
    frames.sort((a, b) => Math.abs(a - i) - Math.abs(b - i));
    const n = S.w * S.h, hints = { u: new Float32Array(n), v: new Float32Array(n), m: new Uint8Array(n) };
    const path = S.scan && S.scan.motions ? E.motionPath(S.scan.motions, start, end) : null, cx = (S.w - 1) / 2, cy = (S.h - 1) / 2;
    for (const j of frames.slice(0, 3)) {
      const list = hintPixels(j), t = path ? E.relativeTransform(path[j - start], path[i - start]) : { tx: 0, ty: 0, angle: 0, logScale: 0 };
      const sc = Math.exp(t.logScale), ca = Math.cos(t.angle) * sc, sa = Math.sin(t.angle) * sc;
      for (let k = 0; k < list.length; k += 3) {
        const q = list[k], qx = q % S.w, qy = (q / S.w) | 0, dx = qx - cx, dy = qy - cy;
        const x = Math.round(cx + ca * dx - sa * dy + t.tx), y = Math.round(cy + sa * dx + ca * dy + t.ty);
        if (x < 0 || y < 0 || x >= S.w || y >= S.h) continue;
        const p = y * S.w + x;
        if (hints.m[p]) continue;
        hints.u[p] = list[k + 1]; hints.v[p] = list[k + 2]; hints.m[p] = 1;
      }
    }
    return hints;
  }

  async function prepareJob(i, params) {
    const refIdx = await pickRefs(i);
    let cur = await getRaw(i);
    const refs = [], fill = await fillRepairs(i, cur);
    if (fill) cur = fill.rgba;
    for (const r of refIdx) refs.push(await getRaw(r));
    const job = {
      width: S.w, height: S.h, cur, refs, params: engineParams(params), frameIndex: i, replace: S.replaced.has(i) && canRebuild(i), inpaint: fill ? fill.inpaint : null,
      protect: protectFor(i), force: S.heal.get(i) || null, reject: S.rejects.get(i) || [],
      prior: S.prior.get(i - 1) || S.prior.get(i + 1) || null, healMode: $('#healMode').value, globalGain: globalGainFor(i, params), levels: params.fade > 0 ? levelsFor(i) : null, colorHints: params.colorize > 0 ? colorHintsFor(i) : null,
    };
    const fillTag = fill ? `:fill${S.protectVersion}` : '';
    const analysisKey = `${S.gen}:${i}:${refIdx.join(',')}:${params.motion ? params.motionRange : 0}:${params.flow}${params.chromaAlign ? (params.chromaLocal ? ':chromaL' : ':chroma') : ''}${job.replace ? ':rebuilt' : ''}${fillTag}`;
    const frameKeys = { cur: `${S.gen}:${i}${fillTag}`, refs: refIdx.map((r) => `${S.gen}:${r}`) };
    return { job, analysisKey, refIdx, frameKeys };
  }
  function storeResult(i, key, refIdx, r, analysisKey) {
    const entry = { key, analysisKey, data: r.data, components: r.components, scratches: r.scratches, confidence: r.confidence, stats: r.stats, refs: refIdx };
    S.results.set(i, entry); S.prior.set(i, r.scratches);
    S.log.set(i, Object.assign({ frame: i, refFrames: refIdx }, r.stats));
    drawScan();
    return entry;
  }
  async function processFrame(i, worker = 0) {
    const gen = S.gen, params = paramsFor(i), key = resultKey(i, params);
    const cached = S.results.get(i);
    if (cached && cached.key === key) return cached;
    const { job, analysisKey, refIdx, frameKeys } = await prepareJob(i, params);
    if (gen !== S.gen) throw new Error('stale');
    const r = await engine.process(job, analysisKey, worker, frameKeys);
    if (gen !== S.gen) throw new Error('stale');
    return storeResult(i, key, refIdx, r, analysisKey);
  }

  // ------------------------------------------------------------------ navigation & processing
  async function goToFrame(i, { process = true } = {}) {
    if (!S.source) return;
    i = clampInt(i, 0, S.total - 1);
    S.frame = i;
    if (shotStart(i) !== S.loadedShot) loadShotParams();
    else if (shotKeys(i)) { setParams(paramsFor(i)); S.lastParams = getParams(); }
    updateKeyUI();
    $('#frameSlider').value = i; $('#frameInput').value = i + 1; updateTimecode(); updateFrameTools();
    const token = ++S.navToken;
    let raw;
    try { raw = await getRaw(i); } catch (err) { if (err.message !== 'stale') setMessage(err.message); return; }
    if (token !== S.navToken) return;
    showFrame(i, raw);
    if (process && $('#autoRestore').checked && !S.playing) requestProcess();
    drawScan();
  }

  function showFrame(i, raw) {
    putData(origCanvas, raw, S.w, S.h);
    const res = S.results.peek(i), valid = res && res.key === resultKey(i);
    putData(resultCanvas, res ? res.data : raw, S.w, S.h);
    S.shown = { frame: i, res: res || null, valid: !!valid };
    rebuildComposite();
    updateInspection();
  }

  function rebuildComposite() {
    const c = ctx2d(compCanvas);
    c.clearRect(0, 0, S.w, S.h); c.drawImage(resultCanvas, 0, 0);
    const layer = S.paint.get(S.frame);
    if (layer) c.drawImage(layer, 0, 0);
    diffDirty = true; S.outputDirty = true; requestDraw();
  }

  /** Restore the current frame; coalesces bursts of requests (slider drags). */
  async function requestProcess() {
    if (!S.source || S.rendering) return;
    if (S.processing) { S.processAgain = true; return; }
    S.processing = true; S.processAgain = false;
    const i = S.frame;
    setBusy(true, 'Restoring…'); $('#restoreBtn').disabled = true;
    try {
      const t0 = performance.now();
      await processFrame(i);
      if (S.frame === i) { showFrame(i, S.raw.peek(i) || (await getRaw(i))); setMessage(`Frame ${i + 1} restored in ${Math.round(performance.now() - t0)} ms`, 0); }
    } catch (err) {
      if (err.message !== 'stale') { console.error(err); setMessage('Restoration failed: ' + err.message, 0); }
    } finally {
      S.processing = false; setBusy(false); $('#restoreBtn').disabled = !S.source;
      if (S.processAgain || (S.frame !== i && $('#autoRestore').checked)) { S.processAgain = false; requestProcess(); }
    }
  }

  let paramTimer = 0;
  function onParamInput() {
    syncOutputs();
    $('#preset').value = 'custom';
    storeParamsFromUI();
    clearTimeout(paramTimer);
    paramTimer = setTimeout(() => { requestDraw(); if (S.source && ($('#autoRestore').checked || (S.shown && S.shown.res))) requestProcess(); }, 140);
  }
  function commitParams(label) {
    if (S.keysBefore) { pushUndo({ type: 'keys', before: S.keysBefore, label: `${label} (keyframe)` }); S.keysBefore = null; S.lastParams = getParams(); return; }
    const now = getParams(), start = shotStart(S.frame), scope = S.shotParams.has(start) ? start : 'clip';
    if (S.lastParams && JSON.stringify(now) !== JSON.stringify(S.lastParams)) pushUndo({ type: 'params', scope, before: S.lastParams, label });
    S.lastParams = now;
  }

  // ------------------------------------------------------------------ view transform & drawing
  let drawQueued = false;
  function requestDraw() { if (!drawQueued) { drawQueued = true; requestAnimationFrame(() => { drawQueued = false; draw(); }); } }

  function stageSize() { const r = $('#stage').getBoundingClientRect(); return { w: Math.max(1, r.width), h: Math.max(1, r.height) }; }
  function fitView() {
    if (!S.source) return;
    const { w, h } = stageSize();
    S.zoom = Math.min((w - 24) / S.w, (h - 24) / S.h);
    S.panX = (w - S.w * S.zoom) / 2; S.panY = (h - S.h * S.zoom) / 2; S.fitMode = true;
    requestDraw();
  }
  function zoomAt(z, sx, sy) {
    z = Math.max(0.03, Math.min(32, z));
    const ix = (sx - S.panX) / S.zoom, iy = (sy - S.panY) / S.zoom;
    S.zoom = z; S.panX = sx - ix * z; S.panY = sy - iy * z; S.fitMode = false;
    requestDraw();
  }
  function zoomCenter(z) { const { w, h } = stageSize(); zoomAt(z, w / 2, h / 2); }
  function toImage(e) {
    const r = display.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    return { sx, sy, x: (sx - S.panX) / S.zoom, y: (sy - S.panY) / S.zoom };
  }

  function computeDiff() {
    const a = ctx2d(origCanvas).getImageData(0, 0, S.w, S.h).data, b = ctx2d(compCanvas).getImageData(0, 0, S.w, S.h).data;
    const out = new Uint8ClampedArray(a.length);
    for (let i = 0; i < a.length; i += 4) {
      const d = (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])) * 2.5;
      out[i] = Math.min(255, d); out[i + 1] = Math.min(255, d * 0.45); out[i + 2] = Math.min(255, d * 0.2 + 18); out[i + 3] = 255;
    }
    putData(diffCanvas, out, S.w, S.h);
    diffDirty = false;
  }

  function draw() {
    const dpr = window.devicePixelRatio || 1, { w, h } = stageSize();
    if (display.width !== Math.round(w * dpr) || display.height !== Math.round(h * dpr)) { display.width = Math.round(w * dpr); display.height = Math.round(h * dpr); }
    dctx.setTransform(1, 0, 0, 1, 0, 0); dctx.clearRect(0, 0, display.width, display.height);
    if (!S.source || !compCanvas) return;
    if (S.fitMode && S._lastStage && (S._lastStage.w !== w || S._lastStage.h !== h)) { S._lastStage = { w, h }; fitView(); return; }
    S._lastStage = { w, h };
    $('#zoomLabel').textContent = Math.round(S.zoom * 100) + '%';
    dctx.setTransform(dpr * S.zoom, 0, 0, dpr * S.zoom, dpr * S.panX, dpr * S.panY);
    dctx.imageSmoothingEnabled = S.zoom < 2;
    dctx.fillStyle = '#000'; dctx.fillRect(0, 0, S.w, S.h);
    const view = S.flip ? 'original' : S.view;
    if (view === 'output') { if (S.outputDirty) computeOutput(); dctx.drawImage(outputCanvas, 0, 0); }
    else if (view === 'original') dctx.drawImage(origCanvas, 0, 0);
    else if (view === 'difference') { if (diffDirty) computeDiff(); dctx.drawImage(diffCanvas, 0, 0); }
    else if (view === 'split') {
      dctx.drawImage(origCanvas, 0, 0);
      dctx.save(); dctx.beginPath(); dctx.rect(S.w * S.split, 0, S.w * (1 - S.split), S.h); dctx.clip(); dctx.drawImage(compCanvas, 0, 0); dctx.restore();
    } else dctx.drawImage(compCanvas, 0, 0);

    const lw = 1 / S.zoom;
    if (view === 'split') {
      dctx.strokeStyle = '#42b7ff'; dctx.lineWidth = 2 * lw;
      dctx.beginPath(); dctx.moveTo(S.w * S.split, 0); dctx.lineTo(S.w * S.split, S.h); dctx.stroke();
      dctx.fillStyle = '#42b7ff'; dctx.fillRect(S.w * S.split - 6 * lw, S.h / 2 - 18 * lw, 12 * lw, 36 * lw);
    }
    const showDefects = view === 'defects' || S.tool === 'review';
    if (S.protect && (view === 'defects' || S.tool === 'protect')) { dctx.globalAlpha = 0.45; dctx.drawImage(protectCanvas, 0, 0); dctx.globalAlpha = 1; }
    const healMask = S.heal.get(S.frame);
    if (healMask && (view === 'defects' || S.tool === 'heal' || S.tool === 'erase')) {
      if (!S._healOverlay || S._healOverlay.frame !== S.frame || S._healOverlay.mask !== healMask) S._healOverlay = { frame: S.frame, mask: healMask, canvas: maskCanvas(healMask, [255, 170, 40]) };
      dctx.globalAlpha = 0.4; dctx.drawImage(S._healOverlay.canvas, 0, 0); dctx.globalAlpha = 1;
    }
    const revMask = S.revert.get(S.frame);
    const hintLayer = S.hints.get(S.frame);
    if (hintLayer && (S.tool === 'colorize' || view === 'defects')) { dctx.globalAlpha = 0.75; dctx.drawImage(hintLayer, 0, 0); dctx.globalAlpha = 1; }
    if (revMask && (view === 'defects' || S.tool === 'revert')) {
      if (!S._revertOverlay || S._revertOverlay.mask !== revMask) S._revertOverlay = { mask: revMask, canvas: maskCanvas(revMask, [110, 230, 140]) };
      dctx.globalAlpha = 0.4; dctx.drawImage(S._revertOverlay.canvas, 0, 0); dctx.globalAlpha = 1;
    }
    if (S.pointer && S.pointer.kind === 'mask') { dctx.globalAlpha = 0.5; dctx.drawImage(strokeCanvas, 0, 0); dctx.globalAlpha = 1; }
    if (view === 'confidence') {
      const c = S.shown && S.shown.res && S.shown.res.confidence;
      if (c) {
        if (!S._confCanvas || S._confCanvas.src !== c) {
          const cv = makeCanvas(c.width, c.height), img = new ImageData(c.width, c.height);
          for (let k = 0; k < c.data.length; k++) { const v = c.data[k], j = k * 4; img.data[j] = v > 40 ? 255 : v * 6; img.data[j + 1] = v > 40 ? Math.max(0, 255 - (v - 40) * 2) : 255; img.data[j + 2] = 40; img.data[j + 3] = Math.min(200, 50 + v * 2); }
          cv.getContext('2d').putImageData(img, 0, 0); S._confCanvas = { src: c, canvas: cv };
        }
        dctx.imageSmoothingEnabled = true; dctx.drawImage(S._confCanvas.canvas, 0, 0, S.w, S.h); dctx.imageSmoothingEnabled = S.zoom < 2;
      }
    }
    if (view !== 'output' && (S.tool === 'roi' || view === 'defects' || S.pointer && S.pointer.kind && S.pointer.kind.startsWith('roi'))) {
      dctx.lineWidth = 2 * lw; dctx.font = `${12 * lw}px system-ui`;
      for (const roi of S.rois) {
        const r = S.pointer && S.pointer.kind === 'roiMove' && S.pointer.roi === roi ? S.pointer.rect : roiRectAt(roi, S.frame);
        if (!r) continue;
        const keyed = roi.keys.has(S.frame);
        const rc = roi.kind === 'repair' ? ['#ffc46b', '#ffaa28', '#ffaa2822'] : ['#8fd3ff', '#428cff', '#428cff22'];
        dctx.strokeStyle = S.selectedRoi === roi.id ? rc[0] : rc[1]; dctx.setLineDash(keyed ? [] : [6 * lw, 4 * lw]);
        dctx.strokeRect(r.x, r.y, r.w, r.h); dctx.fillStyle = rc[2]; dctx.fillRect(r.x, r.y, r.w, r.h);
        dctx.setLineDash([]); dctx.fillStyle = rc[0]; dctx.fillText(roi.name + (keyed ? ' (key)' : ''), r.x + 3 * lw, r.y - 4 * lw);
      }
      if (S.pointer && S.pointer.kind === 'roiNew') { dctx.strokeStyle = '#8fd3ff'; dctx.setLineDash([4 * lw, 3 * lw]); const r = S.pointer.rect; dctx.strokeRect(r.x, r.y, r.w, r.h); dctx.setLineDash([]); }
    }
    const res = S.shown && S.shown.frame === S.frame ? S.shown.res : null;
    if (showDefects && res) {
      dctx.lineWidth = 1.5 * lw;
      for (const c of res.components) {
        const p = 2 * lw;
        dctx.strokeStyle = c.rejected ? '#ff6b7a' : '#6ce0bd';
        dctx.strokeRect(c.x - p, c.y - p, c.w + 2 * p, c.h + 2 * p);
        if (c.rejected) { dctx.beginPath(); dctx.moveTo(c.x - p, c.y - p); dctx.lineTo(c.x + c.w + p, c.y + c.h + p); dctx.stroke(); }
      }
      dctx.strokeStyle = '#f7c65e'; dctx.setLineDash([6 * lw, 4 * lw]); dctx.lineWidth = 1.5 * lw;
      for (const s of res.scratches) {
        dctx.beginPath();
        s.points.forEach((pt, k) => { const y = (pt.y0 + pt.y1) / 2, x = pt.x + 0.5; if (!k) dctx.moveTo(x, pt.y0); dctx.lineTo(x, y); if (k === s.points.length - 1) dctx.lineTo(x, pt.y1); });
        dctx.stroke();
      }
      dctx.setLineDash([]);
    }
    for (const pin of S.pins) {
      if (pin.frame !== S.frame) continue;
      dctx.fillStyle = '#f7c65e'; dctx.beginPath(); dctx.arc(pin.x, pin.y, 6 * lw, 0, Math.PI * 2); dctx.fill();
      dctx.font = `${12 * lw}px system-ui`; dctx.fillStyle = '#fff'; dctx.strokeStyle = '#000'; dctx.lineWidth = 3 * lw;
      dctx.strokeText(pin.text, pin.x + 9 * lw, pin.y + 4 * lw); dctx.fillText(pin.text, pin.x + 9 * lw, pin.y + 4 * lw);
    }
    if (S.cloneSrc && S.tool === 'clone') {
      dctx.strokeStyle = '#fff'; dctx.lineWidth = 1.5 * lw;
      const { x, y } = S.cloneSrc; dctx.beginPath(); dctx.moveTo(x - 8 * lw, y); dctx.lineTo(x + 8 * lw, y); dctx.moveTo(x, y - 8 * lw); dctx.lineTo(x, y + 8 * lw); dctx.stroke();
    }
    // screen-space overlays
    dctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const label = S.flip ? 'Original (flip)' : { restored: 'Restored', original: 'Original', split: 'Original | Restored', difference: 'Difference ×2.5', defects: 'Defects', output: `Output${stabCorrection(S.frame) ? ' · stabilised' : getParams().stabilize ? ' · run Scan clip to stabilise' : ''}`, confidence: 'Motion confidence (red = unreliable)' }[S.view] + (S.replaced.has(S.frame) ? ' · rebuilt frame' : '');
    const status = S.shown && S.shown.res ? (S.shown.valid ? '' : ' · outdated') : ' · not restored';
    dctx.font = '12px system-ui'; const text = label + (S.view === 'original' && !S.flip ? '' : status);
    const tw = dctx.measureText(text).width;
    dctx.fillStyle = '#06101bcc'; dctx.fillRect(8, 8, tw + 14, 22); dctx.fillStyle = S.shown && !S.shown.valid && S.view !== 'original' ? '#f7c65e' : '#dbe6f2'; dctx.fillText(text, 15, 23);
    if (S.mouse && isBrushTool(S.tool)) {
      const r = (+$('#brushSize').value / 2) * S.zoom;
      dctx.strokeStyle = '#000a'; dctx.lineWidth = 3; dctx.beginPath(); dctx.arc(S.mouse.sx, S.mouse.sy, Math.max(1, r), 0, Math.PI * 2); dctx.stroke();
      dctx.strokeStyle = '#fff'; dctx.lineWidth = 1; dctx.stroke();
    }
  }

  let outputCanvas = null;
  function computeOutput() {
    if (!outputCanvas || outputCanvas.width !== S.w || outputCanvas.height !== S.h) outputCanvas = makeCanvas(S.w, S.h);
    const res = S.shown && S.shown.res;
    if (res && S.shown.frame === S.frame) putData(outputCanvas, outputData(S.frame, res.data), S.w, S.h);
    else ctx2d(outputCanvas).drawImage(compCanvas, 0, 0);
    S.outputDirty = false;
  }

  function maskCanvas(mask, [r, g, b]) {
    const c = makeCanvas(S.w, S.h), img = new ImageData(S.w, S.h), d = img.data;
    for (let i = 0; i < mask.length; i++) if (mask[i]) { const j = i * 4; d[j] = r; d[j + 1] = g; d[j + 2] = b; d[j + 3] = 255; }
    ctx2d(c).putImageData(img, 0, 0);
    return c;
  }
  function rebuildProtectCanvas() {
    const c = ctx2d(protectCanvas); c.clearRect(0, 0, S.w, S.h);
    if (S.protect) c.drawImage(maskCanvas(S.protect, [66, 140, 255]), 0, 0);
    $('#clearProtectBtn').disabled = !S.protect;
  }

  // ------------------------------------------------------------------ inspection panel
  function updateInspection() {
    const res = S.shown && S.shown.res, st = res && res.stats;
    const set = (id, v) => { $('#' + id).textContent = v; };
    if (!st) { for (const id of ['mMode', 'mDefects', 'mScratches', 'mFlicker', 'mMotion', 'mNoise', 'mTime', 'mRefs', 'mAlign', 'mChroma']) set(id, '—'); }
    else {
      set('mMode', st.mode);
      set('mDefects', `${st.defects}${st.rejected ? ` (−${st.rejected})` : ''}${st.healedPixels ? ' +heal' : ''}`);
      set('mScratches', st.scratches);
      set('mFlicker', st.flicker ? st.flicker.toFixed(1) + '%' : '0%');
      set('mMotion', st.motionConfidence == null ? 'off' : `${st.meanMotion.toFixed(1)}px · ${Math.round(st.motionConfidence * 100)}%`);
      set('mNoise', st.noise != null ? st.noise.toFixed(1) : '—');
      set('mTime', `${Math.round(st.ms)} ms${st.accel === 'gpu' ? ' · GPU' : ''}`);
      set('mAlign', st.registration ? `${st.registration.dense.toFixed(2)} (block ${st.registration.block.toFixed(2)})` : '—');
      if (st.colorized) $('#mMode').textContent = st.mode + ' · colourised';
      set('mChroma', st.chroma ? `R ${st.chroma.r.map((v) => v.toFixed(2)).join(', ')} · B ${st.chroma.b.map((v) => v.toFixed(2)).join(', ')}` : 'off');
      set('mRefs', res.refs.length ? res.refs.map((r) => r + 1).join(', ') : 'none');
    }
    // histogram + changed pixels (sampled)
    const a = ctx2d(origCanvas).getImageData(0, 0, S.w, S.h).data, b = ctx2d(compCanvas).getImageData(0, 0, S.w, S.h).data;
    const bins = [new Uint32Array(64), new Uint32Array(64), new Uint32Array(64)];
    const step = Math.max(1, Math.floor((S.w * S.h) / 200000)) * 4;
    let changed = 0, n = 0;
    for (let i = 0; i < b.length; i += step) {
      bins[0][b[i] >> 2]++; bins[1][b[i + 1] >> 2]++; bins[2][b[i + 2] >> 2]++;
      if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 6) changed++;
      n++;
    }
    set('mChange', ((changed / n) * 100).toFixed(2) + '%');
    const c = $('#histogram'), g = c.getContext('2d');
    g.clearRect(0, 0, c.width, c.height);
    const max = Math.max(1, ...bins.map((x) => Math.max(...x)));
    g.globalCompositeOperation = 'lighter';
    ['#ff4d6a', '#43d68c', '#4a8dff'].forEach((col, k) => {
      g.fillStyle = col + 'aa';
      bins[k].forEach((v, i) => { const hh = (v / max) * (c.height - 4); g.fillRect((i * c.width) / 64, c.height - hh, c.width / 64 + 0.5, hh); });
    });
    g.globalCompositeOperation = 'source-over';
    updateDefectList();
  }

  function updateDefectList() {
    const res = S.shown && S.shown.res, ul = $('#defectList');
    $('#acceptAllBtn').disabled = $('#rejectAllBtn').disabled = !res || !res.components.length;
    if (!res) { ul.innerHTML = '<li><span>Restore a frame to review its repairs</span></li>'; return; }
    if (!res.components.length) { ul.innerHTML = `<li><span>No dust detected${res.scratches.length ? `; ${res.scratches.length} scratch${res.scratches.length > 1 ? 'es' : ''}` : ''}</span></li>`; return; }
    const list = res.components.map((c, k) => ({ c, k })).sort((p, q) => q.c.area - p.c.area).slice(0, 150);
    ul.innerHTML = list.map(({ c, k }) => `<li data-k="${k}" class="${c.rejected ? 'rejected' : ''}"><input type="checkbox" ${c.rejected ? '' : 'checked'} aria-label="Repair defect at ${Math.round(c.cx)}, ${Math.round(c.cy)}"><span>${c.polarity || 'blotch'} · ${c.area}px · ${Math.round(c.cx)},${Math.round(c.cy)}</span></li>`).join('')
      + (res.components.length > 150 ? `<li><span>…and ${res.components.length - 150} smaller</span></li>` : '');
  }

  // ------------------------------------------------------------------ review / rejections
  function setRejects(frame, list, label) {
    pushUndo({ type: 'rejects', frame, before: (S.rejects.get(frame) || []).slice(), label });
    if (list.length) S.rejects.set(frame, list); else S.rejects.delete(frame);
    bumpVersion(frame); requestProcess();
  }
  function toggleComponent(c) {
    const list = (S.rejects.get(S.frame) || []).slice();
    if (c.rejected) {
      const keep = list.filter((p) => !(p.x >= c.x - 3 && p.x <= c.x + c.w + 3 && p.y >= c.y - 3 && p.y <= c.y + c.h + 3));
      setRejects(S.frame, keep, 'Accepted repair');
    } else {
      list.push({ x: Math.round(c.cx), y: Math.round(c.cy) });
      setRejects(S.frame, list, 'Rejected repair');
    }
  }
  function componentAt(x, y) {
    const res = S.shown && S.shown.res;
    if (!res) return null;
    const m = 4 / S.zoom + 2;
    let best = null;
    for (const c of res.components) if (x >= c.x - m && x <= c.x + c.w + m && y >= c.y - m && y <= c.y + c.h + m && (!best || c.area < best.area)) best = c;
    return best;
  }

  // ------------------------------------------------------------------ brushes
  const isBrushTool = (t) => ['heal', 'clone', 'blur', 'paint', 'erase', 'protect', 'revert', 'fix', 'colorize'].includes(t);
  function getLayer(frame, create) {
    let l = S.paint.get(frame);
    if (!l && create) { l = makeCanvas(S.w, S.h); S.paint.set(frame, l); }
    return l;
  }
  function softDab(srcDraw, x, y, r, target) {
    const d = Math.ceil(r * 2) + 2, tmp = makeCanvas(d, d), t = tmp.getContext('2d');
    srcDraw(t, d);
    t.globalCompositeOperation = 'destination-in';
    const g = t.createRadialGradient(d / 2, d / 2, r * 0.55, d / 2, d / 2, r);
    g.addColorStop(0, '#000'); g.addColorStop(1, 'rgba(0,0,0,0)');
    t.fillStyle = g; t.fillRect(0, 0, d, d);
    target.drawImage(tmp, Math.round(x - d / 2), Math.round(y - d / 2));
  }
  function maskDab(mask, x, y, r, value) {
    const r2 = r * r, x0 = Math.max(0, Math.floor(x - r)), x1 = Math.min(S.w - 1, Math.ceil(x + r)), y0 = Math.max(0, Math.floor(y - r)), y1 = Math.min(S.h - 1, Math.ceil(y + r));
    for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) if ((xx - x) ** 2 + (yy - y) ** 2 <= r2) mask[yy * S.w + xx] = value;
    const sc = ctx2d(strokeCanvas);
    if (value) { sc.fillStyle = S.pointer.color; sc.beginPath(); sc.arc(x, y, r, 0, Math.PI * 2); sc.fill(); }
    else { sc.save(); sc.globalCompositeOperation = 'destination-out'; sc.beginPath(); sc.arc(x, y, r, 0, Math.PI * 2); sc.fill(); sc.restore(); }
  }
  function dab(x, y) {
    const P = S.pointer, r = +$('#brushSize').value / 2;
    if (P.kind === 'mask') { maskDab(P.mask, x, y, r, P.value); requestDraw(); return; }
    if (P.kind === 'hint') {
      let layer = S.hints.get(S.frame);
      if (!layer) { layer = makeCanvas(S.w, S.h); S.hints.set(S.frame, layer); }
      const c = layer.getContext('2d');
      c.save();
      if (P.erase) c.globalCompositeOperation = 'destination-out';
      c.fillStyle = $('#paintColor').value; c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill(); c.restore();
      requestDraw(); return;
    }
    const layer = getLayer(S.frame, true), lctx = layer.getContext('2d');
    if (S.tool === 'erase') {
      lctx.save(); lctx.globalCompositeOperation = 'destination-out';
      const g = lctx.createRadialGradient(x, y, r * 0.55, x, y, r); g.addColorStop(0, '#000'); g.addColorStop(1, 'rgba(0,0,0,0)');
      lctx.fillStyle = g; lctx.beginPath(); lctx.arc(x, y, r, 0, Math.PI * 2); lctx.fill(); lctx.restore();
    } else if (S.tool === 'paint') {
      softDab((t, d) => { t.fillStyle = $('#paintColor').value; t.fillRect(0, 0, d, d); }, x, y, r, lctx);
    } else if (S.tool === 'blur') {
      softDab((t, d) => { t.filter = `blur(${Math.max(1.2, r / 4)}px)`; t.drawImage(strokeBase, x - d / 2, y - d / 2, d, d, 0, 0, d, d); t.filter = 'none'; }, x, y, r, lctx);
    } else if (S.tool === 'clone') {
      const [ox, oy] = S.cloneOffset;
      softDab((t, d) => t.drawImage(strokeBase, x + ox - d / 2, y + oy - d / 2, d, d, 0, 0, d, d), x, y, r, lctx);
    }
    rebuildComposite();
  }
  function strokeTo(x, y) {
    const P = S.pointer, r = +$('#brushSize').value / 2, step = Math.max(1, r * 0.3);
    const dx = x - P.lx, dy = y - P.ly, dist = Math.hypot(dx, dy);
    if (dist < step) return;
    const n = Math.floor(dist / step);
    for (let k = 1; k <= n; k++) dab(P.lx + (dx * k) / n, P.ly + (dy * k) / n);
    P.lx = x; P.ly = y;
  }
  function beginStroke(pt, e) {
    const tool = S.tool;
    if (tool === 'clone') {
      if (e.altKey || !S.cloneSrc) { S.cloneSrc = { x: pt.x, y: pt.y }; S.cloneOffset = null; setMessage('Clone source set. Paint to clone from it (Alt+click to move it).'); requestDraw(); return false; }
      if (!S.cloneOffset) S.cloneOffset = [S.cloneSrc.x - pt.x, S.cloneSrc.y - pt.y];
    }
    if (tool === 'heal' || tool === 'protect' || tool === 'revert' || (tool === 'erase' && e.shiftKey)) {
      const target = tool === 'protect' ? 'protect' : tool === 'revert' ? 'revert' : 'heal';
      const existing = target === 'protect' ? S.protect : target === 'revert' ? S.revert.get(S.frame) : S.heal.get(S.frame);
      const erase = tool === 'erase' || e.shiftKey || e.button === 2;
      if (erase && !existing) return false;
      const rgb = { protect: [66, 140, 255], revert: [110, 230, 140], heal: [255, 170, 40] }[target];
      ctx2d(strokeCanvas).clearRect(0, 0, S.w, S.h);
      S.pointer = { kind: 'mask', target, before: existing ? existing.slice() : null, mask: existing ? existing.slice() : new Uint8Array(S.w * S.h), value: erase ? 0 : 1, color: `rgb(${rgb})`, lx: pt.x, ly: pt.y };
      if (erase) { S.pointer.color = '#000'; ctx2d(strokeCanvas).drawImage(maskCanvas(S.pointer.mask, rgb), 0, 0); S._healOverlay = null; S._revertOverlay = null; S.pointer.hideExisting = true; }
    } else if (tool === 'colorize') {
      const layer = S.hints.get(S.frame), erase = e.shiftKey || e.button === 2;
      if (erase && !layer) return false;
      S.pointer = { kind: 'hint', erase, before: layer ? ctx2d(layer).getImageData(0, 0, S.w, S.h) : null, lx: pt.x, ly: pt.y };
    } else {
      const layer = S.paint.get(S.frame);
      S.pointer = { kind: 'paint', before: layer ? ctx2d(layer).getImageData(0, 0, S.w, S.h) : null, lx: pt.x, ly: pt.y };
      const sb = ctx2d(strokeBase); sb.clearRect(0, 0, S.w, S.h); sb.drawImage(compCanvas, 0, 0);
    }
    dab(pt.x, pt.y);
    return true;
  }
  function endStroke() {
    const P = S.pointer; S.pointer = null;
    if (!P) return;
    if (P.kind === 'hint') {
      pushUndo({ type: 'hints', frame: S.frame, before: P.before, label: 'Colour hint' });
      hintsChanged(S.frame);
      log(`${P.erase ? 'Erased' : 'Painted'} colour hints on frame ${S.frame + 1}`);
      if (!getParams().colorize) setMessage('Colour hints are applied when "Colourise from hints" is above 0 (Colour panel)');
      requestDraw(); return;
    }
    if (P.kind === 'paint') {
      pushUndo({ type: 'paint', frame: S.frame, before: P.before, label: `Manual ${S.tool}` });
      log(`Manual ${S.tool} on frame ${S.frame + 1}`);
    } else if (P.target === 'protect') {
      pushUndo({ type: 'protect', before: P.before, label: 'Protect mask' });
      S.protect = P.mask.some((v) => v) ? P.mask : null; S.protectVersion++;
      rebuildProtectCanvas(); log(P.value ? 'Painted protect mask' : 'Erased protect mask');
      requestProcess();
    } else if (P.target === 'revert') {
      pushUndo({ type: 'revert', frame: S.frame, before: P.before, label: 'History brush' });
      if (P.mask.some((v) => v)) S.revert.set(S.frame, P.mask); else S.revert.delete(S.frame);
      S._revertOverlay = null; bumpVersion(S.frame);
      log(`${P.value ? 'Reverted automatic repairs' : 'Cleared history brush'} on frame ${S.frame + 1}`);
      requestProcess();
    } else {
      pushUndo({ type: 'heal', frame: S.frame, before: P.before, label: 'Heal' });
      if (P.mask.some((v) => v)) S.heal.set(S.frame, P.mask); else S.heal.delete(S.frame);
      S._healOverlay = null; bumpVersion(S.frame);
      log(`${P.value ? 'Healed' : 'Erased heal marks'} on frame ${S.frame + 1}`);
      requestProcess();
    }
    ctx2d(strokeCanvas).clearRect(0, 0, S.w, S.h);
    requestDraw();
  }

  // ------------------------------------------------------------------ frame rebuild, shots, ROIs, Click&Fix
  function invalidateNear(f) { for (let k = f - 2; k <= f + 2; k++) { bumpVersion(k); S.results.delete(k); } }
  function updateFrameTools() {
    if (!S.source) return;
    const f = S.frame, rebuilt = S.replaced.has(f);
    $('#replaceBtn').textContent = rebuilt ? 'Keep original frame' : 'Rebuild frame';
    $('#replaceBtn').classList.toggle('active', rebuilt);
    $('#replaceBtn').disabled = S.rendering || !canRebuild(f);
    $('#splitBtn').textContent = S.splits.has(f) ? 'Remove shot split' : 'Split shot here';
    $('#splitBtn').disabled = S.rendering || f === 0 || (S.scan && S.scan.cuts.has(f));
  }
  function toggleReplace() {
    const f = S.frame;
    if (!canRebuild(f)) { setMessage('The first and last frames cannot be rebuilt: they need a neighbour on each side'); return; }
    pushUndo({ type: 'replace', frame: f, before: S.replaced.has(f), label: 'Rebuild frame' });
    if (S.replaced.has(f)) S.replaced.delete(f); else S.replaced.add(f);
    invalidateNear(f); updateFrameTools(); drawScan();
    log(`${S.replaced.has(f) ? 'Rebuilding' : 'Restored original'} frame ${f + 1}${S.replaced.has(f) ? ' from its neighbours (motion-compensated interpolation)' : ''}`);
    requestProcess();
  }
  function toggleSplit() {
    const f = S.frame;
    if (f === 0 || (S.scan && S.scan.cuts.has(f))) return;
    pushUndo({ type: 'shots', before: { splits: [...S.splits], shotParams: [...S.shotParams.entries()] }, label: 'Shot split' });
    const own = S.shotParams.get(shotStart(f));
    if (S.splits.has(f)) { S.splits.delete(f); S.shotParams.delete(f); }
    else { S.splits.add(f); if (own) S.shotParams.set(f, Object.assign({}, own)); }
    rebuildBounds(); loadShotParams(); updateFrameTools(); drawScan();
    log(`${S.splits.has(f) ? 'Split' : 'Joined'} shot at frame ${f + 1}`);
  }
  function setShotCustom(on) {
    const start = shotStart(S.frame);
    pushUndo({ type: 'shots', before: { splits: [...S.splits], shotParams: [...S.shotParams.entries()] }, label: 'Shot settings' });
    if (on) S.shotParams.set(start, getParams()); else S.shotParams.delete(start);
    loadShotParams(); drawScan();
    log(on ? `Shot at frame ${start + 1} now has its own settings` : `Shot at frame ${start + 1} follows the clip settings`);
    if (S.source) requestProcess();
  }

  /** Per-shot damage assessment from the clip scan. */
  function assessment() {
    if (!S.scan) return [];
    return S.bounds.map((b, k) => {
      const end = k + 1 < S.bounds.length ? S.bounds[k + 1] - 1 : S.total - 1, m = S.scan.motions || [], mean = S.scan.means;
      let jitter = 0, jn = 0, fl = 0, fn = 0, mm = 0;
      for (let f = b + 1; f < end; f++) {
        const a = m[f], c = m[f + 1];
        if (a && c) { jitter += Math.hypot(a.tx - c.tx, a.ty - c.ty) / 2; jn++; }
      }
      for (let f = b + 1; f <= end; f++) { fl += Math.abs(mean[f] - mean[f - 1]); fn++; mm += mean[f]; }
      return { start: b, end, weave: jn ? jitter / jn : 0, flicker: fn ? (fl / fn / (mm / fn || 1)) * 100 : 0, suspects: (S.scan.suspects || []).filter((f) => f >= b && f <= end) };
    });
  }
  function renderAssessment() {
    const el = $('#assessment');
    if (!el) return;
    if (!S.scan) { el.innerHTML = '<li><span>Run <b>Scan clip</b> for a per-shot damage assessment</span></li>'; $('#rebuildSuspectsBtn').disabled = true; return; }
    const rows = assessment();
    const total = rows.reduce((a, r) => a + r.suspects.length, 0);
    $('#rebuildSuspectsBtn').disabled = !total || S.rendering;
    el.innerHTML = rows.map((r, k) => `<li data-goto="${r.start}"><span><b>Shot ${k + 1}</b> · ${r.start + 1}–${r.end + 1} · weave ${r.weave.toFixed(2)} px · flicker ${r.flicker.toFixed(1)}%${r.suspects.length ? ` · <span class="warn">damaged: ${r.suspects.map((f) => `<a href="#" data-goto="${f}">${f + 1}</a>`).join(', ')}</span>` : ''}</span></li>`).join('');
  }
  function rebuildSuspects() {
    const list = (S.scan && S.scan.suspects || []).filter((f) => canRebuild(f) && !S.replaced.has(f));
    if (!list.length) return;
    pushUndo({ type: 'replaceMany', before: [...S.replaced], label: 'Rebuild damaged frames' });
    for (const f of list) { S.replaced.add(f); invalidateNear(f); }
    log(`Rebuilding ${list.length} damaged frame(s): ${list.map((f) => f + 1).join(', ')}`);
    updateFrameTools(); drawScan(); requestProcess();
  }

  function serializeRois() { return S.rois.map((r) => ({ id: r.id, name: r.name, kind: r.kind || 'protect', shotStart: r.shotStart, shotEnd: r.shotEnd, keys: [...r.keys], track: [...r.track] })); }
  function deserializeRois(list) { return (list || []).map((r) => ({ id: r.id, name: r.name, kind: r.kind || 'protect', shotStart: r.shotStart, shotEnd: r.shotEnd, keys: new Map(r.keys), track: new Map(r.track) })); }
  function roiAt(x, y) {
    for (let k = S.rois.length - 1; k >= 0; k--) { const r = roiRectAt(S.rois[k], S.frame); if (r && x >= r.x && y >= r.y && x <= r.x + r.w && y <= r.y + r.h) return S.rois[k]; }
    return null;
  }
  function renderRoiList() {
    const ul = $('#roiList');
    if (!S.rois.length) { ul.innerHTML = '<li><span>Draw a rectangle with the Region tool (G) to protect a moving object</span></li>'; return; }
    ul.innerHTML = S.rois.map((r) => {
      const frames = [...r.keys.keys(), ...r.track.keys()], tracked = r.track.size;
      const repair = r.kind === 'repair';
      return `<li data-roi="${r.id}" class="${S.selectedRoi === r.id ? 'sel' : ''}"><span>${escapeHtml(r.name)} · <b style="color:${repair ? '#ffaa28' : '#8fd3ff'}">${repair ? 'repair' : 'protect'}</b> · ${r.shotStart + 1}–${r.shotEnd + 1}${tracked ? ` · tracked ${frames.length}` : ''}</span><button data-act="kind" title="${repair ? 'Make this a protect region' : 'Make this a repair region: remove a persistent defect (gate hair, subtitle, logo, wire)'}">${repair ? 'Protect' : 'Repair'}</button>${tracked ? '' : '<button data-act="span" title="Apply this (untracked) region to every frame of the clip, across cuts — for gate hair and burnt-in titles">All</button>'}<button data-act="track" title="Track this region through its shot">Track</button><button data-act="del" title="Delete region" aria-label="Delete region">✕</button></li>`;
    }).join('');
  }
  function smallLuma(d, ds) {
    const sw = Math.floor(S.w / ds), sh = Math.floor(S.h / ds), L = new Float32Array(sw * sh), k = 1 / (257 * ds * ds);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
      let v = 0;
      for (let yy = 0; yy < ds; yy++) for (let xx = 0; xx < ds; xx++) { const j = ((y * ds + yy) * S.w + x * ds + xx) * 4; v += 0.2126 * d[j] + 0.7152 * d[j + 1] + 0.0722 * d[j + 2]; }
      L[y * sw + x] = v * k;
    }
    return { L, w: sw, h: sh };
  }
  /** Template tracking (coarse-to-fine SAD, drift-limited template update) of a region through its shot. */
  async function trackRoi(roi) {
    if (S.rendering) return;
    const keyFrame = [...roi.keys.keys()].sort((a, b) => Math.abs(a - S.frame) - Math.abs(b - S.frame))[0];
    const key = roi.keys.get(keyFrame), ds = S.w > 1200 ? 2 : 1;
    S.rendering = true; S.cancel = false; showCancel(true);
    const before = serializeRois();
    try {
      const base = smallLuma(await getRaw(keyFrame), ds), bw = base.w, bh = base.h;
      const tw = Math.max(4, Math.round(key.w / ds)), th = Math.max(4, Math.round(key.h / ds));
      const cut = (L, x, y) => { const t = new Float32Array(tw * th); for (let j = 0; j < th; j++) for (let i = 0; i < tw; i++) { const xx = Math.min(bw - 1, Math.max(0, x + i)), yy = Math.min(bh - 1, Math.max(0, y + j)); t[j * tw + i] = L[yy * bw + xx]; } return t; };
      const keyT = cut(base.L, Math.round(key.x / ds), Math.round(key.y / ds));
      for (const dir of [1, -1]) {
        let tmpl = keyT, px = Math.round(key.x / ds), py = Math.round(key.y / ds);
        for (let f = keyFrame + dir; f >= roi.shotStart && f <= roi.shotEnd; f += dir) {
          if (S.cancel) throw new Error('cancelled');
          if (roi.keys.has(f)) { const k2 = roi.keys.get(f); px = Math.round(k2.x / ds); py = Math.round(k2.y / ds); continue; }
          const { L } = smallLuma(await getRaw(f), ds);
          const sad = (x, y, limit) => { let v = 0; for (let j = 0; j < th; j += 2) { const yy = Math.min(bh - 1, Math.max(0, y + j)); for (let i = 0; i < tw; i += 2) { const xx = Math.min(bw - 1, Math.max(0, x + i)); v += Math.abs(L[yy * bw + xx] - tmpl[j * tw + i]); } if (v > limit) return v; } return v; };
          let best = Infinity, bx = px, by = py;
          const R = Math.ceil(24 / ds);
          for (let y = py - R; y <= py + R; y += 2) for (let x = px - R; x <= px + R; x += 2) { const v = sad(x, y, best); if (v < best) { best = v; bx = x; by = y; } }
          const cx = bx, cy = by;
          for (let y = cy - 2; y <= cy + 2; y++) for (let x = cx - 2; x <= cx + 2; x++) { const v = sad(x, y, best); if (v < best) { best = v; bx = x; by = y; } }
          px = bx; py = by;
          const cur = cut(L, px, py);
          for (let k = 0; k < tmpl.length; k++) tmpl[k] = 0.5 * keyT[k] + 0.5 * cur[k]; // adapt, but stay anchored to the key
          roi.track.set(f, { x: px * ds, y: py * ds, w: key.w, h: key.h });
          if (Math.abs(f - keyFrame) % 4 === 0) setMessage(`Tracking ${roi.name}: frame ${f + 1}`, ((Math.abs(f - keyFrame)) / (roi.shotEnd - roi.shotStart + 1)) * 100);
        }
      }
      pushUndo({ type: 'rois', before, label: 'Track region' });
      S.protectVersion++;
      log(`Tracked ${roi.name} across frames ${roi.shotStart + 1}–${roi.shotEnd + 1}`);
      setMessage(`${roi.name} tracked through its shot`, 0);
    } catch (err) {
      S.rois = deserializeRois(before);
      setMessage(err.message === 'cancelled' ? 'Tracking cancelled' : 'Tracking failed: ' + err.message, 0);
    } finally {
      S.rendering = false; showCancel(false); renderRoiList(); drawScan(); requestProcess();
    }
  }

  /** Click&Fix: detect and repair the defect under the cursor. */
  async function clickFix(pt) {
    const f = S.frame, r = +$('#brushSize').value / 2;
    try {
      let res = S.results.peek(f);
      if (!res || res.key !== resultKey(f) || !res.analysisKey) { S.results.delete(f); res = await processFrame(f); }
      let out = await engine.clickFix(res.analysisKey, pt.x, pt.y, r);
      if (out.missing) { S.results.delete(f); engine.cache.delete(res.analysisKey); res = await processFrame(f); out = await engine.clickFix(res.analysisKey, pt.x, pt.y, r); }
      if (!out.idx || !out.idx.length || f !== S.frame) return;
      const before = S.heal.get(f) || null, mask = before ? Uint8Array.from(before) : new Uint8Array(S.w * S.h);
      for (const i of out.idx) mask[i] = 1;
      pushUndo({ type: 'heal', frame: f, before, label: 'Click&Fix' });
      S.heal.set(f, mask); S._healOverlay = null; bumpVersion(f);
      log(`Click&Fix at ${Math.round(pt.x)}, ${Math.round(pt.y)} on frame ${f + 1}: ${out.idx.length} px`);
      requestProcess();
    } catch (err) { if (err.message !== 'stale') setMessage('Click&Fix failed: ' + err.message); }
  }

  // ------------------------------------------------------------------ undo / redo
  function pushUndo(entry) { S.undo.push(entry); if (S.undo.length > 60) S.undo.shift(); S.redo = []; updateUndoButtons(); }
  function updateUndoButtons() { $('#undoBtn').disabled = !S.undo.length; $('#redoBtn').disabled = !S.redo.length; }
  function swapEntry(e) {
    const inv = Object.assign({}, e);
    if (e.type === 'hints') {
      const layer = S.hints.get(e.frame);
      inv.before = layer ? ctx2d(layer).getImageData(0, 0, S.w, S.h) : null;
      if (e.before) { let l = S.hints.get(e.frame); if (!l) { l = makeCanvas(S.w, S.h); S.hints.set(e.frame, l); } ctx2d(l).putImageData(e.before, 0, 0); } else S.hints.delete(e.frame);
      hintsChanged(e.frame);
      return inv;
    }
    if (e.type === 'paint') {
      const layer = S.paint.get(e.frame);
      inv.before = layer ? ctx2d(layer).getImageData(0, 0, S.w, S.h) : null;
      if (e.before) ctx2d(getLayer(e.frame, true)).putImageData(e.before, 0, 0); else S.paint.delete(e.frame);
    } else if (e.type === 'heal') {
      inv.before = S.heal.get(e.frame) || null;
      if (e.before) S.heal.set(e.frame, e.before); else S.heal.delete(e.frame);
      bumpVersion(e.frame); S._healOverlay = null;
    } else if (e.type === 'rejects') {
      inv.before = (S.rejects.get(e.frame) || []).slice();
      if (e.before.length) S.rejects.set(e.frame, e.before); else S.rejects.delete(e.frame);
      bumpVersion(e.frame);
    } else if (e.type === 'protect') {
      inv.before = S.protect; S.protect = e.before; S.protectVersion++; rebuildProtectCanvas();
    } else if (e.type === 'params') {
      const scope = e.scope === undefined ? 'clip' : e.scope;
      inv.before = scope === 'clip' ? Object.assign({}, BASE, S.globalParams) : Object.assign({}, S.shotParams.get(scope) || S.globalParams);
      if (scope === 'clip') { S.globalParams = e.before; store.set('params', e.before); } else S.shotParams.set(scope, e.before);
      loadShotParams(); $('#preset').value = 'custom'; S.stabCache.clear();
    } else if (e.type === 'revert') {
      inv.before = S.revert.get(e.frame) || null;
      if (e.before) S.revert.set(e.frame, e.before); else S.revert.delete(e.frame);
      bumpVersion(e.frame); S._revertOverlay = null;
    } else if (e.type === 'replace') {
      inv.before = S.replaced.has(e.frame);
      if (e.before) S.replaced.add(e.frame); else S.replaced.delete(e.frame);
      invalidateNear(e.frame); updateFrameTools();
    } else if (e.type === 'rois') {
      inv.before = serializeRois(); S.rois = deserializeRois(e.before); S.protectVersion++; renderRoiList();
    } else if (e.type === 'replaceMany') {
      inv.before = [...S.replaced]; for (const f of new Set([...S.replaced, ...e.before])) invalidateNear(f); S.replaced = new Set(e.before); updateFrameTools(); drawScan();
    } else if (e.type === 'keys') {
      inv.before = snapshotKeys(); S.keys = new Map(e.before); afterKeysChanged();
    } else if (e.type === 'shots') {
      inv.before = { splits: [...S.splits], shotParams: [...S.shotParams.entries()] };
      S.splits = new Set(e.before.splits); S.shotParams = new Map(e.before.shotParams); rebuildBounds(); loadShotParams();
    }
    S.outputDirty = true;
    return inv;
  }
  async function undoRedo(isRedo) {
    const from = isRedo ? S.redo : S.undo, to = isRedo ? S.undo : S.redo;
    const e = from.pop(); if (!e) return;
    to.push(swapEntry(e)); updateUndoButtons();
    log(`${isRedo ? 'Redo' : 'Undo'}: ${e.label || e.type}`);
    if (e.frame !== undefined && e.frame !== S.frame) await goToFrame(e.frame, { process: false });
    if (e.type === 'paint') rebuildComposite(); else requestProcess();
  }

  // ------------------------------------------------------------------ pointer & wheel
  display.addEventListener('contextmenu', (e) => { if (isBrushTool(S.tool)) e.preventDefault(); });
  display.addEventListener('pointerdown', (e) => {
    if (!S.source || S.rendering) return;
    const pt = toImage(e);
    display.setPointerCapture(e.pointerId);
    const nearSplit = S.view === 'split' && Math.abs(pt.sx - (S.panX + S.w * S.split * S.zoom)) < 10;
    if (e.button === 1 || S.spaceDown || nearSplit || S.tool === 'pan' || (S.view === 'split' && !isBrushTool(S.tool) && S.tool !== 'review')) {
      if (S.spaceDown) S.spaceUsed = true;
      S.pointer = nearSplit ? { kind: 'split' } : { kind: 'pan', sx: pt.sx, sy: pt.sy, px: S.panX, py: S.panY };
      if (nearSplit) { S.split = Math.max(0, Math.min(1, pt.x / S.w)); requestDraw(); }
      return;
    }
    if (S.tool === 'review') {
      const c = componentAt(pt.x, pt.y);
      if (c) toggleComponent(c); else setMessage('No detected defect here. Switch to the Defects view to see them.');
      return;
    }
    if (S.tool === 'note') {
      const text = prompt(`Note for frame ${S.frame + 1}:`);
      if (text) {
        S.pins.push({ frame: S.frame, x: Math.round(pt.x), y: Math.round(pt.y), text });
        $('#notes').value += ($('#notes').value ? '\n' : '') + `Frame ${S.frame + 1} (${Math.round(pt.x)}, ${Math.round(pt.y)}): ${text}`;
        log(`Note on frame ${S.frame + 1}`); requestDraw();
      }
      return;
    }
    if (S.tool === 'fix') { if (pt.x >= 0 && pt.y >= 0 && pt.x < S.w && pt.y < S.h) clickFix(pt); return; }
    if (S.tool === 'roi') {
      const hit = roiAt(pt.x, pt.y);
      if (hit) { S.selectedRoi = hit.id; const r = roiRectAt(hit, S.frame); S.pointer = { kind: 'roiMove', roi: hit, ox: pt.x - r.x, oy: pt.y - r.y, rect: Object.assign({}, r), before: serializeRois() }; }
      else S.pointer = { kind: 'roiNew', x0: pt.x, y0: pt.y, rect: { x: pt.x, y: pt.y, w: 0, h: 0 } };
      renderRoiList(); requestDraw();
      return;
    }
    if (isBrushTool(S.tool) && pt.x >= -50 && pt.y >= -50 && pt.x <= S.w + 50 && pt.y <= S.h + 50) beginStroke(pt, e);
  });
  display.addEventListener('pointermove', (e) => {
    const pt = toImage(e);
    S.mouse = pt;
    const P = S.pointer;
    if (P && P.kind === 'pan') { S.panX = P.px + pt.sx - P.sx; S.panY = P.py + pt.sy - P.sy; S.fitMode = false; }
    else if (P && P.kind === 'split') S.split = Math.max(0, Math.min(1, pt.x / S.w));
    else if (P && P.kind === 'roiNew') { const x = Math.max(0, Math.min(S.w, pt.x)), y = Math.max(0, Math.min(S.h, pt.y)); P.rect = { x: Math.min(P.x0, x), y: Math.min(P.y0, y), w: Math.abs(x - P.x0), h: Math.abs(y - P.y0) }; }
    else if (P && P.kind === 'roiMove') { P.rect.x = Math.round(pt.x - P.ox); P.rect.y = Math.round(pt.y - P.oy); }
    else if (P) strokeTo(pt.x, pt.y);
    display.style.cursor = P && P.kind === 'pan' ? 'grabbing' : S.spaceDown || S.tool === 'pan' ? 'grab' : isBrushTool(S.tool) ? 'none' : S.tool === 'review' ? 'pointer' : 'crosshair';
    requestDraw();
  });
  const finishPointer = () => {
    const P = S.pointer;
    if (P && (P.kind === 'paint' || P.kind === 'mask')) { endStroke(); return; }
    S.pointer = null;
    if (P && P.kind === 'roiNew' && P.rect.w >= 6 && P.rect.h >= 6) {
      const before = serializeRois(), id = ++S.roiSeq, r = P.rect;
      S.rois.push({ id, name: `Region ${id}`, kind: $('#regionKind') ? $('#regionKind').value : 'protect', shotStart: shotStart(S.frame), shotEnd: shotEnd(S.frame), keys: new Map([[S.frame, { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) }]]), track: new Map() });
      S.selectedRoi = id; S.protectVersion++;
      pushUndo({ type: 'rois', before, label: 'New protect region' });
      log(`Protect region ${id} on frame ${S.frame + 1}. Use Track to follow it through the shot.`);
      renderRoiList(); drawScan(); requestProcess();
    } else if (P && P.kind === 'roiMove' && (P.rect.x !== Math.round(roiRectAt(P.roi, S.frame).x) || P.rect.y !== Math.round(roiRectAt(P.roi, S.frame).y))) {
      P.roi.keys.set(S.frame, { x: P.rect.x, y: P.rect.y, w: Math.round(P.rect.w), h: Math.round(P.rect.h) }); P.roi.track.delete(S.frame);
      S.protectVersion++;
      pushUndo({ type: 'rois', before: P.before, label: 'Move protect region' });
      log(`Re-keyed ${P.roi.name} on frame ${S.frame + 1}`);
      renderRoiList(); requestProcess();
    }
    requestDraw();
  };
  display.addEventListener('pointerup', finishPointer);
  display.addEventListener('pointercancel', finishPointer);
  display.addEventListener('pointerleave', () => { S.mouse = null; requestDraw(); });
  display.addEventListener('wheel', (e) => {
    if (!S.source) return;
    e.preventDefault();
    const pt = toImage(e);
    zoomAt(S.zoom * Math.pow(1.0018, -e.deltaY * (e.deltaMode === 1 ? 30 : 1)), pt.sx, pt.sy);
  }, { passive: false });
  new ResizeObserver(() => { requestDraw(); drawScan(); }).observe($('#stage'));

  // ------------------------------------------------------------------ timeline, playback, scan strip
  function updateTimecode() {
    const nominal = Math.max(1, Math.round(S.fps)), f = S.frame;
    const ff = f % nominal, total = Math.floor(f / nominal);
    $('#timecode').textContent = [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60, ff].map((v) => String(v).padStart(2, '0')).join(':');
  }
  function updateRangeLabel() {
    if (!S.source) { $('#rangeLabel').textContent = 'Range: —'; return; }
    const a = S.inMark ?? 0, b = S.outMark ?? S.total - 1;
    $('#rangeLabel').textContent = `Range: frames ${a + 1}–${b + 1} (${b - a + 1} frame${b > a ? 's' : ''})${S.inMark == null && S.outMark == null ? ' · whole clip' : ''}`;
    drawScan();
  }
  function renderRange() { const a = S.inMark ?? 0, b = S.outMark ?? S.total - 1; return [Math.min(a, b), Math.max(a, b)]; }

  async function togglePlay() {
    if (!S.source || S.total < 2 || S.rendering) return;
    if (S.playing) { S.playing = false; return; }
    S.playing = true; $('#playBtn').textContent = '❚❚'; $('#playBtn').setAttribute('aria-label', 'Pause');
    if (S.frame >= S.total - 1) await goToFrame(0, { process: false });
    while (S.playing && S.frame < S.total - 1) {
      const t0 = performance.now();
      await goToFrame(S.frame + 1, { process: false });
      const wait = 1000 / S.fps - (performance.now() - t0);
      if (wait > 0) await sleep(wait);
    }
    S.playing = false; $('#playBtn').textContent = '▶'; $('#playBtn').setAttribute('aria-label', 'Play');
    if ($('#autoRestore').checked) requestProcess();
  }

  function drawScan() {
    const c = $('#scanCanvas'), dpr = window.devicePixelRatio || 1, w = Math.max(1, c.clientWidth), h = 30;
    if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = h * dpr; }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    if (!S.source) return;
    const N = Math.max(1, S.total), X = (f) => (N === 1 ? w / 2 : (f / (N - 1)) * (w - 8) + 4);
    const [a, b] = renderRange();
    g.fillStyle = S.inMark == null && S.outMark == null ? '#121c28' : '#1b3a55';
    g.fillRect(X(a) - 2, 0, Math.max(3, X(b) - X(a) + 4), h);
    if (S.scan) {
      const m = S.scan.means, lo = Math.min(...m), hi = Math.max(...m), span = Math.max(4, hi - lo);
      g.strokeStyle = '#8fd3ff'; g.lineWidth = 1; g.beginPath();
      for (let f = 0; f < N; f++) { const y = h - 5 - ((m[f] - lo) / span) * (h - 12); if (!f) g.moveTo(X(f), y); else g.lineTo(X(f), y); }
      g.stroke();
      g.fillStyle = '#ff6b7a';
      for (const f of S.scan.cuts) g.fillRect(X(f) - 1, 0, 2, h);
    }
    S.bounds.forEach((b, k) => {
      const end = k + 1 < S.bounds.length ? S.bounds[k + 1] - 1 : N - 1;
      if (S.shotParams.has(b)) { g.fillStyle = '#6ce0bd22'; g.fillRect(X(b), 0, Math.max(2, X(end) - X(b)), h); }
      if (b > 0) { g.fillStyle = S.splits.has(b) ? '#f7a65e' : '#ff6b7a'; g.fillRect(X(b) - 1, 0, 2, h); }
    });
    g.fillStyle = '#b48cff';
    for (const f of S.replaced) g.fillRect(X(f) - 1.5, 4, 3, h - 8);
    if (S.scan && S.scan.suspects) { g.fillStyle = '#ffd24a'; for (const f of S.scan.suspects) { g.beginPath(); g.moveTo(X(f) - 4, 0); g.lineTo(X(f) + 4, 0); g.lineTo(X(f), 6); g.fill(); } }
    g.fillStyle = '#f7c65e';
    for (const list of S.keys.values()) for (const q of list) { const x = X(q.frame), y = h / 2; g.beginPath(); g.moveTo(x, y - 5); g.lineTo(x + 5, y); g.lineTo(x, y + 5); g.lineTo(x - 5, y); g.fill(); }
    g.fillStyle = '#428cff';
    for (const roi of S.rois) for (const f of [...roi.keys.keys(), ...roi.track.keys()]) g.fillRect(X(f) - 0.5, h - 8, 1.5, 3);
    g.fillStyle = '#6ce0bd';
    for (const f of S.log.keys()) g.fillRect(X(f) - 0.5, h - 4, 1.5, 4);
    g.fillStyle = '#f7c65e';
    for (const f of new Set([...S.heal.keys(), ...S.paint.keys(), ...S.rejects.keys(), ...S.pins.map((p) => p.frame)])) g.fillRect(X(f) - 1, 0, 2, 4);
    g.fillStyle = '#fff'; g.fillRect(X(S.frame) - 1, 0, 2, h);
  }
  $('#scanCanvas').addEventListener('pointerdown', (e) => {
    if (!S.source || S.total < 2 || S.rendering) return;
    const r = e.currentTarget.getBoundingClientRect();
    goToFrame(Math.round(((e.clientX - r.left - 4) / (r.width - 8)) * (S.total - 1)));
  });

  async function scanClip() {
    if (!S.source || S.total < 2 || S.rendering) return;
    S.rendering = true; S.cancel = false; showCancel(true);
    const means = new Float32Array(S.total), hists = [], cuts = new Set(), motions = new Array(S.total).fill(null);
    const t0 = performance.now(), ds = Math.max(1, Math.ceil(S.w / 480)), sw = Math.floor(S.w / ds), sh = Math.floor(S.h / ds);
    const small = (d) => {
      const L = new Float32Array(sw * sh), k = 1 / (257 * ds * ds);
      for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
        let s0 = 0;
        for (let yy = 0; yy < ds; yy++) for (let xx = 0; xx < ds; xx++) { const j = ((y * ds + yy) * S.w + x * ds + xx) * 4; s0 += 0.2126 * d[j] + 0.7152 * d[j + 1] + 0.0722 * d[j + 2]; }
        L[y * sw + x] = s0 * k;
      }
      return L;
    };
    let prevSmall = null;
    const chist = new Array(S.total), tiny = new Array(S.total), ds2 = Math.max(1, Math.ceil(S.w / 160)), tw = Math.floor(S.w / ds2), th = Math.floor(S.h / ds2);
    try {
      for (let f = 0; f < S.total; f++) {
        if (S.cancel) throw new Error('cancelled');
        const raw = await getRaw(f);
        const hist = S.hist.get(f);
        let m = 0; for (let k = 0; k < 64; k++) m += hist[k] * (k * 4 + 2);
        means[f] = m; hists.push(hist);
        if (f && E.cutScore(hists[f - 1], hist) > CUT_THRESHOLD) cuts.add(f);
        const L = small(raw);
        chist[f] = Float32Array.from(E.channelHistograms(raw, S.w * S.h, Math.max(1, Math.floor((S.w * S.h) / 60000))));
        const T = new Float32Array(tw * th), r2 = ds2 / ds;
        for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) T[y * tw + x] = L[Math.min(sh - 1, Math.floor(y * r2)) * sw + Math.min(sw - 1, Math.floor(x * r2))];
        tiny[f] = T;
        if (prevSmall && !cuts.has(f)) {
          const g = await engine.globalMotion(L, prevSmall, sw, sh);
          motions[f] = { tx: g.tx * ds, ty: g.ty * ds, angle: g.angle, scale: g.scale };
        }
        prevSmall = L;
        if (f % 4 === 0) setMessage(`Scanning frame ${f + 1}/${S.total}…`, (f / S.total) * 100);
      }
      const shifts = motions.map((m) => (m ? { tx: m.tx / ds2, ty: m.ty / ds2 } : null));
      const outl = E.frameOutliers(tiny, tw, th, shifts, cuts);
      S.scan = { means, cuts, motions, chist, suspects: outl.suspects, outlierScores: Array.from(outl.scores) };
      S.levelsCache.clear();
      if (outl.suspects.length) log(`Scan flagged ${outl.suspects.length} damaged-frame candidate(s): ${outl.suspects.map((f) => f + 1).join(', ')}`);
      rebuildBounds(); loadShotParams(); renderAssessment();
      const weave = motions.filter(Boolean).map((q) => Math.hypot(q.tx, q.ty));
      log(`Scanned clip: ${cuts.size} scene cut${cuts.size === 1 ? '' : 's'}, brightness range ${Math.min(...means).toFixed(0)}–${Math.max(...means).toFixed(0)}`);
      setMessage(`Scan complete in ${((performance.now() - t0) / 1000).toFixed(1)} s: ${cuts.size} cut${cuts.size === 1 ? '' : 's'}, mean camera/gate motion ${(weave.reduce((x, y) => x + y, 0) / Math.max(1, weave.length)).toFixed(2)} px/frame. Deflicker and stabilisation now use the scan.`, 0);
    } catch (err) {
      setMessage(err.message === 'cancelled' ? 'Scan cancelled' : 'Scan failed: ' + err.message, 0);
    } finally {
      S.rendering = false; showCancel(false); drawScan(); renderAssessment();
      if (S.scan) requestProcess();
    }
  }

  // ------------------------------------------------------------------ export
  function baseName() { return (S.source ? (S.source.kind === 'video' ? S.source.name : S.source.files[0].name) : 'frame').replace(/\.[^.]+$/, '').replace(/[_-]?\d+$/, '').replace(/[^a-z0-9_-]+/gi, '_') || 'frame'; }
  function showCancel(on) {
    $('#cancelBtn').classList.toggle('hidden', !on);
    for (const id of ['exportZipBtn', 'exportPngBtn', 'restoreBtn', 'scanBtn', 'exportFormat', 'queueAddBtn']) $('#' + id).disabled = on || (id === 'scanBtn' && S.total < 2);
    renderQueue();
    updateFrameTools();
    updateExportUI();
  }

  /** The 16-bit deliverable for a frame: restored pixels with any clone/blur/paint layer blended on top. */
  function composite16(f, data) {
    const layer = S.paint.get(f);
    if (!layer) return data;
    const p = ctx2d(layer).getImageData(0, 0, S.w, S.h).data, out = new Uint16Array(data);
    for (let i = 0; i < p.length; i += 4) {
      const a = p[i + 3];
      if (!a) continue;
      const k = a / 255;
      for (let c = 0; c < 3; c++) out[i + c] = out[i + c] * (1 - k) + p[i + c] * 257 * k + 0.5;
    }
    return out;
  }

  /** Stabilising correction for frame i from the clip scan, or null. */
  function stabCorrection(i) {
    const p = paramsFor(i);
    if (!p.stabilize || !S.scan || !S.scan.motions) return null;
    const start = shotStart(i), end = shotEnd(i), key = JSON.stringify([start, end, p.stabMode, p.stabSmooth, p.stabilize]);
    let plan = S.stabCache.get(key);
    if (!plan) {
      const motions = S.scan.motions.slice(start, end + 1);
      motions[0] = null;
      plan = E.stabilizationPlan(motions, null, { mode: p.stabMode, smoothing: p.stabSmooth, strength: p.stabilize / 100 });
      S.stabCache.set(key, plan);
    }
    return Object.assign({}, plan[i - start], { zoom: 1 + p.stabZoom / 100 });
  }
  /** The final deliverable for frame i: restored + manual layer + stabilisation. */
  function outputData(i, data) {
    const d = composite16(i, data), t = stabCorrection(i);
    return t ? E.transformRGBA(d, S.w, S.h, t) : d;
  }

  async function encodeStill(fmt, data, name) {
    if (fmt === 'tiff16') return IO.encodeTIFF(S.w, S.h, data);
    if (fmt === 'dpx10') {
      // Log scans go back out as log DPX (printing density), so a film-out or grading pipeline keeps its encoding.
      if (S.source && S.source.transfer === 'cineon') return IO.encodeDPX(S.w, S.h, IO.applyLUT16(data, SequenceSource.luts.toLog), { name, fps: S.fps, log: true });
      return IO.encodeDPX(S.w, S.h, data, { name, fps: S.fps });
    }
    if (fmt === 'exr') return IO.encodeEXR(S.w, S.h, data, { compression: 'zip' });
    return IO.encodePNG(S.w, S.h, data, fmt === 'png8' ? 8 : 16);
  }
  function outputFormat() { return $('#exportFormat').value; }
  function updateExportUI() {
    const fmt = outputFormat(), video = !!VIDEO_FORMATS[fmt];
    $('#videoQualityRow').classList.toggle('hidden', !video);
    $('#exportZipBtn').textContent = video ? `Render ${VIDEO_FORMATS[fmt].ext.toUpperCase()}` : 'Render to ZIP';
    $('#exportFolderBtn').disabled = !S.source || S.rendering || video || !('showDirectoryPicker' in window);
    $('#exportFolderBtn').title = video ? 'Video renders to a single file' : 'Render the range as image files into a folder you choose';
    store.set('exportFormat', fmt);
  }

  async function exportFrame() {
    if (!S.source) return;
    if (!S.shown || !S.shown.valid) { S.results.delete(S.frame); await requestProcess(); }
    const res = S.shown && S.shown.res;
    if (!res) return;
    let fmt = outputFormat();
    if (VIDEO_FORMATS[fmt]) fmt = 'png16';
    const name = `${baseName()}_restored_${pad(S.frame + 1)}.${STILL_FORMATS[fmt].ext}`;
    download(new Blob([await encodeStill(fmt, outputData(S.frame, res.data), name)]), name);
    log(`Exported frame ${S.frame + 1} as ${STILL_FORMATS[fmt].label}`);
  }

  /** WebCodecs encoder writing H.264 (MP4) or VP9 (WebM) in frame order. */
  async function makeVideoSink(fmt, fps) {
    if (typeof VideoEncoder === 'undefined') throw new Error('Video export needs WebCodecs (current Chrome or Edge)');
    const ew = S.w & ~1, eh = S.h & ~1, big = ew * eh > 2088960;
    const bitrate = Math.round(ew * eh * fps * VIDEO_BPP[$('#videoQuality').value || 'high']);
    const codecs = fmt === 'mp4' ? (big ? ['avc1.640034', 'avc1.640033', 'avc1.640028'] : ['avc1.640028', 'avc1.4d0028', 'avc1.42001f'])
      : (big ? ['vp09.00.50.08', 'vp09.00.40.08', 'vp09.00.10.08'] : ['vp09.00.40.08', 'vp09.00.10.08', 'vp8']);
    let config = null;
    for (const codec of codecs) {
      const cfg = { codec, width: ew, height: eh, bitrate, framerate: fps, latencyMode: 'quality' };
      if (fmt === 'mp4') cfg.avc = { format: 'avc' };
      try { const sup = await VideoEncoder.isConfigSupported(cfg); if (sup.supported) { config = sup.config; break; } } catch { /* try next */ }
    }
    if (!config) throw new Error(`This browser cannot encode ${VIDEO_FORMATS[fmt].label} at ${ew}×${eh}`);
    const chunks = [];
    let description = null, failure = null, index = 0;
    const encoder = new VideoEncoder({
      output: (chunk, meta) => {
        const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data);
        chunks.push({ data, key: chunk.type === 'key', timestamp: chunk.timestamp });
        const d = meta && meta.decoderConfig && meta.decoderConfig.description;
        if (d) description = new Uint8Array(ArrayBuffer.isView(d) ? d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) : d.slice(0));
      },
      error: (e) => { failure = e; },
    });
    encoder.configure(config);
    const full = makeCanvas(S.w, S.h), canvas = makeCanvas(ew, eh), cx = canvas.getContext('2d');
    const gop = Math.max(1, Math.round(fps * 2));
    return {
      codec: config.codec,
      async write(_f, data) {
        if (failure) throw failure;
        putData(full, data, S.w, S.h); cx.drawImage(full, 0, 0);
        const frame = new VideoFrame(canvas, { timestamp: Math.round((index * 1e6) / fps), duration: Math.round(1e6 / fps) });
        encoder.encode(frame, { keyFrame: index % gop === 0 }); frame.close(); index++;
        while (encoder.encodeQueueSize > 4) await sleep(4);
      },
      async finish() {
        await encoder.flush(); encoder.close();
        if (failure) throw failure;
        const bytes = fmt === 'mp4' ? IO.muxMP4({ width: ew, height: eh, fps, chunks, description }) : IO.muxWebM({ codec: config.codec, width: ew, height: eh, fps, chunks });
        return new Blob([bytes], { type: VIDEO_FORMATS[fmt].mime });
      },
      abort() { try { encoder.close(); } catch { /* already closed */ } },
    };
  }

  function poolSize() {
    const cores = navigator.hardwareConcurrency || 4, mp = (S.w * S.h) / 1e6;
    let n = Math.max(1, Math.min(4, Math.floor(cores / 4)));
    if (mp > 8) n = Math.min(n, 2);
    if (engine.gpuName) n = Math.min(n, 3);
    return n;
  }

  /**
   * Render the in/out range. Frames are restored in parallel across a pool of
   * workers and written strictly in order to a folder, a ZIP, or a video file.
   */
  /** Returns 'done', 'cancelled', 'skipped' or 'failed: …'. opts.dir: preselected folder; opts.quiet: no dialogs. */
  async function renderSequence(mode, opts = {}) {
    if (!S.source || S.rendering) return 'skipped';
    const fmt = outputFormat(), video = !!VIDEO_FORMATS[fmt], [a, b] = renderRange(), count = b - a + 1;
    let dir = opts.dir || null, files = [], bytes = 0, sink = null, result = 'done';
    if (mode === 'folder' && !video && !dir) {
      try { dir = await window.showDirectoryPicker({ mode: 'readwrite', id: 'frs-render' }); } catch { return 'skipped'; }
    } else if (!dir && !video && !opts.quiet && count * S.w * S.h * (fmt === 'png8' ? 2.2 : 5) > 1.8e9) {
      if (confirm('This range may produce a ZIP over 2 GB, which browsers struggle to hold in memory. Cancel and use "Render to folder" instead?')) return 'skipped';
    }
    S.rendering = true; S.cancel = false; showCancel(true);
    const t0 = performance.now(), name = baseName(), keep = S.frame, gen = S.gen;
    storeParamsFromUI();
    if (S.scan == null && Array.from({ length: count }, (_, k) => paramsFor(a + k).stabilize).some(Boolean)) setMessage('Stabilisation needs a clip scan; rendering without it', 0);
    const label = (VIDEO_FORMATS[fmt] || STILL_FORMATS[fmt]).label;
    try {
      if (video) sink = await makeVideoSink(fmt, S.fps);
      const workers = await engine.ensurePool(Math.min(poolSize(), count));
      log(`Render started: frames ${a + 1}–${b + 1} as ${label} on ${workers} worker${workers > 1 ? 's' : ''}${engine.gpuName ? ' with GPU flow' : ''}`);
      let next = a, written = a, writing = Promise.resolve();
      const finished = new Map();
      const write = async () => {
        while (finished.has(written)) {
          const f = written, { r, refIdx, key, aKey } = finished.get(f);
          finished.delete(f);
          const entry = storeResult(f, key, refIdx, r, aKey), data = outputData(f, entry.data);
          if (sink) await sink.write(f, data);
          else {
            const fname = `${name}_restored_${pad(f + 1)}.${STILL_FORMATS[fmt].ext}`, enc = await encodeStill(fmt, data, fname);
            if (dir) { const fh = await dir.getFileHandle(fname, { create: true }), wr = await fh.createWritable(); await wr.write(enc); await wr.close(); }
            else { files.push({ name: fname, data: enc }); bytes += enc.length; }
          }
          written++;
          S.frame = f; $('#frameSlider').value = f; $('#frameInput').value = f + 1; updateTimecode();
          if (S.raw.peek(f)) showFrame(f, S.raw.peek(f));
          const done = written - a, el = (performance.now() - t0) / 1000, rate = done / el;
          setMessage(`Rendering ${done}/${count} · ${rate.toFixed(2)} fps · ${Math.ceil((count - done) / rate)} s left`, (done / count) * 100);
        }
      };
      const lane = async (k) => {
        while (!S.cancel && next <= b) {
          while (next - written > workers * 2 && !S.cancel) await sleep(10);
          if (S.cancel || next > b) break;
          const f = next++;
          const params = paramsFor(f), key = resultKey(f, params), cached = S.results.peek(f);
          let r, refIdx;
          let aKey = null;
          if (cached && cached.key === key) { r = cached; refIdx = cached.refs; aKey = cached.analysisKey; }
          else {
            const prep = await prepareJob(f, params);
            if (gen !== S.gen) throw new Error('stale');
            r = await engine.process(prep.job, prep.analysisKey, k, prep.frameKeys); refIdx = prep.refIdx; aKey = prep.analysisKey;
          }
          finished.set(f, { r, refIdx, key, aKey });
          writing = writing.then(write);
          await writing;
        }
      };
      await Promise.all(Array.from({ length: workers }, (_, k) => lane(k)));
      await writing;
      if (S.cancel) throw new Error('cancelled');
      let outName = '';
      if (sink) {
        setMessage('Finalising video…', 99);
        const blob = await sink.finish(); bytes = blob.size;
        outName = `${name}_restored_${pad(a + 1)}-${pad(b + 1)}.${VIDEO_FORMATS[fmt].ext}`;
        download(blob, outName);
      } else if (!dir) {
        setMessage('Packaging ZIP…', 99);
        outName = `${name}_restored_${pad(a + 1)}-${pad(b + 1)}.zip`;
        download(new Blob(IO.zipStoreParts(files), { type: 'application/zip' }), outName);
      }
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      log(`Rendered ${count} frame${count > 1 ? 's' : ''} as ${label} in ${secs} s${dir ? ` to folder "${dir.name}"` : ` (${(bytes / 1048576).toFixed(1)} MB${sink ? ', ' + sink.codec : ''})`}`);
      setMessage(`Render complete: ${count} frame${count > 1 ? 's' : ''} in ${secs} s`, 100);
    } catch (err) {
      if (sink) sink.abort();
      result = err.message === 'cancelled' ? 'cancelled' : 'failed: ' + err.message;
      setMessage(err.message === 'cancelled' ? 'Render cancelled' : 'Render failed: ' + err.message, 0);
      if (err.message !== 'cancelled' && err.message !== 'stale') console.error(err);
    } finally {
      files = null; S.rendering = false; showCancel(false); engine.trimPool();
      if (!S.queueRunning) setTimeout(() => setMessage('Ready', 0), 2500);
      await goToFrame(keep);
    }
    return result;
  }

  // ------------------------------------------------------------------ batch render queue
  function renderQueue() {
    const ul = $('#queueList');
    $('#queueRunBtn').disabled = S.queueRunning || S.rendering || !S.queue.some((q) => q.status !== 'done');
    $('#queueRunBtn').textContent = S.queueRunning ? 'Queue running…' : 'Run queue';
    if (!S.queue.length) { ul.innerHTML = '<li><span>Add clips with their settings, masks and edits; then run them unattended</span></li>'; return; }
    ul.innerHTML = S.queue.map((q) => `<li data-q="${q.id}"><span>${escapeHtml(q.name)} · ${q.range[0] + 1}–${q.range[1] + 1} · ${escapeHtml((VIDEO_FORMATS[q.format] || STILL_FORMATS[q.format]).label)}${q.dir ? ` → ${escapeHtml(q.dir.name)}` : ''} · <b class="${q.status.startsWith('failed') ? 'warn' : ''}">${escapeHtml(q.status)}</b></span>${S.queueRunning ? '' : '<button data-act="del" aria-label="Remove from queue">✕</button>'}</li>`).join('');
  }
  async function addToQueue() {
    if (!S.source || S.rendering) return;
    storeParamsFromUI();
    const fmt = outputFormat(), video = !!VIDEO_FORMATS[fmt];
    let dir = null;
    if (!video && $('#queueDest').value === 'folder') {
      try { dir = await window.showDirectoryPicker({ mode: 'readwrite', id: 'frs-queue' }); } catch { return; }
    }
    const files = S.source.kind === 'video' ? [S.source.file] : S.source.files.slice();
    const item = { id: ++S.queueSeq, name: S.source.name, files, project: projectData(), range: renderRange(), format: fmt, quality: $('#videoQuality').value, dir, status: 'queued' };
    S.queue.push(item);
    log(`Queued ${item.name} (frames ${item.range[0] + 1}–${item.range[1] + 1}, ${(VIDEO_FORMATS[fmt] || STILL_FORMATS[fmt]).label})`);
    renderQueue();
  }
  /** Render every queued clip in turn: reload its media, restore its project, render, report. */
  async function runQueue() {
    if (S.queueRunning || S.rendering) return;
    S.queueRunning = true; renderQueue();
    const t0 = performance.now();
    let done = 0;
    for (const item of S.queue) {
      if (item.status === 'done') continue;
      item.status = 'loading'; renderQueue();
      S.pendingProject = item.project;
      const ok = await importFiles(item.files);
      if (!ok) { item.status = 'failed: could not open media'; renderQueue(); continue; }
      S.inMark = item.range[0]; S.outMark = item.range[1]; updateRangeLabel();
      $('#exportFormat').value = item.format; $('#videoQuality').value = item.quality; updateExportUI();
      item.status = 'rendering'; renderQueue();
      item.status = await renderSequence(item.dir ? 'folder' : 'zip', { dir: item.dir, quiet: true });
      if (item.status === 'done') done++;
      renderQueue();
      if (item.status === 'cancelled') break;
    }
    S.queueRunning = false; renderQueue();
    const msg = `Queue finished: ${done} of ${S.queue.length} clip${S.queue.length > 1 ? 's' : ''} rendered in ${((performance.now() - t0) / 1000).toFixed(1)} s`;
    log(msg); setMessage(msg, 100);
  }

  function thumbnail(canvas) {
    const s = Math.min(1, 560 / S.w), c = makeCanvas(Math.round(S.w * s), Math.round(S.h * s));
    c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.85);
  }
  function exportReport() {
    const frames = [...S.log.values()].sort((p, q) => p.frame - q.frame);
    const tot = frames.reduce((acc, s) => { acc.defects += s.defects; acc.rejected += s.rejected; acc.scratches += s.scratches; acc.px += s.repairedPixels; acc.ms += s.ms; return acc; }, { defects: 0, rejected: 0, scratches: 0, px: 0, ms: 0 });
    const p = getParams();
    const rows = frames.map((s) => `<tr><td>${s.frame + 1}</td><td>${escapeHtml(s.mode)}</td><td>${s.refFrames.map((r) => r + 1).join(', ') || '—'}</td><td>${s.defects}</td><td>${s.rejected}</td><td>${s.scratches}</td><td>${s.flicker.toFixed(1)}%</td><td>${s.motionConfidence == null ? '—' : Math.round(s.motionConfidence * 100) + '%'}</td><td>${s.registration ? `${s.registration.block.toFixed(2)} → ${s.registration.dense.toFixed(2)}` : '—'}</td><td>${Math.round(s.ms)} ms${s.accel === 'gpu' ? ' (GPU)' : ''}</td></tr>`).join('');
    const html = `<!doctype html><meta charset="utf-8"><title>Restoration report · ${escapeHtml(S.source.name)}</title>
<style>body{font:14px/1.45 system-ui,sans-serif;max-width:980px;margin:32px auto;padding:0 16px;color:#19212b}h1{font-size:22px}h2{font-size:16px;margin-top:28px}table{border-collapse:collapse;width:100%;font-size:13px}td,th{border:1px solid #ccd4dd;padding:5px 8px;text-align:left}th{background:#f1f4f8}.pair{display:grid;grid-template-columns:1fr 1fr;gap:12px}.pair img{width:100%;border:1px solid #ccd4dd}.kpi{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}.kpi div{border:1px solid #ccd4dd;border-radius:8px;padding:10px}.kpi b{display:block;font-size:20px}pre{white-space:pre-wrap;background:#f6f8fa;padding:10px;border-radius:6px}</style>
<h1>FrameRestore Studio restoration report</h1>
<p><b>Media:</b> ${escapeHtml(S.source.name)} · ${S.w}×${S.h} · ${S.total} frame(s) @ ${S.fps} fps · ${escapeHtml(S.source.format)}<br><b>Generated:</b> ${new Date().toLocaleString()} · engine ${E.VERSION} · ${escapeHtml($('#engineBadge').textContent)}</p>
<div class="kpi"><div><b>${frames.length}</b>frames restored</div><div><b>${tot.defects}</b>defects repaired</div><div><b>${tot.rejected}</b>repairs rejected in review</div><div><b>${tot.scratches}</b>scratch segments</div></div>
<h2>Frame ${S.frame + 1}: before and after</h2><div class="pair"><figure><img src="${thumbnail(origCanvas)}" alt="Original"><figcaption>Original</figcaption></figure><figure><img src="${thumbnail(compCanvas)}" alt="Restored"><figcaption>Restored</figcaption></figure></div>
${S.scan ? `<h2>Damage assessment</h2><table><tr><th>Shot</th><th>Frames</th><th>Weave (px)</th><th>Flicker</th><th>Damaged frames</th></tr>${assessment().map((r, k) => `<tr><td>${k + 1}</td><td>${r.start + 1}–${r.end + 1}</td><td>${r.weave.toFixed(2)}</td><td>${r.flicker.toFixed(1)}%</td><td>${r.suspects.map((f) => f + 1).join(', ') || '—'}</td></tr>`).join('')}</table>` : ''}
<h2>Settings</h2><table>${Object.entries(p).map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`).join('')}<tr><th>heal source</th><td>${escapeHtml($('#healMode').value)}</td></tr><tr><th>protect mask</th><td>${S.protect ? 'yes' : 'no'}; ${S.rois.length} tracked region(s)</td></tr><tr><th>shots</th><td>${S.bounds.length} (${S.shotParams.size} with their own settings; ${[...S.keys.values()].reduce((a, l) => a + l.length, 0)} keyframes, ${S.keyMode} curves)</td></tr><tr><th>rebuilt frames</th><td>${[...S.replaced].sort((a, b) => a - b).map((f) => f + 1).join(', ') || 'none'}</td></tr><tr><th>clip scan</th><td>${S.scan ? `${S.scan.cuts.size} scene cut(s) at frames ${[...S.scan.cuts].map((f) => f + 1).join(', ') || '—'}` : 'not run'}</td></tr></table>
<h2>Per-frame log</h2><table><tr><th>Frame</th><th>Detection</th><th>References</th><th>Defects</th><th>Rejected</th><th>Scratches</th><th>Flicker corr.</th><th>Motion conf.</th><th>Alignment error (block → dense)</th><th>Time</th></tr>${rows || '<tr><td colspan="10">No frames restored yet</td></tr>'}</table>
<h2>Manual work</h2><p>Frames with heal / Click&amp;Fix marks: ${[...S.heal.keys()].map((f) => f + 1).join(', ') || 'none'}<br>Frames with history-brush reverts: ${[...S.revert.keys()].map((f) => f + 1).join(', ') || 'none'}<br>Frames with clone/blur/paint edits: ${[...S.paint.keys()].map((f) => f + 1).join(', ') || 'none'}</p>
<h2>Notes</h2><pre>${escapeHtml($('#notes').value || 'None')}</pre>
<h2>History</h2><ol>${S.history.slice().reverse().map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ol>`;
    download(new Blob([html], { type: 'text/html' }), `${baseName()}_report.html`);
    log('Exported HTML report');
  }

  // ------------------------------------------------------------------ project files
  function projectData() {
    const enc = (m) => Object.fromEntries([...m.entries()].map(([k, v]) => [k, v]));
    return {
      app: 'FrameRestore Studio', format: 3, version: E.VERSION, savedAt: new Date().toISOString(),
      media: S.source ? { name: S.source.name, kind: S.source.kind, width: S.w, height: S.h, total: S.total, fps: S.fps, frame: S.frame } : null,
      preset: $('#preset').value, params: getParams(), healMode: $('#healMode').value, autoRestore: $('#autoRestore').checked,
      notes: $('#notes').value, pins: S.pins, inMark: S.inMark, outMark: S.outMark,
      protect: S.protect ? IO.encodeMask(S.protect) : null,
      heal: Object.fromEntries([...S.heal.entries()].map(([f, m]) => [f, IO.encodeMask(m)])),
      rejects: enc(S.rejects),
      paint: Object.fromEntries([...S.paint.entries()].map(([f, c]) => [f, c.toDataURL('image/png')])),
      hints: Object.fromEntries([...S.hints.entries()].map(([f, c]) => [f, c.toDataURL('image/png')])),
      revert: Object.fromEntries([...S.revert.entries()].map(([f, m]) => [f, IO.encodeMask(m)])),
      globalParams: S.globalParams, shotParams: [...S.shotParams.entries()], splits: [...S.splits], replaced: [...S.replaced], rois: serializeRois(),
      keys: snapshotKeys(), keyMode: S.keyMode,
      scan: S.scan ? { means: Array.from(S.scan.means), cuts: [...S.scan.cuts], motions: S.scan.motions, chist: S.scan.chist ? S.scan.chist.map((hh) => (hh ? Array.from(hh) : null)) : null, suspects: S.scan.suspects || [] } : null,
      history: S.history,
    };
  }
  function saveProject() {
    if (!S.source) return;
    download(new Blob([JSON.stringify(projectData())], { type: 'application/json' }), `${baseName()}.frs3.json`);
    log('Saved project');
  }
  function applyProject(p, withMedia) {
    const params = p.globalParams || p.params || p.settings || {};
    setParams(Object.assign({}, BASE, params)); S.lastParams = getParams(); S.globalParams = getParams();
    if (p.preset && [...$('#preset').options].some((o) => o.value === p.preset)) $('#preset').value = p.preset;
    if (p.healMode) $('#healMode').value = p.healMode;
    if (typeof p.autoRestore === 'boolean') $('#autoRestore').checked = p.autoRestore;
    if (typeof p.notes === 'string') $('#notes').value = p.notes;
    if (!withMedia) return;
    const m = p.media;
    if (m && (m.width !== S.w || m.height !== S.h)) { setMessage(`Project was made for ${m.width}×${m.height}; masks and edits were not applied`); return; }
    if (m && m.fps && S.source.kind !== 'image') { S.fps = m.fps; S.source.setFps(m.fps); S.total = S.source.total || S.total; updateSourceInfo(); }
    S.pins = Array.isArray(p.pins) ? p.pins : [];
    S.inMark = p.inMark ?? null; S.outMark = p.outMark ?? null;
    if (p.protect) { S.protect = IO.decodeMask(p.protect, S.w * S.h); S.protectVersion++; rebuildProtectCanvas(); }
    for (const [f, enc] of Object.entries(p.heal || {})) S.heal.set(+f, IO.decodeMask(enc, S.w * S.h));
    for (const [f, list] of Object.entries(p.rejects || {})) S.rejects.set(+f, list);
    for (const [f, enc] of Object.entries(p.revert || {})) S.revert.set(+f, IO.decodeMask(enc, S.w * S.h));
    if (p.scan && p.scan.means && p.scan.means.length === S.total) S.scan = { means: Float32Array.from(p.scan.means), cuts: new Set(p.scan.cuts), motions: p.scan.motions || null, chist: p.scan.chist ? p.scan.chist.map((hh) => (hh ? Float32Array.from(hh) : null)) : null, suspects: p.scan.suspects || [] };
    S.keys = new Map(p.keys || []); if (p.keyMode) { S.keyMode = p.keyMode; $('#keyMode').value = p.keyMode; }
    if (p.globalParams) S.globalParams = p.globalParams;
    S.shotParams = new Map(p.shotParams || []); S.splits = new Set(p.splits || []); S.replaced = new Set(p.replaced || []);
    S.rois = deserializeRois(p.rois); S.roiSeq = S.rois.reduce((m, r) => Math.max(m, r.id), 0); S.protectVersion++;
    rebuildBounds(); S.loadedShot = -1; renderRoiList(); renderAssessment(); S.levelsCache.clear();
    const hintLoads = Object.entries(p.hints || {}).map(([f, url]) => new Promise((res) => {
      const img = new Image();
      img.onload = () => { const c = makeCanvas(S.w, S.h); c.getContext('2d').drawImage(img, 0, 0); S.hints.set(+f, c); S.hintPix.delete(+f); res(); };
      img.onerror = () => res();
      img.src = url;
    }));
    const loads = Object.entries(p.paint || {}).map(([f, url]) => new Promise((res) => {
      const img = new Image();
      img.onload = () => { getLayer(+f, true).getContext('2d').drawImage(img, 0, 0); if (+f === S.frame) rebuildComposite(); res(); };
      img.onerror = () => res();
      img.src = url;
    }));
    if (Array.isArray(p.history)) { S.history = p.history.concat(S.history).slice(0, 60); }
    updateRangeLabel();
    log(`Project restored (${S.heal.size} healed, ${Object.keys(p.paint || {}).length} painted, ${S.rejects.size} reviewed frames)`);
    return Promise.all([...loads, ...hintLoads]);
  }
  async function openProject(file) {
    try {
      const p = JSON.parse(await file.text());
      if (!p || (p.app !== 'FrameRestore Studio' && !p.settings && !p.params)) throw new Error('not a FrameRestore Studio project');
      if (S.source && p.media && p.media.width === S.w && p.media.height === S.h) { await applyProject(p, true); S.results.clear(); await goToFrame(p.media.frame || 0); setMessage('Project opened'); }
      else { applyProject(p, false); S.pendingProject = p; setMessage(`Project settings loaded. Import ${p.media ? p.media.name : 'the original media'} to restore masks and edits.`); }
    } catch (err) { setMessage('Could not open project: ' + err.message); }
  }

  // ------------------------------------------------------------------ wiring
  function selectTool(t) {
    S.tool = t; S.cloneOffset = null;
    for (const b of $$('[data-tool]')) b.classList.toggle('active', b.dataset.tool === t);
    display.style.cursor = t === 'pan' ? 'grab' : isBrushTool(t) ? 'none' : t === 'review' ? 'pointer' : 'crosshair';
    if ((t === 'roi' || t === 'fix') && (S.view === 'original' || S.view === 'output' || S.view === 'difference')) selectView('restored');
    if (t === 'review' && S.view !== 'defects' && S.view !== 'restored') selectView('restored');
    requestDraw();
  }
  function selectView(v) {
    S.view = v;
    for (const b of $$('[data-view]')) b.classList.toggle('active', b.dataset.view === v);
    requestDraw();
  }
  function applyPreset(name) {
    const p = PRESETS[name]; if (!p) return;
    setParams(Object.assign({}, BASE, p)); store.set('params', getParams());
    commitParams(`Preset: ${$('#preset').selectedOptions[0].text}`);
    log(`Applied preset ${$('#preset').selectedOptions[0].text}`);
    if (S.source) requestProcess();
  }

  $('#importBtn').onclick = () => $('#mediaInput').click();
  $('#folderBtn').onclick = () => $('#folderInput').click();
  $('#openProjectBtn').onclick = () => $('#projectInput').click();
  $('#saveProjectBtn').onclick = saveProject;
  $('#helpBtn').onclick = () => $('#helpDialog').showModal();
  $('#mediaInput').onchange = (e) => { importFiles(e.target.files); e.target.value = ''; };
  $('#folderInput').onchange = (e) => { importFiles(e.target.files); e.target.value = ''; };
  $('#projectInput').onchange = (e) => { if (e.target.files[0]) openProject(e.target.files[0]); e.target.value = ''; };
  $('#restoreBtn').onclick = () => { S.results.delete(S.frame); requestProcess(); };
  $('#scanBtn').onclick = scanClip;
  $('#cancelBtn').onclick = () => { S.cancel = true; };
  $('#preset').onchange = (e) => applyPreset(e.target.value);
  $('#autoRestore').onchange = (e) => { store.set('autoRestore', e.target.checked); if (e.target.checked) requestProcess(); };
  $('#healMode').onchange = () => { if (S.heal.size) requestProcess(); };
  $('#transferSelect').onchange = (e) => {
    if (!S.source || !S.source.setTransfer) return;
    S.source.setTransfer(e.target.value);
    S.gen++; S.raw.clear(); S.results.clear(); S.hist.clear(); S.log.clear(); S.prior.clear(); S.fillCache.clear(); engine.reset();
    updateSourceInfo(); log(`Source transfer: ${S.source.transfer}`);
    goToFrame(S.frame);
  };
  $('#chromaAlign').addEventListener('change', () => { $('#chromaLocal').disabled = !$('#chromaAlign').checked; });
  $('#fpsSelect').onchange = (e) => {
    if (!S.source) return;
    const v = e.target.value === 'auto' ? S.source.detectedFps || 24 : +e.target.value;
    S.fps = v; S.source.setFps(v); store.set('fps', v);
    if (S.source.kind === 'video') {
      S.gen++; S.total = S.source.total; S.raw.clear(); S.results.clear(); S.hist.clear(); S.log.clear(); S.scan = null; S.prior.clear(); engine.reset(); rebuildBounds();
      $('#frameSlider').max = S.total - 1; $('#frameInput').max = S.total; $('#totalLabel').textContent = '/ ' + S.total;
      if (S.paint.size || S.heal.size || S.rejects.size) setMessage('Frame rate changed: per-frame edits now refer to different frames', 0);
    }
    updateSourceInfo(); updateTimecode(); updateRangeLabel(); log(`Frame rate set to ${v} fps`);
    goToFrame(Math.min(S.frame, S.total - 1));
  };
  for (const id of [...NUM_PARAMS, ...BOOL_PARAMS, ...SELECT_PARAMS]) {
    const el = $('#' + id);
    el.addEventListener('input', onParamInput);
    el.addEventListener('change', () => { onParamInput(); commitParams(`Changed ${id}`); });
  }
  $('#brushSize').addEventListener('input', () => { syncOutputs(); requestDraw(); });
  for (const b of $$('[data-tool]')) b.onclick = () => selectTool(b.dataset.tool);
  for (const b of $$('[data-view]')) b.onclick = () => selectView(b.dataset.view);
  $('#zoomFitBtn').onclick = fitView;
  $('#zoom100Btn').onclick = () => zoomCenter(1);
  $('#undoBtn').onclick = () => undoRedo(false);
  $('#redoBtn').onclick = () => undoRedo(true);
  $('#firstBtn').onclick = () => goToFrame(0);
  $('#prevBtn').onclick = () => goToFrame(S.frame - 1);
  $('#nextBtn').onclick = () => goToFrame(S.frame + 1);
  $('#playBtn').onclick = togglePlay;
  $('#frameSlider').oninput = (e) => goToFrame(+e.target.value, { process: false });
  $('#frameSlider').onchange = (e) => goToFrame(+e.target.value);
  $('#frameInput').onchange = (e) => goToFrame((+e.target.value || 1) - 1);
  const mark = (which) => {
    const key = which === 'in' ? 'inMark' : 'outMark';
    S[key] = S[key] === S.frame ? null : S.frame;
    log(S[key] == null ? `Cleared ${which}-point` : `${which === 'in' ? 'In' : 'Out'}-point at frame ${S.frame + 1}`);
    updateRangeLabel();
  };
  $('#markInBtn').onclick = () => mark('in');
  $('#markOutBtn').onclick = () => mark('out');
  $('#exportPngBtn').onclick = exportFrame;
  $('#exportFormat').onchange = updateExportUI;
  $('#replaceBtn').onclick = toggleReplace;
  $('#queueAddBtn').onclick = addToQueue;
  $('#queueRunBtn').onclick = runQueue;
  $('#queueList').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-q]');
    if (!li || !(e.target.dataset && e.target.dataset.act === 'del') || S.queueRunning) return;
    S.queue = S.queue.filter((q) => q.id !== +li.dataset.q); renderQueue();
  });
  $('#keyBtn').onclick = toggleKey;
  $('#keyPrevBtn').onclick = () => jumpKey(-1);
  $('#keyNextBtn').onclick = () => jumpKey(1);
  $('#keyMode').onchange = (e) => { pushUndo({ type: 'keys', before: snapshotKeys(), label: 'Keyframe curve' }); S.keyMode = e.target.value; afterKeysChanged(); };
  $('#rebuildSuspectsBtn').onclick = rebuildSuspects;
  $('#assessment').addEventListener('click', (e) => { const t = e.target.closest('[data-goto]'); if (!t) return; e.preventDefault(); goToFrame(+t.dataset.goto); });
  $('#splitBtn').onclick = toggleSplit;
  $('#shotCustom').onchange = (e) => setShotCustom(e.target.checked);
  $('#roiList').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-roi]'); if (!li) return;
    const roi = S.rois.find((r) => r.id === +li.dataset.roi); if (!roi) return;
    const act = e.target.dataset && e.target.dataset.act;
    if (act === 'del') { pushUndo({ type: 'rois', before: serializeRois(), label: 'Delete region' }); S.rois = S.rois.filter((r) => r !== roi); S.protectVersion++; renderRoiList(); drawScan(); requestProcess(); log(`Deleted ${roi.name}`); return; }
    if (act === 'track') { trackRoi(roi); return; }
    if (act === 'kind' || act === 'span') {
      pushUndo({ type: 'rois', before: serializeRois(), label: act === 'kind' ? 'Region kind' : 'Region span' });
      if (act === 'kind') roi.kind = roi.kind === 'repair' ? 'protect' : 'repair';
      else { roi.shotStart = 0; roi.shotEnd = S.total - 1; }
      S.protectVersion++; S.fillCache.clear(); renderRoiList(); drawScan(); requestProcess();
      log(act === 'kind' ? `${roi.name} is now a ${roi.kind} region` : `${roi.name} now spans the whole clip`);
      return;
    }
    S.selectedRoi = roi.id; renderRoiList();
    if (S.frame < roi.shotStart || S.frame > roi.shotEnd) goToFrame(roi.shotStart);
    requestDraw();
  });
  $('#useGPU').onchange = async (e) => { await engine.setGPU(e.target.checked); log(`GPU acceleration ${e.target.checked ? 'on' : 'off'}${engine.gpuName ? ` (${engine.gpuName})` : ''}`); S.results.clear(); if (S.source) requestProcess(); };
  $('#exportFolderBtn').onclick = () => renderSequence('folder');
  $('#exportZipBtn').onclick = () => renderSequence('zip');
  $('#exportReportBtn').onclick = exportReport;
  $('#clearProtectBtn').onclick = () => { if (!S.protect) return; pushUndo({ type: 'protect', before: S.protect, label: 'Clear protect' }); S.protect = null; S.protectVersion++; rebuildProtectCanvas(); log('Cleared protect mask'); requestProcess(); };
  $('#clearFrameEditsBtn').onclick = () => {
    const f = S.frame;
    if (S.paint.has(f)) { pushUndo({ type: 'paint', frame: f, before: ctx2d(S.paint.get(f)).getImageData(0, 0, S.w, S.h), label: 'Clear paint' }); S.paint.delete(f); }
    if (S.heal.has(f)) { pushUndo({ type: 'heal', frame: f, before: S.heal.get(f), label: 'Clear heal' }); S.heal.delete(f); bumpVersion(f); }
    if (S.rejects.has(f)) { pushUndo({ type: 'rejects', frame: f, before: S.rejects.get(f), label: 'Clear review' }); S.rejects.delete(f); bumpVersion(f); }
    S.pins = S.pins.filter((p) => p.frame !== f); S._healOverlay = null;
    log(`Cleared edits on frame ${f + 1}`); rebuildComposite(); requestProcess();
  };
  $('#defectList').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-k]'); if (!li) return;
    const c = S.shown.res.components[+li.dataset.k];
    if (e.target.tagName === 'INPUT') { toggleComponent(c); return; }
    const { w, h } = stageSize(), z = Math.max(S.zoom, Math.min(8, Math.min(w, h) / (Math.max(c.w, c.h) * 6)));
    S.zoom = z; S.panX = w / 2 - c.cx * z; S.panY = h / 2 - c.cy * z; S.fitMode = false;
    if (S.view !== 'defects' && S.view !== 'split') selectView('defects');
    requestDraw();
  });
  $('#acceptAllBtn').onclick = () => setRejects(S.frame, [], 'Accepted all repairs');
  $('#rejectAllBtn').onclick = () => setRejects(S.frame, S.shown.res.components.map((c) => ({ x: Math.round(c.cx), y: Math.round(c.cy) })), 'Rejected all repairs');
  $('#notes').addEventListener('input', () => store.set('notes', $('#notes').value));

  const stage = $('#stage');
  stage.addEventListener('dragover', (e) => { e.preventDefault(); stage.classList.add('drag-over'); });
  stage.addEventListener('dragleave', () => stage.classList.remove('drag-over'));
  stage.addEventListener('drop', async (e) => {
    e.preventDefault(); stage.classList.remove('drag-over');
    const items = [...(e.dataTransfer.items || [])];
    let files = items.length && items[0].webkitGetAsEntry ? await readDroppedEntries(items) : [...e.dataTransfer.files];
    const proj = files.find((f) => /\.json$/i.test(f.name));
    if (proj && files.length === 1) { openProject(proj); return; }
    files = files.filter((f) => !/\.json$/i.test(f.name));
    importFiles(files);
  });

  window.addEventListener('keydown', (e) => {
    if ($('#helpDialog').open) return;
    const k = e.key, mod = e.ctrlKey || e.metaKey;
    if (mod && k.toLowerCase() === 'z') { e.preventDefault(); undoRedo(e.shiftKey); return; }
    if (mod && k.toLowerCase() === 'y') { e.preventDefault(); undoRedo(true); return; }
    if (mod && k.toLowerCase() === 's') { e.preventDefault(); saveProject(); return; }
    if (mod && k.toLowerCase() === 'o') { e.preventDefault(); $('#mediaInput').click(); return; }
    if (isTyping(e) || mod || e.altKey) return;
    if (k === '?') { $('#helpDialog').showModal(); return; }
    if (!S.source) return;
    const tools = { v: 'pan', d: 'review', h: 'heal', c: 'clone', b: 'blur', p: 'paint', e: 'erase', m: 'protect', n: 'note', x: 'fix', y: 'revert', g: 'roi', q: 'colorize' };
    const views = { 1: 'restored', 2: 'original', 3: 'split', 4: 'difference', 5: 'defects', 6: 'output', 7: 'confidence' };
    if (k === ' ') { e.preventDefault(); if (!e.repeat) { S.spaceDown = true; S.spaceUsed = false; display.style.cursor = 'grab'; } return; }
    if (k === 'ArrowLeft' || k === 'ArrowRight') { e.preventDefault(); if (!S.rendering) goToFrame(S.frame + (k === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 10 : 1)); return; }
    if (k === 'Home' || k === 'End') { e.preventDefault(); if (!S.rendering) goToFrame(k === 'Home' ? 0 : S.total - 1); return; }
    if (k === '\\') { S.flip = true; requestDraw(); return; }
    const lk = k.toLowerCase();
    if (tools[lk]) selectTool(tools[lk]);
    else if (views[k]) selectView(views[k]);
    else if (lk === 'r') { S.results.delete(S.frame); requestProcess(); }
    else if (lk === 'f') fitView();
    else if (k === '0') zoomCenter(1);
    else if (k === '+' || k === '=') zoomCenter(S.zoom * 1.25);
    else if (k === '-' || k === '_') zoomCenter(S.zoom / 1.25);
    else if (k === '[' || k === ']') { const el = $('#brushSize'); el.value = clampInt(+el.value * (k === ']' ? 1.2 : 1 / 1.2) + (k === ']' ? 1 : -1), +el.min, +el.max); syncOutputs(); requestDraw(); }
    else if (lk === 'j') toggleReplace();
    else if (lk === 's') toggleSplit();
    else if (lk === 'k') toggleKey();
    else if (k === ',' || k === '.') jumpKey(k === '.' ? 1 : -1);
    else if (lk === 'i') mark('in');
    else if (lk === 'o') mark('out');
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === ' ') { S.spaceDown = false; if (!S.spaceUsed && !isTyping(e) && S.source) togglePlay(); display.style.cursor = ''; }
    if (e.key === '\\') { S.flip = false; requestDraw(); }
  });
  window.addEventListener('blur', () => { S.spaceDown = false; S.flip = false; });
  window.addEventListener('beforeunload', (e) => { if (S.paint.size || S.heal.size || S.rejects.size || S.protect) { e.preventDefault(); e.returnValue = ''; } });

  // ------------------------------------------------------------------ startup
  setParams(Object.assign({}, BASE, store.get('params', {})));
  S.lastParams = getParams(); S.globalParams = getParams();
  renderRoiList(); renderAssessment(); renderQueue();
  $('#autoRestore').checked = store.get('autoRestore', true);
  $('#notes').value = store.get('notes', '');
  $('#exportFormat').value = store.get('exportFormat', 'png16');
  if (!$('#exportFormat').value) $('#exportFormat').value = 'png16';
  $('#useGPU').checked = store.get('gpu', true);
  updateExportUI();
  $('#preset').value = 'custom';
  engine.ready = engine.init();
  drawScan();
  window.FRS = { state: S, E, IO, colorHintsFor, fillRepairs, addToQueue, runQueue, paramsFor, toggleKey, rebuildSuspects, assessment, stabCorrection, outputData, clickFix, trackRoi, toggleReplace, toggleSplit, setShotCustom, importFiles, goToFrame, requestProcess, getParams, setParams: (p) => { setParams(p); storeParamsFromUI(); }, renderSequence, exportReport, saveProject, projectData, engine };
})();
