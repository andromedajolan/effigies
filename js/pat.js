// Reader for Photoshop pattern files (.pat, "8BPT" version 1). Handles bitmap, grayscale, indexed and RGB patterns at 8 or 16 bits,
// raw or RLE (PackBits) channel data, with an optional alpha channel. CMYK/Lab patterns are skipped and reported.
const MODES = { 0: 'bitmap', 1: 'grayscale', 2: 'indexed', 3: 'RGB', 4: 'CMYK', 7: 'multichannel', 8: 'duotone', 9: 'Lab' };

function unpackBits(src, dst, rowsBytes) {   // one scanline of PackBits
  let i = 0, o = 0;
  while (o < rowsBytes && i < src.length) {
    const n = src[i++] << 24 >> 24;
    if (n >= 0) { for (let k = 0; k <= n && o < rowsBytes; k++) dst[o++] = src[i++]; }
    else if (n !== -128) { const v = src[i++]; for (let k = 0; k < 1 - n && o < rowsBytes; k++) dst[o++] = v; }
  }
}

/** Parse a .pat file. Returns {patterns: [{id, name, width, height, data(Uint8ClampedArray RGBA), mode}], skipped: [{name, reason}]}. Throws on a bad file. */
export function parsePat(buf) {
  const dv = new DataView(buf), u8 = new Uint8Array(buf);
  const sig = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
  if (sig !== '8BPT') throw new Error('This is not a Photoshop pattern (.pat) file.');
  const ver = dv.getUint16(4); if (ver !== 1) throw new Error('Unsupported .pat version ' + ver + '.');
  const count = dv.getUint32(6); let o = 10;
  const out = [], skipped = [];
  for (let n = 0; n < count && o < buf.byteLength - 16; n++) {
    const mode = dv.getUint32(o + 4), h = dv.getUint16(o + 8), w = dv.getUint16(o + 10); o += 12;
    const nl = dv.getUint32(o); o += 4;
    let name = ''; for (let i = 0; i < nl; i++) { const c = dv.getUint16(o + i * 2); if (c) name += String.fromCharCode(c); } o += nl * 2;
    const idl = u8[o]; let id = ''; for (let i = 0; i < idl; i++) id += String.fromCharCode(u8[o + 1 + i]); o += 1 + idl;
    let palette = null;
    if (mode === 2) { palette = u8.subarray(o, o + 768); o += 768 + 4; }
    const vlen = dv.getUint32(o + 4), vend = o + 8 + vlen;
    const nch = dv.getUint32(o + 24); let p = o + 28;
    const chans = [];
    for (let c = 0; c < nch + 2 && p + 4 <= vend; c++) {
      const flag = dv.getUint32(p); p += 4; if (!flag) continue;
      const ln = dv.getUint32(p), depth = dv.getUint32(p + 4);
      const top = dv.getUint32(p + 8), left = dv.getUint32(p + 12), bot = dv.getUint32(p + 16), right = dv.getUint32(p + 20);
      const comp = u8[p + 26], data = u8.subarray(p + 27, p + 4 + ln);
      chans.push({ depth, w: right - left, h: bot - top, comp, data }); p += 4 + ln;
    }
    o = vend;
    name = name.includes('=') ? name.split('=').pop() : name;    // "$$$/Presets/.../Stone=Stone"
    name = name.replace(/\.(jpg|jpeg|png|tif|tiff|psd)$/i, '').trim() || 'Pattern';
    if (!(mode in { 0: 1, 1: 1, 2: 1, 3: 1 })) { skipped.push({ name, reason: (MODES[mode] || 'mode ' + mode) + ' patterns are not supported' }); continue; }
    if (!w || !h || !chans.length) { skipped.push({ name, reason: 'empty pattern' }); continue; }
    try { out.push({ id: id || 'pat-' + n + '-' + name, name, width: w, height: h, mode: MODES[mode], data: decode(mode, w, h, chans, palette) }); }
    catch (e) { skipped.push({ name, reason: e.message }); }
  }
  if (!out.length && !skipped.length) throw new Error('No patterns found in this file.');
  return { patterns: out, skipped };
}

function decodeChannel(ch, w, h) {   // -> Uint8Array(w*h), 8-bit (16-bit is reduced to its high byte)
  const bpp = ch.depth === 16 ? 2 : ch.depth === 1 ? 0 : 1, rowBytes = bpp ? w * bpp : (w + 7) >> 3;
  const raw = new Uint8Array(rowBytes * h);
  if (ch.comp === 0) raw.set(ch.data.subarray(0, raw.length));
  else if (ch.comp === 1) {
    let p = h * 2;                                            // scanline byte counts first
    for (let y = 0; y < h; y++) {
      const cnt = (ch.data[y * 2] << 8) | ch.data[y * 2 + 1];
      unpackBits(ch.data.subarray(p, p + cnt), raw.subarray(y * rowBytes, (y + 1) * rowBytes), rowBytes); p += cnt;
    }
  } else throw new Error('compression type ' + ch.comp + ' is not supported');
  const out = new Uint8Array(w * h);
  if (ch.depth === 8) out.set(raw.subarray(0, w * h));
  else if (ch.depth === 16) for (let i = 0; i < w * h; i++) out[i] = raw[i * 2];
  else if (ch.depth === 1) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = (raw[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1 ? 0 : 255;
  else throw new Error('bit depth ' + ch.depth + ' is not supported');
  return out;
}

function decode(mode, w, h, chans, palette) {
  const px = new Uint8ClampedArray(w * h * 4), cs = chans.map((c) => decodeChannel(c, w, h));
  const need = mode === 3 ? 3 : 1;
  if (cs.length < need) throw new Error('missing colour channels');
  const alpha = cs.length > need ? cs[need] : null;
  for (let i = 0; i < w * h; i++) {
    let r, g, b;
    if (mode === 3) { r = cs[0][i]; g = cs[1][i]; b = cs[2][i]; }
    else if (mode === 2) { const k = cs[0][i]; r = palette[k]; g = palette[256 + k]; b = palette[512 + k]; }
    else r = g = b = cs[0][i];
    px[i * 4] = r; px[i * 4 + 1] = g; px[i * 4 + 2] = b; px[i * 4 + 3] = alpha ? alpha[i] : 255;
  }
  return px;
}
