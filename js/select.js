// Selections: an alpha mask cropped to its bounding box, {canvas, x, y} in document space.
// Helpers to build, combine, feather and invert selections, and to draw "marching ants" for the overlay.
import { makeCanvas, ctxOf, rectIntersect } from './util.js';

export const selRect = (s) => ({ x: s.x, y: s.y, w: s.canvas.width, h: s.canvas.height });

/** Selection from a shape. kind: 'rect' | 'ellipse'. rect is in doc space (may be fractional); it is clipped to the document. */
export function shapeSelection(kind, rect, docW, docH, feather = 0, antiAlias = true) {
  let x0 = Math.round(rect.x), y0 = Math.round(rect.y), x1 = Math.round(rect.x + rect.w), y1 = Math.round(rect.y + rect.h);
  if (kind === 'rect') { /* integers already */ } else { x0 = Math.floor(rect.x); y0 = Math.floor(rect.y); x1 = Math.ceil(rect.x + rect.w); y1 = Math.ceil(rect.y + rect.h); }
  const pad = Math.ceil(feather * 2);
  const cx0 = Math.max(0, x0 - pad), cy0 = Math.max(0, y0 - pad), cx1 = Math.min(docW, x1 + pad), cy1 = Math.min(docH, y1 + pad);
  if (cx1 <= cx0 || cy1 <= cy0 || x1 <= x0 || y1 <= y0) return null;
  const c = makeCanvas(cx1 - cx0, cy1 - cy0), g = ctxOf(c);
  g.fillStyle = '#000';
  if (kind === 'rect') g.fillRect(x0 - cx0, y0 - cy0, x1 - x0, y1 - y0);
  else {
    g.beginPath(); g.ellipse((x0 + x1) / 2 - cx0, (y0 + y1) / 2 - cy0, (x1 - x0) / 2, (y1 - y0) / 2, 0, 0, 6.2832); g.fill();
    if (!antiAlias) hardenAlpha(c);
  }
  let sel = { canvas: c, x: cx0, y: cy0 };
  if (feather > 0) sel = featherSel(sel, feather, docW, docH);
  return trim(sel);
}

function hardenAlpha(c) {
  const g = ctxOf(c), im = g.getImageData(0, 0, c.width, c.height), d = im.data;
  for (let i = 3; i < d.length; i += 4) d[i] = d[i] >= 128 ? 255 : 0;
  g.putImageData(im, 0, 0);
}

export function selectAll(w, h) {
  const c = makeCanvas(w, h), g = ctxOf(c); g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
  return { canvas: c, x: 0, y: 0 };
}

/** Shrink the canvas to the bounding box of non-empty pixels. Returns null if nothing is selected. */
export function trim(sel) {
  if (!sel) return null;
  const c = sel.canvas, w = c.width, h = c.height;
  const d = ctxOf(c).getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++) if (d[row + x * 4 + 3] > 0) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) return null;
  if (x0 === 0 && y0 === 0 && x1 === w - 1 && y1 === h - 1) return sel;
  const n = makeCanvas(x1 - x0 + 1, y1 - y0 + 1);
  ctxOf(n).drawImage(c, -x0, -y0);
  return { canvas: n, x: sel.x + x0, y: sel.y + y0 };
}

/** Combine the existing selection with a new shape selection. mode: 'new' | 'add' | 'sub' | 'int'. */
export function combine(old, add, mode, docW, docH) {
  if (!old || mode === 'new') return add;
  if (!add) return mode === 'sub' ? old : mode === 'int' ? null : old;
  const ra = selRect(old), rb = selRect(add);
  let r;
  if (mode === 'add') { const x0 = Math.min(ra.x, rb.x), y0 = Math.min(ra.y, rb.y); r = { x: x0, y: y0, w: Math.max(ra.x + ra.w, rb.x + rb.w) - x0, h: Math.max(ra.y + ra.h, rb.y + rb.h) - y0 }; }
  else r = ra;
  const c = makeCanvas(r.w, r.h), g = ctxOf(c);
  g.drawImage(old.canvas, old.x - r.x, old.y - r.y);
  if (mode === 'add') g.drawImage(add.canvas, add.x - r.x, add.y - r.y);
  else if (mode === 'sub') { g.globalCompositeOperation = 'destination-out'; g.drawImage(add.canvas, add.x - r.x, add.y - r.y); }
  else if (mode === 'int') { g.globalCompositeOperation = 'destination-in'; g.drawImage(add.canvas, add.x - r.x, add.y - r.y); }
  return trim({ canvas: c, x: r.x, y: r.y });
}

export function invertSel(sel, docW, docH) {
  const c = makeCanvas(docW, docH), g = ctxOf(c);
  g.fillStyle = '#000'; g.fillRect(0, 0, docW, docH);
  if (sel) { g.globalCompositeOperation = 'destination-out'; g.drawImage(sel.canvas, sel.x, sel.y); }
  return trim({ canvas: c, x: 0, y: 0 });
}

export function featherSel(sel, radius, docW, docH) {
  if (!sel || radius <= 0) return sel;
  const pad = Math.ceil(radius * 2);
  const x0 = Math.max(0, sel.x - pad), y0 = Math.max(0, sel.y - pad), x1 = Math.min(docW, sel.x + sel.canvas.width + pad), y1 = Math.min(docH, sel.y + sel.canvas.height + pad);
  const c = makeCanvas(x1 - x0, y1 - y0), g = ctxOf(c);
  g.filter = `blur(${radius}px)`; g.drawImage(sel.canvas, sel.x - x0, sel.y - y0); g.filter = 'none';
  return trim({ canvas: c, x: x0, y: y0 });
}

/** Grow (amount>0) or shrink (amount<0) a selection by whole pixels. */
export function growSel(sel, amount, docW, docH) {
  if (!sel || !amount) return sel;
  const n = Math.abs(Math.round(amount)), pad = amount > 0 ? n : 0;
  const x0 = Math.max(0, sel.x - pad), y0 = Math.max(0, sel.y - pad), x1 = Math.min(docW, sel.x + sel.canvas.width + pad), y1 = Math.min(docH, sel.y + sel.canvas.height + pad);
  const w = x1 - x0, h = y1 - y0;
  const src = ctxOf(sel.canvas).getImageData(0, 0, sel.canvas.width, sel.canvas.height).data;
  const sw = sel.canvas.width, sh = sel.canvas.height, ox = sel.x - x0, oy = sel.y - y0;
  // alpha plane
  let a = new Uint8Array(w * h);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) a[(y + oy) * w + x + ox] = src[(y * sw + x) * 4 + 3];
  const pass = (grow) => {   // separable max/min filter with a square window of radius 1 (repeat n times -> diamond-ish, fine for UI use)
    const b = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let v = grow ? 0 : 255;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (dx && dy) continue;
        const xx = x + dx, yy = y + dy;
        const t = xx < 0 || yy < 0 || xx >= w || yy >= h ? (grow ? 0 : 0) : a[yy * w + xx];
        v = grow ? Math.max(v, t) : Math.min(v, t);
      }
      b[y * w + x] = v;
    }
    a = b;
  };
  for (let i = 0; i < n; i++) pass(amount > 0);
  const c = makeCanvas(w, h), g = ctxOf(c), im = g.createImageData(w, h);
  for (let i = 0; i < w * h; i++) im.data[i * 4 + 3] = a[i];
  g.putImageData(im, 0, 0);
  return trim({ canvas: c, x: x0, y: y0 });
}

/** Marching-ants overlay: two phase images of the selection edge, sized to the viewport (device pixels). */
export function buildAnts(sel, v, W, H) {
  const c = makeCanvas(W, H, true), g = ctxOf(c);
  g.imageSmoothingEnabled = false;
  const dx = sel.x * v.zoom + v.tx, dy = sel.y * v.zoom + v.ty;
  g.drawImage(sel.canvas, dx, dy, sel.canvas.width * v.zoom, sel.canvas.height * v.zoom);
  const im = g.getImageData(0, 0, W, H), d = im.data;
  const inside = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) inside[i] = d[i * 4 + 3] > 127 ? 1 : 0;
  const mk = () => { const o = makeCanvas(W, H, false), og = ctxOf(o); return { o, im: og.createImageData(W, H) }; };
  const A = mk(), B = mk();
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (!inside[i]) continue;
    const edge = x === 0 || y === 0 || x === W - 1 || y === H - 1 || !inside[i - 1] || !inside[i + 1] || !inside[i - W] || !inside[i + W];
    if (!edge) continue;
    const white = (((x + y) >> 2) & 1) === 0, p = i * 4;
    for (const [t, flip] of [[A, false], [B, true]]) {
      const val = (white !== flip) ? 255 : 0;
      t.im.data[p] = t.im.data[p + 1] = t.im.data[p + 2] = val; t.im.data[p + 3] = 255;
    }
  }
  ctxOf(A.o).putImageData(A.im, 0, 0); ctxOf(B.o).putImageData(B.im, 0, 0);
  return { a: A.o, b: B.o };
}

export { rectIntersect };
