// Retouching tools: Smudge, Blur, Sharpen, Clone Stamp, Healing Brush, Spot Healing Brush and Mixer Brush.
// They edit the layer's pixels directly while you drag, and record the whole stroke as one undo step.
import { makeCanvas, ctxOf, clamp, hexToRgb, toast } from './util.js';
import { renderFull } from './render.js';

const svg = (d) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICONS = {
  smudge: svg('<path d="M7 17c0-3 2-4 4-6 1.5-1.5 2-3.5 4-5l3 3c-1.5 2-3.5 2.5-5 4-2 2-3 4-6 4z"/><path d="M5 20c2 0 5-.5 7-2"/>'),
  blurTool: svg('<path d="M12 4c3 4.5 6 7 6 10.5a6 6 0 01-12 0C6 11 9 8.5 12 4z"/>'),
  sharpenTool: svg('<path d="M12 4l7 14H5z"/><path d="M12 10v4"/>'),
  clone: svg('<path d="M9 20h6M12 20v-5M8 15h8l-1-6a3 3 0 00-6 0zM10 6a2 2 0 114 0"/>'),
  heal: svg('<rect x="4" y="9" width="16" height="6" rx="3" transform="rotate(-35 12 12)"/><path d="M10.5 10.5l3 3M12 9l3 3M9 12l3 3"/>'),
  spotHeal: svg('<circle cx="12" cy="12" r="6" stroke-dasharray="2 2.6"/><path d="M12 9.5v5M9.5 12h5"/>'),
  mixer: svg('<path d="M19 3.5l1.5 1.5-8 8-2-2z"/><path d="M9.5 11.5c-2.6 0-3.5 1.8-3.5 3.3 0 1.4-.8 2.6-2 3.2"/><path d="M4 20c2 .5 6 .5 9-2s3-2.5 5-2.5"/>'),
};

const RT_DEFAULTS = { size: 40, hardness: 50, strength: 50 };

// ── small float helpers (premultiplied RGBA in Float32Array) ──
/** Box-blur a w x h premultiplied float region (edge clamped), `iter` passes. */
function blurF(px, w, h, r, iter = 2) {
  if (r < 1) return px;
  let a = px, b = new Float32Array(px.length);
  for (let it = 0; it < iter; it++) {
    for (let j = 0; j < h; j++) for (let c = 0; c < 4; c++) {
      const o = j * w * 4 + c; let sum = a[o] * (r + 1);
      for (let i = 0; i < r; i++) sum += a[o + Math.min(i, w - 1) * 4];
      for (let i = 0; i < w; i++) { sum += a[o + Math.min(i + r, w - 1) * 4] - a[o + Math.max(i - r - 1, 0) * 4]; b[o + i * 4] = sum / (2 * r + 1); }
    }
    for (let i = 0; i < w; i++) for (let c = 0; c < 4; c++) {
      const o = i * 4 + c, st = w * 4; let sum = b[o] * (r + 1);
      for (let j = 0; j < r; j++) sum += b[o + Math.min(j, h - 1) * st];
      for (let j = 0; j < h; j++) { sum += b[o + Math.min(j + r, h - 1) * st] - b[o + Math.max(j - r - 1, 0) * st]; a[o + j * st] = sum / (2 * r + 1); }
    }
    if (a === px) { /* in place result is in px */ }
  }
  return a;
}
/** Premultiplied float copy of ImageData-like straight RGBA bytes. */
function toF(d, n) { const o = new Float32Array(n * 4); for (let i = 0; i < n; i++) { const a = d[i * 4 + 3] / 255; o[i * 4] = d[i * 4] * a; o[i * 4 + 1] = d[i * 4 + 1] * a; o[i * 4 + 2] = d[i * 4 + 2] * a; o[i * 4 + 3] = d[i * 4 + 3]; } return o; }
/** Region of straight RGBA bytes (a full-layer plane) as premultiplied floats; outside the plane is transparent. */
function planeRegion(P, pw, ph, x, y, w, h) {
  const o = new Float32Array(w * h * 4);
  for (let j = 0; j < h; j++) { const yy = y + j; if (yy < 0 || yy >= ph) continue; for (let i = 0; i < w; i++) { const xx = x + i; if (xx < 0 || xx >= pw) continue; const k = (yy * pw + xx) * 4, q = (j * w + i) * 4, a = P[k + 3] / 255; o[q] = P[k] * a; o[q + 1] = P[k + 1] * a; o[q + 2] = P[k + 2] * a; o[q + 3] = P[k + 3]; } }
  return o;
}

class Retouch {
  constructor(app, id, name, key, group, extra = {}) {
    this.app = app; this.id = id; this.name = name; this.key = key; this.group = group; this.icon = ICONS[id] || ICONS.smudge;
    this.defaults = { ...RT_DEFAULTS, ...(extra.defaults || {}) };
    this.options = [
      { key: 'size', label: 'Size', type: 'number', min: 1, max: 2000, slider: [1, 300], suffix: 'px' },
      { key: 'hardness', label: 'Hardness', type: 'number', min: 0, max: 100, suffix: '%' },
      { key: 'strength', label: extra.strengthLabel || 'Strength', type: 'number', min: 1, max: 100, suffix: '%' },
      ...(extra.options || []),
    ];
    this.hint = extra.hint || ''; this.spacing = extra.spacing || 0.1; this.s = null; this.cursor = 'crosshair';
  }
  get o() { return { ...RT_DEFAULTS, ...this.defaults, ...this.app.opts(this.id, this.defaults) }; }
  ring() { return this.o.size / 2; }
  ready() {
    const doc = this.app.doc; if (!doc) return null;
    const L = doc.active;
    if (!L) { toast('Add or select a layer first.'); return null; }
    if (L.type !== 'raster') { toast('Select a regular layer (this tool paints on pixels).'); return null; }
    if (L.editMask && L.mask) { toast('This tool works on layer pixels, not masks.'); return null; }
    if (!L.visible) { toast('That layer is hidden.'); return null; }
    if (L.lockAll || L.lockPix) { toast('That layer is locked.'); return null; }
    return L;
  }
  /** Alt-click to set a sample point (Clone and Healing). */
  setSource(c) { this.src = { x: Math.round(c.x), y: Math.round(c.y) }; this.off = null; this.app.vp.drawOverlay(); }
  down(c) {
    if (this.needsSource && c.e.altKey) { this.setSource(c); return; }
    const L = this.ready(); if (!L) return;
    const doc = this.app.doc, o = this.o;
    if (this.needsSource && !this.src) { toast('Alt-click first to choose the area to copy from.'); return; }
    doc.rasterizeText(L);
    L.ensureRect(0, 0, doc.w, doc.h);   // make the layer cover the document so it can be retouched anywhere
    const g = ctxOf(L.canvas), base = g.getImageData(0, 0, L.canvas.width, L.canvas.height);
    const s = this.s = { L, base, pw: L.canvas.width, ph: L.canvas.height, o, dirty: null, last: { x: c.x, y: c.y }, carry: 0, seed: 7919, sel: null, flat: null };
    if (doc.sel) {   // selection alpha over the layer's pixels
      const sc = makeCanvas(s.pw, s.ph, false), sg = ctxOf(sc); sg.drawImage(doc.sel.canvas, doc.sel.x - L.x, doc.sel.y - L.y);
      const sd = sg.getImageData(0, 0, s.pw, s.ph).data, a = new Uint8Array(s.pw * s.ph); for (let i = 0; i < a.length; i++) a[i] = sd[i * 4 + 3]; s.sel = a;
    }
    if (this.needsSource) {
      if (!this.off || !o.aligned) this.off = { x: this.src.x - Math.round(c.x), y: this.src.y - Math.round(c.y) };
      if (o.sample === 'all') { const f = renderFull(doc.layers, doc.w, doc.h, {}); s.flat = { data: ctxOf(f).getImageData(0, 0, f.width, f.height).data, w: f.width, h: f.height, ox: 0, oy: 0 }; }
    }
    if (this.begin) this.begin(s, c);
    this.dab(c.x, c.y);
  }
  rnd(s) { s.seed = (s.seed * 1664525 + 1013904223) >>> 0; return s.seed / 4294967296; }
  /** Plane the source reads from: the layer as it was when the stroke began, or the flattened document. */
  srcPlane(s) { return s.flat ? s.flat : { data: s.base.data, w: s.pw, h: s.ph, ox: s.L.x, oy: s.L.y }; }
  dab(x, y) {
    const s = this.s, L = s.L, o = s.o, r = Math.max(0.5, o.size / 2);
    const sx0 = Math.floor(x - r) - L.x, sy0 = Math.floor(y - r) - L.y, D = Math.ceil(r * 2) + 1;
    const cx0 = Math.max(0, sx0), cy0 = Math.max(0, sy0), cx1 = Math.min(s.pw, sx0 + D), cy1 = Math.min(s.ph, sy0 + D);
    const w = cx1 - cx0, h = cy1 - cy0; if (w <= 0 || h <= 0) return;
    const cur = ctxOf(L.canvas).getImageData(cx0, cy0, w, h), n = w * h, under = toF(cur.data, n);
    const mask = new Float32Array(n), hard = o.hardness / 100, str = o.strength / 100, ccx = x - L.x, ccy = y - L.y;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const d = Math.hypot(cx0 + i + 0.5 - ccx, cy0 + j + 0.5 - ccy) / r; let m = 1;
      if (d >= 1) m = 0; else if (d > hard) { const t = (d - hard) / Math.max(0.0001, 1 - hard); m = 1 - t * t * (3 - 2 * t); }
      if (m > 0 && s.sel) m *= s.sel[(cy0 + j) * s.pw + cx0 + i] / 255;
      mask[j * w + i] = m;
    }
    const reg = { x: cx0, y: cy0, w, h, n, under, mask, cx: ccx, cy: ccy, r, sx0, sy0, D, docX: x, docY: y };
    const res = this.compute(s, reg); if (!res) return;
    const out = res.out, over = !!res.over, op = res.opacity ?? str;
    for (let i = 0; i < n; i++) {
      const a = mask[i] * op; if (a <= 0) continue; const k = i * 4;
      let R, G, B, A;
      if (over) { const oa = out[k + 3] / 255, keep = 1 - a * oa; R = under[k] * keep + out[k] * a; G = under[k + 1] * keep + out[k + 1] * a; B = under[k + 2] * keep + out[k + 2] * a; A = under[k + 3] * keep + out[k + 3] * a; }
      else { R = under[k] + (out[k] - under[k]) * a; G = under[k + 1] + (out[k + 1] - under[k + 1]) * a; B = under[k + 2] + (out[k + 2] - under[k + 2]) * a; A = under[k + 3] + (out[k + 3] - under[k + 3]) * a; }
      A = clamp(A, 0, 255); const inv = A > 0 ? 255 / A : 0;
      cur.data[k] = R * inv; cur.data[k + 1] = G * inv; cur.data[k + 2] = B * inv; cur.data[k + 3] = A;
    }
    ctxOf(L.canvas).putImageData(cur, cx0, cy0);
    L.touch();
    const rect = { x: cx0 + L.x, y: cy0 + L.y, w, h };
    s.dirty = s.dirty ? unionRect(s.dirty, rect) : rect;
    this.app.vp.invalidate(rect);
  }
  move(c) {
    const s = this.s; if (!s) return;
    const sp = Math.max(1, s.o.size * this.spacing), dx = c.x - s.last.x, dy = c.y - s.last.y, dist = Math.hypot(dx, dy);
    this.cursorPt = { x: c.x, y: c.y };
    if (!dist) return;
    let t = sp - s.carry;
    while (t <= dist) { this.dab(s.last.x + (dx * t) / dist, s.last.y + (dy * t) / dist); t += sp; }
    s.carry = dist - (t - sp); s.last = { x: c.x, y: c.y };
  }
  up() {
    const s = this.s; if (!s) return; this.s = null;
    const doc = this.app.doc, L = s.L, r = s.dirty;
    if (!r) return;
    const lx = r.x - L.x, ly = r.y - L.y, bx = Math.max(0, lx), by = Math.max(0, ly), ex = Math.min(s.pw, lx + r.w), ey = Math.min(s.ph, ly + r.h), w = ex - bx, h = ey - by;
    if (w <= 0 || h <= 0) return;
    const before = new ImageData(w, h);
    for (let j = 0; j < h; j++) before.data.set(s.base.data.subarray(((by + j) * s.pw + bx) * 4, ((by + j) * s.pw + bx + w) * 4), j * w * 4);
    const after = ctxOf(L.canvas).getImageData(bx, by, w, h);
    doc.pushPatch(L, { x: bx + L.x, y: by + L.y, w, h }, before, after, this.name);
  }
  cancel() {
    const s = this.s; if (!s) return; this.s = null;
    ctxOf(s.L.canvas).putImageData(s.base, 0, 0); s.L.touch(); this.app.vp.invalidate();
  }
  drawOverlay(g, vp) {
    if (!this.needsSource || !this.src) return;
    const v = vp.doc.view, dpr = vp.dpr; let p = this.src;
    if (this.s && this.off && this.cursorPt) p = { x: this.cursorPt.x + this.off.x, y: this.cursorPt.y + this.off.y };
    else if (this.off && vp.cursor) { const d = vp.toDoc(vp.cursor.dx, vp.cursor.dy); p = { x: d.x + this.off.x, y: d.y + this.off.y }; }
    const sx = p.x * v.zoom + v.tx, sy = p.y * v.zoom + v.ty, rr = (this.o.size / 2) * v.zoom;
    g.save(); g.lineWidth = Math.max(1, dpr); g.strokeStyle = 'rgba(0,0,0,.85)'; g.beginPath(); g.arc(sx, sy, rr, 0, 6.2832); g.stroke();
    g.strokeStyle = '#fff'; g.beginPath(); g.arc(sx, sy, Math.max(1, rr - dpr), 0, 6.2832); g.moveTo(sx - 7 * dpr, sy); g.lineTo(sx + 7 * dpr, sy); g.moveTo(sx, sy - 7 * dpr); g.lineTo(sx, sy + 7 * dpr); g.stroke(); g.restore();
  }
}
function unionRect(a, b) { const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y); return { x: x0, y: y0, w: Math.max(a.x + a.w, b.x + b.w) - x0, h: Math.max(a.y + a.h, b.y + b.h) - y0 }; }

// ── Smudge ──
class SmudgeTool extends Retouch {
  constructor(app) { super(app, 'smudge', 'Smudge Tool', 'r', 'retouch', { defaults: { finger: false }, options: [{ key: 'finger', label: 'Finger Painting', type: 'check' }], hint: 'Drag to smear pixels. Finger Painting starts each stroke with the foreground color.', spacing: 0.06 }); }
  begin(s) { s.carryBuf = null; }
  compute(s, g) {
    const D = g.D, ox = g.x - g.sx0 - s.L.x * 0, oy = g.y - g.sy0;
    if (!s.carryBuf) {
      s.carryBuf = new Float32Array(D * D * 4);
      if (s.o.finger) { const [R, G, B] = hexToRgb(this.app.fg); for (let i = 0; i < D * D; i++) { s.carryBuf.set([R, G, B, 255], i * 4); } }
      else for (let j = 0; j < g.h; j++) for (let i = 0; i < g.w; i++) { const a = ((j + oy) * D + i + ox) * 4, b = (j * g.w + i) * 4; for (let c = 0; c < 4; c++) s.carryBuf[a + c] = g.under[b + c]; }
    }
    const out = new Float32Array(g.n * 4), keep = s.o.strength / 100;
    for (let j = 0; j < g.h; j++) for (let i = 0; i < g.w; i++) {
      const a = ((j + oy) * D + i + ox) * 4, b = (j * g.w + i) * 4;
      for (let c = 0; c < 4; c++) { out[b + c] = s.carryBuf[a + c]; s.carryBuf[a + c] = s.carryBuf[a + c] * keep + g.under[b + c] * (1 - keep); }
    }
    return { out, opacity: 1 };
  }
}
// ── Blur / Sharpen ──
class BlurTool extends Retouch {
  constructor(app, sharpen) { super(app, sharpen ? 'sharpenTool' : 'blurTool', sharpen ? 'Sharpen Tool' : 'Blur Tool', 'r', 'retouch', { hint: sharpen ? 'Paint to sharpen detail.' : 'Paint to soften.', spacing: 0.1 }); this.sharpen = sharpen; }
  compute(s, g) {
    const rad = clamp(Math.round(s.o.size * 0.05), 1, 8), bl = blurF(new Float32Array(g.under), g.w, g.h, rad, 2);
    if (!this.sharpen) return { out: bl, opacity: (s.o.strength / 100) * 0.9 };
    const out = new Float32Array(g.under.length);
    for (let i = 0; i < out.length; i += 4) { const a = g.under[i + 3]; for (let c = 0; c < 3; c++) out[i + c] = clamp(g.under[i + c] + (g.under[i + c] - bl[i + c]) * 1.6, 0, a); out[i + 3] = a; }
    return { out, opacity: (s.o.strength / 100) * 0.6 };
  }
}
// ── Clone Stamp / Healing ──
class CloneTool extends Retouch {
  constructor(app) { super(app, 'clone', 'Clone Stamp Tool', 's', 'clone', { defaults: { hardness: 70, strength: 100, aligned: true, sample: 'layer' }, strengthLabel: 'Opacity', spacing: 0.1,
    options: [{ key: 'aligned', label: 'Aligned', type: 'check' }, { key: 'sample', label: 'Sample', type: 'select', choices: [['layer', 'Current Layer'], ['all', 'All Layers']] }], hint: 'Alt-click to choose the source, then paint.' }); this.needsSource = true; }
  srcRegion(s, g) { const P = this.srcPlane(s); return planeRegion(P.data, P.w, P.h, g.x + s.L.x + this.off.x - P.ox, g.y + s.L.y + this.off.y - P.oy, g.w, g.h); }
  compute(s, g) { return { out: this.srcRegion(s, g), over: true, opacity: s.o.strength / 100 }; }
}
class HealTool extends CloneTool {
  constructor(app) { super(app); this.id = 'heal'; this.name = 'Healing Brush Tool'; this.key = 'j'; this.group = 'heal'; this.icon = ICONS.heal; this.defaults = { ...this.defaults, hardness: 60, strength: 100 };
    this.options = this.options.filter((d) => d.key !== 'sample'); this.hint = 'Alt-click a clean area, then paint over the flaw: texture comes from the source, color and light from around it.'; }
  compute(s, g) {
    const src = this.srcRegion(s, g), rad = Math.max(2, Math.round(s.o.size * 0.14)), big = Math.max(3, Math.round(s.o.size * 0.3));
    const srcLow = blurF(new Float32Array(src), g.w, g.h, rad, 2);
    const dst = planeRegion(s.base.data, s.pw, s.ph, g.x, g.y, g.w, g.h), dstLow = blurF(new Float32Array(dst), g.w, g.h, big, 2);
    return { out: healMix(g, src, srcLow, dstLow), opacity: s.o.strength / 100 };
  }
}
function healMix(g, src, srcLow, dstLow) {
  const out = new Float32Array(g.under.length);
  for (let i = 0; i < out.length; i += 4) { const a = g.under[i + 3]; for (let c = 0; c < 3; c++) out[i + c] = clamp(dstLow[i + c] + (src[i + c] - srcLow[i + c]), 0, a); out[i + 3] = a; }
  return out;
}
class SpotHealTool extends Retouch {
  constructor(app) { super(app, 'spotHeal', 'Spot Healing Brush Tool', 'j', 'heal', { defaults: { size: 30, hardness: 70, strength: 100 }, spacing: 0.25, hint: 'Click or drag over a blemish: it is repaired from the surroundings automatically.' }); }
  compute(s, g) {
    const r = g.r, ringPts = 20, rr = r * 1.25, cands = []; const base = s.base.data, pw = s.pw, ph = s.ph;
    const at = (x, y) => { x = Math.round(x); y = Math.round(y); if (x < 0 || y < 0 || x >= pw || y >= ph) return null; const k = (y * pw + x) * 4; return [base[k], base[k + 1], base[k + 2]]; };
    const ring = []; for (let i = 0; i < ringPts; i++) { const a = (i / ringPts) * 6.2832; ring.push(at(g.cx + Math.cos(a) * rr, g.cy + Math.sin(a) * rr)); }
    let best = null, bd = 1e18;
    for (const mult of [2.6, 3.8]) for (let k = 0; k < 12; k++) {
      const a = (k / 12) * 6.2832, ox = Math.cos(a) * r * mult, oy = Math.sin(a) * r * mult; let ssd = 0, cnt = 0;
      for (let i = 0; i < ringPts; i++) { const p = ring[i]; if (!p) continue; const a2 = (i / ringPts) * 6.2832, q = at(g.cx + ox + Math.cos(a2) * rr, g.cy + oy + Math.sin(a2) * rr); if (!q) { ssd = 1e18; break; } ssd += (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2; cnt++; }
      if (cnt > 4 && ssd / cnt < bd) { bd = ssd / cnt; best = { x: ox, y: oy }; }
    }
    if (!best) return null;
    const src = planeRegion(base, pw, ph, g.x + Math.round(best.x), g.y + Math.round(best.y), g.w, g.h), rad = Math.max(2, Math.round(s.o.size * 0.14));
    const srcLow = blurF(new Float32Array(src), g.w, g.h, rad, 2), dstLow = new Float32Array(src.length);
    let mr = 0, mg = 0, mb = 0, mn = 0;   // the colour of the surroundings is the low-frequency base
    for (const p of ring) if (p) { mr += p[0]; mg += p[1]; mb += p[2]; mn++; }
    if (!mn) return null;
    for (let i = 0; i < dstLow.length; i += 4) { dstLow[i] = mr / mn; dstLow[i + 1] = mg / mn; dstLow[i + 2] = mb / mn; dstLow[i + 3] = 255; }
    return { out: healMix(g, src, srcLow, dstLow), opacity: s.o.strength / 100 };
  }
}
// ── Mixer Brush ──
class MixerTool extends Retouch {
  constructor(app) { super(app, 'mixer', 'Mixer Brush Tool', 'b', 'brush', { defaults: { hardness: 70, strength: 60, wet: 40, load: 80 }, strengthLabel: 'Flow', spacing: 0.08,
    options: [{ key: 'wet', label: 'Wet', type: 'number', min: 0, max: 100, suffix: '%' }, { key: 'load', label: 'Load', type: 'number', min: 0, max: 100, suffix: '%' }], hint: 'Paints with the foreground color and blends it with what is already on the layer. Wet: how much canvas color is picked up. Load: how much fresh paint is refilled.' }); }
  begin(s) { const [R, G, B] = hexToRgb(this.app.fg); s.res = [R, G, B]; }
  compute(s, g) {
    let r = 0, gr = 0, b = 0, w = 0;   // canvas colour under the brush (alpha weighted)
    for (let i = 0; i < g.n; i++) { const m = g.mask[i], a = g.under[i * 4 + 3] / 255; if (m <= 0 || a <= 0) continue; r += g.under[i * 4] / a * m * a; gr += g.under[i * 4 + 1] / a * m * a; b += g.under[i * 4 + 2] / a * m * a; w += m * a; }
    const wet = s.o.wet / 100, load = s.o.load / 100;
    let col = s.res;
    if (w > 0.01) { const u = [r / w, gr / w, b / w], cover = clamp(w / Math.max(1, g.mask.reduce((p, q) => p + q, 0)), 0, 1); col = col.map((v, i) => v + (u[i] - v) * wet * cover); }
    const [fr, fg2, fb] = hexToRgb(this.app.fg); s.res = col.map((v, i) => v + ([fr, fg2, fb][i] - v) * load);
    const out = new Float32Array(g.under.length); for (let i = 0; i < g.n; i++) { out[i * 4] = col[0]; out[i * 4 + 1] = col[1]; out[i * 4 + 2] = col[2]; out[i * 4 + 3] = 255; }
    return { out, over: true, opacity: s.o.strength / 100 };
  }
}

export function createRetouchTools(app) {
  return [new SmudgeTool(app), new BlurTool(app, false), new BlurTool(app, true), new CloneTool(app), new HealTool(app), new SpotHealTool(app), new MixerTool(app)];
}
