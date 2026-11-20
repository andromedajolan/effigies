// Free Transform: scale, rotate, skew and move the active raster layer with on-canvas handles.
// The layer is resampled once, when you press Enter (or Apply). Escape cancels.
import { h, toast } from './util.js';

const HANDLES = [   // [name, u, v] in 0..1 of the layer rectangle
  ['nw', 0, 0], ['n', 0.5, 0], ['ne', 1, 0], ['e', 1, 0.5], ['se', 1, 1], ['s', 0.5, 1], ['sw', 0, 1], ['w', 0, 0.5],
];
const CURSORS = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };

export class FreeTransform {
  constructor(app) { this.app = app; this.active = false; this.drag = null; this.bar = null; }
  get vp() { return this.app.vp; }

  start() {
    const app = this.app, d = app.doc, L = d && d.active;
    if (this.active) return;
    if (!L) return;
    if (L.type !== 'raster') { toast('Free Transform works on regular and type layers.'); return; }
    if (!L.canvas) { toast('That layer is empty.'); return; }
    if (L.lockPos || L.lockAll || L.lockPix) { toast('That layer is locked.'); return; }
    this.doc = d; this.L = L; this.src = L.canvas; this.w = L.canvas.width; this.h = L.canvas.height;
    this.M = [1, 0, 0, 1, L.x, L.y];   // layer pixels -> document
    this.active = true; L.hideForEdit = true; this.vp.invalidate();
    this.buildBar(); this.sync(); this.vp.setCursorStyle('default'); this.vp.drawOverlay();
  }

  // ── geometry ──
  pt(u, v, M = this.M) { return [M[0] * u + M[2] * v + M[4], M[1] * u + M[3] * v + M[5]]; }
  inv(x, y, M = this.M) { const det = M[0] * M[3] - M[1] * M[2] || 1e-9, X = x - M[4], Y = y - M[5]; return [(M[3] * X - M[2] * Y) / det, (-M[1] * X + M[0] * Y) / det]; }
  center() { return this.pt(this.w / 2, this.h / 2); }
  dev(p) { const v = this.doc.view; return [p[0] * v.zoom + v.tx, p[1] * v.zoom + v.ty]; }
  /** local -> local map about an anchor, composed into M. m = [a b c d] (2x2, column-major like M). */
  applyLocal(M0, m, al) {
    const [a, b, c, d] = M0;
    const A = [a * m[0] + c * m[1], b * m[0] + d * m[1], a * m[2] + c * m[3], b * m[2] + d * m[3]];
    const sx = al[0] - (m[0] * al[0] + m[2] * al[1]), sy = al[1] - (m[1] * al[0] + m[3] * al[1]);
    return [A[0], A[1], A[2], A[3], M0[4] + a * sx + c * sy, M0[5] + b * sx + d * sy];
  }
  handlePos(name) { const hd = HANDLES.find((q) => q[0] === name); return [hd[1] * this.w, hd[2] * this.h]; }

  hit(dev, touch) {
    const r = (touch ? 16 : 9) * this.vp.dpr;
    for (const [n, u, v] of HANDLES) { const p = this.dev(this.pt(u * this.w, v * this.h)); if (Math.hypot(p[0] - dev.x, p[1] - dev.y) <= r) return n; }
    const q = this.inv(...Object.values(this.vp.toDoc(dev.x, dev.y)));
    return q[0] >= 0 && q[0] <= this.w && q[1] >= 0 && q[1] <= this.h ? 'move' : 'rotate';
  }

  // ── pointer routing (called by the viewport) ──
  down(c) {
    const kind = this.hit(c.dev, c.e.pointerType === 'touch');
    this.drag = { kind, sx: c.x, sy: c.y, M0: [...this.M], c: this.center(), a0: Math.atan2(c.y - this.center()[1], c.x - this.center()[0]) };
  }
  move(c) {
    const D = this.drag; if (!D) return;
    const e = c.e, M0 = D.M0;
    if (D.kind === 'move') {
      let dx = c.x - D.sx, dy = c.y - D.sy;
      if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      const ng = this.app.guides;
      if (ng) {   // snap the transformed rectangle's edges and centre
        const pts = [[0, 0], [this.w, 0], [0, this.h], [this.w, this.h], [this.w / 2, this.h / 2]].map((q) => this.pt(q[0], q[1], M0));
        const sx = ng.snap('v', pts.map((q) => q[0] + dx)), sy = ng.snap('h', pts.map((q) => q[1] + dy)); dx += sx; dy += sy;
      }
      this.M = [M0[0], M0[1], M0[2], M0[3], M0[4] + dx, M0[5] + dy];
    } else if (D.kind === 'rotate') {
      let da = Math.atan2(c.y - D.c[1], c.x - D.c[0]) - D.a0;
      if (e.shiftKey) { const base = Math.atan2(M0[1], M0[0]); da = Math.round((base + da) / (Math.PI / 12)) * (Math.PI / 12) - base; }
      this.rotateAbout(M0, D.c, da);
    } else {
      const name = D.kind, side = name.length === 1, hd = HANDLES.find((q) => q[0] === name);
      const hl = [hd[1] * this.w, hd[2] * this.h], al0 = [(1 - hd[1]) * this.w, (1 - hd[2]) * this.h];
      const ctr = [this.w / 2, this.h / 2], al = e.altKey ? ctr : al0;
      const pl = this.inv(c.x, c.y, M0);
      if (side && (e.ctrlKey || e.metaKey)) {   // skew along the edge
        const horiz = name === 'n' || name === 's', p0 = this.inv(D.sx, D.sy, M0);
        const dl = horiz ? pl[0] - p0[0] : pl[1] - p0[1], span = horiz ? hl[1] - al0[1] : hl[0] - al0[0];
        let s = dl / (span || 1); const anch = al0;
        const m = horiz ? [1, 0, s, 1] : [1, s, 0, 1];
        this.M = this.applyLocal(M0, m, anch);
      } else {
        let kx = Math.abs(hl[0] - al[0]) < 1e-9 ? 1 : (pl[0] - al[0]) / (hl[0] - al[0]);
        let ky = Math.abs(hl[1] - al[1]) < 1e-9 ? 1 : (pl[1] - al[1]) / (hl[1] - al[1]);
        if (name === 'n' || name === 's') kx = 1; if (name === 'e' || name === 'w') ky = 1;
        if (e.shiftKey) {
          const vert = name === 'n' || name === 's';   // these change the height only
          if (side) { const m = vert ? Math.abs(ky) : Math.abs(kx), sg = Math.sign(vert ? ky : kx) || 1; kx = vert ? m : sg * m; ky = vert ? sg * m : m; }
          else { const m = (Math.abs(kx) + Math.abs(ky)) / 2; kx = (Math.sign(kx) || 1) * m; ky = (Math.sign(ky) || 1) * m; }
        }
        if (Math.abs(kx) < 0.002) kx = 0.002 * (kx < 0 ? -1 : 1); if (Math.abs(ky) < 0.002) ky = 0.002 * (ky < 0 ? -1 : 1);
        this.M = this.applyLocal(M0, [kx, 0, 0, ky], al);
      }
    }
    this.sync(); this.vp.drawOverlay();
  }
  up() { this.drag = null; this.vp.drawOverlay(); }
  hover(c) {
    const k = this.hit(c.dev, false);
    this.vp.setCursorStyle(k === 'move' ? 'move' : k === 'rotate' ? 'alias' : CURSORS[k]);
  }
  rotateAbout(M0, ctr, da) {
    const cs = Math.cos(da), sn = Math.sin(da);
    const [a, b, c, d, e, f] = M0, rx = (x, y) => [ctr[0] + cs * (x - ctr[0]) - sn * (y - ctr[1]), ctr[1] + sn * (x - ctr[0]) + cs * (y - ctr[1])];
    const t = rx(e, f);
    this.M = [cs * a - sn * b, sn * a + cs * b, cs * c - sn * d, sn * c + cs * d, t[0], t[1]];
  }
  nudge(dx, dy) { this.M = [this.M[0], this.M[1], this.M[2], this.M[3], this.M[4] + dx, this.M[5] + dy]; this.sync(); this.vp.drawOverlay(); }

  // ── numeric bar ──
  buildBar() {
    const mk = (label, min, max, step) => { const i = h('input', { type: 'number', step: String(step), style: 'width:70px' }); return [i, h('label', { class: 'xf-f' }, label, i)]; };
    const [W, wl] = mk('W', 1, 5000, 0.1), [H, hl] = mk('H', 1, 5000, 0.1), [R, rl] = mk('∠', -360, 360, 0.1);
    this.fields = { W, H, R };
    const setScale = () => {
      const n0 = Math.hypot(this.M[0], this.M[1]) || 1, n1 = Math.hypot(this.M[2], this.M[3]) || 1, sx = Number(W.value) / 100, sy = Number(H.value) / 100;
      if (!(sx > 0 && sy > 0)) return;
      const c = this.center(), M = this.M;
      this.M = [M[0] / n0 * sx, M[1] / n0 * sx, M[2] / n1 * sy, M[3] / n1 * sy, 0, 0];
      const q = this.pt(this.w / 2, this.h / 2, this.M); this.M[4] = c[0] - (q[0] - 0); this.M[5] = c[1] - (q[1] - 0); this.sync(); this.vp.drawOverlay();
    };
    const setAngle = () => { const t = Number(R.value); if (Number.isNaN(t)) return; const cur = Math.atan2(this.M[1], this.M[0]); this.rotateAbout([...this.M], this.center(), (t * Math.PI) / 180 - cur); this.sync(); this.vp.drawOverlay(); };
    W.onchange = H.onchange = setScale; R.onchange = setAngle;
    const ok = h('button', { class: 'btn small primary', type: 'button', onclick: () => this.commit() }, 'Apply'), no = h('button', { class: 'btn small', type: 'button', onclick: () => this.cancel() }, 'Cancel');
    this.bar = h('div', { id: 'xf-bar' }, h('b', null, 'Free Transform'), wl, '%', hl, '%', rl, '°', ok, no,
      h('small', null, 'Shift: proportional / 15°. Alt: from center. Ctrl+drag a side handle: skew. Enter applies, Esc cancels.'));
    document.getElementById('stage').append(this.bar);
  }
  sync() {
    if (!this.fields) return;
    const n0 = Math.hypot(this.M[0], this.M[1]), n1 = Math.hypot(this.M[2], this.M[3]);
    const f = (v) => String(Math.round(v * 100) / 100);
    const set = (el, v) => { if (document.activeElement !== el) el.value = f(v); };
    set(this.fields.W, n0 * 100); set(this.fields.H, n1 * 100); set(this.fields.R, (Math.atan2(this.M[1], this.M[0]) * 180) / Math.PI);
  }

  // ── drawing ──
  drawOverlay(g) {
    if (!this.active) return;
    const vp = this.vp, v = this.doc.view, dpr = vp.dpr, M = this.M;
    g.save();
    g.globalAlpha = this.L.opacity; g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'medium';
    g.setTransform(v.zoom * M[0], v.zoom * M[1], v.zoom * M[2], v.zoom * M[3], v.zoom * M[4] + v.tx, v.zoom * M[5] + v.ty);
    g.drawImage(this.src, 0, 0);
    g.restore();
    g.save(); g.lineWidth = Math.max(1, dpr);
    const P = [[0, 0], [this.w, 0], [this.w, this.h], [0, this.h]].map((q) => this.dev(this.pt(q[0], q[1])));
    g.strokeStyle = '#fff'; g.beginPath(); P.forEach((q, i) => (i ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1]))); g.closePath(); g.stroke();
    g.strokeStyle = '#000'; g.setLineDash([4 * dpr, 4 * dpr]); g.stroke(); g.setLineDash([]);
    const s = 4.5 * dpr;
    for (const [, u, w] of HANDLES) { const q = this.dev(this.pt(u * this.w, w * this.h)); g.fillStyle = '#fff'; g.strokeStyle = '#000'; g.fillRect(q[0] - s, q[1] - s, 2 * s, 2 * s); g.strokeRect(q[0] - s, q[1] - s, 2 * s, 2 * s); }
    const c = this.dev(this.center()); g.strokeStyle = '#000'; g.beginPath(); g.moveTo(c[0] - 6 * dpr, c[1]); g.lineTo(c[0] + 6 * dpr, c[1]); g.moveTo(c[0], c[1] - 6 * dpr); g.lineTo(c[0], c[1] + 6 * dpr); g.stroke();
    g.restore();
  }

  // ── finish ──
  close() {
    this.active = false; this.drag = null; if (this.L) this.L.hideForEdit = false;
    if (this.bar) { this.bar.remove(); this.bar = null; } this.fields = null;
    this.vp.invalidate(); this.vp.drawOverlay(); this.app.refreshCursor();
  }
  commit() {
    if (!this.active) return;
    const d = this.doc, L = this.L, M = [...this.M], moved = M.some((v, i) => Math.abs(v - [1, 0, 0, 1, L.x, L.y][i]) > 1e-9);
    this.close();
    if (!moved) return;
    const pure = Math.abs(M[0] - 1) < 1e-9 && Math.abs(M[1]) < 1e-9 && Math.abs(M[2]) < 1e-9 && Math.abs(M[3] - 1) < 1e-9;
    if (pure) { d.pushProps('Move', [{ layer: L, old: { x: L.x, y: L.y }, now: { x: Math.round(M[4]), y: Math.round(M[5]) } }]); L.x = Math.round(M[4]); L.y = Math.round(M[5]); L.touch(); this.app.vp.invalidate(); return; }
    d.applyLayerMatrix(L, M, 'Free Transform');
  }
  cancel() { if (!this.active) return; this.close(); }
}

/** Fixed layer operations: flips and 90-degree turns about the layer's centre. */
export function layerTurn(app, kind) {
  const d = app.doc, L = d && d.active;
  if (!L || L.type !== 'raster' || !L.canvas) { toast('Select a regular layer first.'); return; }
  if (L.lockPos || L.lockAll || L.lockPix) { toast('That layer is locked.'); return; }
  const w = L.canvas.width, hh = L.canvas.height, cx = L.x + w / 2, cy = L.y + hh / 2;
  const R = { fliph: [-1, 0, 0, 1], flipv: [1, 0, 0, -1], r180: [-1, 0, 0, -1], cw: [0, 1, -1, 0], ccw: [0, -1, 1, 0] }[kind];
  const name = { fliph: 'Flip Horizontal', flipv: 'Flip Vertical', r180: 'Rotate 180°', cw: 'Rotate 90° CW', ccw: 'Rotate 90° CCW' }[kind];
  const [a, b, c, dd] = R, e = cx - (a * (w / 2) + c * (hh / 2)), f = cy - (b * (w / 2) + dd * (hh / 2));
  d.applyLayerMatrix(L, [a, b, c, dd, e, f], name);
}
