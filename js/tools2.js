// Stage 2 tools: Marquee (rect / ellipse / single row / single column), Crop, Gradient, Paint Bucket.
import { makeCanvas, ctxOf, clamp, hexToRgb, toast, rectIntersect } from './util.js';
import { shapeSelection, combine, selRect, trim } from './select.js';
import { compose, releaseCanvas } from './render.js';
import { GRADIENTS, stopsFor, lut } from './gradients.js';
import { TypeTool } from './type.js';
export { GRADIENTS };

const svg = (d) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
export const ICONS2 = {
  'marquee-rect': svg('<rect x="4" y="5" width="16" height="14" stroke-dasharray="3 2.5"/>'),
  'marquee-ellipse': svg('<ellipse cx="12" cy="12" rx="8.5" ry="6.5" stroke-dasharray="3 2.5"/>'),
  'marquee-row': svg('<path d="M3 12h18" stroke-dasharray="3 2.5"/><path d="M5 8v8M19 8v8" opacity=".4"/>'),
  'marquee-col': svg('<path d="M12 3v18" stroke-dasharray="3 2.5"/><path d="M8 5h8M8 19h8" opacity=".4"/>'),
  crop: svg('<path d="M7 3v14h14M3 7h14v14"/>'),
  gradient: svg('<rect x="3.5" y="5" width="17" height="14" rx="1.5"/><path d="M6 16l12-8" stroke-dasharray="2 2"/>'),
  bucket: svg('<path d="M5 11l7-7 7 7-6 6a2.5 2.5 0 01-3.5 0zM5 11h14M20.5 16c0 1.4-1 2.5-1 2.5s-1-1.1-1-2.5a1 1 0 012 0z"/>'),
};

const MODES = [['new', 'New selection'], ['add', 'Add to selection'], ['sub', 'Subtract from selection'], ['int', 'Intersect with selection']];

// ───────────── Marquee ─────────────
class MarqueeTool {
  constructor(app, kind, name) {
    this.app = app; this.kind = kind; this.id = 'marquee-' + kind; this.optKey = 'marquee'; this.name = name; this.key = 'm'; this.group = 'marquee'; this.icon = ICONS2[this.id];
    this.defaults = { mode: 'new', feather: 0, antiAlias: true };
    this.options = [
      { key: 'mode', label: 'Mode', type: 'select', choices: MODES },
      { key: 'feather', label: 'Feather', type: 'number', min: 0, max: 250, suffix: 'px' },
    ];
    if (kind === 'ellipse') this.options.push({ key: 'antiAlias', label: 'Anti-alias', type: 'check' });
    this.cursor = 'crosshair'; this.drag = null;
    this.hint = 'Shift = square/circle, Alt = from center. Hold Shift/Alt before dragging to add/subtract.';
  }
  get o() { return this.app.opts(this.optKey, this.defaults); }
  rectOf(d, e) {
    let x0 = d.x, y0 = d.y, x1 = d.cx, y1 = d.cy;
    if (this.kind === 'row') { x0 = 0; x1 = this.app.doc.w; y0 = Math.floor(d.cy); y1 = y0 + 1; return { x: x0, y: y0, w: x1 - x0, h: 1 }; }
    if (this.kind === 'col') { y0 = 0; y1 = this.app.doc.h; x0 = Math.floor(d.cx); x1 = x0 + 1; return { x: x0, y: y0, w: 1, h: y1 - y0 }; }
    let dx = x1 - x0, dy = y1 - y0;
    if (e.shiftKey && d.constrain) { const m = Math.max(Math.abs(dx), Math.abs(dy)); dx = Math.sign(dx || 1) * m; dy = Math.sign(dy || 1) * m; }
    if (e.altKey && d.altOk) return { x: Math.min(x0 - dx, x0 + dx), y: Math.min(y0 - dy, y0 + dy), w: Math.abs(dx) * 2, h: Math.abs(dy) * 2 };
    return { x: Math.min(x0, x0 + dx), y: Math.min(y0, y0 + dy), w: Math.abs(dx), h: Math.abs(dy) };
  }
  down(c) {
    const doc = this.app.doc; if (!doc) return;
    const o = this.o; let mode = o.mode;
    const e = c.e;
    if (e.shiftKey && e.altKey) mode = 'int'; else if (e.shiftKey) mode = 'add'; else if (e.altKey) mode = 'sub';
    const sel = doc.sel;
    const inside = sel && c.x >= sel.x && c.y >= sel.y && c.x < sel.x + sel.canvas.width && c.y < sel.y + sel.canvas.height
      && ctxOf(sel.canvas).getImageData(Math.floor(c.x - sel.x), Math.floor(c.y - sel.y), 1, 1).data[3] > 127;
    if (mode === 'new' && inside && (this.kind === 'rect' || this.kind === 'ellipse')) { this.drag = { move: true, sx: c.x, sy: c.y, dx: 0, dy: 0 }; return; }
    this.drag = { x: c.x, y: c.y, cx: c.x, cy: c.y, mode, constrain: !e.shiftKey, altOk: !e.altKey, moved: false };
  }
  move(c) {
    const d = this.drag; if (!d) return;
    if (d.move) { d.dx = Math.round(c.x - d.sx); d.dy = Math.round(c.y - d.sy); this.app.vp.drawOverlay(); return; }
    if (!c.e.shiftKey) d.constrain = true;
    if (!c.e.altKey) d.altOk = true;
    d.cx = c.x; d.cy = c.y;
    if (Math.hypot(c.x - d.x, c.y - d.y) * this.app.vp.z > 2) d.moved = true;
    this.app.vp.drawOverlay();
  }
  up(c) {
    const d = this.drag; this.drag = null; if (!d) return;
    const doc = this.app.doc;
    if (d.move) {
      if (d.dx || d.dy) doc.setSelection({ canvas: doc.sel.canvas, x: doc.sel.x + d.dx, y: doc.sel.y + d.dy }, 'Move Selection');
      this.app.vp.drawOverlay(); return;
    }
    if (!d.moved && (this.kind === 'rect' || this.kind === 'ellipse')) { if (doc.sel) doc.setSelection(null, 'Deselect'); this.app.vp.drawOverlay(); return; }
    d.cx = c.x; d.cy = c.y;
    const r = this.rectOf(d, c.e), o = this.o;
    const shape = shapeSelection(this.kind === 'ellipse' ? 'ellipse' : 'rect', r, doc.w, doc.h, o.feather, o.antiAlias !== false);
    const next = combine(doc.sel, shape, d.mode, doc.w, doc.h);
    if (!next && !doc.sel) { this.app.vp.drawOverlay(); return; }
    doc.setSelection(next, d.mode === 'new' ? 'Marquee' : 'Modify Selection');
    this.app.vp.drawOverlay();
  }
  cancel() { this.drag = null; this.app.vp.drawOverlay(); }
  drawOverlay(g, vp) {
    const d = this.drag; if (!d) return;
    const z = vp.z, v = vp.doc.view;
    if (d.move) {
      const s = vp.doc.sel; g.save(); g.strokeStyle = '#fff'; g.setLineDash([5, 4]); g.strokeRect(Math.round((s.x + d.dx) * z + v.tx) + 0.5, Math.round((s.y + d.dy) * z + v.ty) + 0.5, s.canvas.width * z, s.canvas.height * z); g.restore(); return;
    }
    const r = this.rectOf(d, _modKeys);
    g.save(); g.lineWidth = Math.max(1, vp.dpr);
    const x = r.x * z + v.tx, y = r.y * z + v.ty, w = r.w * z, hh = r.h * z;
    for (const [col, off] of [['#000', 0], ['#fff', 4 * vp.dpr]]) {
      g.strokeStyle = col; g.setLineDash([4 * vp.dpr, 4 * vp.dpr]); g.lineDashOffset = off; g.beginPath();
      if (this.kind === 'ellipse') g.ellipse(x + w / 2, y + hh / 2, Math.max(0.5, w / 2), Math.max(0.5, hh / 2), 0, 0, 6.2832); else g.rect(x + 0.5, y + 0.5, w, hh);
      g.stroke();
    }
    g.restore();
  }
}
const _modKeys = { shiftKey: false, altKey: false };
// keep modifier state for overlay drawing while a drag is active
if (typeof document !== 'undefined') {
  const upd = (e) => { _modKeys.shiftKey = e.shiftKey; _modKeys.altKey = e.altKey; };
  document.addEventListener('keydown', upd); document.addEventListener('keyup', upd); document.addEventListener('pointermove', upd, true);
}

// ───────────── Crop ─────────────
const RATIOS = [['free', 'Free'], ['1', '1 : 1 (square cover)'], ['1.3333', '4 : 3'], ['1.5', '3 : 2'], ['1.7778', '16 : 9'], ['0.5625', '9 : 16 (story)'], ['0.8', '4 : 5 (portrait)']];
class CropTool {
  constructor(app) {
    this.app = app; this.id = 'crop'; this.name = 'Crop Tool'; this.key = 'c'; this.group = 'crop'; this.icon = ICONS2.crop;
    this.defaults = { ratio: 'free', deletePixels: true };
    this.options = [
      { key: 'ratio', label: 'Ratio', type: 'select', choices: RATIOS },
      { key: 'deletePixels', label: 'Delete Cropped Pixels', type: 'check' },
      { type: 'button', label: '✓ Crop (Enter)', run: (a) => a.tools.crop.commit() },
      { type: 'button', label: '✕ Cancel (Esc)', run: (a) => a.tools.crop.cancel() },
    ];
    this.cursor = 'crosshair'; this.box = null; this.drag = null;
    this.hint = 'Drag a box, adjust the handles, press Enter to crop.';
  }
  get o() { return this.app.opts(this.id, this.defaults); }
  handles() {
    const b = this.box; if (!b) return [];
    const mx = b.x + b.w / 2, my = b.y + b.h / 2, r = b.x + b.w, bt = b.y + b.h;
    return [['nw', b.x, b.y], ['n', mx, b.y], ['ne', r, b.y], ['e', r, my], ['se', r, bt], ['s', mx, bt], ['sw', b.x, bt], ['w', b.x, my]];
  }
  hit(c) {
    const vp = this.app.vp, tol = 9 * vp.dpr / vp.z;
    for (const [n, x, y] of this.handles()) if (Math.abs(c.x - x) < tol && Math.abs(c.y - y) < tol) return n;
    const b = this.box;
    if (b && c.x >= b.x && c.x <= b.x + b.w && c.y >= b.y && c.y <= b.y + b.h) return 'move';
    return null;
  }
  down(c) {
    const doc = this.app.doc; if (!doc) return;
    const h = this.hit(c);
    if (h) this.drag = { h, sx: c.x, sy: c.y, b: { ...this.box } };
    else { this.drag = { h: 'new', sx: c.x, sy: c.y, b: null }; this.box = { x: c.x, y: c.y, w: 0, h: 0 }; }
  }
  ratio() { const r = this.o.ratio; return r === 'free' ? 0 : Number(r); }
  move(c) {
    const d = this.drag; if (!d) return;
    const dx = c.x - d.sx, dy = c.y - d.sy, R = this.ratio();
    if (d.h === 'move') { this.box = { ...d.b, x: d.b.x + dx, y: d.b.y + dy }; }
    else if (d.h === 'new') {
      let w = dx, h = dy;
      if (R) { const m = Math.max(Math.abs(w), Math.abs(h / 1)); w = Math.sign(w || 1) * Math.max(Math.abs(w), Math.abs(h) * R); h = Math.sign(h || 1) * Math.abs(w) / R; }
      this.box = { x: Math.min(d.sx, d.sx + w), y: Math.min(d.sy, d.sy + h), w: Math.abs(w), h: Math.abs(h) };
    } else {
      let { x, y, w, h } = d.b; let x1 = x + w, y1 = y + h;
      if (d.h.includes('w')) x = Math.min(x + dx, x1 - 1); if (d.h.includes('e')) x1 = Math.max(x1 + dx, x + 1);
      if (d.h.includes('n')) y = Math.min(y + dy, y1 - 1); if (d.h.includes('s')) y1 = Math.max(y1 + dy, y + 1);
      w = x1 - x; h = y1 - y;
      if (R) {
        if (d.h === 'n' || d.h === 's') { w = h * R; } else { h = w / R; }
        if (d.h.includes('w')) x = x1 - w; if (d.h.includes('n')) y = y1 - h;
        if (d.h === 'n' || d.h === 's') x = d.b.x + d.b.w / 2 - w / 2;
        if (d.h === 'e' || d.h === 'w') y = d.b.y + d.b.h / 2 - h / 2;
      }
      this.box = { x, y, w, h };
    }
    this.app.vp.drawOverlay();
  }
  up() { this.drag = null; if (this.box && (this.box.w < 2 || this.box.h < 2)) this.box = null; this.app.vp.drawOverlay(); }
  commit() {
    const doc = this.app.doc, b = this.box; if (!doc || !b) return;
    if (doc.cropTo(b, this.o.deletePixels)) { toast(`Cropped to ${Math.round(b.w)} × ${Math.round(b.h)} px.`); }
    this.box = null; this.app.vp.drawOverlay();
  }
  cancel() { this.drag = null; this.box = null; this.app.vp.drawOverlay(); }
  enter() { if (this.box) { this.commit(); return true; } return false; }
  dblclick() { this.commit(); }
  drawOverlay(g, vp) {
    const b = this.box; if (!b) return;
    const z = vp.z, v = vp.doc.view, dpr = vp.dpr;
    const x = Math.round(b.x * z + v.tx), y = Math.round(b.y * z + v.ty), w = Math.round(b.w * z), h = Math.round(b.h * z);
    g.save(); g.fillStyle = 'rgba(0,0,0,.55)';
    g.beginPath(); g.rect(0, 0, vp.W, vp.H); g.rect(x, y, w, h); g.fill('evenodd');
    g.strokeStyle = '#fff'; g.lineWidth = Math.max(1, dpr); g.strokeRect(x + 0.5, y + 0.5, w, h);
    g.globalAlpha = 0.45; g.beginPath();
    for (const f of [1 / 3, 2 / 3]) { g.moveTo(x + w * f, y); g.lineTo(x + w * f, y + h); g.moveTo(x, y + h * f); g.lineTo(x + w, y + h * f); }
    g.stroke(); g.globalAlpha = 1;
    g.fillStyle = '#fff'; g.strokeStyle = '#000';
    for (const [, hx, hy] of this.handles()) { const px = Math.round(hx * z + v.tx), py = Math.round(hy * z + v.ty), s = 4 * dpr; g.fillRect(px - s, py - s, s * 2, s * 2); g.strokeRect(px - s + 0.5, py - s + 0.5, s * 2, s * 2); }
    g.restore();
  }
}

// ───────────── Gradient ─────────────
class GradientTool {
  constructor(app) {
    this.app = app; this.id = 'gradient'; this.name = 'Gradient Tool'; this.key = 'g'; this.group = 'gradient'; this.icon = ICONS2.gradient;
    this.defaults = { preset: 'fgbg', type: 'linear', reverse: false, opacity: 100 };
    this.options = [
      { key: 'preset', label: 'Gradient', type: 'select', choices: GRADIENTS },
      { key: 'type', label: 'Type', type: 'select', choices: [['linear', 'Linear'], ['radial', 'Radial'], ['angle', 'Angle'], ['reflected', 'Reflected'], ['diamond', 'Diamond']] },
      { key: 'reverse', label: 'Reverse', type: 'check' },
      { key: 'opacity', label: 'Opacity', type: 'number', min: 1, max: 100, suffix: '%' },
    ];
    this.cursor = 'crosshair'; this.drag = null;
    this.hint = 'Drag to set the start and end of the gradient. Shift snaps to 45°.';
  }
  get o() { return this.app.opts(this.id, this.defaults); }
  down(c) {
    const doc = this.app.doc, L = doc && doc.active;
    if (L && L.type === 'adjust') this.app.doc.paintableMask(L);
    else if (!L || L.type !== 'raster') { toast('Select a regular layer first.'); return; }
    if (!(L.editMask && L.mask) && (L.lockPix || L.lockAll)) { toast('That layer is locked.'); return; }
    this.drag = { x: c.x, y: c.y, cx: c.x, cy: c.y };
  }
  end(c) {
    const d = this.drag; let x = c.x, y = c.y;
    if (c.e.shiftKey) { const dx = x - d.x, dy = y - d.y, a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4), l = Math.hypot(dx, dy); x = d.x + Math.cos(a) * l; y = d.y + Math.sin(a) * l; }
    return { x, y };
  }
  move(c) { if (!this.drag) return; const e = this.end(c); this.drag.cx = e.x; this.drag.cy = e.y; this.app.vp.drawOverlay(); }
  up(c) {
    const d = this.drag; this.drag = null; if (!d) return;
    const e = this.end(c); this.app.vp.drawOverlay();
    if (Math.hypot(e.x - d.x, e.y - d.y) < 1) return;
    this.apply(d.x, d.y, e.x, e.y);
  }
  apply(x0, y0, x1, y1) {
    const doc = this.app.doc, L = doc.active, o = this.o;
    let rect = { x: 0, y: 0, w: doc.w, h: doc.h };
    if (doc.sel) { rect = rectIntersect(rect, selRect(doc.sel)); if (!rect) return; }
    const src = makeCanvas(rect.w, rect.h, true), g = ctxOf(src);
    const stops = stopsFor(o.preset, this.app.fg, this.app.bg), ax = x0 - rect.x, ay = y0 - rect.y, bx = x1 - rect.x, by = y1 - rect.y;
    const css = (c) => `rgba(${c[0]},${c[1]},${c[2]},${c[3]})`;
    const ordered = o.reverse ? stops.map(([t, c]) => [1 - t, c]).reverse() : stops;
    const len = Math.hypot(bx - ax, by - ay);
    if (o.type === 'linear' || o.type === 'radial' || o.type === 'reflected') {
      let gr;
      if (o.type === 'linear') gr = g.createLinearGradient(ax, ay, bx, by);
      else if (o.type === 'radial') gr = g.createRadialGradient(ax, ay, 0, ax, ay, len);
      else gr = g.createLinearGradient(ax - (bx - ax), ay - (by - ay), bx, by);
      if (o.type === 'reflected') { for (const [t, c] of ordered) { gr.addColorStop(0.5 + t / 2, css(c)); gr.addColorStop(0.5 - t / 2, css(c)); } }
      else for (const [t, c] of ordered) gr.addColorStop(t, css(c));
      g.fillStyle = gr; g.fillRect(0, 0, rect.w, rect.h);
    } else {
      const table = lut(stops, o.reverse), im = g.createImageData(rect.w, rect.h), D = im.data;
      const base = Math.atan2(by - ay, bx - ax), ux = (bx - ax) / (len || 1), uy = (by - ay) / (len || 1);
      for (let y = 0; y < rect.h; y++) for (let x = 0; x < rect.w; x++) {
        const px = x - ax, py = y - ay; let t;
        if (o.type === 'angle') { t = ((Math.atan2(py, px) - base) / 6.28318 + 2) % 1; }
        else { const along = Math.abs(px * ux + py * uy), across = Math.abs(-px * uy + py * ux); t = (along + across) / (len || 1); }
        const k = clamp(Math.round(t * 255), 0, 255) * 4, p = (y * rect.w + x) * 4;
        D[p] = table[k]; D[p + 1] = table[k + 1]; D[p + 2] = table[k + 2]; D[p + 3] = table[k + 3];
      }
      g.putImageData(im, 0, 0);
    }
    if (o.opacity < 100) { const t = makeCanvas(rect.w, rect.h, false), tg = t.getContext('2d'); tg.globalAlpha = o.opacity / 100; tg.drawImage(src, 0, 0); doc.paintToTarget(L, rect, 'Gradient', t); }
    else doc.paintToTarget(L, rect, 'Gradient', src);
  }
  cancel() { this.drag = null; this.app.vp.drawOverlay(); }
  drawOverlay(g, vp) {
    const d = this.drag; if (!d) return; const z = vp.z, v = vp.doc.view;
    g.save(); g.lineWidth = Math.max(1, vp.dpr);
    g.beginPath(); g.moveTo(d.x * z + v.tx, d.y * z + v.ty); g.lineTo(d.cx * z + v.tx, d.cy * z + v.ty);
    g.strokeStyle = '#000'; g.lineWidth = 3 * vp.dpr; g.stroke(); g.strokeStyle = '#fff'; g.lineWidth = vp.dpr; g.stroke();
    g.restore();
  }
}

// ───────────── Paint Bucket ─────────────
class BucketTool {
  constructor(app) {
    this.app = app; this.id = 'bucket'; this.name = 'Paint Bucket Tool'; this.key = 'g'; this.group = 'gradient'; this.icon = ICONS2.bucket;
    this.defaults = { tolerance: 32, contiguous: true, allLayers: false, antiAlias: true, opacity: 100 };
    this.options = [
      { key: 'tolerance', label: 'Tolerance', type: 'number', min: 0, max: 255 },
      { key: 'contiguous', label: 'Contiguous', type: 'check' },
      { key: 'allLayers', label: 'All Layers', type: 'check' },
      { key: 'antiAlias', label: 'Anti-alias', type: 'check' },
      { key: 'opacity', label: 'Opacity', type: 'number', min: 1, max: 100, suffix: '%' },
    ];
    this.cursor = 'crosshair';
    this.hint = 'Click to fill similar pixels with the foreground color.';
  }
  get o() { return this.app.opts(this.id, this.defaults); }
  sampleImage(doc, L, rect) {
    const o = this.o;
    if (L.editMask && L.mask) {   // sample the mask as gray
      const c = makeCanvas(rect.w, rect.h, true), g = ctxOf(c); g.drawImage(L.mask.canvas, L.x + L.mask.x - rect.x, L.y + L.mask.y - rect.y);
      const im = g.getImageData(0, 0, rect.w, rect.h), d = im.data; for (let i = 0; i < d.length; i += 4) { d[i] = d[i + 1] = d[i + 2] = d[i + 3]; d[i + 3] = 255; } return im;
    }
    if (o.allLayers) {
      const c = compose(doc.layers, { zoom: 1, tx: -rect.x, ty: -rect.y }, rect.w, rect.h, null, { x: rect.x, y: rect.y });
      const im = ctxOf(c).getImageData(0, 0, rect.w, rect.h); releaseCanvas(c); return im;
    }
    const c = makeCanvas(rect.w, rect.h, true), g = ctxOf(c);
    if (L.canvas) g.drawImage(L.canvas, L.x - rect.x, L.y - rect.y);
    return g.getImageData(0, 0, rect.w, rect.h);
  }
  down(c) {
    const doc = this.app.doc, L = doc && doc.active;
    if (L && L.type === 'adjust') this.app.doc.paintableMask(L);
    else if (!L || L.type !== 'raster') { toast('Select a regular layer first.'); return; }
    if (!(L.editMask && L.mask) && (L.lockPix || L.lockAll)) { toast('That layer is locked.'); return; }
    const rect = { x: 0, y: 0, w: doc.w, h: doc.h };
    const sx = Math.floor(c.x), sy = Math.floor(c.y);
    if (sx < 0 || sy < 0 || sx >= rect.w || sy >= rect.h) return;
    const o = this.o, im = this.sampleImage(doc, L, rect), D = im.data, W = rect.w, H = rect.h;
    const si = (sy * W + sx) * 4, tr = D[si], tg = D[si + 1], tb = D[si + 2], ta = D[si + 3], tol = o.tolerance;
    const match = (i) => Math.abs(D[i] - tr) <= tol && Math.abs(D[i + 1] - tg) <= tol && Math.abs(D[i + 2] - tb) <= tol && Math.abs(D[i + 3] - ta) <= tol;
    const fill = new Uint8Array(W * H);
    let minX = W, minY = H, maxX = -1, maxY = -1;
    if (o.contiguous) {
      const stack = [sx, sy];
      while (stack.length) {
        const y = stack.pop(), x0 = stack.pop();
        let x = x0; while (x >= 0 && !fill[y * W + x] && match((y * W + x) * 4)) x--; x++;
        let up = false, dn = false;
        for (; x < W && !fill[y * W + x] && match((y * W + x) * 4); x++) {
          fill[y * W + x] = 1; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
          if (y > 0) { const m = !fill[(y - 1) * W + x] && match(((y - 1) * W + x) * 4); if (m && !up) { stack.push(x, y - 1); up = true; } else if (!m) up = false; }
          if (y < H - 1) { const m = !fill[(y + 1) * W + x] && match(((y + 1) * W + x) * 4); if (m && !dn) { stack.push(x, y + 1); dn = true; } else if (!m) dn = false; }
        }
      }
    } else {
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (match((y * W + x) * 4)) { fill[y * W + x] = 1; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    }
    if (maxX < 0) return;
    const r = { x: Math.max(0, minX - 1), y: Math.max(0, minY - 1), w: 0, h: 0 }; r.w = Math.min(W, maxX + 2) - r.x; r.h = Math.min(H, maxY + 2) - r.y;
    const out = makeCanvas(r.w, r.h, true), og = ctxOf(out), oi = og.createImageData(r.w, r.h), [R, G, B] = hexToRgb(this.app.fg);
    const a = Math.round(o.opacity * 2.55);
    for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) if (fill[(y + r.y) * W + x + r.x]) { const p = (y * r.w + x) * 4; oi.data[p] = R; oi.data[p + 1] = G; oi.data[p + 2] = B; oi.data[p + 3] = a; }
    og.putImageData(oi, 0, 0);
    let src = out;
    if (o.antiAlias) { src = makeCanvas(r.w, r.h, false); const sg = src.getContext('2d'); sg.filter = 'blur(0.5px)'; sg.drawImage(out, 0, 0); sg.filter = 'none'; }
    doc.paintToTarget(L, r, 'Paint Bucket', src);
  }
}

export function createTools2(app) {
  return [
    new MarqueeTool(app, 'rect', 'Rectangular Marquee Tool'), new MarqueeTool(app, 'ellipse', 'Elliptical Marquee Tool'),
    new MarqueeTool(app, 'row', 'Single Row Marquee Tool'), new MarqueeTool(app, 'col', 'Single Column Marquee Tool'),
    new CropTool(app), new GradientTool(app), new BucketTool(app), new TypeTool(app),
  ];
}
