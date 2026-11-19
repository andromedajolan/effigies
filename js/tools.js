// Tools for stage 1: Move, Brush (plain), Eraser (plain), Hand, Zoom, Eyedropper.
// Each tool: {id, name, key, group, icon, options[], down/move/up/cancel, ring()}
import { makeCanvas, ctxOf, clamp, hexToRgb, rgbToHex, toast } from './util.js';
import { compose, releaseCanvas } from './render.js';

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
let tipCache = { key: '', canvas: null };
function brushTip(size, hardness, color) {
  const key = size.toFixed(2) + '|' + hardness + '|' + color;
  if (tipCache.key === key) return tipCache.canvas;
  const d = Math.max(1, Math.ceil(size) + 2), c = makeCanvas(d, d, false), g = c.getContext('2d');
  const r = size / 2, cx = d / 2;
  const [R, G, B] = hexToRgb(color);
  if (hardness >= 99) {
    g.fillStyle = color; g.beginPath(); g.arc(cx, cx, Math.max(0.5, r), 0, 6.2832); g.fill();
  } else {
    const gr = g.createRadialGradient(cx, cx, 0, cx, cx, Math.max(0.5, r));
    const hh = clamp(hardness / 100, 0, 0.98);
    gr.addColorStop(0, `rgba(${R},${G},${B},1)`); gr.addColorStop(hh, `rgba(${R},${G},${B},1)`); gr.addColorStop(1, `rgba(${R},${G},${B},0)`);
    g.fillStyle = gr; g.fillRect(0, 0, d, d);
  }
  tipCache = { key, canvas: c };
  return c;
}

class StrokeTool {
  constructor(app, id, name, key, erase) {
    this.app = app; this.id = id; this.name = name; this.key = key; this.group = id; this.erase = erase; this.icon = ICONS[id];
    this.stroke = null;
    this.defaults = erase ? { size: 60, hardness: 90, opacity: 100, flow: 100 } : { size: 40, hardness: 80, opacity: 100, flow: 100 };
    this.options = [
      { key: 'size', label: 'Size', type: 'number', min: 1, max: 5000, slider: [1, 500], suffix: 'px' },
      { key: 'hardness', label: 'Hardness', type: 'number', min: 0, max: 100, suffix: '%' },
      { key: 'opacity', label: 'Opacity', type: 'number', min: 1, max: 100, suffix: '%' },
      { key: 'flow', label: 'Flow', type: 'number', min: 1, max: 100, suffix: '%' },
    ];
    this.hint = 'Stage 1 has a plain round brush. Dynamics, masks and the full Brush panel arrive in stage 2.';
  }
  get o() { return this.app.opts(this.id, this.defaults); }
  ring() { return this.o.size / 2; }
  ready() {
    const doc = this.app.doc; if (!doc) return null;
    const L = doc.active;
    if (!L) { toast('Add or select a layer first.'); return null; }
    if (L.type !== 'raster') { toast('Select a regular layer (a group has no pixels).'); return null; }
    if (!L.visible) { toast('That layer is hidden.'); return null; }
    if (L.lockAll || L.lockPix) { toast('That layer is locked.'); return null; }
    if (this.erase && L.lockTrans) { toast('Unlock transparent pixels to erase.'); return null; }
    return L;
  }
  down(c) {
    const L = this.ready(); if (!L) return;
    const doc = this.app.doc;
    let x0 = 0, y0 = 0, x1 = doc.w, y1 = doc.h;
    if (L.canvas) { x0 = Math.min(x0, L.x); y0 = Math.min(y0, L.y); x1 = Math.max(x1, L.x + L.w); y1 = Math.max(y1, L.y + L.h); }
    this.stroke = { layer: L, canvas: makeCanvas(x1 - x0, y1 - y0, false), ox: x0, oy: y0, opacity: this.o.opacity / 100, erase: this.erase, last: null, carry: 0, dirty: null, pts: 0 };
    doc.live = this.stroke;
    this.dab(c.x, c.y);
    this.stroke.last = { x: c.x, y: c.y };
    this.flush();
  }
  dab(x, y) {
    const s = this.stroke, o = this.o;
    const color = this.erase ? '#000000' : this.app.fg;
    const tip = brushTip(o.size, o.hardness, color);
    const g = s.canvas.getContext('2d');
    g.globalAlpha = o.flow / 100;
    g.drawImage(tip, x - s.ox - tip.width / 2, y - s.oy - tip.height / 2);
    const m = tip.width / 2 + 1;
    const r = { x: Math.floor(x - m), y: Math.floor(y - m), w: Math.ceil(m * 2) + 1, h: Math.ceil(m * 2) + 1 };
    if (!s.dirty) s.dirty = r;
    else { const a = s.dirty, x0 = Math.min(a.x, r.x), y0 = Math.min(a.y, r.y); s.dirty = { x: x0, y: y0, w: Math.max(a.x + a.w, r.x + r.w) - x0, h: Math.max(a.y + a.h, r.y + r.h) - y0 }; }
    s.pend = s.pend ? (() => { const a = s.pend, x0 = Math.min(a.x, r.x), y0 = Math.min(a.y, r.y); return { x: x0, y: y0, w: Math.max(a.x + a.w, r.x + r.w) - x0, h: Math.max(a.y + a.h, r.y + r.h) - y0 }; })() : r;
  }
  flush() { const s = this.stroke; if (s && s.pend) { this.app.vp.invalidate(s.pend); s.pend = null; } }
  move(c) {
    const s = this.stroke; if (!s) return;
    const spacing = Math.max(1, this.o.size * 0.25);
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
    this.stroke = null;
    const doc = this.app.doc; doc.live = null;
    const L = s.layer, r = s.dirty;
    if (!r) { this.app.vp.invalidate(); return; }
    const cl = { x: Math.max(r.x, s.ox), y: Math.max(r.y, s.oy), w: 0, h: 0 };
    cl.w = Math.min(r.x + r.w, s.ox + s.canvas.width) - cl.x; cl.h = Math.min(r.y + r.h, s.oy + s.canvas.height) - cl.y;
    if (cl.w <= 0 || cl.h <= 0) { this.app.vp.invalidate(); return; }
    doc.editPixels(L, cl, this.erase ? 'Eraser' : 'Brush Tool', (g, ox, oy) => {
      g.save();
      g.globalAlpha = s.opacity;
      g.globalCompositeOperation = this.erase ? 'destination-out' : (L.lockTrans ? 'source-atop' : 'source-over');
      g.drawImage(s.canvas, 0, 0, s.canvas.width, s.canvas.height, s.ox + ox, s.oy + oy, s.canvas.width, s.canvas.height);
      g.restore();
    });
  }
  cancel() { if (!this.stroke) return; this.stroke = null; this.app.doc.live = null; this.app.vp.invalidate(); }
}

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
    const nx = d.ox + Math.round(c.x - d.sx), ny = d.oy + Math.round(c.y - d.sy);
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
  const list = [new MoveTool(app), new StrokeTool(app, 'brush', 'Brush Tool', 'b', false), new StrokeTool(app, 'eraser', 'Eraser Tool', 'e', true), new EyedropperTool(app), new HandTool(app), new ZoomTool(app)];
  return Object.fromEntries(list.map((t) => [t.id, t]));
}
