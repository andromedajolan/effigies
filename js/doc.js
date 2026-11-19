// Document model: layers, groups, history, and every operation that changes them.
import { uid, makeCanvas, ctxOf, rectUnion } from './util.js';
import { compose, renderFull, releaseCanvas } from './render.js';

export const canvasBytes = (c) => (c ? c.width * c.height * 4 : 0);

export class Layer {
  constructor(o = {}) {
    this.id = o.id || uid();
    this.type = o.type || 'raster';
    this.name = o.name || 'Layer';
    this.visible = o.visible ?? true;
    this.opacity = o.opacity ?? 1;
    this.fill = o.fill ?? 1;
    this.blend = o.blend || (this.type === 'group' ? 'pass' : 'normal');
    this.lockTrans = !!o.lockTrans; this.lockPix = !!o.lockPix; this.lockPos = !!o.lockPos; this.lockAll = !!o.lockAll;
    this.x = o.x || 0; this.y = o.y || 0;
    this.canvas = o.canvas || null;
    this.children = this.type === 'group' ? (o.children || []) : null;
    this.collapsed = !!o.collapsed;
    this.ver = 1;          // bumps whenever pixels change (autosave watches this)
    this.thumbDirty = true;
  }
  touch() { this.ver++; this.thumbDirty = true; }
  get w() { return this.canvas ? this.canvas.width : 0; }
  get h() { return this.canvas ? this.canvas.height : 0; }
  bounds() { return this.canvas ? { x: this.x, y: this.y, w: this.canvas.width, h: this.canvas.height } : null; }
  /** Grow the pixel canvas so it covers the doc-space rectangle [x0,x1) x [y0,y1). */
  ensureRect(x0, y0, x1, y1) {
    x0 = Math.floor(x0); y0 = Math.floor(y0); x1 = Math.ceil(x1); y1 = Math.ceil(y1);
    if (!this.canvas) { this.canvas = makeCanvas(x1 - x0, y1 - y0); this.x = x0; this.y = y0; return; }
    const cx1 = this.x + this.canvas.width, cy1 = this.y + this.canvas.height;
    if (x0 >= this.x && y0 >= this.y && x1 <= cx1 && y1 <= cy1) return;
    const nx0 = Math.min(x0, this.x), ny0 = Math.min(y0, this.y), nx1 = Math.max(x1, cx1), ny1 = Math.max(y1, cy1);
    const nc = makeCanvas(nx1 - nx0, ny1 - ny0);
    ctxOf(nc).drawImage(this.canvas, this.x - nx0, this.y - ny0);
    this.canvas = nc; this.x = nx0; this.y = ny0;
  }
}

export function layerMeta(L) {
  return {
    id: L.id, type: L.type, name: L.name, visible: L.visible, opacity: L.opacity, fill: L.fill, blend: L.blend,
    lockTrans: L.lockTrans, lockPix: L.lockPix, lockPos: L.lockPos, lockAll: L.lockAll,
    x: L.x, y: L.y, w: L.w, h: L.h, collapsed: L.collapsed,
  };
}

export function cloneCanvas(c) {
  if (!c) return null;
  const n = makeCanvas(c.width, c.height);
  ctxOf(n).drawImage(c, 0, 0);
  return n;
}

export function cloneLayer(L, fresh = true, suffix = '') {
  const n = new Layer({ ...layerMeta(L), id: fresh ? undefined : L.id, name: L.name + suffix, canvas: cloneCanvas(L.canvas) });
  if (L.type === 'group') { n.children = L.children.map((k) => cloneLayer(k, fresh)); }
  return n;
}

export function walkLayers(list, fn, parent = null) {
  for (const L of list) { fn(L, parent); if (L.children) walkLayers(L.children, fn, L); }
}

function treeBytes(layers) { let n = 0; walkLayers(layers, (L) => { n += canvasBytes(L.canvas); }); return n; }

// ───────────────────────── History ─────────────────────────
export class History {
  constructor(doc) { this.doc = doc; this.items = []; this.index = -1; this.bytes = 0; this.limit = 50; this.budget = 320 * 1048576; }
  push(e) {
    for (const d of this.items.splice(this.index + 1)) this.bytes -= d.bytes || 0;
    this.items.push(e); this.index = this.items.length - 1; this.bytes += e.bytes || 0;
    while (this.items.length > 1 && (this.items.length > this.limit || this.bytes > this.budget)) {
      const d = this.items.shift(); this.bytes -= d.bytes || 0; this.index--;
    }
    this.doc.changed({ history: true, skipRender: true });
  }
  apply(e, fn) { fn(); this.doc.changed(e.rect ? { rect: e.rect, tree: !!e.tree, history: true } : { tree: true, history: true }); }
  undo() { if (this.index < 0) return false; const e = this.items[this.index]; this.index--; this.apply(e, () => e.undo()); return true; }
  redo() { if (this.index >= this.items.length - 1) return false; const e = this.items[this.index + 1]; this.index++; this.apply(e, () => e.redo()); return true; }
  goto(i) { while (this.index > i && this.undo()); while (this.index < i && this.redo()); }
  get canUndo() { return this.index >= 0; }
  get canRedo() { return this.index < this.items.length - 1; }
}

// ───────────────────────── Transaction (structural/property/pixel-swap edits) ─────────────────────────
class Txn {
  constructor(doc, name) { this.doc = doc; this.name = name; this.ops = []; this.before = doc.snapTree(); this.bytes = 0; this.rect = null; }
  swapPixels(L, canvas, x, y) {
    const o = { canvas: L.canvas, x: L.x, y: L.y };
    const n = { canvas, x, y };
    const set = (v) => { L.canvas = v.canvas; L.x = v.x; L.y = v.y; L.touch(); };
    set(n); this.bytes += canvasBytes(o.canvas);
    this.ops.push({ undo: () => set(o), redo: () => set(n) });
  }
  setProps(L, props) {
    const o = {}; for (const k of Object.keys(props)) o[k] = L[k];
    Object.assign(L, props);
    if ('x' in props || 'y' in props) L.touch();
    this.ops.push({ undo: () => Object.assign(L, o), redo: () => Object.assign(L, props) });
  }
  setSize(w, h) {
    const d = this.doc, ow = d.w, oh = d.h;
    d.w = w; d.h = h;
    this.ops.push({ undo: () => { d.w = ow; d.h = oh; }, redo: () => { d.w = w; d.h = h; } });
  }
  end() {
    const d = this.doc, after = d.snapTree();
    const keep = new Set(); walkLayers(d.layers, (L) => keep.add(L));
    let gone = 0; const scan = (nodes) => { for (const n of nodes) { if (!keep.has(n.L)) gone += canvasBytes(n.L.canvas); if (n.kids) scan(n.kids); } };
    scan(this.before.tree);
    const before = this.before, ops = this.ops;
    d.hist.push({
      name: this.name, bytes: this.bytes + gone,
      undo: () => { for (let i = ops.length - 1; i >= 0; i--) ops[i].undo(); d.restoreTree(before); },
      redo: () => { for (const o of ops) o.redo(); d.restoreTree(after); },
    });
    d.changed({ tree: true });
  }
}

// ───────────────────────── Document ─────────────────────────
export class Doc {
  constructor({ id, name = 'Untitled', w = 3000, h = 3000 } = {}) {
    this.id = id || uid();
    this.name = name; this.w = w; this.h = h;
    this.layers = []; this.activeId = null;
    this.view = { zoom: 1, tx: 0, ty: 0, fit: true };
    this.hist = new History(this);
    this.rev = 0; this.savedRev = -1;
    this.created = Date.now(); this.modified = Date.now();
    this.songRef = null;
    this.seq = 1; this.gseq = 1;
    this.listeners = new Set();
    this.live = null;
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  changed(info = {}) { this.rev++; this.modified = Date.now(); for (const fn of this.listeners) fn(info); }

  // tree helpers
  snapTree() { const s = (list) => list.map((L) => ({ L, kids: L.children ? s(L.children) : null })); return { tree: s(this.layers), active: this.activeId }; }
  restoreTree(s) {
    const r = (nodes) => nodes.map((n) => { if (n.kids) n.L.children = r(n.kids); return n.L; });
    this.layers = r(s.tree); this.activeId = s.active;
  }
  findNode(id, list = this.layers, parent = null) {
    for (let i = 0; i < list.length; i++) {
      if (list[i].id === id) return { layer: list[i], list, index: i, parent };
      if (list[i].children) { const r = this.findNode(id, list[i].children, list[i]); if (r) return r; }
    }
    return null;
  }
  find(id) { const n = this.findNode(id); return n ? n.layer : null; }
  get active() { return this.activeId ? this.find(this.activeId) : null; }
  allLayers() { const a = []; walkLayers(this.layers, (L) => a.push(L)); return a; }
  begin(name) { return new Txn(this, name); }
  estimateBytes() { return treeBytes(this.layers); }
  isRaster(L) { return L && L.type === 'raster'; }

  // pixel history: before/after are ImageData for the doc-space rect
  pushPatch(L, rect, before, after, name) {
    const apply = (img) => { L.ensureRect(rect.x, rect.y, rect.x + rect.w, rect.y + rect.h); ctxOf(L.canvas).putImageData(img, rect.x - L.x, rect.y - L.y); L.touch(); };
    this.hist.push({ name, rect, bytes: rect.w * rect.h * 8, undo: () => apply(before), redo: () => apply(after) });
    this.changed({ rect, layerId: L.id, skipRender: true });
  }
  /** Run drawing code on a layer over a doc-space rect and record the change for undo. */
  editPixels(L, rect, name, fn) {
    L.ensureRect(rect.x, rect.y, rect.x + rect.w, rect.y + rect.h);
    const g = ctxOf(L.canvas), ox = rect.x - L.x, oy = rect.y - L.y;
    const before = g.getImageData(ox, oy, rect.w, rect.h);
    fn(g, -L.x, -L.y);   // drawing offset: doc space -> layer space
    const after = g.getImageData(ox, oy, rect.w, rect.h);
    L.touch();
    this.pushPatch(L, rect, before, after, name);
    this.changed({ rect, layerId: L.id });
  }
  pushProps(name, entries) {   // entries: [{layer, old:{}, now:{}}] already applied
    this.hist.push({
      name, bytes: 0,
      undo: () => { for (const e of entries) { Object.assign(e.layer, e.old); if ('x' in e.old || 'y' in e.old) e.layer.touch(); } },
      redo: () => { for (const e of entries) { Object.assign(e.layer, e.now); if ('x' in e.now || 'y' in e.now) e.layer.touch(); } },
    });
    this.changed({ tree: true });
  }

  // ── layer operations ──
  _insertAbove(L) {
    const n = this.activeId && this.findNode(this.activeId);
    if (n) n.list.splice(n.index + 1, 0, L); else this.layers.push(L);
  }
  newLayer(opts = {}) {
    const t = this.begin(opts.type === 'group' ? 'New Group' : 'New Layer');
    const L = new Layer({ name: opts.name || (opts.type === 'group' ? 'Group ' + this.gseq++ : 'Layer ' + this.seq++), ...opts });
    this._insertAbove(L); this.activeId = L.id;
    t.end(); return L;
  }
  addImageLayer(canvas, name, x, y, opts = {}) {
    const t = this.begin(opts.historyName || 'New Layer');
    const L = new Layer({ name: name || 'Layer ' + this.seq++, canvas, x, y });
    this._insertAbove(L); this.activeId = L.id;
    t.end(); return L;
  }
  duplicateLayer(L = this.active, name) {
    if (!L) return null;
    const t = this.begin(name ? 'Layer via Copy' : 'Duplicate Layer');
    const n = cloneLayer(L, true, name === undefined ? ' copy' : '');
    const nd = this.findNode(L.id); nd.list.splice(nd.index + 1, 0, n); this.activeId = n.id;
    t.end(); return n;
  }
  deleteLayer(L = this.active) {
    if (!L) return;
    const t = this.begin('Delete Layer');
    const n = this.findNode(L.id);
    n.list.splice(n.index, 1);
    const nb = n.list[Math.min(n.index, n.list.length - 1)] || n.parent || this.layers[this.layers.length - 1];
    this.activeId = nb ? nb.id : null;
    t.end();
  }
  moveTo(L, targetList, index, name = 'Move Layer') {
    // refuse to drop a group inside itself
    if (L.type === 'group') { let bad = false; walkLayers(L.children, (k) => { if (k.children === targetList) bad = true; }); if (bad || L.children === targetList) return false; }
    const t = this.begin(name);
    const n = this.findNode(L.id);
    n.list.splice(n.index, 1);
    if (n.list === targetList && index > n.index) index--;
    targetList.splice(Math.max(0, Math.min(index, targetList.length)), 0, L);
    t.end(); return true;
  }
  arrange(L, how) {
    const n = this.findNode(L.id); if (!n) return;
    const len = n.list.length; let to = n.index;
    if (how === 'front') to = len - 1; else if (how === 'back') to = 0; else if (how === 'forward') to = Math.min(len - 1, n.index + 1); else if (how === 'backward') to = Math.max(0, n.index - 1);
    if (to === n.index) return;
    const t = this.begin('Arrange Layers');
    n.list.splice(n.index, 1); n.list.splice(to, 0, L);
    t.end();
  }
  group(L = this.active) {
    if (!L) return null;
    const t = this.begin('New Group from Layers');
    const n = this.findNode(L.id);
    const G = new Layer({ type: 'group', name: 'Group ' + this.gseq++, children: [L] });
    n.list.splice(n.index, 1, G); this.activeId = G.id;
    t.end(); return G;
  }
  ungroup(G = this.active) {
    if (!G || G.type !== 'group') return;
    const t = this.begin('Ungroup Layers');
    const n = this.findNode(G.id);
    n.list.splice(n.index, 1, ...G.children);
    this.activeId = G.children.length ? G.children[G.children.length - 1].id : null;
    t.end();
  }
  _flatten(nodes, region, bg) {
    const tf = { zoom: 1, tx: -region.x, ty: -region.y };
    const c = compose(nodes, tf, region.w, region.h);
    const out = makeCanvas(region.w, region.h);
    ctxOf(out).drawImage(c, 0, 0);
    releaseCanvas(c);
    return out;
  }
  mergeDown(L = this.active) {
    if (!L || L.type !== 'raster') return false;
    const n = this.findNode(L.id);
    const below = n.list[n.index - 1];
    if (!below || below.type !== 'raster' || !L.visible) return false;
    const bb = below.bounds(), ub = L.bounds();
    const region = rectUnion(bb, ub);
    if (!region) return false;
    const t = this.begin('Merge Layers');
    const lower = { type: 'raster', visible: true, opacity: 1, fill: 1, blend: 'normal', canvas: below.canvas, x: below.x, y: below.y };
    const out = this._flatten([lower, L], region);
    t.swapPixels(below, out, region.x, region.y);
    n.list.splice(n.index, 1); this.activeId = below.id;
    t.end(); return true;
  }
  mergeVisible() {
    const vis = this.layers.filter((L) => L.visible);
    if (vis.length < 2) return false;
    let region = null;
    walkLayers(vis, (L) => { if (L.canvas) region = rectUnion(region, L.bounds()); });
    if (!region) return false;
    const t = this.begin('Merge Visible');
    const out = this._flatten(vis, region);
    const idx = this.layers.indexOf(vis[0]);
    const M = new Layer({ name: vis[0].name, canvas: out, x: region.x, y: region.y });
    this.layers = this.layers.filter((L) => !L.visible);
    this.layers.splice(Math.min(idx, this.layers.length), 0, M);
    this.activeId = M.id;
    t.end(); return true;
  }
  flatten() {
    const vis = this.layers.filter((L) => L.visible);
    if (!vis.length || (this.layers.length === 1 && this.layers[0].type === 'raster')) return false;
    const t = this.begin('Flatten Image');
    const region = { x: 0, y: 0, w: this.w, h: this.h };
    const out = this._flatten(vis, region);
    const M = new Layer({ name: 'Background', canvas: out, x: 0, y: 0 });
    this.layers = [M]; this.activeId = M.id;
    t.end(); return true;
  }
  fillLayer(L, color, name = 'Fill') {
    if (!L || L.type !== 'raster' || L.lockPix || L.lockAll) return false;
    this.editPixels(L, { x: 0, y: 0, w: this.w, h: this.h }, name, (g, ox, oy) => {
      g.save(); g.globalCompositeOperation = L.lockTrans ? 'source-atop' : 'source-over';
      g.fillStyle = color; g.fillRect(ox, oy, this.w, this.h); g.restore();
    });
    return true;
  }
  clearLayer(L) {
    if (!L || L.type !== 'raster' || !L.canvas || L.lockPix || L.lockAll) return false;
    const r = L.bounds();
    this.editPixels(L, r, 'Clear', (g) => g.clearRect(0, 0, L.canvas.width, L.canvas.height));
    return true;
  }

  // ── whole-document geometry ──
  _rebuildAll(name, nw, nh, fn) {
    const t = this.begin(name);
    walkLayers(this.layers, (L) => { if (L.type === 'raster' && L.canvas) { const r = fn(L); if (r) t.swapPixels(L, r.canvas, r.x, r.y); } });
    t.setSize(nw, nh);
    t.end();
  }
  resizeImage(nw, nh, { smooth = true, sharpen = 0 } = {}) {
    const sx = nw / this.w, sy = nh / this.h;
    this._rebuildAll('Image Size', nw, nh, (L) => {
      const w = Math.max(1, Math.round(L.w * sx)), h = Math.max(1, Math.round(L.h * sy));
      let src = L.canvas;
      // step toward the target in <=2x jumps so big changes stay clean
      let cw = src.width, ch = src.height;
      while (smooth && (cw > w * 2 || ch > h * 2 || cw * 2 < w || ch * 2 < h) && (cw !== w || ch !== h)) {
        const nxw = cw > w * 2 ? Math.ceil(cw / 2) : cw * 2 < w ? cw * 2 : w;
        const nxh = ch > h * 2 ? Math.ceil(ch / 2) : ch * 2 < h ? ch * 2 : h;
        const step = makeCanvas(nxw, nxh); const g = ctxOf(step);
        g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high'; g.drawImage(src, 0, 0, nxw, nxh);
        src = step; cw = nxw; ch = nxh;
      }
      const out = makeCanvas(w, h); const g = ctxOf(out);
      g.imageSmoothingEnabled = smooth; if (smooth) g.imageSmoothingQuality = 'high';
      g.drawImage(src, 0, 0, w, h);
      if (sharpen > 0 && (w > L.w || h > L.h)) unsharp(out, sharpen / 100);
      return { canvas: out, x: Math.round(L.x * sx), y: Math.round(L.y * sy) };
    });
  }
  resizeCanvas(nw, nh, ax = 1, ay = 1) {
    const dx = Math.round((nw - this.w) * ax / 2), dy = Math.round((nh - this.h) * ay / 2);
    const t = this.begin('Canvas Size');
    walkLayers(this.layers, (L) => { t.setProps(L, { x: L.x + dx, y: L.y + dy }); });
    t.setSize(nw, nh);
    t.end();
  }
  transformImage(kind) {
    const W = this.w, H = this.h;
    const M = { cw: [0, 1, -1, 0, H, 0], ccw: [0, -1, 1, 0, 0, W], r180: [-1, 0, 0, -1, W, H], fliph: [-1, 0, 0, 1, W, 0], flipv: [1, 0, 0, -1, 0, H] }[kind];
    const swap = kind === 'cw' || kind === 'ccw';
    const names = { cw: 'Rotate 90° CW', ccw: 'Rotate 90° CCW', r180: 'Rotate 180°', fliph: 'Flip Canvas Horizontal', flipv: 'Flip Canvas Vertical' };
    this._rebuildAll(names[kind], swap ? H : W, swap ? W : H, (L) => {
      const [a, b, c, d, e, f] = M;
      const xs = [L.x, L.x + L.w], ys = [L.y, L.y + L.h];
      const px = [], py = [];
      for (const x of xs) for (const y of ys) { px.push(a * x + c * y + e); py.push(b * x + d * y + f); }
      const bx = Math.min(...px), by = Math.min(...py);
      const out = makeCanvas(Math.max(...px) - bx, Math.max(...py) - by);
      const g = ctxOf(out); g.imageSmoothingEnabled = false;
      g.setTransform(a, b, c, d, e - bx, f - by); g.drawImage(L.canvas, L.x, L.y);
      return { canvas: out, x: bx, y: by };
    });
  }

  toCanvas(opts) { return renderFull(this.layers, this.w, this.h, opts); }
}

/** Unsharp mask on a canvas (RGB only, alpha untouched). amount 0..1.5ish, radius in px. */
export function unsharp(canvas, amount, radius = 1.2) {
  const w = canvas.width, h = canvas.height;
  const blur = makeCanvas(w, h); const bg = ctxOf(blur);
  bg.filter = `blur(${radius}px)`; bg.drawImage(canvas, 0, 0); bg.filter = 'none';
  const g = ctxOf(canvas);
  const a = g.getImageData(0, 0, w, h), b = bg.getImageData(0, 0, w, h);
  const A = a.data, B = b.data, k = amount * 1.5;
  for (let i = 0; i < A.length; i += 4) {
    if (A[i + 3] === 0) continue;
    A[i] += k * (A[i] - B[i]); A[i + 1] += k * (A[i + 1] - B[i + 1]); A[i + 2] += k * (A[i + 2] - B[i + 2]);
  }
  g.putImageData(a, 0, 0);
}
