// Rulers, guides and snapping. Guides live on the document: doc.guides = [{o:'h'|'v', p: document px}].
import { toast } from './util.js';

const RW = 18;   // ruler thickness, CSS px
const STEPS = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000];

export class Guides {
  constructor(app) {
    this.app = app; this.drag = null;
    const stage = document.getElementById('stage');
    this.h = document.createElement('canvas'); this.h.id = 'ruler-h'; this.h.className = 'ruler';
    this.v = document.createElement('canvas'); this.v.id = 'ruler-v'; this.v.className = 'ruler';
    this.c = document.createElement('div'); this.c.id = 'ruler-c';
    stage.append(this.h, this.v, this.c);
    this.h.addEventListener('pointerdown', (e) => this.begin(e, 'h'));
    this.v.addEventListener('pointerdown', (e) => this.begin(e, 'v'));
    for (const el of [this.h, this.v]) {
      el.addEventListener('pointermove', (e) => this.moveGuide(e)); el.addEventListener('pointerup', (e) => this.end(e)); el.addEventListener('pointercancel', (e) => this.end(e, true));
    }
    new ResizeObserver(() => this.draw()).observe(stage);
    app.on('prefs', () => this.layout()); app.on('doc', () => this.draw()); app.on('view', () => this.draw());
    this.layout();
  }
  get doc() { return this.app.doc; }
  get on() { return !!this.app.prefs.rulers; }
  get vp() { return this.app.vp; }
  layout() { const on = this.on; for (const el of [this.h, this.v, this.c]) el.style.display = on ? 'block' : 'none'; this.draw(); }

  // ── rulers ──
  draw() {
    if (!this.on) return;
    const stage = this.h.parentElement, r = stage.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    const W = Math.round(r.width), H = Math.round(r.height);
    this.h.width = Math.round((W - RW) * dpr); this.h.height = Math.round(RW * dpr); this.h.style.width = (W - RW) + 'px'; this.h.style.height = RW + 'px';
    this.v.width = Math.round(RW * dpr); this.v.height = Math.round((H - RW) * dpr); this.v.style.width = RW + 'px'; this.v.style.height = (H - RW) + 'px';
    const d = this.doc;
    for (const [cv, horiz] of [[this.h, true], [this.v, false]]) {
      const g = cv.getContext('2d'), L = horiz ? cv.width : cv.height, T = horiz ? cv.height : cv.width;
      const cs = getComputedStyle(document.documentElement);
      g.fillStyle = cs.getPropertyValue('--bg3').trim() || '#3a3a3a'; g.fillRect(0, 0, cv.width, cv.height);
      g.strokeStyle = cs.getPropertyValue('--fg').trim() || '#ccc'; g.fillStyle = g.strokeStyle; g.globalAlpha = 0.9; g.lineWidth = 1; g.font = `${9 * dpr}px system-ui,sans-serif`;
      if (d) {
        const z = d.view.zoom, off = (horiz ? d.view.tx : d.view.ty) - (horiz ? RW * dpr : RW * dpr);   // ruler origin sits RW px in from the stage edge
        let step = STEPS.find((s) => s * z / dpr >= 60) || STEPS[STEPS.length - 1];
        const minor = step * z / dpr >= 100 ? step / 10 : step * z / dpr >= 40 ? step / 5 : step / 2;
        const lo = Math.floor(-off / z / minor) * minor, hi = Math.ceil((L - off) / z / minor) * minor;
        g.beginPath();
        for (let p = lo; p <= hi; p += minor) {
          const x = Math.round(p * z + off) + 0.5, major = Math.abs(p / step - Math.round(p / step)) < 1e-9;
          const len = major ? T : T * 0.35;
          if (horiz) { g.moveTo(x, T - len); g.lineTo(x, T); } else { g.moveTo(T - len, x); g.lineTo(T, x); }
        }
        g.stroke();
        for (let p = Math.floor(lo / step) * step; p <= hi; p += step) {
          const x = p * z + off + 3 * dpr;
          if (horiz) g.fillText(String(p), x, 10 * dpr); else { g.save(); g.translate(10 * dpr, x + 0); g.rotate(-Math.PI / 2); g.fillText(String(p), -(String(p).length * 4.5 * dpr) , 0); g.restore(); }
        }
        g.globalAlpha = 1;
        const cur = this.vp && this.vp.cursor;     // cursor marker
        if (cur) { g.strokeStyle = '#ff5a5a'; g.beginPath(); const q = Math.round(horiz ? cur.dx - RW * dpr : cur.dy - RW * dpr) + 0.5; if (horiz) { g.moveTo(q, 0); g.lineTo(q, T); } else { g.moveTo(0, q); g.lineTo(T, q); } g.stroke(); }
      }
    }
  }

  // ── guides: model ──
  list() { const d = this.doc; if (!d) return []; return d.guides || (d.guides = []); }
  visible() { return this.app.prefs.guidesShow !== false; }
  setGuides(next, name) {
    const d = this.doc, old = (d.guides || []).map((g) => ({ ...g })), now = next.map((g) => ({ ...g }));
    if (JSON.stringify(old) === JSON.stringify(now)) return;
    d.guides = now.map((g) => ({ ...g }));
    d.hist.push({ name, bytes: 0, undo: () => { d.guides = old.map((g) => ({ ...g })); }, redo: () => { d.guides = now.map((g) => ({ ...g })); } });
    this.vp.drawOverlay(); this.app.emit('docchange');
  }
  add(o, p) { this.setGuides([...this.list(), { o, p: Math.round(p) }], 'New Guide'); }
  clear() { if (this.list().length) this.setGuides([], 'Clear Guides'); }

  // ── guides: dragging ──
  evDoc(e) { const dev = this.vp.evDev(e); return this.vp.toDoc(dev.x, dev.y); }
  begin(e, o) {
    if (!this.doc || this.app.prefs.guidesLock) { if (this.app.prefs.guidesLock) toast('Guides are locked (View > Lock Guides).'); return; }
    e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId);
    this.drag = { o, idx: -1, from: null, ghost: null, el: e.currentTarget };
    this.moveGuide(e);
  }
  grab(dev) {   // pointer on canvas: is it over a guide? returns index or -1
    if (!this.visible() || this.app.prefs.guidesLock) return -1;
    const v = this.doc.view, tol = 5 * this.vp.dpr; let best = -1, bd = tol;
    this.list().forEach((g, i) => { const x = (g.o === 'v' ? g.p * v.zoom + v.tx : g.p * v.zoom + v.ty), dd = Math.abs((g.o === 'v' ? dev.x : dev.y) - x); if (dd <= bd) { bd = dd; best = i; } });
    return best;
  }
  startMove(idx) { this.drag = { o: this.list()[idx].o, idx, from: this.list().map((g) => ({ ...g })), ghost: null, el: null }; }
  moveGuide(e) {
    const D = this.drag; if (!D) return;
    const p = this.evDoc(e), pos = D.o === 'v' ? p.x : p.y, r = this.vp.canvas.getBoundingClientRect();
    const inside = e.clientX >= r.left + RW && e.clientY >= r.top + RW && e.clientX <= r.right && e.clientY <= r.bottom;
    D.pos = Math.round(pos); D.inside = inside;
    this.vp.drawOverlay();
  }
  end(e, cancel) {
    const D = this.drag; if (!D) return; this.drag = null;
    if (D.el && D.el.hasPointerCapture && D.el.hasPointerCapture(e.pointerId)) D.el.releasePointerCapture(e.pointerId);
    if (cancel) { this.vp.drawOverlay(); return; }
    const cur = this.list().map((g) => ({ ...g }));
    if (D.idx < 0) { if (D.inside) { this.doc.guides = cur; this.setGuides([...cur, { o: D.o, p: D.pos }], 'New Guide'); } }
    else {
      const base = D.from.map((g) => ({ ...g })); this.doc.guides = base;
      if (!D.inside) this.setGuides(base.filter((_, i) => i !== D.idx), 'Delete Guide');
      else this.setGuides(base.map((g, i) => (i === D.idx ? { ...g, p: D.pos } : g)), 'Move Guide');
    }
    this.vp.drawOverlay();
  }
  /** Used by the canvas while a guide that is already placed is being dragged. */
  canvasDown(e, dev) { const i = this.grab(dev); if (i < 0) return false; this.startMove(i); this.moveGuide(e); return true; }
  canvasMove(e) { if (!this.drag || this.drag.idx < 0) return false; this.moveGuide(e); return true; }
  canvasUp(e) { if (!this.drag || this.drag.idx < 0) return false; this.end(e); return true; }

  // ── drawing the guides on the overlay (device px) ──
  drawGuides(g) {
    const d = this.doc, v = d.view, dpr = this.vp.dpr, D = this.drag;
    if (!this.visible() && !D) return;
    g.save(); g.lineWidth = Math.max(1, dpr); g.strokeStyle = '#19d3c5';
    const W = this.vp.W, H = this.vp.H;
    const items = this.list().map((q, i) => (D && D.idx === i ? { o: q.o, p: D.pos } : q));
    if (D && D.idx < 0 && D.pos !== undefined) items.push({ o: D.o, p: D.pos });
    if (this.visible() || D) for (const q of items) {
      g.beginPath();
      if (q.o === 'v') { const x = Math.round(q.p * v.zoom + v.tx) + 0.5; g.moveTo(x, 0); g.lineTo(x, H); } else { const y = Math.round(q.p * v.zoom + v.ty) + 0.5; g.moveTo(0, y); g.lineTo(W, y); }
      g.stroke();
    }
    if (D && D.pos !== undefined) {   // readout while dragging
      const t = `${D.pos}px`, cur = this.vp.cursor; g.fillStyle = 'rgba(0,0,0,.75)'; g.font = `${11 * dpr}px system-ui,sans-serif`;
      const x = (cur ? cur.dx : 40) + 12 * dpr, y = (cur ? cur.dy : 40) - 10 * dpr, w = g.measureText(t).width + 8 * dpr;
      g.fillRect(x, y - 12 * dpr, w, 16 * dpr); g.fillStyle = '#fff'; g.fillText(t, x + 4 * dpr, y);
    }
    g.restore();
  }

  // ── snapping ──
  targets(axis) {   // document coordinates along 'v' (x) or 'h' (y)
    const d = this.doc, out = [0, axis === 'v' ? d.w : d.h];
    if (this.visible()) for (const g of this.list()) if (g.o === axis) out.push(g.p);
    const p = this.app.prefs, S = axis === 'v' ? d.w : d.h;
    if (p.guideCenter) out.push(S / 2); if (p.guideThirds) out.push(S / 3, S * 2 / 3); if (p.guideSafe) out.push(S * 0.1, S * 0.9);
    return out;
  }
  /** Best shift for a set of candidate edge positions along one axis, or 0. */
  snap(axis, edges) {
    if (this.app.prefs.snap === false || !this.doc) return 0;
    const tol = 6 / this.doc.view.zoom; let best = 0, bd = tol + 1e-9;
    for (const t of this.targets(axis)) for (const e of edges) { const dd = t - e; if (Math.abs(dd) < bd) { bd = Math.abs(dd); best = dd; } }
    return best;
  }
}
