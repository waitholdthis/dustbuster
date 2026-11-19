// Tests for DPX/TIFF decoding, ZIP writing and mask encoding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';

const require = createRequire(import.meta.url);
const IO = require('../src/io.js');
import { writeFileSync } from 'node:fs';

function makeDPX({ width, height, bits, packing = 1, le = false, pixel }) {
  const comps = 3, header = 2048;
  let body;
  if (bits === 10) {
    const words = width * height;
    body = new DataView(new ArrayBuffer(words * 4));
    for (let i = 0; i < words; i++) {
      const [r, g, b] = pixel(i);
      body.setUint32(i * 4, packing === 1 ? ((r << 22) | (g << 12) | (b << 2)) >>> 0 : ((r << 20) | (g << 10) | b) >>> 0, le);
    }
  } else if (bits === 16) {
    body = new DataView(new ArrayBuffer(width * height * comps * 2));
    for (let i = 0; i < width * height; i++) pixel(i).forEach((v, c) => body.setUint16((i * 3 + c) * 2, v, le));
  } else {
    const row = Math.ceil((width * comps) / 4) * 4;
    body = new DataView(new ArrayBuffer(row * height));
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixel(y * width + x).forEach((v, c) => body.setUint8(y * row + x * 3 + c, v));
  }
  const buf = new ArrayBuffer(header + body.byteLength), dv = new DataView(buf);
  dv.setUint32(0, 0x53445058, le); dv.setUint32(4, header, le);
  dv.setUint32(772, width, le); dv.setUint32(776, height, le);
  dv.setUint8(800, 50); dv.setUint8(803, bits); dv.setUint16(804, packing, le); dv.setUint16(806, 0, le); dv.setUint32(808, header, le);
  new Uint8Array(buf).set(new Uint8Array(body.buffer), header);
  return buf;
}

test('DPX 10-bit method A big-endian, method B little-endian, 8 and 16 bit', () => {
  const w = 5, h = 3, px10 = (i) => [i * 60 % 1024, 1023 - i * 40, 512];
  for (const [packing, le] of [[1, false], [2, true]]) {
    const img = IO.decodeDPX(makeDPX({ width: w, height: h, bits: 10, packing, le, pixel: px10 }));
    assert.equal(img.width, w); assert.equal(img.height, h); assert.equal(img.bitDepth, 10);
    for (let i = 0; i < w * h; i++) {
      const e = px10(i).map((v) => Math.round((v * 65535) / 1023));
      assert.deepEqual([img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2], img.data[i * 4 + 3]], [...e, 65535]);
    }
  }
  const img16 = IO.decodeDPX(makeDPX({ width: 3, height: 2, bits: 16, le: true, pixel: (i) => [i * 10000, 65535, 0] }));
  assert.equal(img16.data[4], 10000, '16-bit DPX keeps full precision');
  const img8 = IO.decodeDPX(makeDPX({ width: 3, height: 2, bits: 8, pixel: (i) => [i, 100, 200] }));
  assert.deepEqual(Array.from(img8.data.slice(12, 16)), [3 * 257, 100 * 257, 200 * 257, 65535]);
  assert.throws(() => IO.decodeDPX(new ArrayBuffer(4096)), /Not a DPX/);
});

function makeTIFF({ width, height, spp = 3, compression = 1, predictor = 1, strip }) {
  const entries = [[256, 3, 1, width], [257, 3, 1, height], [258, 3, 1, 8], [259, 3, 1, compression], [262, 3, 1, spp >= 3 ? 2 : 1],
    [273, 4, 1, 0], [277, 3, 1, spp], [278, 3, 1, height], [279, 4, 1, strip.length], [317, 3, 1, predictor]];
  const ifdSize = 2 + entries.length * 12 + 4, dataOff = 8 + ifdSize;
  const buf = new ArrayBuffer(dataOff + strip.length), dv = new DataView(buf);
  dv.setUint16(0, 0x4949, false); dv.setUint16(2, 42, true); dv.setUint32(4, 8, true); dv.setUint16(8, entries.length, true);
  entries.forEach(([tag, type, n, v], k) => {
    const e = 10 + k * 12;
    dv.setUint16(e, tag, true); dv.setUint16(e + 2, type, true); dv.setUint32(e + 4, n, true);
    const val = tag === 273 ? dataOff : v;
    if (type === 3) dv.setUint16(e + 8, val, true); else dv.setUint32(e + 8, val, true);
  });
  new Uint8Array(buf).set(strip, dataOff);
  return buf;
}

function lzwEncode(data) {
  const out = [];
  let bitBuf = 0, bitLen = 0, codeLen = 9;
  const emit = (code) => { bitBuf = (bitBuf << codeLen) | code; bitLen += codeLen; while (bitLen >= 8) { out.push((bitBuf >>> (bitLen - 8)) & 255); bitLen -= 8; } bitBuf &= (1 << bitLen) - 1; };
  let dict = new Map(), next = 258;
  emit(256);
  let w = String.fromCharCode(data[0]);
  for (let i = 1; i < data.length; i++) {
    const c = String.fromCharCode(data[i]), wc = w + c;
    if ((wc.length === 1) || dict.has(wc)) { w = wc; continue; }
    emit(w.length === 1 ? w.charCodeAt(0) : dict.get(w));
    dict.set(wc, next++);
    // TIFF 'early change': the decoder widens one entry later than it adds, so widen at next == 2^n.
    if (next >= 1 << codeLen && codeLen < 12) codeLen++;
    if (next >= 4093) { emit(256); dict = new Map(); next = 258; codeLen = 9; }
    w = c;
  }
  emit(w.length === 1 ? w.charCodeAt(0) : dict.get(w));
  emit(257);
  if (bitLen) out.push((bitBuf << (8 - bitLen)) & 255);
  return new Uint8Array(out);
}

test('TIFF uncompressed, PackBits, and LZW with horizontal predictor', () => {
  const w = 17, h = 9, raw = new Uint8Array(w * h * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 7 + ((i / 51) | 0) * 13) & 255;
  const check = (img) => { for (let i = 0; i < w * h; i++) assert.deepEqual(Array.from(img.data.slice(i * 4, i * 4 + 3)), Array.from(raw.slice(i * 3, i * 3 + 3), (v) => v * 257)); };
  check(IO.decodeTIFF(makeTIFF({ width: w, height: h, strip: raw })));
  const pb = []; for (let i = 0; i < raw.length; i += 100) { const chunk = raw.slice(i, i + 100); pb.push(chunk.length - 1, ...chunk); }
  check(IO.decodeTIFF(makeTIFF({ width: w, height: h, compression: 32773, strip: new Uint8Array(pb) })));
  const diff = new Uint8Array(raw);
  for (let y = 0; y < h; y++) for (let x = w - 1; x >= 1; x--) for (let c = 0; c < 3; c++) { const o = (y * w + x) * 3 + c; diff[o] = (raw[o] - raw[o - 3]) & 255; }
  check(IO.decodeTIFF(makeTIFF({ width: w, height: h, compression: 5, predictor: 2, strip: lzwEncode(diff) })));
  const big = new Uint8Array(20000).map((_, i) => (i * 31) % 251);
  assert.deepEqual(IO.lzwDecode(lzwEncode(big), big.length), big, 'LZW survives code-width growth and dictionary resets');
});

function hasFfmpeg() { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } }

function decodePNG(buf) {
  let p = 8, width, height, idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8), d = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { width = d.readUInt32BE(0); height = d.readUInt32BE(4); assert.equal(d[8], 8); assert.equal(d[9], 2); }
    if (type === 'IDAT') idat.push(d);
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat)), bpp = 3, stride = width * bpp, out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x], a = x >= bpp ? out[y * stride + x - bpp] : 0, b = y ? out[(y - 1) * stride + x] : 0, c = x >= bpp && y ? out[(y - 1) * stride + x - bpp] : 0;
      let pr = 0;
      if (f === 1) pr = a; else if (f === 2) pr = b; else if (f === 3) pr = (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[y * stride + x] = (v + pr) & 255;
    }
  }
  return { width, height, data: out };
}

test('decodes real DPX and TIFF files written by ffmpeg', { skip: !hasFfmpeg() && 'ffmpeg not installed' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'frs-io-'));
  try {
    // Build an RGB reference first so every format below is converted from identical pixels.
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=96x54', '-frames:v', '1', '-y', '-pix_fmt', 'rgb24', join(dir, 'ref.png')]);
    const src = ['-v', 'error', '-i', join(dir, 'ref.png'), '-y'];
    execFileSync('ffmpeg', [...src, '-pix_fmt', 'gbrp10le', join(dir, 'f10.dpx')]);
    execFileSync('ffmpeg', [...src, '-pix_fmt', 'rgb48le', join(dir, 'f16.dpx')]);
    execFileSync('ffmpeg', [...src, '-pix_fmt', 'rgb24', '-compression_algo', 'lzw', join(dir, 'lzw.tif')]);
    execFileSync('ffmpeg', [...src, '-pix_fmt', 'rgb48le', '-compression_algo', 'raw', join(dir, 'raw16.tif')]);
    const ref = decodePNG(readFileSync(join(dir, 'ref.png')));
    for (const [file, decode, tol] of [['f10.dpx', IO.decodeDPX, 1], ['f16.dpx', IO.decodeDPX, 1], ['lzw.tif', IO.decodeTIFF, 0], ['raw16.tif', IO.decodeTIFF, 1]]) {
      const b = readFileSync(join(dir, file));
      const img = decode(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
      assert.equal(img.width, ref.width, file); assert.equal(img.height, ref.height, file);
      let worst = 0;
      for (let i = 0; i < ref.width * ref.height; i++) for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(Math.round(img.data[i * 4 + c] / 257) - ref.data[i * 3 + c]));
      assert.ok(worst <= tol, `${file}: max deviation ${worst}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ZIP writer produces a structurally valid archive with correct CRCs', () => {
  const files = [{ name: 'frame_000001.png', data: new Uint8Array([1, 2, 3]) }, { name: 'b.txt', data: new TextEncoder().encode('hello') }];
  const parts = IO.zipStoreParts(files, new Date(2024, 0, 2, 3, 4, 6));
  const zip = Buffer.concat(parts.map((p) => Buffer.from(p)));
  const eocd = zip.length - 22;
  assert.equal(zip.readUInt32LE(eocd), 0x06054b50);
  assert.equal(zip.readUInt16LE(eocd + 10), 2);
  let cd = zip.readUInt32LE(eocd + 16);
  for (const f of files) {
    assert.equal(zip.readUInt32LE(cd), 0x02014b50);
    const crc = zip.readUInt32LE(cd + 16), size = zip.readUInt32LE(cd + 24), nameLen = zip.readUInt16LE(cd + 28), local = zip.readUInt32LE(cd + 42);
    assert.equal(zip.toString('utf8', cd + 46, cd + 46 + nameLen), f.name);
    assert.equal(crc, IO.crc32(f.data)); assert.equal(size, f.data.length);
    assert.equal(zip.readUInt32LE(local), 0x04034b50);
    const ln = zip.readUInt16LE(local + 26);
    assert.deepEqual(new Uint8Array(zip.subarray(local + 30 + ln, local + 30 + ln + size)), f.data);
    cd += 46 + nameLen;
  }
  assert.equal(IO.crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('mask RLE round-trips and natural sort orders frame numbers', () => {
  const m = new Uint8Array(1000); m.fill(1, 10, 50); m.fill(1, 999);
  assert.deepEqual(IO.decodeMask(IO.encodeMask(m), 1000), m);
  assert.deepEqual(IO.decodeMask(IO.encodeMask(new Uint8Array(5)), 5), new Uint8Array(5));
  assert.deepEqual(['f10.dpx', 'f9.dpx', 'f100.dpx'].sort(IO.naturalCompare), ['f9.dpx', 'f10.dpx', 'f100.dpx']);
});

function gradient16(w, h) {
  const img = new Uint16Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const j = (y * w + x) * 4;
    img[j] = (x * 65535) / (w - 1); img[j + 1] = (y * 65535) / (h - 1); img[j + 2] = ((x * 977 + y * 131) * 37) % 65536; img[j + 3] = 65535;
  }
  return img;
}
const toBuf = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

test('16-bit TIFF and 10-bit DPX encoders round-trip through the decoders', () => {
  const w = 37, h = 23, img = gradient16(w, h);
  const tif = IO.decodeTIFF(toBuf(IO.encodeTIFF(w, h, img)));
  assert.equal(tif.bitDepth, 16); assert.deepEqual(tif.data, img);
  const dpx = IO.decodeDPX(toBuf(IO.encodeDPX(w, h, img, { name: 'x.dpx', fps: 24 })));
  assert.equal(dpx.bitDepth, 10);
  let worst = 0; for (let i = 0; i < img.length; i++) if (i % 4 !== 3) worst = Math.max(worst, Math.abs(dpx.data[i] - img[i]));
  assert.ok(worst <= 33, `10-bit quantisation error ${worst} (max allowed 32.5 of 65535)`);
});

test('PNG encoder writes 16-bit and 8-bit files', async () => {
  const w = 33, h = 17, img = gradient16(w, h);
  for (const depth of [16, 8]) {
    const png = Buffer.from(await IO.encodePNG(w, h, img, depth));
    assert.equal(png.readUInt32BE(0), 0x89504e47); assert.equal(png[24], depth); assert.equal(png[25], 2);
    let p = 8, idat = [];
    while (p < png.length) { const len = png.readUInt32BE(p), type = png.toString('ascii', p + 4, p + 8); assert.equal(IO.crc32(png.subarray(p + 4, p + 8 + len)), png.readUInt32BE(p + 8 + len), `${type} crc`); if (type === 'IDAT') idat.push(png.subarray(p + 8, p + 8 + len)); p += 12 + len; }
    const raw = inflateSync(Buffer.concat(idat)), bpp = depth === 16 ? 6 : 3, stride = w * bpp;
    let worst = 0;
    for (let y = 0; y < h; y++) {
      assert.equal(raw[y * (stride + 1)], 1);
      const row = Buffer.alloc(stride);
      for (let x = 0; x < stride; x++) row[x] = (raw[y * (stride + 1) + 1 + x] + (x >= bpp ? row[x - bpp] : 0)) & 255;
      for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) {
        const v = depth === 16 ? row.readUInt16BE(x * 6 + c * 2) : row[x * 3 + c] * 257;
        worst = Math.max(worst, Math.abs(v - img[(y * w + x) * 4 + c]));
      }
    }
    assert.ok(depth === 16 ? worst === 0 : worst <= 129, `depth ${depth} error ${worst}`);
  }
});

test('ffmpeg reads our 16-bit PNG, 16-bit TIFF and 10-bit DPX', { skip: !hasFfmpeg() && 'ffmpeg not installed' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'frs-enc-'));
  try {
    const w = 48, h = 30, img = gradient16(w, h);
    writeFileSync(join(dir, 'a.png'), await IO.encodePNG(w, h, img, 16));
    writeFileSync(join(dir, 'a.tif'), IO.encodeTIFF(w, h, img));
    writeFileSync(join(dir, 'a.dpx'), IO.encodeDPX(w, h, img));
    for (const [f, tol] of [['a.png', 0], ['a.tif', 0], ['a.dpx', 64]]) {
      const out = execFileSync('ffmpeg', ['-v', 'error', '-i', join(dir, f), '-f', 'rawvideo', '-pix_fmt', 'rgb48le', '-']);
      assert.equal(out.length, w * h * 6, `${f} size`);
      let worst = 0;
      for (let i = 0; i < w * h; i++) for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(out.readUInt16LE((i * 3 + c) * 2) - img[i * 4 + c]));
      assert.ok(worst <= tol, `${f}: ffmpeg decode deviates by ${worst}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('RGBA TIFF keeps the fourth (infrared) channel in alpha', () => {
  const w = 6, h = 4, raw = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) { raw[i * 4] = i; raw[i * 4 + 1] = 2 * i; raw[i * 4 + 2] = 3 * i; raw[i * 4 + 3] = i === 5 ? 20 : 240; }
  const img = IO.decodeTIFF(makeTIFF({ width: w, height: h, spp: 4, strip: raw }));
  assert.equal(img.infrared, true);
  assert.equal(img.data[5 * 4 + 3], 20 * 257); assert.equal(img.data[4 * 4 + 3], 240 * 257); assert.equal(img.data[5 * 4 + 2], 15 * 257);
});

test('half-float conversion is exact on representable values', () => {
  for (const v of [0, 1, 0.5, 2, 65504, -3.25, 0.0009765625, 6.103515625e-5]) assert.equal(IO.fromHalf(IO.toHalf(v)), v, String(v));
  assert.ok(Math.abs(IO.fromHalf(IO.toHalf(0.1)) - 0.1) < 1e-4);
  assert.equal(IO.toHalf(1e6), 0x7c00, 'overflow to infinity');
});

test('OpenEXR round-trips through the encoder and decoder (ZIP and uncompressed)', async () => {
  const w = 53, h = 37, img = gradient16(w, h);
  for (const compression of ['zip', 'none']) {
    const exr = await IO.encodeEXR(w, h, img, { compression });
    const back = await IO.decodeEXR(toBuf(exr));
    assert.equal(back.width, w); assert.equal(back.height, h);
    let worst = 0, sum = 0, n = 0;
    for (let i = 0; i < img.length; i++) if (i % 4 !== 3) { const d = Math.abs(back.data[i] - img[i]); sum += d; n++; if (img[i] > 3000) worst = Math.max(worst, d); }
    assert.ok(worst <= 40 && sum / n < 8, `${compression}: worst ${worst}, mean ${(sum / n).toFixed(2)} (of 65535)`);
  }
});

test('ffmpeg reads our EXR and we read ffmpeg EXR', { skip: !hasFfmpeg() && 'ffmpeg not installed' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'frs-exr-'));
  try {
    const w = 48, h = 30, img = gradient16(w, h);
    writeFileSync(join(dir, 'ours.exr'), await IO.encodeEXR(w, h, img));
    // Compare the half-float bits ffmpeg reads (its half->float32 path mishandles subnormals, so use raw halves).
    const out = execFileSync('ffmpeg', ['-v', 'error', '-i', join(dir, 'ours.exr'), '-f', 'rawvideo', '-pix_fmt', 'gbrpf16le', '-']);
    const plane = w * h, chan = { 0: 2, 1: 0, 2: 1 }; // gbrp planes: G, B, R
    let mismatches = 0;
    for (let i = 0; i < plane; i++) for (let c = 0; c < 3; c++) {
      const bits = out.readUInt16LE((chan[c] * plane + i) * 2), expect = IO.toHalf(Math.pow(img[i * 4 + c] / 65535, 2.2));
      if (Math.abs(bits - expect) > 1) mismatches++;
    }
    assert.equal(mismatches, 0, 'ffmpeg reads exactly the half values we wrote');
    writeFileSync(join(dir, 'src.png'), await IO.encodePNG(w, h, img, 16));
    for (const [comp, fmt] of [['zip16', 'half'], ['none', 'float']]) {
      const f = join(dir, `ff_${comp}.exr`);
      execFileSync('ffmpeg', ['-v', 'error', '-i', join(dir, 'src.png'), '-pix_fmt', 'gbrpf32le', '-c:v', 'exr', '-compression', comp, '-format', fmt, '-y', f]);
      const b = readFileSync(f), dec = await IO.decodeEXR(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
      // Reference: the exact values stored in ffmpeg's file (raw halves / floats), not the PNG source,
      // because ffmpeg's own 16-bit -> float conversion is lossy in the shadows.
      const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', f, '-f', 'rawvideo', '-pix_fmt', fmt === 'half' ? 'gbrpf16le' : 'gbrpf32le', '-']);
      let bad = 0;
      for (let i = 0; i < plane; i++) for (let c = 0; c < 3; c++) {
        const lin = fmt === 'half' ? IO.fromHalf(raw.readUInt16LE((chan[c] * plane + i) * 2)) : raw.readFloatLE((chan[c] * plane + i) * 4);
        const expect = Math.round(Math.pow(Math.min(1, Math.max(0, lin)), 1 / 2.2) * 65535);
        if (Math.abs(dec.data[i * 4 + c] - expect) > 1) bad++;
      }
      assert.equal(bad, 0, `${comp}/${fmt}: ${bad} samples off`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Cineon log transfer: reference points and round trip', () => {
  assert.ok(Math.abs(IO.cineonToLinear(95)) < 1e-9, 'code 95 is black');
  assert.ok(Math.abs(IO.cineonToLinear(685) - 1) < 1e-9, 'code 685 is reference white');
  assert.ok(Math.abs(IO.cineonToLinear(470) - 0.18) < 0.03, `code 470 is ~18% grey (${IO.cineonToLinear(470).toFixed(3)})`);
  for (const lin of [0.01, 0.18, 0.5, 0.9]) assert.ok(Math.abs(IO.cineonToLinear(IO.linearToCineon(lin)) - lin) < 1e-9);
  const { toDisplay, toLog } = IO.cineonLUTs();
  let worst = 0;
  for (let v = 2000; v < 65535; v += 97) worst = Math.max(worst, Math.abs(toDisplay[toLog[v]] - v));
  assert.ok(worst < 300, `display -> log -> display drift ${worst} of 65535`);
  const img = new Uint16Array([65535, 0, 32768, 65535]), dpx = IO.decodeDPX(toBuf(IO.encodeDPX(1, 1, img, { log: true })));
  assert.equal(dpx.transfer, 1, 'log DPX is flagged as printing density');
});
