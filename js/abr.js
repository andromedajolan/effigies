// Photoshop brush (.abr) reader and writer. Reads versions 1, 2 (older) and 6+ (CS and later) sampled brushes.
// Computed (round/parametric) brushes carry no bitmap and are skipped. Each brush is {name, width, height, alpha (Uint8Array, 255 = full ink), spacing (%)}.
function unpack(src, pos, rowBytes, h, comp) {
  const raw = new Uint8Array(rowBytes * h);
  if (comp === 0) { raw.set(src.subarray(pos, pos + raw.length)); return raw; }
  if (comp !== 1) throw new Error('Unknown brush compression');
  const counts = new Uint16Array(h), dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
  for (let j = 0; j < h; j++) counts[j] = dv.getUint16(pos + j * 2);
  let p = pos + h * 2;
  for (let j = 0; j < h; j++) {
    let o = j * rowBytes; const end = o + rowBytes, rowEnd = p + counts[j];
    while (o < end && p < rowEnd) {
      const n = (src[p++] << 24) >> 24;
      if (n >= 0) { for (let i = 0; i <= n && o < end; i++) raw[o++] = src[p++]; }
      else if (n !== -128) { const v = src[p++]; for (let i = 0; i < 1 - n && o < end; i++) raw[o++] = v; }
    }
    p = rowEnd;
  }
  return raw;
}
function readBitmap(src, pos, top, left, bottom, right, depth, comp) {
  const w = right - left, h = bottom - top;
  if (w < 1 || h < 1 || w > 8000 || h > 8000) return null;
  const bpp = depth === 16 ? 2 : depth === 8 ? 1 : 0; if (!bpp) return null;
  const raw = unpack(src, pos, w * bpp, h, comp);
  if (bpp === 1) return { width: w, height: h, alpha: raw };
  const a = new Uint8Array(w * h); for (let i = 0; i < a.length; i++) a[i] = raw[i * 2];
  return { width: w, height: h, alpha: a };
}
export function parseAbr(buf) {
  const src = new Uint8Array(buf), dv = new DataView(buf), out = { brushes: [], skipped: 0, version: 0 };
  if (src.length < 4) throw new Error('That does not look like a Photoshop brush (.abr) file.');
  const ver = dv.getUint16(0), sub = dv.getUint16(2); out.version = ver;
  const str = (p, n) => String.fromCharCode(...src.subarray(p, p + n));
  if (ver === 1 || ver === 2) {
    const count = sub; let p = 4;
    for (let i = 0; i < count && p + 6 <= src.length; i++) {
      const type = dv.getUint16(p), size = dv.getUint32(p + 2), start = p + 6; p = start + size;
      if (type !== 2) { out.skipped++; continue; }
      try {
        let q = start + 4; const spacing = dv.getUint16(q); q += 2;
        let name = 'Brush ' + (out.brushes.length + 1);
        if (ver === 2) { const n = dv.getUint32(q); q += 4; let t = ''; for (let k = 0; k < n; k++) t += String.fromCharCode(dv.getUint16(q + k * 2)); q += n * 2; t = t.replace(/\0+$/, ''); if (t) name = t; }
        q += 1;        // anti-aliasing
        q += 8;        // bounds as shorts
        const top = dv.getUint32(q), left = dv.getUint32(q + 4), bottom = dv.getUint32(q + 8), right = dv.getUint32(q + 12); q += 16;
        const depth = dv.getUint16(q); q += 2; const comp = src[q++];
        const bm = readBitmap(src, q, top, left, bottom, right, depth, comp);
        if (!bm) { out.skipped++; continue; }
        out.brushes.push({ name, ...bm, spacing: Math.min(999, Math.max(1, spacing || 25)) });
      } catch { out.skipped++; }
    }
    return out;
  }
  if (ver >= 6 && ver <= 30 && src.length >= 12 && String.fromCharCode(...src.subarray(4, 8)) === '8BIM') {
    let p = 4;
    while (p + 12 <= src.length) {
      if (str(p, 4) !== '8BIM') break;
      const key = str(p + 4, 4), len = dv.getUint32(p + 8), data = p + 12; p = data + len;
      if (key !== 'samp') continue;
      let q = data;
      while (q + 4 < data + len) {
        const size = dv.getUint32(q), start = q + 4; q = start + ((size + 3) & ~3);
        if (size < 20) continue;
        try {
          let r = start; const klen = src[r++]; const key2 = str(r, klen); r += klen;
          r += sub === 1 ? 10 : 264;
          const top = dv.getUint32(r), left = dv.getUint32(r + 4), bottom = dv.getUint32(r + 8), right = dv.getUint32(r + 12); r += 16;
          const depth = dv.getUint16(r); r += 2; const comp = src[r++];
          const bm = readBitmap(src, r, top, left, bottom, right, depth, comp);
          if (!bm) { out.skipped++; continue; }
          out.brushes.push({ name: 'Brush ' + (out.brushes.length + 1), key: key2, ...bm, spacing: 25 });
        } catch { out.skipped++; }
      }
    }
    return out;
  }
  throw new Error('That does not look like a Photoshop brush (.abr) file.');
}

/** Write a version 2 ABR with sampled brushes (uncompressed 8-bit). brushes: [{name,width,height,alpha,spacing}] */
export function buildAbr(brushes) {
  const parts = []; const push = (u) => parts.push(u);
  const u16 = (v) => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v); return b; };
  const u32 = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0); return b; };
  push(u16(2)); push(u16(brushes.length));
  for (const b of brushes) {
    const name = String(b.name || 'Brush').slice(0, 200), nameBytes = new Uint8Array((name.length + 1) * 2), nv = new DataView(nameBytes.buffer);
    for (let i = 0; i < name.length; i++) nv.setUint16(i * 2, name.charCodeAt(i));
    const body = [u32(0), u16(Math.round(b.spacing || 25)), u32(name.length + 1), nameBytes, new Uint8Array([1]), u16(0), u16(0), u16(b.height), u16(b.width), u32(0), u32(0), u32(b.height), u32(b.width), u16(8), new Uint8Array([0]), b.alpha];
    let n = 0; for (const x of body) n += x.length;
    push(u16(2)); push(u32(n)); for (const x of body) push(x);
  }
  return new Blob(parts, { type: 'application/octet-stream' });
}
