// Tools for stage 1: Move, Brush (plain), Eraser (plain), Hand, Zoom, Eyedropper.
// Each tool: {id, name, key, group, icon, options[], down/move/up/cancel, ring()}
import { getBrushAlpha } from './brushes.js';
import { makeCanvas, ctxOf, clamp, hexToRgb, rgbToHex, toast, rectIntersect } from './util.js';
import { compose, releaseCanvas } from './render.js';
import { createTools2 } from './tools2.js';
import { createRetouchTools } from './retouch.js';

const svg = (d) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
export const ICONS = {
  move: svg('<path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/>'),
  brush: svg('<path d="M19 3.5l1.5 1.5-8.5 8.5-2-2zM9.5 11.5c-2.6 0-3.5 1.8-3.5 3.3 0 1.4-.8 2.6-2 3.2 3.2.6 7.5-.2 7.5-4.3z"/>'),
  eraser: svg('<path d="M4.5 15.5l9-9 6 6-6.5 6.5H8.5zM9 11l6 6M12 19h8"/>'),
  hand: svg('<path d="M8 13V6.5a1.5 1.5 0 013 0V11M11 11V4.5a1.5 1.5 0 013 0V11M14 11V6.5a1.5 1.5 0 013 0V13M17 11.5a1.5 1.5 0 013 0V15c0 4-3 6-6.5 6S8 19.5 6.5 17L4.5 13.5a1.5 1.5 0 012.5-1.5L8 13"/>'),
  zoom: svg('<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5.5 5.5M8 10.5h5M10.5 8v5"/>'),
  eyedropper: svg('<path d="M14.5 4.5l5 5-2.5 2.5-5-5zM12.5 7.5L4.5 15.5V19.5H8.5L16.5 11.5M4.5 19.5"/>'),
};

// ───────────── Brush engine ─────────────
export const BRUSH_DEFAULTS = { size: 40, hardness: 80, opacity: 100, flow: 100, spacing: 25, roundness: 100, angle: 0, scatter: 0, sizeJitter: 0, opacityJitter: 0, pressure: true, tip: 'round' };
export const ERASER_DEFAULTS = { ...BRUSH_DEFAULTS, size: 60, hardness: 90 };
export const TIPS = [['round', 'Round'], ['square', 'Square'], ['chalk', 'Chalk'], ['star', 'Star']];

let tipCache = { key: '', canvas: null };
let noiseTile = null;
function noise() {
  if (noiseTile) return noiseTile;
  const c = makeCanvas(64, 64, false), g = c.getContext('2d'), im = g.createImageData(64, 64);
  let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let i = 0; i < 64 * 64; i++) { im.data[i * 4 + 3] = rnd() < 0.62 ? 255 : 40 + rnd() * 90; }
  g.putImageData(im, 0, 0); noiseTile = c; return c;
}
/** A brush tip image (size x size) of the given colour; roundness and angle are applied when stamping. */
export function brushTip(size, hardness, color, shape = 'round') {
  let custom = null;
  if (shape.startsWith('c:')) { custom = getBrushAlpha(shape.slice(2)); if (!custom) shape = 'round'; }
  const key = size.toFixed(2) + '|' + hardness + '|' + color + '|' + shape;
  if (tipCache.key === key) return tipCache.canvas;
  const d = Math.max(1, Math.ceil(size) + 2), c = makeCanvas(d, d, false), g = c.getContext('2d');
  const r = size / 2, cx = d / 2;
  const [R, G, B] = hexToRgb(color);
  const soft = clamp(1 - hardness / 100, 0, 1);
  if (custom) {
    const k = size / Math.max(custom.width, custom.height), tw = custom.width * k, th = custom.height * k;
    g.imageSmoothingQuality = 'high'; g.drawImage(custom, cx - tw / 2, cx - th / 2, tw, th);
    g.globalCompositeOperation = 'source-in'; g.fillStyle = color; g.fillRect(0, 0, d, d); g.globalCompositeOperation = 'source-over';
    tipCache = { key, canvas: c }; return c;
  }
  if (shape === 'square' || shape === 'star') {
    g.fillStyle = color; g.beginPath();
    if (shape === 'square') g.rect(cx - r, cx - r, size, size);
    else for (let i = 0; i < 10; i++) { const rr = i % 2 ? r * 0.45 : r, a = -1.5708 + i * 0.62832; g.lineTo(cx + Math.cos(a) * rr, cx + Math.sin(a) * rr); }
    g.closePath(); g.fill();
    if (soft > 0.02 && size > 3) { const t = makeCanvas(d, d, false), tg = t.getContext('2d'); tg.filter = `blur(${soft * size * 0.18}px)`; tg.drawImage(c, 0, 0); g.clearRect(0, 0, d, d); g.drawImage(t, 0, 0); }
  } else if (hardness >= 99) {
    g.fillStyle = color; g.beginPath(); g.arc(cx, cx, Math.max(0.5, r), 0, 6.2832); g.fill();
  } else {
    const gr = g.createRadialGradient(cx, cx, 0, cx, cx, Math.max(0.5, r));
    const hh = clamp(hardness / 100, 0, 0.98);
    gr.addColorStop(0, `rgba(${R},${G},${B},1)`); gr.addColorStop(hh, `rgba(${R},${G},${B},1)`); gr.addColorStop(1, `rgba(${R},${G},${B},0)`);
    g.fillStyle = gr; g.fillRect(0, 0, d, d);
  }
  if (shape === 'chalk') {
    g.save(); g.globalCompositeOperation = 'destination-in';
    g.fillStyle = g.createPattern(noise(), 'repeat'); g.fillRect(0, 0, d, d); g.restore();
  }
  tipCache = { key, canvas: c };
  return c;
}

class StrokeTool {
  constructor(app, id, name, key, erase) {
    this.app = app; this.id = id; this.name = name; this.key = key; this.group = id; this.erase = erase; this.icon = ICONS[id];
    this.stroke = null;
    this.defaults = erase ? ERASER_DEFAULTS : BRUSH_DEFAULTS;
    this.options = [
      { key: 'size', label: 'Size', type: 'number', min: 1, max: 5000, slider: [1, 500], suffix: 'px' },
      { key: 'hardness', label: 'Hardness', type: 'number', min: 0, max: 100, suffix: '%' },
      { key: 'opacity', label: 'Opacity', type: 'number', min: 1, max: 100, suffix: '%' },
      { key: 'flow', label: 'Flow', type: 'number', min: 1, max: 100, suffix: '%' },
    ];
    this.hint = 'More controls (spacing, angle, scatter, jitter, tip) are in the Brush panel.';
  }
  get o() { return { ...BRUSH_DEFAULTS, ...this.app.opts(this.id, this.defaults) }; }
  ring() { return this.o.size / 2; }
  ready() {
    const doc = this.app.doc; if (!doc) return null;
    const L = doc.active;
    if (!L) { toast('Add or select a layer first.'); return null; }
    if (L.type === 'adjust') doc.paintableMask(L);
    else if (L.type !== 'raster') { toast('Select a regular layer (a group has no pixels).'); return null; }
    if (!L.visible) { toast('That layer is hidden.'); return null; }
    if (L.editMask && L.mask) return L;
    if (L.lockAll || L.lockPix) { toast('That layer is locked.'); return null; }
    if (this.erase && L.lockTrans) { toast('Unlock transparent pixels to erase.'); return null; }
    return L;
  }
  down(c) {
    const L = this.ready(); if (!L) return;
    const doc = this.app.doc, o = this.o, maskMode = !!(L.editMask && L.mask);
    let x0 = 0, y0 = 0, x1 = doc.w, y1 = doc.h;
    if (L.canvas) { x0 = Math.min(x0, L.x); y0 = Math.min(y0, L.y); x1 = Math.max(x1, L.x + L.w); y1 = Math.max(y1, L.y + L.h); }
    const s = this.stroke = { layer: L, canvas: makeCanvas(x1 - x0, y1 - y0, false), ox: x0, oy: y0, opacity: o.opacity / 100, erase: this.erase, last: null, carry: 0, dirty: null, pts: 0, maskMode, o,
      show: doc.sel ? makeCanvas(x1 - x0, y1 - y0, false) : null, pressure: 1, seed: (Math.random() * 1e9) | 0 };
    if (maskMode) {
      L.ensureMaskRect(x0, y0, x1, y1);
      const m = L.mask; s.bx = L.x + m.x; s.by = L.y + m.y; s.base = cloneCanvasPlain(m.canvas);
      const col = this.erase ? this.app.bg : this.app.fg; const [R, G, B] = hexToRgb(col);
      s.target = 1 - (0.299 * R + 0.587 * G + 0.114 * B) / 255;
    } else doc.live = s;
    this.pressure(c);
    this.dab(c.x, c.y);
    s.last = { x: c.x, y: c.y };
    this.flush();
  }
  pressure(c) { const s = this.stroke; s.pressure = (s.o.pressure && c.e && c.e.pointerType === 'pen' && c.e.pressure > 0) ? clamp(c.e.pressure * 1.25, 0.05, 1) : 1; }
  rnd() { const s = this.stroke; s.seed = (s.seed * 1664525 + 1013904223) >>> 0; return s.seed / 4294967296; }
  dab(x, y) {
    const s = this.stroke, o = s.o;
    const color = (this.erase || s.maskMode) ? '#000000' : this.app.fg;
    const size = Math.max(0.5, o.size * s.pressure * (1 - (o.sizeJitter / 100) * this.rnd()));
    if (o.scatter) { const sc = (o.scatter / 100) * o.size; x += (this.rnd() - 0.5) * 2 * sc; y += (this.rnd() - 0.5) * 2 * sc; }
    const tip = brushTip(o.size, o.hardness, color, o.tip);
    const g = s.canvas.getContext('2d');
    g.globalAlpha = (o.flow / 100) * (1 - (o.opacityJitter / 100) * this.rnd());
    const k = size / o.size, rd = o.roundness / 100, ang = o.angle * Math.PI / 180;
    const px = x - s.ox, py = y - s.oy;
    if (k === 1 && rd === 1 && !ang) g.drawImage(tip, px - tip.width / 2, py - tip.height / 2);
    else { g.save(); g.translate(px, py); g.rotate(ang); g.scale(k, k * rd); g.drawImage(tip, -tip.width / 2, -tip.height / 2); g.restore(); }
    const m = (tip.width / 2) * Math.max(k, 1) + 1;
    const r = { x: Math.floor(x - m), y: Math.floor(y - m), w: Math.ceil(m * 2) + 1, h: Math.ceil(m * 2) + 1 };
    const un = (a, b) => { if (!a) return b; const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y); return { x: x0, y: y0, w: Math.max(a.x + a.w, b.x + b.w) - x0, h: Math.max(a.y + a.h, b.y + b.h) - y0 }; };
    s.dirty = un(s.dirty, r); s.pend = un(s.pend, r);
  }
  /** Bring the "visible" copy (selection-clipped) and, for masks, the mask itself up to date for the pending rect. */
  flush() {
    const s = this.stroke; if (!s || !s.pend) return;
    const doc = this.app.doc;
    let r = rectIntersect(s.pend, { x: s.ox, y: s.oy, w: s.canvas.width, h: s.canvas.height }); s.pend = null;
    if (!r) return;
    if (s.show) {
      const g = s.show.getContext('2d');
      g.save(); g.beginPath(); g.rect(r.x - s.ox, r.y - s.oy, r.w, r.h); g.clip(); g.clearRect(r.x - s.ox, r.y - s.oy, r.w, r.h);
      g.drawImage(s.canvas, 0, 0);
      g.globalCompositeOperation = 'destination-in'; g.drawImage(doc.sel.canvas, doc.sel.x - s.ox, doc.sel.y - s.oy);
      g.restore();
    }
    if (s.maskMode) this.applyMask(r);
    this.app.vp.invalidate(r);
  }
  applyMask(r) {
    const s = this.stroke, L = s.layer, m = L.mask;
    const cov = (s.show || s.canvas).getContext('2d').getImageData(r.x - s.ox, r.y - s.oy, r.w, r.h).data;
    const base = s.base.getContext('2d').getImageData(r.x - s.bx, r.y - s.by, r.w, r.h);
    const d = base.data, t = s.target * 255;
    for (let i = 0; i < d.length; i += 4) {
      const a = (cov[i + 3] / 255) * s.opacity;
      d[i] = d[i + 1] = d[i + 2] = 0;
      d[i + 3] = d[i + 3] * (1 - a) + t * a;
    }
    ctxOf(m.canvas).putImageData(base, r.x - s.bx, r.y - s.by);
  }
  move(c) {
    const s = this.stroke; if (!s) return;
    const o = s.o, spacing = Math.max(1, o.size * (o.spacing / 100));
    this.pressure(c);
    const dx = c.x - s.last.x, dy = c.y - s.last.y, dist = Math.hypot(dx, dy);
    if (!dist) return;
    let t = spacing - s.carry;
    while (t <= dist) { this.dab(s.last.x + dx * t / dist, s.last.y + dy * t / dist); t += spacing; }
    s.carry = dist - (t - spacing);
    s.last = { x: c.x, y: c.y };
    this.flush();
  }
  up() {
    const s = this.stroke; if (!s) return;
    this.flush();
    this.stroke = null;
    const doc = this.app.doc; doc.live = null;
    const L = s.layer, r = s.dirty;
    if (!r) { this.app.vp.invalidate(); return; }
    const cl = { x: Math.max(r.x, s.ox), y: Math.max(r.y, s.oy), w: 0, h: 0 };
    cl.w = Math.min(r.x + r.w, s.ox + s.canvas.width) - cl.x; cl.h = Math.min(r.y + r.h, s.oy + s.canvas.height) - cl.y;
    if (cl.w <= 0 || cl.h <= 0) { this.app.vp.invalidate(); return; }
    if (s.maskMode) {
      const before = s.base.getContext('2d').getImageData(cl.x - s.bx, cl.y - s.by, cl.w, cl.h);
      const after = ctxOf(L.mask.canvas).getImageData(cl.x - s.bx, cl.y - s.by, cl.w, cl.h);
      L.touchMask();
      doc.pushMaskPatch(L, cl, before, after, this.erase ? 'Eraser (Mask)' : 'Brush Tool (Mask)');
      return;
    }
    const src = s.show || s.canvas;
    doc.editPixels(L, cl, this.erase ? 'Eraser' : 'Brush Tool', (g, ox, oy) => {
      g.save();
      g.globalAlpha = s.opacity;
      g.globalCompositeOperation = this.erase ? 'destination-out' : (L.lockTrans ? 'source-atop' : 'source-over');
      g.drawImage(src, 0, 0, src.width, src.height, s.ox + ox, s.oy + oy, src.width, src.height);
      g.restore();
    });
  }
  cancel() {
    const s = this.stroke; if (!s) return; this.stroke = null; this.app.doc.live = null;
    if (s.maskMode) { const m = s.layer.mask; if (m && s.base) { const g = ctxOf(m.canvas); g.clearRect(0, 0, m.canvas.width, m.canvas.height); g.drawImage(s.base, 0, 0); } }
    this.app.vp.invalidate();
  }
}
function cloneCanvasPlain(c) { const n = makeCanvas(c.width, c.height); ctxOf(n).drawImage(c, 0, 0); return n; }

// ───────────── Move ─────────────
class MoveTool {
  constructor(app) {
    this.app = app; this.id = 'move'; this.name = 'Move Tool'; this.key = 'v'; this.group = 'move'; this.icon = ICONS.move;
    this.defaults = { autoSelect: false };
    this.options = [{ key: 'autoSelect', label: 'Auto-Select Layer', type: 'check' }];
    this.drag = null;
    this.hint = 'Drag a layer onto another document’s tab to copy it there.';
  }
  pick(x, y) {
    const doc = this.app.doc;
    const walk = (list) => {
      for (let i = list.length - 1; i >= 0; i--) {
        const L = list[i]; if (!L.visible) continue;
        if (L.type === 'group') { const r = walk(L.children); if (r) return r; continue; }
        if (!L.canvas) continue;
        const lx = Math.floor(x - L.x), ly = Math.floor(y - L.y);
        if (lx < 0 || ly < 0 || lx >= L.w || ly >= L.h) continue;
        if (ctxOf(L.canvas).getImageData(lx, ly, 1, 1).data[3] > 8) return L;
      }
      return null;
    };
    return walk(doc.layers);
  }
  down(c) {
    const doc = this.app.doc;
    if (this.o.autoSelect) { const L = this.pick(c.x, c.y); if (L) { doc.activeId = L.id; doc.changed({ tree: true, skipRender: true }); } }
    const L = doc.active;
    if (!L) return;
    if (L.type === 'group') { toast('Select a regular layer to move.'); return; }
    if (L.lockPos || L.lockAll) { toast('That layer’s position is locked.'); return; }
    this.drag = { L, sx: c.x, sy: c.y, ox: L.x, oy: L.y, moved: false, tab: null };
  }
  get o() { return this.app.opts(this.id, this.defaults); }
  move(c) {
    const d = this.drag; if (!d) return;
    let nx = d.ox + Math.round(c.x - d.sx), ny = d.oy + Math.round(c.y - d.sy);
    const G = this.app.guides, L = d.L;
    if (G && L.canvas && !c.e.ctrlKey) {   // snap the layer's edges and centre to guides and the canvas edge
      nx += Math.round(G.snap('v', [nx, nx + L.w / 2, nx + L.w])); ny += Math.round(G.snap('h', [ny, ny + L.h / 2, ny + L.h]));
    }
    if (nx !== d.L.x || ny !== d.L.y) { d.L.x = nx; d.L.y = ny; d.moved = true; this.app.vp.invalidate(); }
    const el = document.elementFromPoint(c.e.clientX, c.e.clientY);
    const tab = el && el.closest && el.closest('.doc-tab');
    const id = tab && tab.dataset.id !== this.app.doc.id ? tab.dataset.id : null;
    if (id !== d.tab) { d.tab = id; this.app.highlightTab(id); }
  }
  up() {
    const d = this.drag; if (!d) return; this.drag = null;
    this.app.highlightTab(null);
    const doc = this.app.doc;
    if (d.tab) {
      d.L.x = d.ox; d.L.y = d.oy; d.L.touch(); this.app.vp.invalidate();
      this.app.copyLayerToDoc(d.L, d.tab);
      return;
    }
    if (d.moved) { doc.pushProps('Move', [{ layer: d.L, old: { x: d.ox, y: d.oy }, now: { x: d.L.x, y: d.L.y } }]); }
  }
  cancel() { const d = this.drag; if (!d) return; this.drag = null; d.L.x = d.ox; d.L.y = d.oy; this.app.highlightTab(null); this.app.vp.invalidate(); }
}

// ───────────── Hand / Zoom / Eyedropper ─────────────
class HandTool {
  constructor(app) {
    this.app = app; this.id = 'hand'; this.name = 'Hand Tool'; this.key = 'h'; this.group = 'hand'; this.icon = ICONS.hand;
    this.defaults = {}; this.options = [{ type: 'button', label: 'Fit Screen', run: (a) => a.vp.fit() }, { type: 'button', label: '100%', run: (a) => a.vp.zoomTo(1) }];
    this.cursor = 'grab';
  }
}
class ZoomTool {
  constructor(app) {
    this.app = app; this.id = 'zoom'; this.name = 'Zoom Tool'; this.key = 'z'; this.group = 'zoom'; this.icon = ICONS.zoom;
    this.defaults = {}; this.options = [{ type: 'button', label: 'Fit Screen', run: (a) => a.vp.fit() }, { type: 'button', label: '100%', run: (a) => a.vp.zoomTo(1) }];
    this.cursor = 'zoom-in'; this.drag = null;
    this.hint = 'Click to zoom in, Alt-click to zoom out, drag a box to zoom to it.';
  }
  down(c) { this.drag = { x: c.dev.x, y: c.dev.y, cx: c.dev.x, cy: c.dev.y, alt: c.e.altKey }; }
  move(c) { if (this.drag) { this.drag.cx = c.dev.x; this.drag.cy = c.dev.y; this.app.vp.drawOverlay(); } }
  up(c) {
    const d = this.drag; this.drag = null; const vp = this.app.vp;
    if (!d) return;
    const w = Math.abs(c.dev.x - d.x), h = Math.abs(c.dev.y - d.y);
    if (w > 6 * vp.dpr && h > 6 * vp.dpr && !d.alt) {
      const z = Math.min(vp.W / w, vp.H / h) * vp.z, cx = (c.dev.x + d.x) / 2, cy = (c.dev.y + d.y) / 2;
      const p = vp.toDoc(cx, cy); const v = vp.doc.view; v.zoom = clamp(z, 0.01, 64); v.tx = vp.W / 2 - p.x * v.zoom; v.ty = vp.H / 2 - p.y * v.zoom; v.fit = false; vp.snap(); vp.viewChanged(false);
    } else vp.stepZoom(d.alt ? -1 : 1, c.dev.x, c.dev.y);
  }
  cancel() { this.drag = null; }
  drawOverlay(g) { const d = this.drag; if (!d) return; g.save(); g.setLineDash([5, 4]); g.strokeStyle = '#fff'; g.strokeRect(Math.min(d.x, d.cx), Math.min(d.y, d.cy), Math.abs(d.cx - d.x), Math.abs(d.cy - d.y)); g.restore(); }
}
class EyedropperTool {
  constructor(app) {
    this.app = app; this.id = 'eyedropper'; this.name = 'Eyedropper Tool'; this.key = 'i'; this.group = 'eyedropper'; this.icon = ICONS.eyedropper;
    this.defaults = { size: 1, all: true };
    this.options = [
      { key: 'size', label: 'Sample Size', type: 'select', choices: [[1, 'Point Sample'], [3, '3 by 3 Average'], [5, '5 by 5 Average']] },
      { key: 'all', label: 'Sample All Layers', type: 'check' },
    ];
    this.cursor = 'crosshair'; this.down_ = false;
    this.hint = 'Click to pick the foreground color; Alt-click picks the background.';
  }
  get o() { return this.app.opts(this.id, this.defaults); }
  sample(x, y) {
    const doc = this.app.doc, n = Number(this.o.size) || 1, h = (n - 1) / 2;
    const px = Math.floor(x) - h, py = Math.floor(y) - h;
    let data;
    if (this.o.all || !doc.active || doc.active.type !== 'raster') {
      const c = compose(doc.layers, { zoom: 1, tx: -px, ty: -py }, n, n, null, { x: 0, y: 0 });
      data = ctxOf(c).getImageData(0, 0, n, n).data; releaseCanvas(c);
    } else {
      const L = doc.active; if (!L.canvas) return null;
      const c = makeCanvas(n, n); const g = ctxOf(c); g.drawImage(L.canvas, L.x - px, L.y - py); data = g.getImageData(0, 0, n, n).data;
    }
    let r = 0, g2 = 0, b = 0, a = 0;
    for (let i = 0; i < data.length; i += 4) { r += data[i]; g2 += data[i + 1]; b += data[i + 2]; a += data[i + 3]; }
    const k = data.length / 4;
    if (a / k < 1) return null;
    return rgbToHex(r / k, g2 / k, b / k);
  }
  pick(c) { const col = this.sample(c.x, c.y); if (!col) return; if (c.e.altKey) this.app.setBg(col); else this.app.setFg(col); }
  down(c) { this.pick(c); }
  move(c) { this.pick(c); }
  up() {}
}

export function createTools(app) {
  const t2 = createTools2(app), pick = (re) => t2.filter((t) => re.test(t.id));
  const list = [new MoveTool(app), ...pick(/^marquee/), ...pick(/^crop/), new StrokeTool(app, 'brush', 'Brush Tool', 'b', false), new StrokeTool(app, 'eraser', 'Eraser Tool', 'e', true), ...createRetouchTools(app), ...pick(/^(gradient|bucket)/), ...pick(/^type$/), new EyedropperTool(app), new HandTool(app), new ZoomTool(app)];
  return Object.fromEntries(list.map((t) => [t.id, t]));
}
