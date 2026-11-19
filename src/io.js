/*
 * FrameRestore Studio I/O helpers: 16-bit DPX and TIFF decoding for film-scan
 * sequences; OpenEXR read/write; 16-bit PNG, 16-bit TIFF and 10-bit DPX encoders; MP4 (H.264) and
 * WebM (VP9/AV1) muxers for WebCodecs output; a store-only ZIP writer;
 * run-length mask encoding and natural filename sorting. Dependency-free;
 * works in browsers and under Node.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FRSIO = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** Build 16-bit RGBA from a per-pixel getter returning 16-bit [r, g, b]. */
  function toRGBA16(width, height, getter) {
    const out = new Uint16Array(width * height * 4);
    for (let i = 0, j = 0; i < width * height; i++, j += 4) {
      const [r, g, b, a] = getter(i);
      out[j] = r + 0.5; out[j + 1] = g + 0.5; out[j + 2] = b + 0.5; out[j + 3] = a === undefined ? 65535 : a + 0.5;
    }
    return out;
  }

  // ------------------------------------------------------------------ DPX
  /**
   * SMPTE 268M DPX reader. Supports RGB, RGBA and luma image elements at 8,
   * 10 (packing method A or B), 12 (method A) and 16 bits, either byte order,
   * uncompressed. Output is 16-bit RGBA (code values scaled to 0..65535, no log conversion).
   */
  function decodeDPX(buffer) {
    const dv = new DataView(buffer);
    if (buffer.byteLength < 2048) throw new Error('DPX file is too small');
    const magic = dv.getUint32(0, false);
    let le;
    if (magic === 0x53445058) le = false; else if (magic === 0x58504453) le = true;
    else throw new Error('Not a DPX file (bad magic number)');
    const u32 = (o) => dv.getUint32(o, le), u16 = (o) => dv.getUint16(o, le);
    const dataOffset = u32(4);
    const width = u32(772), height = u32(776);
    const descriptor = dv.getUint8(800), bits = dv.getUint8(803), packing = u16(804), encoding = u16(806);
    const elemOffset = u32(808);
    if (!width || !height || width > 32768 || height > 32768) throw new Error('DPX has invalid dimensions');
    if (encoding !== 0) throw new Error('Run-length encoded DPX is not supported');
    const comps = descriptor === 50 ? 3 : descriptor === 51 || descriptor === 52 ? 4 : descriptor === 6 || descriptor === 1 || descriptor === 2 || descriptor === 3 || descriptor === 4 ? 1 : 0;
    if (!comps) throw new Error(`Unsupported DPX descriptor ${descriptor}`);
    const start = elemOffset && elemOffset !== 0xffffffff ? elemOffset : dataOffset;
    const n = width * height, total = n * comps;
    const vals = new Uint16Array(total);
    let maxv;
    if (bits === 8) {
      maxv = 255;
      const rowBytes = Math.ceil((width * comps) / 4) * 4;
      for (let y = 0; y < height; y++) for (let k = 0; k < width * comps; k++) vals[y * width * comps + k] = dv.getUint8(start + y * rowBytes + k);
    } else if (bits === 10) {
      maxv = 1023;
      if (packing === 1 || packing === 2) {
        const perRowWords = Math.ceil((width * comps) / 3);
        let idx = 0;
        for (let y = 0; y < height; y++) {
          for (let wd = 0; wd < perRowWords; wd++) {
            const word = u32(start + (y * perRowWords + wd) * 4);
            const c = packing === 1 ? [(word >>> 22) & 1023, (word >>> 12) & 1023, (word >>> 2) & 1023] : [(word >>> 20) & 1023, (word >>> 10) & 1023, word & 1023];
            for (let q = 0; q < 3 && idx < (y + 1) * width * comps; q++) vals[idx++] = c[q];
          }
        }
      } else {
        // packing 0: continuous 10-bit stream in 32-bit words, LSB first per word
        let bitPos = 0;
        for (let k = 0; k < total; k++) {
          const wordIdx = bitPos >>> 5, off = bitPos & 31;
          let v = u32(start + wordIdx * 4) >>> off;
          if (off > 22) v |= u32(start + (wordIdx + 1) * 4) << (32 - off);
          vals[k] = v & 1023; bitPos += 10;
        }
      }
    } else if (bits === 12) {
      maxv = 4095;
      for (let k = 0; k < total; k++) { const v = u16(start + k * 2); vals[k] = packing === 1 ? v >>> 4 : v & 4095; }
    } else if (bits === 16) {
      maxv = 65535;
      for (let k = 0; k < total; k++) vals[k] = u16(start + k * 2);
    } else throw new Error(`Unsupported DPX bit depth ${bits}`);
    const scale = 65535 / maxv;
    const data = toRGBA16(width, height, (i) => {
      const o = i * comps;
      if (comps === 1) { const v = vals[o] * scale; return [v, v, v]; }
      // A fourth component (RGBA descriptors) is kept in alpha: scanners store the infrared dirt layer there.
      return comps === 4 ? [vals[o] * scale, vals[o + 1] * scale, vals[o + 2] * scale, vals[o + 3] * scale] : [vals[o] * scale, vals[o + 1] * scale, vals[o + 2] * scale];
    });
    return { width, height, data, bitDepth: bits, format: 'DPX', infrared: comps === 4, transfer: dv.getUint8(801) };
  }

  // ------------------------------------------------------------------ TIFF
  /** TIFF LZW (MSB-first, early change) using prefix/suffix tables. */
  function lzwDecode(src, expected) {
    const out = new Uint8Array(expected);
    const prefix = new Int32Array(4096), suffix = new Uint8Array(4096), first = new Uint8Array(4096), length = new Uint32Array(4096);
    for (let i = 0; i < 256; i++) { prefix[i] = -1; suffix[i] = i; first[i] = i; length[i] = 1; }
    const totalBits = src.length * 8;
    let op = 0, bitPos = 0, codeLen = 9, next = 258, prev = -1;
    const write = (code) => {
      const len = length[code];
      let end = op + len - 1, c = code;
      while (c >= 0) { if (end < expected) out[end] = suffix[c]; end--; c = prefix[c]; }
      op += len;
    };
    while (op < expected && bitPos + codeLen <= totalBits) {
      let code = 0;
      for (let i = 0; i < codeLen; i++, bitPos++) code = (code << 1) | ((src[bitPos >>> 3] >>> (7 - (bitPos & 7))) & 1);
      if (code === 257) break;
      if (code === 256) { next = 258; codeLen = 9; prev = -1; continue; }
      if (prev < 0) {
        if (code > 255) throw new Error('Corrupt LZW data');
        write(code); prev = code; continue;
      }
      let firstByte;
      if (code < next) firstByte = first[code];
      else if (code === next) firstByte = first[prev];
      else throw new Error('Corrupt LZW data');
      if (next < 4096) {
        prefix[next] = prev; suffix[next] = firstByte; first[next] = first[prev]; length[next] = length[prev] + 1;
        next++;
      }
      write(code);
      prev = code;
      if (next + 1 >= 1 << codeLen && codeLen < 12) codeLen++;
    }
    return out;
  }

  function packBitsDecode(src, expected) {
    const out = new Uint8Array(expected);
    let ip = 0, op = 0;
    while (op < expected && ip < src.length) {
      const n = (src[ip++] << 24) >> 24;
      if (n >= 0) { for (let i = 0; i <= n && op < expected; i++) out[op++] = src[ip++]; }
      else if (n !== -128) { const v = src[ip++]; for (let i = 0; i < 1 - n && op < expected; i++) out[op++] = v; }
    }
    return out;
  }

  /**
   * Baseline TIFF reader: strips, chunky planar configuration, 8 or 16 bits per
   * sample, RGB(A) or greyscale, no compression, PackBits or LZW with optional
   * horizontal predictor. First image only.
   */
  function decodeTIFF(buffer) {
    const dv = new DataView(buffer), bytes = new Uint8Array(buffer);
    const bo = dv.getUint16(0, false);
    let le;
    if (bo === 0x4949) le = true; else if (bo === 0x4d4d) le = false; else throw new Error('Not a TIFF file');
    if (dv.getUint16(2, le) !== 42) throw new Error('BigTIFF and non-standard TIFF are not supported');
    const ifd = dv.getUint32(4, le), count = dv.getUint16(ifd, le);
    const tags = {};
    const sizes = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };
    for (let i = 0; i < count; i++) {
      const e = ifd + 2 + i * 12, tag = dv.getUint16(e, le), type = dv.getUint16(e + 2, le), n = dv.getUint32(e + 4, le);
      const size = (sizes[type] || 1) * n, off = size <= 4 ? e + 8 : dv.getUint32(e + 8, le);
      const vals = [];
      for (let k = 0; k < Math.min(n, 1 << 20); k++) {
        if (type === 3) vals.push(dv.getUint16(off + k * 2, le));
        else if (type === 4) vals.push(dv.getUint32(off + k * 4, le));
        else vals.push(dv.getUint8(off + k));
      }
      tags[tag] = vals;
    }
    const width = tags[256] && tags[256][0], height = tags[257] && tags[257][0];
    if (!width || !height) throw new Error('TIFF is missing dimensions');
    if (tags[322]) throw new Error('Tiled TIFF is not supported');
    const spp = (tags[277] && tags[277][0]) || 1, bps = (tags[258] && tags[258][0]) || 1;
    const compression = (tags[259] && tags[259][0]) || 1, photometric = tags[262] ? tags[262][0] : 1;
    const planar = (tags[284] && tags[284][0]) || 1, predictor = (tags[317] && tags[317][0]) || 1;
    if (planar !== 1) throw new Error('Planar TIFF is not supported');
    if (bps !== 8 && bps !== 16) throw new Error(`TIFF ${bps}-bit samples are not supported`);
    if (tags[339] && tags[339][0] === 3) throw new Error('Floating-point TIFF is not supported');
    if (![0, 1, 2].includes(photometric)) throw new Error(`TIFF photometric ${photometric} is not supported`);
    const offsets = tags[273], counts = tags[279], rps = (tags[278] && tags[278][0]) || height;
    const bpp = (spp * bps) / 8, rowBytes = width * bpp;
    const raw = new Uint8Array(rowBytes * height);
    let pos = 0;
    for (let s = 0; s < offsets.length; s++) {
      const rows = Math.min(rps, height - s * rps);
      if (rows <= 0) break;
      const expected = rows * rowBytes, src = bytes.subarray(offsets[s], offsets[s] + counts[s]);
      let strip;
      if (compression === 1) strip = src;
      else if (compression === 32773) strip = packBitsDecode(src, expected);
      else if (compression === 5) strip = lzwDecode(src, expected);
      else throw new Error(`TIFF compression ${compression} is not supported`);
      raw.set(strip.subarray(0, expected), pos);
      pos += expected;
    }
    const view16 = bps === 16 ? new DataView(raw.buffer) : null;
    if (predictor === 2) {
      for (let y = 0; y < height; y++) for (let x = 1; x < width; x++) for (let c = 0; c < spp; c++) {
        if (bps === 8) { const o = y * rowBytes + x * spp + c; raw[o] = (raw[o] + raw[o - spp]) & 255; }
        else { const o = y * rowBytes + (x * spp + c) * 2; view16.setUint16(o, (view16.getUint16(o, le) + view16.getUint16(o - spp * 2, le)) & 65535, le); }
      }
    }
    const get = bps === 16 ? (k) => view16.getUint16(k * 2, le) : (k) => raw[k] * 257;
    const data = toRGBA16(width, height, (i) => {
      const k = i * spp;
      if (spp >= 4) return [get(k), get(k + 1), get(k + 2), get(k + 3)];
      if (spp >= 3) return [get(k), get(k + 1), get(k + 2)];
      let v = get(k);
      if (photometric === 0) v = 65535 - v;
      return [v, v, v];
    });
    return { width, height, data, bitDepth: bps, format: 'TIFF', infrared: spp >= 4 };
  }

  // ------------------------------------------------------------------ ZIP
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  /** Builds an uncompressed ZIP archive; returns an array of Uint8Array parts. */
  function zipStoreParts(files, date) {
    const enc = new TextEncoder(), parts = [], central = [];
    const d = date || new Date();
    const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    let offset = 0;
    for (const f of files) {
      const name = enc.encode(f.name), data = f.data, crc = crc32(data);
      if (offset + data.length > 0xfffffff0) throw new Error('ZIP archive would exceed 4 GB; export to a folder instead');
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
      h.setUint16(10, dosTime, true); h.setUint16(12, dosDate, true); h.setUint32(14, crc, true);
      h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
      parts.push(new Uint8Array(h.buffer), name, data);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
      c.setUint16(12, dosTime, true); c.setUint16(14, dosDate, true); c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
      c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
      central.push(new Uint8Array(c.buffer), name);
      offset += 30 + name.length + data.length;
    }
    const cdSize = central.reduce((s, p) => s + p.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    return parts.concat(central, [new Uint8Array(end.buffer)]);
  }


  // ------------------------------------------------------------------ image encoders
  const pngCrcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();

  async function deflate(bytes) {
    if (typeof CompressionStream === 'undefined') throw new Error('CompressionStream is not available');
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /** Encode 16-bit RGBA as an RGB PNG at 8 or 16 bits per channel (async: uses CompressionStream). */
  async function encodePNG(width, height, rgba16, bitDepth) {
    const depth = bitDepth === 8 ? 8 : 16, bpp = depth === 16 ? 6 : 3, stride = width * bpp;
    const raw = new Uint8Array((stride + 1) * height), row = new Uint8Array(stride);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const j = (y * width + x) * 4, o = x * bpp;
        if (depth === 16) {
          for (let c = 0; c < 3; c++) { const v = rgba16[j + c]; row[o + c * 2] = v >>> 8; row[o + c * 2 + 1] = v & 255; }
        } else for (let c = 0; c < 3; c++) row[o + c] = Math.min(255, (rgba16[j + c] + 128) / 257);
      }
      const base = y * (stride + 1);
      raw[base] = 1; // Sub filter
      for (let x = 0; x < stride; x++) raw[base + 1 + x] = (row[x] - (x >= bpp ? row[x - bpp] : 0)) & 255;
    }
    const idat = await deflate(raw);
    const chunk = (type, data) => {
      const out = new Uint8Array(12 + data.length), dv = new DataView(out.buffer);
      dv.setUint32(0, data.length);
      for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
      out.set(data, 8);
      let c = 0xffffffff;
      for (let i = 4; i < 8 + data.length; i++) c = pngCrcTable[(c ^ out[i]) & 255] ^ (c >>> 8);
      dv.setUint32(8 + data.length, (c ^ 0xffffffff) >>> 0);
      return out;
    };
    const ihdr = new Uint8Array(13), hv = new DataView(ihdr.buffer);
    hv.setUint32(0, width); hv.setUint32(4, height); ihdr[8] = depth; ihdr[9] = 2;
    return concatBytes([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))]);
  }

  /** Encode 16-bit RGBA as an uncompressed 16-bit RGB baseline TIFF (little-endian). */
  function encodeTIFF(width, height, rgba16) {
    const n = width * height, dataLen = n * 6, entries = 12, ifdOff = 8, ifdLen = 2 + entries * 12 + 4;
    const bpsOff = ifdOff + ifdLen, resOff = bpsOff + 6, dataOff = resOff + 16;
    const buf = new ArrayBuffer(dataOff + dataLen), dv = new DataView(buf);
    dv.setUint16(0, 0x4949, false); dv.setUint16(2, 42, true); dv.setUint32(4, ifdOff, true); dv.setUint16(ifdOff, entries, true);
    const tags = [[256, 4, 1, width], [257, 4, 1, height], [258, 3, 3, bpsOff], [259, 3, 1, 1], [262, 3, 1, 2], [273, 4, 1, dataOff],
      [274, 3, 1, 1], [277, 3, 1, 3], [278, 4, 1, height], [279, 4, 1, dataLen], [282, 5, 1, resOff], [283, 5, 1, resOff + 8]];
    tags.forEach(([tag, type, count, value], k) => {
      const e = ifdOff + 2 + k * 12;
      dv.setUint16(e, tag, true); dv.setUint16(e + 2, type, true); dv.setUint32(e + 4, count, true);
      if (type === 3 && count === 1) dv.setUint16(e + 8, value, true); else dv.setUint32(e + 8, value, true);
    });
    dv.setUint32(ifdOff + 2 + entries * 12, 0, true);
    for (let c = 0; c < 3; c++) dv.setUint16(bpsOff + c * 2, 16, true);
    dv.setUint32(resOff, 72, true); dv.setUint32(resOff + 4, 1, true); dv.setUint32(resOff + 8, 72, true); dv.setUint32(resOff + 12, 1, true);
    const out = new Uint16Array(buf, dataOff, n * 3);
    for (let i = 0; i < n; i++) { out[i * 3] = rgba16[i * 4]; out[i * 3 + 1] = rgba16[i * 4 + 1]; out[i * 3 + 2] = rgba16[i * 4 + 2]; }
    return new Uint8Array(buf);
  }

  /** Encode 16-bit RGBA as a 10-bit RGB DPX (SMPTE 268M v2.0, packing method A, big-endian). meta.log marks printing-density data. */
  function encodeDPX(width, height, rgba16, meta) {
    const header = 2048, n = width * height, size = header + n * 4;
    const buf = new ArrayBuffer(size), dv = new DataView(buf), bytes = new Uint8Array(buf);
    const str = (off, text, len) => { for (let i = 0; i < len; i++) bytes[off + i] = i < text.length ? text.charCodeAt(i) & 127 : 0; };
    for (let i = 0; i < header; i++) bytes[i] = 0;
    for (const off of [1712, 1716, 1720]) dv.setUint32(off, 0xffffffff, false);
    dv.setUint32(0, 0x53445058, false); dv.setUint32(4, header, false); str(8, 'V2.0', 8);
    dv.setUint32(16, size, false); dv.setUint32(20, 1, false); dv.setUint32(24, 1664, false); dv.setUint32(28, 384, false); dv.setUint32(32, 0, false);
    str(36, (meta && meta.name) || 'frame.dpx', 100); str(136, new Date().toISOString().replace('T', ':').slice(0, 19), 24);
    str(160, 'FrameRestore Studio', 100);
    dv.setUint32(660, 0xffffffff, false);
    dv.setUint16(768, 0, false); dv.setUint16(770, 1, false); dv.setUint32(772, width, false); dv.setUint32(776, height, false);
    dv.setUint32(780, 0, false); dv.setUint32(784, 0, false); dv.setFloat32(788, 0, false); dv.setUint32(792, 1023, false); dv.setFloat32(796, 2.047, false);
    bytes[800] = 50; bytes[801] = meta && meta.log ? 1 : 2; bytes[802] = meta && meta.log ? 1 : 2; bytes[803] = 10;
    dv.setUint16(804, 1, false); dv.setUint16(806, 0, false); dv.setUint32(808, header, false); dv.setUint32(812, 0, false); dv.setUint32(816, 0, false);
    if (meta && meta.fps) dv.setFloat32(1724, meta.fps, false); else dv.setUint32(1724, 0xffffffff, false);
    for (let i = 0; i < n; i++) {
      const j = i * 4, r = (rgba16[j] * 1023 + 32767) / 65535 | 0, g = (rgba16[j + 1] * 1023 + 32767) / 65535 | 0, b = (rgba16[j + 2] * 1023 + 32767) / 65535 | 0;
      dv.setUint32(header + i * 4, ((r << 22) | (g << 12) | (b << 2)) >>> 0, false);
    }
    return bytes;
  }

  function concatBytes(parts) {
    let len = 0;
    for (const p of parts) len += p.length;
    const out = new Uint8Array(len);
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
  }

  // ------------------------------------------------------------------ OpenEXR
  // Pixel values in the app are display-encoded; EXR is scene-linear by convention.
  // The conversion uses a pure 2.2 power curve (documented, reversible).
  const EXR_GAMMA = 2.2;
  const f32 = new Float32Array(1), u32v = new Uint32Array(f32.buffer);
  function toHalf(v) {
    f32[0] = v;
    const x = u32v[0], sign = (x >>> 16) & 0x8000;
    let e = ((x >>> 23) & 0xff) - 127 + 15, m = x & 0x7fffff;
    if (((x >>> 23) & 0xff) === 0xff) return sign | 0x7c00 | (m ? 0x200 : 0);
    if (e >= 31) return sign | 0x7c00;
    if (e <= 0) {
      if (e < -10) return sign;
      m |= 0x800000;
      const shift = 14 - e, half = m >>> shift, rem = m & ((1 << shift) - 1), mid = 1 << (shift - 1);
      return sign | (half + (rem > mid || (rem === mid && half & 1) ? 1 : 0));
    }
    let half = sign | (e << 10) | (m >>> 13);
    const rem = m & 0x1fff;
    if (rem > 0x1000 || (rem === 0x1000 && half & 1)) half++;
    return half;
  }
  function fromHalf(h) {
    const s = h & 0x8000 ? -1 : 1, e = (h >>> 10) & 0x1f, m = h & 0x3ff;
    if (e === 0) return s * m * 5.960464477539063e-8;
    if (e === 31) return m ? NaN : s * Infinity;
    return s * Math.pow(2, e - 15) * (1 + m / 1024);
  }

  async function inflateZlib(bytes) {
    if (typeof DecompressionStream === 'undefined') throw new Error('DecompressionStream is not available');
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  /** OpenEXR ZIP pre-filter: split even/odd bytes, then delta-encode. */
  function exrZipFilter(raw) {
    const n = raw.length, t = new Uint8Array(n), half = (n + 1) >> 1;
    for (let i = 0, a = 0, b = half; i < n; i += 2) { t[a++] = raw[i]; if (i + 1 < n) t[b++] = raw[i + 1]; }
    for (let i = n - 1; i > 0; i--) t[i] = (t[i] - t[i - 1] + 128 + 256) & 255;
    return t;
  }
  function exrZipUnfilter(t) {
    const n = t.length, raw = new Uint8Array(n), d = Uint8Array.from(t), half = (n + 1) >> 1;
    for (let i = 1; i < n; i++) d[i] = (d[i - 1] + d[i] - 128 + 256) & 255;
    for (let i = 0, a = 0, b = half; i < n; i += 2) { raw[i] = d[a++]; if (i + 1 < n) raw[i + 1] = d[b++]; }
    return raw;
  }

  /**
   * Encode 16-bit display-encoded RGBA as a scene-linear half-float RGB
   * OpenEXR (scanline). compression: 'zip' (16 lines per chunk, default) or 'none'.
   */
  async function encodeEXR(width, height, rgba16, opts) {
    const zip = !(opts && opts.compression === 'none'), lines = zip ? 16 : 1;
    const enc = new TextEncoder(), parts = [];
    const attr = (name, type, data) => { const a = enc.encode(name), t = enc.encode(type), sz = new Uint8Array(4); new DataView(sz.buffer).setUint32(0, data.length, true); parts.push(a, new Uint8Array([0]), t, new Uint8Array([0]), sz, data); };
    const le = (vals, kind) => { const b = new Uint8Array(vals.length * 4), dv = new DataView(b.buffer); vals.forEach((v, i) => (kind === 'f' ? dv.setFloat32(i * 4, v, true) : dv.setInt32(i * 4, v, true))); return b; };
    // channel record: name\0, int pixelType(1=HALF), uchar pLinear, 3 reserved, int xSampling, int ySampling
    const ch = [];
    for (const c of ['B', 'G', 'R']) { ch.push(...enc.encode(c), 0); const d = new Uint8Array(16), dv = new DataView(d.buffer); dv.setInt32(0, 1, true); dv.setInt32(8, 1, true); dv.setInt32(12, 1, true); ch.push(...d); }
    ch.push(0);
    parts.push(new Uint8Array([0x76, 0x2f, 0x31, 0x01, 2, 0, 0, 0]));
    attr('channels', 'chlist', new Uint8Array(ch));
    attr('compression', 'compression', new Uint8Array([zip ? 3 : 0]));
    attr('dataWindow', 'box2i', le([0, 0, width - 1, height - 1]));
    attr('displayWindow', 'box2i', le([0, 0, width - 1, height - 1]));
    attr('lineOrder', 'lineOrder', new Uint8Array([0]));
    attr('pixelAspectRatio', 'float', le([1], 'f'));
    attr('screenWindowCenter', 'v2f', le([0, 0], 'f'));
    attr('screenWindowWidth', 'float', le([1], 'f'));
    parts.push(new Uint8Array([0]));
    const header = concatBytes(parts), chunks = Math.ceil(height / lines);
    const lut = new Uint16Array(65536);
    for (let v = 0; v < 65536; v++) lut[v] = toHalf(Math.pow(v / 65535, EXR_GAMMA));
    const blocks = [];
    for (let c = 0; c < chunks; c++) {
      const y0 = c * lines, y1 = Math.min(height, y0 + lines), raw = new Uint8Array((y1 - y0) * width * 3 * 2), dv = new DataView(raw.buffer);
      let o = 0;
      for (let y = y0; y < y1; y++) for (const chn of [2, 1, 0]) for (let x = 0; x < width; x++, o += 2) dv.setUint16(o, lut[rgba16[(y * width + x) * 4 + chn]], true);
      let data = raw;
      if (zip) { const z = await deflate(exrZipFilter(raw)); if (z.length < raw.length) data = z; }
      const head = new Uint8Array(8), hv = new DataView(head.buffer);
      hv.setInt32(0, y0, true); hv.setInt32(4, data.length, true);
      blocks.push(head, data);
    }
    const table = new Uint8Array(chunks * 8), tv = new DataView(table.buffer);
    let off = header.length + table.length;
    for (let c = 0; c < chunks; c++) { tv.setBigUint64(c * 8, BigInt(off), true); off += blocks[c * 2].length + blocks[c * 2 + 1].length; }
    return concatBytes([header, table, ...blocks]);
  }

  /**
   * Decode a scanline OpenEXR (HALF or FLOAT channels R, G, B and optional A;
   * NONE, ZIPS or ZIP compression) into 16-bit display-encoded RGBA. An "A"
   * channel is kept in alpha. Values are converted from linear with the same
   * 2.2 curve used by the encoder and clipped to 0..1.
   */
  async function decodeEXR(buffer) {
    const dv = new DataView(buffer), bytes = new Uint8Array(buffer);
    if (dv.getUint32(0, true) !== 20000630) throw new Error('Not an OpenEXR file');
    const flags = dv.getUint32(4, true);
    if (flags & 0x200) throw new Error('Tiled OpenEXR is not supported');
    if (flags & 0x1000) throw new Error('Multi-part / deep OpenEXR is not supported');
    let p = 8;
    const str = () => { let e = p; while (bytes[e]) e++; const t = new TextDecoder().decode(bytes.subarray(p, e)); p = e + 1; return t; };
    const attrs = {};
    for (;;) {
      const name = str();
      if (!name) break;
      const type = str(), size = dv.getUint32(p, true); p += 4;
      attrs[name] = { type, off: p, size }; p += size;
    }
    const channels = [];
    { let q = attrs.channels.off; const end = q + attrs.channels.size;
      while (q < end && bytes[q]) { let e = q; while (bytes[e]) e++; const nm = new TextDecoder().decode(bytes.subarray(q, e)); q = e + 1; channels.push({ name: nm, type: dv.getInt32(q, true), xs: dv.getInt32(q + 8, true), ys: dv.getInt32(q + 12, true) }); q += 16; } }
    const compression = bytes[attrs.compression.off];
    if (![0, 2, 3].includes(compression)) throw new Error(`OpenEXR compression ${['NONE', 'RLE', 'ZIPS', 'ZIP', 'PIZ', 'PXR24', 'B44', 'B44A', 'DWAA', 'DWAB'][compression] || compression} is not supported (use ZIP or none)`);
    if (channels.some((c) => c.xs !== 1 || c.ys !== 1)) throw new Error('Subsampled OpenEXR channels are not supported');
    const dw = attrs.dataWindow.off, xMin = dv.getInt32(dw, true), yMin = dv.getInt32(dw + 4, true), xMax = dv.getInt32(dw + 8, true), yMax = dv.getInt32(dw + 12, true);
    const width = xMax - xMin + 1, height = yMax - yMin + 1, lines = compression === 3 ? 16 : 1, chunks = Math.ceil(height / lines);
    const sizes = channels.map((c) => (c.type === 1 ? 2 : 4));
    const lineBytes = sizes.reduce((a, b) => a + b, 0) * width;
    const out = new Uint16Array(width * height * 4).fill(65535);
    const idx = { R: 0, G: 1, B: 2, A: 3, Y: -1 };
    const lut = new Uint16Array(65536);
    for (let h = 0; h < 65536; h++) { const v = fromHalf(h); lut[h] = !(v > 0) ? 0 : v >= 1 ? 65535 : Math.round(Math.pow(v, 1 / EXR_GAMMA) * 65535); }
    const fromLinear = (v) => (!(v > 0) ? 0 : v >= 1 ? 65535 : Math.round(Math.pow(v, 1 / EXR_GAMMA) * 65535));
    for (let c = 0; c < chunks; c++) {
      const off = Number(dv.getBigUint64(p + c * 8, true)), y = dv.getInt32(off, true) - yMin, len = dv.getInt32(off + 4, true);
      const nLines = Math.min(lines, height - y);
      let data = bytes.subarray(off + 8, off + 8 + len);
      if (compression !== 0 && len < nLines * lineBytes) data = exrZipUnfilter(await inflateZlib(data));
      const ddv = new DataView(data.buffer, data.byteOffset, data.byteLength);
      let o = 0;
      for (let l = 0; l < nLines; l++) {
        const row = y + l;
        channels.forEach((ch, k) => {
          const target = idx[ch.name] === undefined ? null : idx[ch.name];
          for (let x = 0; x < width; x++, o += sizes[k]) {
            if (target === null) continue;
            const v = sizes[k] === 2 ? lut[ddv.getUint16(o, true)] : fromLinear(ddv.getFloat32(o, true));
            const j = (row * width + x) * 4;
            if (target === -1) { out[j] = out[j + 1] = out[j + 2] = v; } else out[j + target] = target === 3 ? (sizes[k] === 2 ? Math.round(Math.min(1, Math.max(0, fromHalf(ddv.getUint16(o, true)))) * 65535) : Math.round(Math.min(1, Math.max(0, ddv.getFloat32(o, true))) * 65535)) : v;
          }
        });
      }
    }
    return { width, height, data: out, bitDepth: channels[0] && channels[0].type === 1 ? 16 : 32, format: 'EXR', infrared: channels.some((c) => c.name === 'A'), linear: true };
  }

  // ------------------------------------------------------------------ transfer functions
  /**
   * Cineon / DPX printing-density log (Kodak convention: 10-bit black 95,
   * white 685, 0.002 density per code value, negative gamma 0.6). The working
   * space is display-referred (2.2), so log scans are linearised and then
   * display-encoded; the inverse is used when writing log DPX again.
   */
  const CINEON = { black: 95, white: 685, gamma: 0.6, display: 2.2 };
  function cineonToLinear(code10) {
    const off = Math.pow(10, ((CINEON.black - CINEON.white) * 0.002) / CINEON.gamma);
    return (Math.pow(10, ((code10 - CINEON.white) * 0.002) / CINEON.gamma) - off) / (1 - off);
  }
  function linearToCineon(lin) {
    const off = Math.pow(10, ((CINEON.black - CINEON.white) * 0.002) / CINEON.gamma);
    return CINEON.white + (Math.log10(Math.max(1e-9, lin * (1 - off) + off)) * CINEON.gamma) / 0.002;
  }
  /** 65536-entry LUTs between 16-bit Cineon code values and 16-bit display-encoded values. */
  function cineonLUTs() {
    const toDisplay = new Uint16Array(65536), toLog = new Uint16Array(65536);
    for (let v = 0; v < 65536; v++) {
      const lin = cineonToLinear((v / 65535) * 1023);
      toDisplay[v] = Math.round(Math.min(1, Math.max(0, Math.pow(Math.max(0, lin), 1 / CINEON.display))) * 65535);
      const code = linearToCineon(Math.pow(v / 65535, CINEON.display));
      toLog[v] = Math.round(Math.min(1023, Math.max(0, code)) * (65535 / 1023));
    }
    return { toDisplay, toLog };
  }
  /** Apply a 16-bit LUT to the RGB of an RGBA16 buffer (alpha untouched), returning a copy. */
  function applyLUT16(rgba16, lut) {
    const out = new Uint16Array(rgba16);
    for (let j = 0; j < out.length; j += 4) { out[j] = lut[out[j]]; out[j + 1] = lut[out[j + 1]]; out[j + 2] = lut[out[j + 2]]; }
    return out;
  }

  // ------------------------------------------------------------------ video muxers
  /**
   * WebM (Matroska) muxer for one video track of encoded chunks.
   * chunks: [{ data: Uint8Array, key: boolean, timestamp: microseconds }]
   */
  function muxWebM({ codec, width, height, fps, chunks, codecPrivate }) {
    const id = (hex) => { const b = []; for (let v = hex; v > 0; v = Math.floor(v / 256)) b.unshift(v & 255); return new Uint8Array(b); };
    const vint = (n) => {
      for (let len = 1; len <= 8; len++) if (n < 2 ** (7 * len) - 1) {
        const out = new Uint8Array(len);
        let v = n;
        for (let i = len - 1; i >= 0; i--) { out[i] = v & 255; v = Math.floor(v / 256); }
        out[0] |= 1 << (8 - len);
        return out;
      }
      throw new Error('EBML size too large');
    };
    const uint = (v) => { const b = []; do { b.unshift(v & 255); v = Math.floor(v / 256); } while (v > 0); return new Uint8Array(b); };
    const el = (hex, ...body) => { const data = concatBytes(body.map((x) => (typeof x === 'string' ? new TextEncoder().encode(x) : x))); return concatBytes([id(hex), vint(data.length), data]); };
    const f64 = (v) => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v); return b; };
    const codecId = codec.startsWith('vp09') ? 'V_VP9' : codec.startsWith('vp8') ? 'V_VP8' : codec.startsWith('av01') ? 'V_AV1' : null;
    if (!codecId) throw new Error(`WebM cannot carry ${codec}`);
    const frameNs = Math.round(1e9 / fps), lastMs = chunks.length ? chunks[chunks.length - 1].timestamp / 1000 : 0;
    const ebml = el(0x1a45dfa3, el(0x4286, uint(1)), el(0x42f7, uint(1)), el(0x42f2, uint(4)), el(0x42f3, uint(8)), el(0x4282, 'webm'), el(0x4287, uint(4)), el(0x4285, uint(2)));
    const info = el(0x1549a966, el(0x2ad7b1, uint(1000000)), el(0x4d80, 'FrameRestore Studio'), el(0x5741, 'FrameRestore Studio'), el(0x4489, f64(lastMs + frameNs / 1e6)));
    const trackBody = [el(0xd7, uint(1)), el(0x73c5, uint(1)), el(0x83, uint(1)), el(0x86, codecId), el(0x23e383, uint(frameNs)), el(0xe0, el(0xb0, uint(width)), el(0xba, uint(height)))];
    if (codecPrivate && codecPrivate.length) trackBody.push(el(0x63a2, codecPrivate));
    const tracks = el(0x1654ae6b, el(0xae, ...trackBody));
    const clusters = [], cues = [];
    let offset = info.length + tracks.length, cluster = null;
    const flush = () => { if (!cluster) return; const c = el(0x1f43b675, el(0xe7, uint(cluster.time)), ...cluster.blocks); clusters.push(c); cues.push({ time: cluster.time, pos: cluster.pos }); offset += c.length; cluster = null; };
    for (const ch of chunks) {
      const ms = Math.round(ch.timestamp / 1000);
      if (!cluster || ch.key || ms - cluster.time > 30000) { flush(); cluster = { time: ms, pos: offset, blocks: [] }; }
      const rel = ms - cluster.time, head = new Uint8Array(4);
      head[0] = 0x81; head[1] = (rel >> 8) & 255; head[2] = rel & 255; head[3] = ch.key ? 0x80 : 0;
      cluster.blocks.push(el(0xa3, head, ch.data));
    }
    flush();
    const cueEl = el(0x1c53bb6b, ...cues.map((c) => el(0xbb, el(0xb3, uint(c.time)), el(0xb7, el(0xf7, uint(1)), el(0xf1, uint(c.pos))))));
    const segBody = concatBytes([info, tracks, ...clusters, cueEl]);
    return concatBytes([ebml, id(0x18538067), vint(segBody.length), segBody]);
  }

  /**
   * MP4 (ISO BMFF) muxer for one H.264 track, "faststart" layout (moov before
   * mdat). description is the avcC record from VideoEncoder's decoderConfig.
   */
  function muxMP4({ width, height, fps, chunks, description }) {
    if (!description || !description.length) throw new Error('H.264 MP4 needs the encoder avcC description');
    const u8 = (v) => new Uint8Array([v & 255]), u16 = (v) => new Uint8Array([(v >> 8) & 255, v & 255]);
    const u32 = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0); return b; };
    const str = (t) => new TextEncoder().encode(t);
    const box = (type, ...body) => { const data = concatBytes(body); return concatBytes([u32(8 + data.length), str(type), data]); };
    const full = (type, version, flags, ...body) => box(type, u8(version), u8(flags >> 16), u16(flags & 0xffff), ...body);
    const ntsc = [23.976, 29.97, 59.94, 47.952].some((f) => Math.abs(f - fps) < 0.01);
    const timescale = ntsc ? Math.round(fps * 1.001) * 1000 : Math.round(fps * 1000), delta = ntsc ? 1001 : 1000;
    const count = chunks.length, duration = count * delta;
    const matrix = concatBytes([u32(0x10000), u32(0), u32(0), u32(0), u32(0x10000), u32(0), u32(0), u32(0), u32(0x40000000)]);
    const mdatSize = 8 + chunks.reduce((s, c) => s + c.data.length, 0);
    if (mdatSize > 0xffffffff) throw new Error('MP4 output over 4 GB; render an image sequence instead');
    const build = (dataOffset) => {
      const avc1 = box('avc1', new Uint8Array(6), u16(1), new Uint8Array(16), u16(width), u16(height), u32(0x00480000), u32(0x00480000), u32(0), u16(1),
        concatBytes([u8(19), str('FrameRestore Studio'), new Uint8Array(12)]), u16(0x18), u16(0xffff), box('avcC', description));
      const stsd = full('stsd', 0, 0, u32(1), avc1);
      const stts = full('stts', 0, 0, u32(1), u32(count), u32(delta));
      const keys = chunks.map((c, i) => (c.key ? i + 1 : 0)).filter(Boolean);
      const stss = full('stss', 0, 0, u32(keys.length), ...keys.map(u32));
      const stsc = full('stsc', 0, 0, u32(1), u32(1), u32(count), u32(1));
      const stsz = full('stsz', 0, 0, u32(0), u32(count), ...chunks.map((c) => u32(c.data.length)));
      const stco = full('stco', 0, 0, u32(1), u32(dataOffset));
      const stbl = box('stbl', stsd, stts, stss, stsc, stsz, stco);
      const minf = box('minf', full('vmhd', 0, 1, new Uint8Array(8)), box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1))), stbl);
      const mdia = box('mdia', full('mdhd', 0, 0, u32(0), u32(0), u32(timescale), u32(duration), u16(0x55c4), u16(0)),
        full('hdlr', 0, 0, u32(0), str('vide'), new Uint8Array(12), str('FrameRestore video'), u8(0)), minf);
      const tkhd = full('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(Math.round((duration / timescale) * 1000)), new Uint8Array(8), u16(0), u16(0), u16(0), u16(0), matrix, u32(width << 16), u32(height << 16));
      const mvhd = full('mvhd', 0, 0, u32(0), u32(0), u32(1000), u32(Math.round((duration / timescale) * 1000)), u32(0x10000), u16(0x100), new Uint8Array(10), matrix, new Uint8Array(24), u32(2));
      return box('moov', mvhd, box('trak', tkhd, mdia));
    };
    const ftyp = box('ftyp', str('isom'), u32(512), str('isom'), str('iso2'), str('avc1'), str('mp41'));
    const probe = build(0);
    const moov = build(ftyp.length + probe.length + 8);
    return concatBytes([ftyp, moov, u32(mdatSize), str('mdat'), ...chunks.map((c) => c.data)]);
  }

  // ------------------------------------------------------------------ masks & names
  /** Run-length encode a 0/1 mask as a compact base-36 string. */
  function encodeMask(mask) {
    const runs = [];
    let cur = 0, len = 0;
    for (let i = 0; i < mask.length; i++) {
      const v = mask[i] ? 1 : 0;
      if (v === cur) len++; else { runs.push(len); cur = v; len = 1; }
    }
    runs.push(len);
    return runs.map((r) => r.toString(36)).join('.');
  }
  function decodeMask(str, length) {
    const mask = new Uint8Array(length);
    let pos = 0, v = 0;
    for (const part of String(str || '').split('.')) {
      const len = parseInt(part, 36) || 0;
      if (v) mask.fill(1, pos, Math.min(length, pos + len));
      pos += len; v ^= 1;
    }
    return mask;
  }

  function naturalCompare(a, b) {
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
  }

  function extension(name) {
    const m = /\.([^.]+)$/.exec(String(name).toLowerCase());
    return m ? m[1] : '';
  }

  return { cineonToLinear, linearToCineon, cineonLUTs, applyLUT16, decodeDPX, decodeTIFF, decodeEXR, encodeEXR, toHalf, fromHalf, lzwDecode, packBitsDecode, encodePNG, encodeTIFF, encodeDPX, muxWebM, muxMP4, concatBytes, crc32, zipStoreParts, encodeMask, decodeMask, naturalCompare, extension };
});
