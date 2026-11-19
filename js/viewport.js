// The canvas view: zoom, pan, drawing the composite, the overlay (brush ring, cover guides) and pointer routing.
import { compose, releaseCanvas } from './render.js';
import { clamp } from './util.js';
import { buildAnts } from './select.js';

export const ZOOM_STEPS = [0.03125, 0.0625, 0.125, 0.25, 1 / 3, 0.5, 2 / 3, 1, 2, 3, 4, 5, 6, 8, 12, 16, 32];

function checkerPattern(ctx) {
  const c = document.createElement('canvas'); c.width = c.height = 16;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, 16, 16);
  g.fillStyle = '#c9c9c9'; g.fillRect(0, 0, 8, 8); g.fillRect(8, 8, 8, 8);
  return ctx.createPattern(c, 'repeat');
}

export class Viewport {
  constructor(stage, app) {
    this.app = app; this.stage = stage;
    this.canvas = stage.querySelector('#view');
    this.overlay = stage.querySelector('#overlay');
    this.ctx = this.canvas.getContext('2d');
    this.octx = this.overlay.getContext('2d');
    this.checker = checkerPattern(this.ctx);
    this.doc = null; this.W = 0; this.H = 0; this.dpr = 1;
    this.frame = null; this.pending = null; this.raf = 0; this.settleTimer = 0;
    this.pointers = new Map(); this.gesture = null; this.panning = null;
    this.space = false; this.cursor = null; this.surround = '#444';
    this._bind();
    new ResizeObserver(() => this.resize()).observe(stage);
    this.resize();
  }

  // ── geometry ──
  get z() { return this.doc ? this.doc.view.zoom : 1; }
  toDoc(dx, dy) { const v = this.doc.view; return { x: (dx - v.tx) / v.zoom, y: (dy - v.ty) / v.zoom }; }
  toDev(x, y) { const v = this.doc.view; return { x: x * v.zoom + v.tx, y: y * v.zoom + v.ty }; }
  evDev(e) { const r = this.canvas.getBoundingClientRect(); return { x: (e.clientX - r.left) * this.dpr, y: (e.clientY - r.top) * this.dpr }; }

  setDoc(doc) {
    this.doc = doc; this.frame = null;
    if (doc && doc.view.fit) this.fit(false);
    this.invalidate();
  }
  resize() {
    const r = this.stage.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(r.width * dpr)), H = Math.max(1, Math.round(r.height * dpr));
    if (W === this.W && H === this.H && dpr === this.dpr) return;
    const oldW = this.W, oldH = this.H;
    this.W = W; this.H = H; this.dpr = dpr;
    for (const c of [this.canvas, this.overlay]) { c.width = W; c.height = H; c.style.width = r.width + 'px'; c.style.height = r.height + 'px'; }
    this.checker = checkerPattern(this.ctx);
    if (this.doc) {
      if (this.doc.view.fit) this.fit(false);
      else if (oldW) { this.doc.view.tx += (W - oldW) / 2; this.doc.view.ty += (H - oldH) / 2; }
    }
    this.frame = null; this.invalidate();
  }
  fit(render = true) {
    if (!this.doc) return;
    const m = 24 * this.dpr, d = this.doc, v = d.view;
    let z = Math.min((this.W - m * 2) / d.w, (this.H - m * 2) / d.h);
    z = Math.max(0.01, z);
    v.zoom = z; v.fit = true;
    v.tx = (this.W - d.w * z) / 2; v.ty = (this.H - d.h * z) / 2;
    this.snap();
    if (render) this.viewChanged(true);
  }
  snap() { const v = this.doc.view; if (v.zoom >= 1) { v.tx = Math.round(v.tx); v.ty = Math.round(v.ty); } }
  zoomTo(z, cx = this.W / 2, cy = this.H / 2, soft = false) {
    const v = this.doc.view;
    z = clamp(z, 0.01, 64);
    const p = this.toDoc(cx, cy);
    v.zoom = z; v.tx = cx - p.x * z; v.ty = cy - p.y * z; v.fit = false;
    this.snap(); this.viewChanged(soft);
  }
  stepZoom(dir, cx, cy) {
    const z = this.z; let t;
    if (dir > 0) t = ZOOM_STEPS.find((s) => s > z * 1.001) || 32; else { t = [...ZOOM_STEPS].reverse().find((s) => s < z * 0.999) || ZOOM_STEPS[0]; }
    this.zoomTo(t, cx, cy);
  }
  panBy(dx, dy, soft = true) { const v = this.doc.view; v.tx += dx; v.ty += dy; v.fit = false; this.snap(); this.viewChanged(soft); }
  viewChanged(soft) {
    this.app.onViewChanged && this.app.onViewChanged();
    if (soft) { this.drawFast(); clearTimeout(this.settleTimer); this.settleTimer = setTimeout(() => this.invalidate(), 90); }
    else this.invalidate();
    this.drawOverlay();
  }

  // ── rendering ──
  invalidate(docRect) {
    if (!this.doc) { this.clear(); return; }
    if (!docRect) this.pending = { full: true };
    else if (!this.pending) this.pending = { rect: { ...docRect } };
    else if (!this.pending.full) {
      const a = this.pending.rect, b = docRect;
      const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y);
      this.pending.rect = { x: x0, y: y0, w: Math.max(a.x + a.w, b.x + b.w) - x0, h: Math.max(a.y + a.h, b.y + b.h) - y0 };
    }
    if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; const p = this.pending; this.pending = null; if (p) this.renderNow(p.full ? null : p.rect); });
  }
  clear() { this.ctx.fillStyle = this.surround; this.ctx.fillRect(0, 0, this.W, this.H); this.octx.clearRect(0, 0, this.W, this.H); }
  docScreenRect() {
    const d = this.doc, v = d.view;
    const x0 = Math.max(0, Math.floor(v.tx)), y0 = Math.max(0, Math.floor(v.ty));
    const x1 = Math.min(this.W, Math.ceil(v.tx + d.w * v.zoom)), y1 = Math.min(this.H, Math.ceil(v.ty + d.h * v.zoom));
    return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
  }
  paintChecker(r) {
    const v = this.doc.view, g = this.ctx, tx = Math.round(v.tx), ty = Math.round(v.ty);
    g.save(); g.translate(tx, ty); g.fillStyle = this.checker; g.fillRect(r.x - tx, r.y - ty, r.w, r.h); g.restore();
  }
  renderNow(docRect) {
    const d = this.doc; if (!d) return;
    const v = d.view, g = this.ctx;
    const screen = this.docScreenRect();
    let r = screen;
    if (docRect && screen) {
      const x0 = Math.floor(docRect.x * v.zoom + v.tx) - 1, y0 = Math.floor(docRect.y * v.zoom + v.ty) - 1;
      const x1 = Math.ceil((docRect.x + docRect.w) * v.zoom + v.tx) + 1, y1 = Math.ceil((docRect.y + docRect.h) * v.zoom + v.ty) + 1;
      const ix0 = Math.max(screen.x, x0), iy0 = Math.max(screen.y, y0), ix1 = Math.min(screen.x + screen.w, x1), iy1 = Math.min(screen.y + screen.h, y1);
      r = ix1 > ix0 && iy1 > iy0 ? { x: ix0, y: iy0, w: ix1 - ix0, h: iy1 - iy0 } : null;
      if (!r) return;
    } else {
      g.fillStyle = this.surround; g.fillRect(0, 0, this.W, this.H);
    }
    if (!r) { this.frame = null; return; }
    this.paintChecker(r);
    const tf = { zoom: v.zoom, tx: v.tx - r.x, ty: v.ty - r.y };
    const comp = compose(d.layers, tf, r.w, r.h, d.live, { x: r.x, y: r.y });
    g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1;
    g.drawImage(comp, r.x, r.y);
    if (!docRect) {
      if (this.frame) releaseCanvas(this.frame.canvas);
      this.frame = { canvas: comp, z: v.zoom, tx: v.tx, ty: v.ty, x0: r.x, y0: r.y };
    } else {
      const f = this.frame;
      if (f && f.z === v.zoom && f.tx === v.tx && f.ty === v.ty) {
        const fg = f.canvas.getContext('2d');
        fg.clearRect(r.x - f.x0, r.y - f.y0, r.w, r.h); fg.drawImage(comp, r.x - f.x0, r.y - f.y0);
      } else this.frame = null;
      releaseCanvas(comp);
    }
    this.app.onRendered && this.app.onRendered(docRect);
  }
  drawFast() {
    const d = this.doc; if (!d) return;
    const v = d.view, g = this.ctx;
    g.fillStyle = this.surround; g.fillRect(0, 0, this.W, this.H);
    const r = this.docScreenRect(); if (!r) return;
    this.paintChecker(r);
    const f = this.frame;
    if (f) {
      const s = v.zoom / f.z;
      g.save(); g.beginPath(); g.rect(r.x, r.y, r.w, r.h); g.clip();
      g.imageSmoothingEnabled = true;
      g.drawImage(f.canvas, (f.x0 - f.tx) * s + v.tx, (f.y0 - f.ty) * s + v.ty, f.canvas.width * s, f.canvas.height * s);
      g.restore();
    }
  }

  // ── overlay (brush ring, cover guides) ──
  drawOverlay() {
    const g = this.octx, d = this.doc;
    g.clearRect(0, 0, this.W, this.H);
    if (!d) return;
    const v = d.view, dpr = this.dpr, p = this.app.prefs;
    const x0 = v.tx, y0 = v.ty, x1 = v.tx + d.w * v.zoom, y1 = v.ty + d.h * v.zoom;
    g.save(); g.lineWidth = Math.max(1, dpr); g.strokeStyle = 'rgba(255,255,255,.35)';
    g.strokeRect(Math.round(x0) - 0.5, Math.round(y0) - 0.5, Math.round(x1 - x0) + 1, Math.round(y1 - y0) + 1);
    g.restore();
    if (p.guideCenter || p.guideThirds || p.guideSafe) {
      g.save(); g.beginPath(); g.rect(x0, y0, x1 - x0, y1 - y0); g.clip();
      g.strokeStyle = '#2ad4ff'; g.lineWidth = Math.max(1, dpr); g.setLineDash([6 * dpr, 4 * dpr]);
      const line = (ax, ay, bx, by) => { g.beginPath(); g.moveTo(Math.round(ax) + 0.5, Math.round(ay) + 0.5); g.lineTo(Math.round(bx) + 0.5, Math.round(by) + 0.5); g.stroke(); };
      const W = x1 - x0, H = y1 - y0;
      if (p.guideCenter) { line(x0 + W / 2, y0, x0 + W / 2, y1); line(x0, y0 + H / 2, x1, y0 + H / 2); }
      if (p.guideThirds) for (const f of [1 / 3, 2 / 3]) { line(x0 + W * f, y0, x0 + W * f, y1); line(x0, y0 + H * f, x1, y0 + H * f); }
      if (p.guideSafe) { g.strokeStyle = '#ffb02a'; g.strokeRect(Math.round(x0 + W * 0.1) + 0.5, Math.round(y0 + H * 0.1) + 0.5, Math.round(W * 0.8), Math.round(H * 0.8)); }
      g.restore();
    }
    this.drawAnts(g);
    const tool = this.app.tool;
    if (tool && tool.drawOverlay) tool.drawOverlay(g, this);
    if (this.cursor && tool && tool.ring) {
      const r = tool.ring(); // radius in doc px
      if (r) {
        const rr = (r * v.zoom);
        g.save(); g.lineWidth = Math.max(1, dpr);
        if (rr >= 2) {
          g.strokeStyle = 'rgba(0,0,0,.85)'; g.beginPath(); g.arc(this.cursor.dx, this.cursor.dy, rr + dpr * 0.5, 0, 6.2832); g.stroke();
          g.strokeStyle = 'rgba(255,255,255,.95)'; g.beginPath(); g.arc(this.cursor.dx, this.cursor.dy, rr - dpr * 0.5, 0, 6.2832); g.stroke();
        }
        const c = 5 * dpr; g.strokeStyle = 'rgba(255,255,255,.9)'; g.beginPath();
        g.moveTo(this.cursor.dx - c, this.cursor.dy); g.lineTo(this.cursor.dx + c, this.cursor.dy); g.moveTo(this.cursor.dx, this.cursor.dy - c); g.lineTo(this.cursor.dx, this.cursor.dy + c); g.stroke();
        g.restore();
      }
    }
  }

  drawAnts(g) {
    const d = this.doc, sel = d && d.sel;
    if (!sel) { if (this.antTimer) { clearInterval(this.antTimer); this.antTimer = 0; } this.ants = null; return; }
    const v = d.view, key = `${v.zoom}|${v.tx}|${v.ty}|${this.W}|${this.H}`;
    if (!this.ants || this.ants.sel !== sel || this.ants.key !== key) this.ants = { sel, key, img: buildAnts(sel, v, this.W, this.H), phase: this.ants ? this.ants.phase : 0 };
    g.drawImage(this.ants.phase ? this.ants.img.b : this.ants.img.a, 0, 0);
    if (!this.antTimer) this.antTimer = setInterval(() => { if (this.ants && this.doc && this.doc.sel === this.ants.sel && !document.hidden) { this.ants.phase ^= 1; this.drawOverlay(); } }, 450);
  }

  // ── input ──
  _bind() {
    const el = this.overlay;
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('pointerdown', (e) => this._down(e));
    el.addEventListener('pointermove', (e) => this._move(e));
    el.addEventListener('pointerup', (e) => this._up(e));
    el.addEventListener('pointercancel', (e) => this._up(e, true));
    el.addEventListener('pointerleave', () => { this.cursor = null; this.drawOverlay(); });
    el.addEventListener('wheel', (e) => this._wheel(e), { passive: false });
    el.addEventListener('dblclick', (e) => { const t = this.app.tool; if (t && t.dblclick) t.dblclick(e); });
  }
  _ctx(e) { const dev = this.evDev(e); const p = this.toDoc(dev.x, dev.y); return { x: p.x, y: p.y, dev, e, vp: this }; }
  _down(e) {
    if (!this.doc) return;
    this.overlay.setPointerCapture(e.pointerId);
    const dev = this.evDev(e);
    this.pointers.set(e.pointerId, { x: dev.x, y: dev.y, type: e.pointerType });
    if (this.pointers.size === 2) {                       // touch: pinch + two-finger pan
      this.app.tool && this.app.tool.cancel && this.app.tool.cancel();
      const [a, b] = [...this.pointers.values()];
      this.gesture = { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
      this.panning = null; this.toolDown = false; return;
    }
    if (this.pointers.size > 2) return;
    const handTool = this.app.tool && this.app.tool.id === 'hand';
    if (e.button === 1 || this.space || handTool) {        // pan
      this.panning = { x: dev.x, y: dev.y }; this.overlay.style.cursor = 'grabbing'; return;
    }
    if (e.button === 2) return;
    this.toolDown = true;
    const t = this.app.tool; if (t && t.down) t.down(this._ctx(e));
  }
  _move(e) {
    if (!this.doc) return;
    const dev = this.evDev(e);
    this.cursor = { dx: dev.x, dy: dev.y };
    this.app.onPointer && this.app.onPointer(this.toDoc(dev.x, dev.y));
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: dev.x, y: dev.y, type: e.pointerType });
    if (this.gesture && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y), cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      const v = this.doc.view; const p = this.toDoc(this.gesture.cx, this.gesture.cy);
      const z = clamp(v.zoom * (d / this.gesture.d), 0.01, 64);
      v.zoom = z; v.tx = cx - p.x * z; v.ty = cy - p.y * z; v.fit = false;
      this.gesture = { d, cx, cy }; this.viewChanged(true); return;
    }
    if (this.panning) { this.panBy(dev.x - this.panning.x, dev.y - this.panning.y); this.panning = { x: dev.x, y: dev.y }; return; }
    const t = this.app.tool;
    if (this.toolDown && t && t.move) t.move(this._ctx(e));
    else if (t && t.hover) t.hover(this._ctx(e));
    this.drawOverlay();
  }
  _up(e, cancel) {
    this.pointers.delete(e.pointerId);
    if (this.gesture) { if (this.pointers.size < 2) { this.gesture = null; this.invalidate(); } return; }
    if (this.panning) { this.panning = null; this.overlay.style.cursor = ''; this.app.refreshCursor(); this.invalidate(); return; }
    if (this.toolDown) { this.toolDown = false; const t = this.app.tool; if (t) { if (cancel && t.cancel) t.cancel(); else if (t.up) t.up(this._ctx(e)); } }
    this.drawOverlay();
  }
  _wheel(e) {
    if (!this.doc) return;
    e.preventDefault();
    const dev = this.evDev(e);
    let dy = e.deltaY, dx = e.deltaX;
    if (e.deltaMode === 1) { dy *= 16; dx *= 16; }
    const mode = this.app.prefs.wheel;                 // 'zoom' | 'scroll'
    const zoomIt = e.ctrlKey || e.metaKey ? true : e.altKey ? true : mode === 'zoom';
    if (zoomIt && !e.shiftKey) {
      const f = Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0016));
      this.zoomTo(this.z * f, dev.x, dev.y, true);
    } else if (e.shiftKey) this.panBy(-(dy || dx) * this.dpr, 0);
    else this.panBy(-dx * this.dpr, -dy * this.dpr);
  }
  setCursorStyle(c) { if (!this.panning) this.overlay.style.cursor = c; }
}
