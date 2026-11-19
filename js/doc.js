// Document model: layers, groups, history, and every operation that changes them.
import { uid, makeCanvas, ctxOf, rectUnion, rectIntersect } from './util.js';
import { compose, renderFull, releaseCanvas } from './render.js';

export const canvasBytes = (c) => (c ? c.width * c.height * 4 : 0);
export const selBytes = (s) => (s ? canvasBytes(s.canvas) : 0);

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
    this.mask = o.mask || null;          // {canvas, x, y}: x,y are relative to the layer origin; alpha = how much is HIDDEN
    this.maskOn = o.maskOn ?? true;
    this.editMask = false;               // transient: paint target is the mask
    this.mver = 1;
    this.ver = 1;          // bumps whenever pixels change (autosave watches this)
    this.thumbDirty = true;
  }
  touch() { this.ver++; this.thumbDirty = true; }
  touchMask() { this.mver++; this.thumbDirty = true; }
  /** Grow (or create) the mask so it covers the doc-space rectangle. Outside the mask a layer is fully visible. */
  ensureMaskRect(x0, y0, x1, y1) {
    x0 = Math.floor(x0) - this.x; y0 = Math.floor(y0) - this.y; x1 = Math.ceil(x1) - this.x; y1 = Math.ceil(y1) - this.y;
    const m = this.mask;
    if (!m) { this.mask = { canvas: makeCanvas(x1 - x0, y1 - y0), x: x0, y: y0 }; return; }
    const cx1 = m.x + m.canvas.width, cy1 = m.y + m.canvas.height;
    if (x0 >= m.x && y0 >= m.y && x1 <= cx1 && y1 <= cy1) return;
    const nx0 = Math.min(x0, m.x), ny0 = Math.min(y0, m.y), nx1 = Math.max(x1, cx1), ny1 = Math.max(y1, cy1);
    const nc = makeCanvas(nx1 - nx0, ny1 - ny0);
    ctxOf(nc).drawImage(m.canvas, m.x - nx0, m.y - ny0);
    this.mask = { canvas: nc, x: nx0, y: ny0 };
  }
  maskBounds() { const m = this.mask; return m ? { x: this.x + m.x, y: this.y + m.y, w: m.canvas.width, h: m.canvas.height } : null; }
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
    x: L.x, y: L.y, w: L.w, h: L.h, collapsed: L.collapsed, maskOn: L.maskOn,
    mask: L.mask ? { x: L.mask.x, y: L.mask.y, w: L.mask.canvas.width, h: L.mask.canvas.height } : null,
  };
}

export function cloneCanvas(c) {
  if (!c) return null;
  const n = makeCanvas(c.width, c.height);
  ctxOf(n).drawImage(c, 0, 0);
  return n;
}

export function cloneLayer(L, fresh = true, suffix = '') {
  const n = new Layer({ ...layerMeta(L), id: fresh ? undefined : L.id, name: L.name + suffix, canvas: cloneCanvas(L.canvas),
    mask: L.mask ? { canvas: cloneCanvas(L.mask.canvas), x: L.mask.x, y: L.mask.y } : null });
  if (L.type === 'group') { n.children = L.children.map((k) => cloneLayer(k, fresh)); }
  return n;
}

export function walkLayers(list, fn, parent = null) {
  for (const L of list) { fn(L, parent); if (L.children) walkLayers(L.children, fn, L); }
}

function treeBytes(layers) { let n = 0; walkLayers(layers, (L) => { n += canvasBytes(L.canvas) + (L.mask ? canvasBytes(L.mask.canvas) : 0); }); return n; }

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
  setMask(L, mask) {
    const o = L.mask;
    const set = (v) => { L.mask = v; L.touchMask(); };
    set(mask); this.bytes += o ? canvasBytes(o.canvas) : 0;
    this.ops.push({ undo: () => set(o), redo: () => set(mask) });
  }
  setProps(L, props) {
    const o = {}; for (const k of Object.keys(props)) o[k] = L[k];
    Object.assign(L, props);
    if ('x' in props || 'y' in props) L.touch();
    this.ops.push({ undo: () => Object.assign(L, o), redo: () => Object.assign(L, props) });
  }
  clearSel() {
    const d = this.doc, o = d.sel;
    if (!o) return;
    d.sel = null; this.bytes += selBytes(o);
    this.ops.push({ undo: () => { d.sel = o; }, redo: () => { d.sel = null; } });
  }
  setSize(w, h) {
    const d = this.doc, ow = d.w, oh = d.h;
    d.w = w; d.h = h;
    this.ops.push({ undo: () => { d.w = ow; d.h = oh; }, redo: () => { d.w = w; d.h = h; } });
  }
  end() {
    const d = this.doc, after = d.snapTree();
    const keep = new Set(); walkLayers(d.layers, (L) => keep.add(L));
    let gone = 0; const scan = (nodes) => { for (const n of nodes) { if (!keep.has(n.L)) gone += canvasBytes(n.L.canvas) + (n.L.mask ? canvasBytes(n.L.mask.canvas) : 0); if (n.kids) scan(n.kids); } };
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
    this.sel = null; this.lastSel = null;   // selection: {canvas (alpha), x, y} in doc space
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
  // mask pixel history (mask canvas holds HIDE amount in its alpha channel)
  pushMaskPatch(L, rect, before, after, name) {
    const apply = (img) => { L.ensureMaskRect(rect.x, rect.y, rect.x + rect.w, rect.y + rect.h); const m = L.mask; ctxOf(m.canvas).putImageData(img, rect.x - L.x - m.x, rect.y - L.y - m.y); L.touchMask(); };
    this.hist.push({ name, rect, bytes: rect.w * rect.h * 8, undo: () => apply(before), redo: () => apply(after) });
    this.changed({ rect, layerId: L.id, skipRender: true });
  }
  editMask(L, rect, name, fn) {
    L.ensureMaskRect(rect.x, rect.y, rect.x + rect.w, rect.y + rect.h);
    const m = L.mask, g = ctxOf(m.canvas), ox = rect.x - L.x - m.x, oy = rect.y - L.y - m.y;
    const before = g.getImageData(ox, oy, rect.w, rect.h);
    fn(g, -(L.x + m.x), -(L.y + m.y));
    const after = g.getImageData(ox, oy, rect.w, rect.h);
    L.touchMask();
    this.pushMaskPatch(L, rect, before, after, name);
    this.changed({ rect, layerId: L.id });
  }
  /** Multiply an RGBA rect-sized canvas by the active selection (in place). */
  clipToSelection(src, rect) {
    if (!this.sel) return src;
    const g = ctxOf(src); g.save(); g.globalCompositeOperation = 'destination-in';
    g.drawImage(this.sel.canvas, this.sel.x - rect.x, this.sel.y - rect.y);
    g.restore();
    return src;
  }
  /** Put a rect-sized RGBA canvas onto the paint target (layer pixels, or the mask when the mask is being edited). */
  paintToTarget(L, rect, name, src, { erase = false, clip = true } = {}) {
    if (clip) this.clipToSelection(src, rect);
    if (L.editMask && L.mask) {
      const img = ctxOf(src).getImageData(0, 0, rect.w, rect.h).data;
      this.editMask(L, rect, name, (g, ox, oy) => {
        const m = g.getImageData(rect.x + ox, rect.y + oy, rect.w, rect.h), d = m.data;
        for (let i = 0; i < d.length; i += 4) {
          const a = img[i + 3] / 255; if (!a) continue;
          const lum = erase ? 1 : (0.299 * img[i] + 0.587 * img[i + 1] + 0.114 * img[i + 2]) / 255;
          d[i + 3] = d[i + 3] * (1 - a) + (1 - lum) * 255 * a;
        }
        g.putImageData(m, rect.x + ox, rect.y + oy);
      });
      return;
    }
    this.editPixels(L, rect, name, (g, ox, oy) => {
      g.save();
      g.globalCompositeOperation = erase ? 'destination-out' : (L.lockTrans ? 'source-atop' : 'source-over');
      g.drawImage(src, rect.x + ox, rect.y + oy); g.restore();
    });
  }
  setSelection(sel, name = 'Select') {
    const old = this.sel;
    if (old) this.lastSel = old;
    this.sel = sel;
    this.hist.push({ name, bytes: selBytes(old) + selBytes(sel), sel: true, undo: () => { this.sel = old; }, redo: () => { this.sel = sel; } });
    this.changed({ selection: true });
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
    const lower = { type: 'raster', visible: true, opacity: 1, fill: 1, blend: 'normal', canvas: below.canvas, x: below.x, y: below.y, mask: below.mask, maskOn: below.maskOn };
    const out = this._flatten([lower, L], region);
    t.swapPixels(below, out, region.x, region.y);
    if (below.mask) t.setMask(below, null);
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
    if (!L || L.type !== 'raster') return false;
    const editM = L.editMask && L.mask;
    if (!editM && (L.lockPix || L.lockAll)) return false;
    let rect = { x: 0, y: 0, w: this.w, h: this.h };
    if (this.sel) { const b = { x: this.sel.x, y: this.sel.y, w: this.sel.canvas.width, h: this.sel.canvas.height }; rect = rectIntersect(rect, b); if (!rect) return false; }
    const src = makeCanvas(rect.w, rect.h, false), g = ctxOf(src); g.fillStyle = color; g.fillRect(0, 0, rect.w, rect.h);
    this.paintToTarget(L, rect, name, src);
    return true;
  }
  clearLayer(L) {
    if (!L || L.type !== 'raster' || !L.canvas || L.lockPix || L.lockAll) return false;
    if (this.sel) {
      const rect = rectIntersect(L.bounds(), { x: this.sel.x, y: this.sel.y, w: this.sel.canvas.width, h: this.sel.canvas.height });
      if (!rect) return false;
      const src = makeCanvas(rect.w, rect.h, false), g = ctxOf(src); g.fillStyle = '#000'; g.fillRect(0, 0, rect.w, rect.h);
      this.paintToTarget(L, rect, 'Clear', src, { erase: true });
      return true;
    }
    const r = L.bounds();
    this.editPixels(L, r, 'Clear', (g) => g.clearRect(0, 0, L.canvas.width, L.canvas.height));
    return true;
  }

  // ── layer masks ──
  _maskRegion(L) { return rectUnion({ x: 0, y: 0, w: this.w, h: this.h }, L.bounds()); }
  /** kind: 'reveal' | 'hide' | 'revealSel' | 'hideSel' */
  addMask(L, kind = 'reveal') {
    if (!L || L.type !== 'raster' || L.mask) return false;
    const r = this._maskRegion(L), c = makeCanvas(r.w, r.h), g = ctxOf(c);
    const sel = this.sel;
    if (kind === 'hide' || kind === 'revealSel') { g.fillStyle = '#000'; g.fillRect(0, 0, r.w, r.h); }
    if (sel && kind === 'revealSel') { g.globalCompositeOperation = 'destination-out'; g.drawImage(sel.canvas, sel.x - r.x, sel.y - r.y); }
    if (sel && kind === 'hideSel') {
      const t = makeCanvas(sel.canvas.width, sel.canvas.height), tg = ctxOf(t); tg.fillStyle = '#000'; tg.fillRect(0, 0, t.width, t.height);
      tg.globalCompositeOperation = 'destination-in'; tg.drawImage(sel.canvas, 0, 0); g.drawImage(t, sel.x - r.x, sel.y - r.y);
    }
    if ((kind === 'revealSel' || kind === 'hideSel') && !sel) return this.addMask(L, kind === 'revealSel' ? 'hide' : 'reveal');
    const t = this.begin('Add Layer Mask');
    t.setMask(L, { canvas: c, x: r.x - L.x, y: r.y - L.y });
    t.setProps(L, { maskOn: true });
    L.editMask = true;
    t.end(); return true;
  }
  deleteMask(L, apply = false) {
    if (!L || !L.mask) return false;
    const t = this.begin(apply ? 'Apply Layer Mask' : 'Delete Layer Mask');
    if (apply && L.canvas) {
      const out = makeCanvas(L.w, L.h), g = ctxOf(out);
      g.drawImage(L.canvas, 0, 0);
      if (L.maskOn) { g.globalCompositeOperation = 'destination-out'; g.drawImage(L.mask.canvas, L.mask.x, L.mask.y); }
      t.swapPixels(L, out, L.x, L.y);
    }
    t.setMask(L, null); L.editMask = false;
    t.end(); return true;
  }
  invertMask(L) {
    if (!L || !L.mask) return false;
    const r = this._maskRegion(L);
    this.editMask(L, r, 'Invert Mask', (g, ox, oy) => {
      const im = g.getImageData(r.x + ox, r.y + oy, r.w, r.h), d = im.data;
      for (let i = 3; i < d.length; i += 4) d[i] = 255 - d[i];
      g.putImageData(im, r.x + ox, r.y + oy);
    });
    return true;
  }
  toggleMask(L) {
    if (!L || !L.mask) return;
    const o = L.maskOn; L.maskOn = !o; L.touchMask();
    this.pushProps(L.maskOn ? 'Enable Layer Mask' : 'Disable Layer Mask', [{ layer: L, old: { maskOn: o }, now: { maskOn: L.maskOn } }]);
  }

  // ── whole-document geometry ──
  _rebuildAll(name, nw, nh, fn) {
    const t = this.begin(name);
    walkLayers(this.layers, (L) => {
      if (L.type !== 'raster') return;
      let r = null;
      if (L.canvas) { r = fn(L); if (r) t.swapPixels(L, r.canvas, r.x, r.y); }
      if (L.mask) {
        const m = L.mask, rm = fn({ x: L.x + m.x, y: L.y + m.y, w: m.canvas.width, h: m.canvas.height, canvas: m.canvas });
        if (rm && rm.canvas) { const nx = r ? r.x : L.x, ny = r ? r.y : L.y; t.setMask(L, { canvas: rm.canvas, x: rm.x - nx, y: rm.y - ny }); } else t.setMask(L, null);
      }
    });
    t.clearSel();
    t.setSize(nw, nh);
    t.end();
  }
  /** Crop the document to a doc-space rectangle. deletePixels=false keeps off-canvas pixels on the layers. */
  cropTo(rect, deletePixels = true) {
    rect = { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.w), h: Math.round(rect.h) };
    if (rect.w < 1 || rect.h < 1) return false;
    if (rect.x === 0 && rect.y === 0 && rect.w === this.w && rect.h === this.h) return false;
    if (!deletePixels) {
      const t = this.begin('Crop');
      walkLayers(this.layers, (L) => { t.setProps(L, { x: L.x - rect.x, y: L.y - rect.y }); });
      t.clearSel(); t.setSize(rect.w, rect.h); t.end(); return true;
    }
    this._rebuildAll('Crop', rect.w, rect.h, (P) => {
      const ix = rectIntersect({ x: P.x, y: P.y, w: P.w, h: P.h }, rect);
      if (!ix) return { canvas: null, x: 0, y: 0 };
      const out = makeCanvas(ix.w, ix.h);
      ctxOf(out).drawImage(P.canvas, P.x - ix.x, P.y - ix.y);
      return { canvas: out, x: ix.x - rect.x, y: ix.y - rect.y };
    });
    return true;
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
    t.clearSel();
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
