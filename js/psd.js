// Photoshop PSD reader and writer (8-bit RGB documents with layers, groups, masks, blend modes, opacity).
// Reading also accepts 16-bit, grayscale and CMYK files. Text, styles, smart objects and adjustment layers are not editable here:
// layers keep their rendered pixels and adjustment layers are skipped (the importer reports them).
import { makeCanvas, ctxOf } from './util.js';

const BLEND_IN = { 'norm': 'normal', 'diss': 'dissolve', 'dark': 'darken', 'mul ': 'multiply', 'idiv': 'colorburn', 'lbrn': 'linearburn', 'dkCl': 'darkercolor', 'lite': 'lighten', 'scrn': 'screen', 'div ': 'colordodge', 'lddg': 'lineardodge', 'lgCl': 'lightercolor', 'over': 'overlay', 'sLit': 'softlight', 'hLit': 'hardlight', 'vLit': 'vividlight', 'lLit': 'linearlight', 'pLit': 'pinlight', 'hMix': 'hardmix', 'diff': 'difference', 'smud': 'exclusion', 'fsub': 'subtract', 'fdiv': 'divide', 'hue ': 'hue', 'sat ': 'saturation', 'colr': 'color', 'lum ': 'luminosity', 'pass': 'pass' };
const BLEND_OUT = Object.fromEntries(Object.entries(BLEND_IN).map(([k, v]) => [v, k]));
const SKIP_KEYS = new Set(['levl', 'curv', 'brit', 'hue2', 'hue ', 'blnc', 'selc', 'mixr', 'grdm', 'phfl', 'thrs', 'post', 'nvrt', 'vibA', 'clrL', 'expA', 'blwh', 'CgEd', 'SoCo', 'GdFl', 'PtFl']);

class Reader {
  constructor(buf) { this.dv = new DataView(buf); this.u8 = new Uint8Array(buf); this.p = 0; }
  u8_() { return this.dv.getUint8(this.p++); }
  u16() { const v = this.dv.getUint16(this.p); this.p += 2; return v; }
  i16() { const v = this.dv.getInt16(this.p); this.p += 2; return v; }
  u32() { const v = this.dv.getUint32(this.p); this.p += 4; return v; }
  i32() { const v = this.dv.getInt32(this.p); this.p += 4; return v; }
  str(n) { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(this.u8[this.p + i]); this.p += n; return s; }
  skip(n) { this.p += n; }
}

function unpackBits(src, pos, rowBytes, out, off) {
  let o = 0;
  while (o < rowBytes) {
    const n = (src[pos++] << 24) >> 24;
    if (n >= 0) { for (let i = 0; i <= n && o < rowBytes; i++) out[off + o++] = src[pos++]; }
    else if (n !== -128) { const v = src[pos++]; for (let i = 0; i < 1 - n && o < rowBytes; i++) out[off + o++] = v; }
  }
  return pos;
}
async function inflate(bytes) {
  const ds = new DecompressionStream('deflate'), w = ds.writable.getWriter(); w.write(bytes); w.close();
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}
/** Decode one channel (w x h samples of `depth` bits) to bytes, one per sample. */
async function readChannel(R, end, w, h, depth) {
  const comp = R.u16(), bpp = depth === 16 ? 2 : depth === 8 ? 1 : 0;
  if (!bpp) throw new Error('Only 8 and 16 bit PSD files are supported.');
  const rowBytes = w * bpp, raw = new Uint8Array(rowBytes * h);
  if (w > 0 && h > 0) {
    if (comp === 0) { raw.set(R.u8.subarray(R.p, R.p + raw.length)); }
    else if (comp === 1) { const counts = []; for (let j = 0; j < h; j++) counts.push(R.u16()); let pos = R.p; for (let j = 0; j < h; j++) { unpackBits(R.u8, pos, rowBytes, raw, j * rowBytes); pos += counts[j]; } }
    else if (comp === 2 || comp === 3) {
      const un = await inflate(R.u8.subarray(R.p, end));
      if (comp === 3) { // delta (prediction) coding per row
        for (let j = 0; j < h; j++) { const o = j * rowBytes; if (bpp === 1) { for (let i = 1; i < w; i++) un[o + i] = (un[o + i] + un[o + i - 1]) & 255; } else { for (let i = 1; i < w; i++) { const k = o + i * 2, pk = k - 2, v = (((un[k] << 8) | un[k + 1]) + ((un[pk] << 8) | un[pk + 1])) & 65535; un[k] = v >> 8; un[k + 1] = v & 255; } } }
      }
      raw.set(un.subarray(0, raw.length));
    } else throw new Error('Unknown PSD compression ' + comp);
  }
  R.p = end;
  if (bpp === 1) return raw;
  const o = new Uint8Array(w * h); for (let i = 0; i < o.length; i++) o[i] = raw[i * 2];   // high byte of each 16-bit sample
  return o;
}
function toCanvas(chans, w, h, mode, hasAlpha) {
  const c = makeCanvas(Math.max(1, w), Math.max(1, h)), g = ctxOf(c); if (w <= 0 || h <= 0) return null;
  const im = g.createImageData(w, h), d = im.data, n = w * h;
  const A = chans.alpha;
  for (let i = 0; i < n; i++) {
    let r, gg, b;
    if (mode === 4) { const C = 255 - chans.c[0][i], M = 255 - chans.c[1][i], Y = 255 - chans.c[2][i], K = 255 - chans.c[3][i]; r = (C * K) / 255; gg = (M * K) / 255; b = (Y * K) / 255; }
    else if (mode === 1) { r = gg = b = chans.c[0][i]; }
    else { r = chans.c[0][i]; gg = chans.c[1][i]; b = chans.c[2][i]; }
    d[i * 4] = r; d[i * 4 + 1] = gg; d[i * 4 + 2] = b; d[i * 4 + 3] = A ? A[i] : 255;
  }
  g.putImageData(im, 0, 0); return c;
}

/** Parse a PSD. Returns {width, height, layers:[node], skipped:[name], flat}. node = {kind:'raster'|'group', name, visible, opacity, fill, blend, clip, x, y, canvas, mask, children}. */
export async function parsePsd(buf) {
  const R = new Reader(buf);
  if (R.str(4) !== '8BPS') throw new Error('That is not a Photoshop (PSD) file.');
  const ver = R.u16(); if (ver !== 1) throw new Error('Large Document (PSB) files are not supported.');
  R.skip(6); const nch = R.u16(), H = R.u32(), W = R.u32(), depth = R.u16(), mode = R.u16();
  if (![1, 3, 4].includes(mode)) throw new Error('Only RGB, grayscale and CMYK PSD files can be opened (this one is ' + ({ 0: 'bitmap', 2: 'indexed', 7: 'multichannel', 8: 'duotone', 9: 'Lab' }[mode] || 'another mode') + ').');
  if (depth !== 8 && depth !== 16) throw new Error('Only 8 and 16 bit PSD files can be opened.');
  R.skip(R.u32());      // colour mode data
  R.skip(R.u32());      // image resources
  const secLen = R.u32(), secEnd = R.p + secLen, out = { width: W, height: H, layers: [], skipped: [], flat: null };
  const need = mode === 4 ? 4 : mode === 1 ? 1 : 3;
  let records = [], layerInfoEnd = 0;
  const readLayerInfo = async (len) => {
    const start = R.p, end = start + len; if (len < 2) return;
    let count = R.i16(); const merged = count < 0; count = Math.abs(count);
    for (let i = 0; i < count; i++) records.push(readRecord(R, need));
    for (const rec of records) {
      rec.pix = {};
      for (const ch of rec.channels) {
        const cEnd = R.p + ch.len, isMask = ch.id === -2 || ch.id === -3;
        const rw = isMask ? rec.mask.right - rec.mask.left : rec.w, rh = isMask ? rec.mask.bottom - rec.mask.top : rec.h;
        if (ch.len < 2) { R.p = cEnd; continue; }
        if (isMask && ch.id === -3 && rec.pix[-2]) { R.p = cEnd; continue; }
        rec.pix[ch.id] = await readChannel(R, cEnd, rw, rh, depth);
      }
    }
    R.p = end; layerInfoEnd = end;
  };
  if (secLen > 0) {
    const liLen = R.u32();
    if (liLen > 0) await readLayerInfo(liLen);
    else { // 16/32-bit files keep layers in an 'Lr16' block after the (empty) layer info
      const gm = R.u32(); R.skip(gm);
      while (R.p + 12 <= secEnd) { const sig = R.str(4), key = R.str(4), len = R.u32(), s = R.p; if ((sig === '8BIM' || sig === '8B64') && (key === 'Lr16' || key === 'Lr32')) { await readLayerInfo(len); break; } R.p = s + len; if (len & 1) R.p++; }
    }
  }
  R.p = secEnd;
  // flattened image (used when there are no layers)
  const cmp = R.p < buf.byteLength ? R.u16() : -1;
  const buildTree = () => {
    const root = []; const stack = [root];
    for (const rec of records) {
      if (rec.divider === 3) { stack.push([]); continue; }
      if (rec.divider === 1 || rec.divider === 2) {
        const kids = stack.length > 1 ? stack.pop() : [];
        stack[stack.length - 1].push({ kind: 'group', name: rec.name, visible: rec.visible, opacity: rec.opacity, fill: 1, blend: rec.blend === 'pass' ? 'pass' : rec.blend, clip: false, collapsed: rec.divider === 2, x: 0, y: 0, canvas: null, mask: null, children: kids });
        continue;
      }
      if (rec.skip) { out.skipped.push(rec.name); continue; }
      const chans = { c: [], alpha: rec.pix[-1] || null };
      let ok = rec.w > 0 && rec.h > 0;
      for (let k = 0; k < need; k++) { if (!rec.pix[k]) { ok = false; break; } chans.c.push(rec.pix[k]); }
      const node = { kind: 'raster', name: rec.name, visible: rec.visible, opacity: rec.opacity, fill: rec.fill, blend: rec.blend, clip: rec.clip, x: rec.left, y: rec.top, canvas: ok ? toCanvas(chans, rec.w, rec.h, mode) : null, mask: null, children: null };
      if (rec.mask && rec.pix[-2] && rec.mask.right > rec.mask.left && rec.mask.bottom > rec.mask.top) node.mask = buildMask(rec, W, H);
      stack[stack.length - 1].push(node);
    }
    while (stack.length > 1) { const k = stack.pop(); stack[stack.length - 1].push(...k); }   // unbalanced groups: keep their content
    return root;
  };
  out.layers = buildTree();
  if (!records.length || !out.layers.length) {   // flat image
    if (cmp >= 0 && R.p < buf.byteLength) {
      const planes = []; const n = W * H, bpp = depth === 16 ? 2 : 1;
      if (cmp === 0) { for (let c = 0; c < Math.min(nch, 4); c++) { const p = new Uint8Array(n); for (let i = 0; i < n; i++) p[i] = R.u8[R.p + (c * n + i) * bpp]; planes.push(p); } }
      else if (cmp === 1) {
        const counts = []; const total = nch * H; for (let i = 0; i < total; i++) counts.push(R.u16()); let pos = R.p, ci = 0;
        for (let c = 0; c < Math.min(nch, 4); c++) { const raw = new Uint8Array(W * H * bpp); for (let j = 0; j < H; j++) { unpackBits(R.u8, pos, W * bpp, raw, j * W * bpp); pos += counts[c * H + j]; } const p = new Uint8Array(n); for (let i = 0; i < n; i++) p[i] = raw[i * bpp]; planes.push(p); ci++; }
      } else throw new Error('Unsupported flattened image compression.');
      const chans = { c: planes.slice(0, need), alpha: planes.length > need ? planes[need] : null };
      const c = toCanvas(chans, W, H, mode);
      out.layers = [{ kind: 'raster', name: 'Background', visible: true, opacity: 1, fill: 1, blend: 'normal', clip: false, x: 0, y: 0, canvas: c, mask: null, children: null }];
    }
  }
  return out;
}
function buildMask(rec, W, H) {
  const m = rec.mask, w = m.right - m.left, h = m.bottom - m.top, src = rec.pix[-2];
  const outside = m.def === 0 ? 255 : 0;      // alpha here means HIDDEN: a PSD mask that is 0 outside hides the layer there
  let cx0 = m.left, cy0 = m.top, cw = w, ch = h;
  if (m.def === 0) { cx0 = Math.min(m.left, 0); cy0 = Math.min(m.top, 0); cw = Math.max(m.right, W) - cx0; ch = Math.max(m.bottom, H) - cy0; }
  const c = makeCanvas(cw, ch), g = ctxOf(c), im = g.createImageData(cw, ch), d = im.data;
  for (let i = 0; i < cw * ch; i++) d[i * 4 + 3] = outside;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) d[((j + m.top - cy0) * cw + i + m.left - cx0) * 4 + 3] = 255 - src[j * w + i];
  g.putImageData(im, 0, 0);
  return { canvas: c, x: cx0, y: cy0, enabled: !(m.flags & 2) };   // x,y are document coordinates here
}
function readRecord(R, need) {
  const top = R.i32(), left = R.i32(), bottom = R.i32(), right = R.i32(), nc = R.u16(), channels = [];
  for (let i = 0; i < nc; i++) channels.push({ id: R.i16(), len: R.u32() });
  if (R.str(4) !== '8BIM') throw new Error('Damaged PSD layer record.');
  const bkey = R.str(4), opacity = R.u8_() / 255, clip = R.u8_() === 1, flags = R.u8_(); R.skip(1);
  const extra = R.u32(), extraEnd = R.p + extra, rec = { top, left, bottom, right, w: right - left, h: bottom - top, channels, blend: BLEND_IN[bkey] || 'normal', opacity, clip, visible: !(flags & 2), fill: 1, divider: 0, name: 'Layer', mask: null, skip: false };
  const ml = R.u32();
  if (ml >= 20) {
    const mend = R.p + ml, mt = R.i32(), mlf = R.i32(), mb = R.i32(), mr = R.i32(), def = R.u8_(), mflags = R.u8_();
    rec.mask = { top: mt, left: mlf, bottom: mb, right: mr, def, flags: mflags }; R.p = mend;
  } else R.p += ml;
  R.skip(R.u32());   // blending ranges
  const nlen = R.u8_(); let name = R.str(nlen); R.skip((4 - ((nlen + 1) % 4)) % 4); rec.name = name;
  while (R.p + 12 <= extraEnd) {
    const sig = R.str(4), key = R.str(4); let len = R.u32(); const s = R.p;
    if (sig !== '8BIM' && sig !== '8B64') break;
    if (key === 'luni') { const n = R.u32(); let t = ''; for (let i = 0; i < n; i++) { t += String.fromCharCode(R.u16()); } rec.name = t.replace(/\0+$/, '') || rec.name; }
    else if (key === 'lsct' || key === 'lsdk') { rec.divider = R.u32(); if (len >= 12 && R.str(4) === '8BIM') { const bk = R.str(4); if (rec.divider === 1 || rec.divider === 2) rec.blend = BLEND_IN[bk] || rec.blend; } }
    else if (key === 'iOpa') rec.fill = R.u8_() / 255;
    else if (SKIP_KEYS.has(key)) rec.skip = true;
    R.p = s + len + (len & 1);
  }
  R.p = extraEnd;
  return rec;
}

// ───────────── writer ─────────────
function packBitsRow(src, off, n, out) {
  let i = 0;
  while (i < n) {
    let run = 1; while (i + run < n && run < 128 && src[off + i + run] === src[off + i]) run++;
    if (run > 1) { out.push(257 - run, src[off + i]); i += run; continue; }
    let lit = 1; while (i + lit < n && lit < 128 && !(i + lit + 1 < n && src[off + i + lit] === src[off + i + lit + 1])) lit++;
    out.push(lit - 1); for (let k = 0; k < lit; k++) out.push(src[off + i + k]); i += lit;
  }
}
/** RLE-encode a w x h plane (1 byte per sample): returns bytes = [u16 compression=1][row counts][data]. */
function rlePlane(plane, w, h) {
  const rows = [], counts = new Uint16Array(h); let total = 0;
  for (let j = 0; j < h; j++) { const row = []; packBitsRow(plane, j * w, w, row); counts[j] = row.length; rows.push(row); total += row.length; }
  const out = new Uint8Array(2 + h * 2 + total), dv = new DataView(out.buffer); dv.setUint16(0, 1);
  for (let j = 0; j < h; j++) dv.setUint16(2 + j * 2, counts[j]);
  let p = 2 + h * 2; for (const r of rows) { out.set(r, p); p += r.length; }
  return out;
}
const planesOf = (canvas) => {
  const w = canvas.width, h = canvas.height, d = ctxOf(canvas).getImageData(0, 0, w, h).data, n = w * h, P = [new Uint8Array(n), new Uint8Array(n), new Uint8Array(n), new Uint8Array(n)];
  for (let i = 0; i < n; i++) { P[0][i] = d[i * 4]; P[1][i] = d[i * 4 + 1]; P[2][i] = d[i * 4 + 2]; P[3][i] = d[i * 4 + 3]; }
  return P;
};
class Writer {
  constructor() { this.parts = []; this.len = 0; }
  push(u8) { this.parts.push(u8); this.len += u8.length; }
  u16(v) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v); this.push(b); }
  i16(v) { const b = new Uint8Array(2); new DataView(b.buffer).setInt16(0, v); this.push(b); }
  u32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0); this.push(b); }
  i32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, v); this.push(b); }
  u8(v) { this.push(new Uint8Array([v])); }
  str(s) { this.push(new Uint8Array([...s].map((c) => c.charCodeAt(0)))); }
  zeros(n) { this.push(new Uint8Array(n)); }
  blob() { return new Blob(this.parts, { type: 'image/vnd.adobe.photoshop' }); }
}
const emptyChans = () => [0, 1, 2, 3].map(() => new Uint8Array([0, 0]));
function pascalName(name) {
  const a = [...unescape(encodeURIComponent(name)).slice(0, 255)].map((c) => c.charCodeAt(0) & 255), pad = (4 - ((a.length + 1) % 4)) % 4;
  return [a.length, ...a, ...new Array(pad).fill(0)];
}
function block(key, data) {   // additional layer information block, padded to even length
  const w = new Writer(); w.str('8BIM'); w.str(key); w.u32(data.length + (data.length & 1)); w.push(data); if (data.length & 1) w.u8(0);
  return concat(w.parts);
}
function concat(parts) { let n = 0; for (const p of parts) n += p.length; const o = new Uint8Array(n); let k = 0; for (const p of parts) { o.set(p, k); k += p.length; } return o; }
function u32b(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0); return b; }
function unicodeName(name) { const n = name.length, b = new Uint8Array(4 + n * 2), dv = new DataView(b.buffer); dv.setUint32(0, n); for (let i = 0; i < n; i++) dv.setUint16(4 + i * 2, name.charCodeAt(i)); return b; }

/**
 * Build a PSD from document data. layers: bottom-to-top tree of {kind, name, visible, opacity, fill, blend, clip, x, y, canvas, mask:{canvas,x,y(doc),enabled}, collapsed, children}.
 * flat: canvas of the composite (document size).
 */
export function buildPsd(width, height, layers, flat) {
  const records = [], chanData = [];
  const emit = (list) => {
    for (const L of list) {
      if (L.kind === 'group') {
        // bounding divider first (it sits below the group's children), then children, then the folder record
        records.push(groupRecord('</Layer group>', 3, { visible: true, opacity: 1, blend: 'pass' }, null)); chanData.push(emptyChans());
        emit(L.children);
        records.push(groupRecord(L.name, L.collapsed ? 2 : 1, L, null)); chanData.push(emptyChans());
        continue;
      }
      records.push(null); chanData.push(null); const idx = records.length - 1;
      const c = L.canvas, w = c ? c.width : 0, h = c ? c.height : 0, chans = [], datas = [];
      if (c && w > 0 && h > 0) {
        const P = planesOf(c);
        for (const [id, plane] of [[-1, P[3]], [0, P[0]], [1, P[1]], [2, P[2]]]) { const e = rlePlane(plane, w, h); chans.push([id, e.length]); datas.push(e); }
      } else for (const id of [-1, 0, 1, 2]) { chans.push([id, 2]); datas.push(new Uint8Array([0, 0])); }
      let maskRec = null;
      if (L.mask && L.mask.canvas) {
        const mc = L.mask.canvas, mw = mc.width, mh = mc.height, md = ctxOf(mc).getImageData(0, 0, mw, mh).data, pl = new Uint8Array(mw * mh);
        for (let i = 0; i < pl.length; i++) pl[i] = 255 - md[i * 4 + 3];   // our alpha is how much is hidden
        const e = rlePlane(pl, mw, mh); chans.push([-2, e.length]); datas.push(e);
        maskRec = { top: L.mask.y, left: L.mask.x, bottom: L.mask.y + mh, right: L.mask.x + mw, flags: L.mask.enabled === false ? 2 : 0 };
      }
      const rec = new Writer();
      const left = c ? L.x : 0, top = c ? L.y : 0;
      rec.i32(top); rec.i32(left); rec.i32(top + h); rec.i32(left + w); rec.u16(chans.length);
      for (const [id, len] of chans) { rec.i16(id); rec.u32(len); }
      rec.str('8BIM'); rec.str(BLEND_OUT[L.blend] && L.blend !== 'pass' ? BLEND_OUT[L.blend] : 'norm');
      rec.u8(Math.round(Math.max(0, Math.min(1, L.opacity)) * 255)); rec.u8(L.clip ? 1 : 0); rec.u8(L.visible ? 0 : 2); rec.u8(0);
      const extra = [];
      if (maskRec) { const m = new Writer(); m.i32(maskRec.top); m.i32(maskRec.left); m.i32(maskRec.bottom); m.i32(maskRec.right); m.u8(255); m.u8(maskRec.flags); m.zeros(2); extra.push(u32b(20), concat(m.parts)); } else extra.push(u32b(0));
      extra.push(u32b(0));   // blending ranges
      extra.push(new Uint8Array(pascalName(L.name)));
      extra.push(block('luni', unicodeName(L.name)), block('iOpa', new Uint8Array([Math.round(Math.max(0, Math.min(1, L.fill ?? 1)) * 255)])));
      const ex = concat(extra); rec.u32(ex.length); rec.push(ex);
      records[idx] = concat(rec.parts); chanData[idx] = datas;
    }
  };
  function groupRecord(name, type, L, _) {
    const rec = new Writer(); rec.i32(0); rec.i32(0); rec.i32(0); rec.i32(0); rec.u16(4);
    for (const id of [-1, 0, 1, 2]) { rec.i16(id); rec.u32(2); }
    rec.str('8BIM'); rec.str('pass'); rec.u8(Math.round(Math.max(0, Math.min(1, L.opacity)) * 255)); rec.u8(0); rec.u8(L.visible ? 0 : 2); rec.u8(0);
    const sect = new Writer(); sect.u32(type); if (type !== 3) { sect.str('8BIM'); sect.str(BLEND_OUT[L.blend] && L.blend !== 'pass' ? BLEND_OUT[L.blend] : 'pass'); }
    const extra = concat([u32b(0), u32b(0), new Uint8Array(pascalName(name)), block('luni', unicodeName(name)), block('lsct', concat(sect.parts))]);
    rec.u32(extra.length); rec.push(extra); return concat(rec.parts);
  }
  emit(layers);
  const li = new Writer(); li.i16(records.length);
  for (const r of records) li.push(r);
  for (const ds of chanData) for (const d of ds) li.push(d);
  let liLen = li.len; const pad = liLen & 1; if (pad) li.u8(0);
  const w = new Writer();
  w.str('8BPS'); w.u16(1); w.zeros(6); w.u16(3); w.u32(height); w.u32(width); w.u16(8); w.u16(3);
  w.u32(0); w.u32(0);   // colour mode data, image resources
  w.u32(4 + li.len + 4); w.u32(li.len); for (const p of li.parts) w.push(p); w.u32(0);   // layer info, global mask
  const P = planesOf(flat);
  const merged = [];
  const cnt = new Writer();
  w.u16(1);
  const encoded = [0, 1, 2].map((k) => { const rows = [], counts = new Uint16Array(height); for (let j = 0; j < height; j++) { const row = []; packBitsRow(P[k], j * width, width, row); counts[j] = row.length; rows.push(row); } return { rows, counts }; });
  for (const e of encoded) for (let j = 0; j < height; j++) w.u16(e.counts[j]);
  for (const e of encoded) for (const r of e.rows) w.push(new Uint8Array(r));
  return w.blob();
}
