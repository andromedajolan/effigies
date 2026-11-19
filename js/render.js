// Compositor: layers -> one canvas, for any zoom/offset. Used by the viewport, thumbnails, merges and export.
// Normal-mode layers go through the browser's canvas (fast); every other blend mode is done per pixel in blend.js.
import { blendBuffers } from './blend.js';
import { ctxOf } from './util.js';

const pool = new Map();
export function takeCanvas(w, h) {
  const key = w + 'x' + h;
  const list = pool.get(key);
  let c = list && list.pop();
  if (!c) { c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d', { willReadFrequently: true }); }
  else { const g = ctxOf(c); g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = 'source-over'; g.clearRect(0, 0, w, h); }
  return c;
}
export function releaseCanvas(c) {
  if (!c) return;
  const key = c.width + 'x' + c.height;
  let list = pool.get(key);
  if (!list) { list = []; pool.set(key, list); }
  if (list.length < 3 && c.width * c.height <= 9e6) list.push(c);
  if (pool.size > 12) { const k = pool.keys().next().value; if (k !== key) pool.delete(k); }
}

function blendOnto(g, src, rx, ry, rw, rh, mode, eff, ox, oy) {
  if (mode === 'normal' || mode === 'pass') {
    g.globalAlpha = eff; g.drawImage(src, rx, ry); g.globalAlpha = 1; return;
  }
  const A = g.getImageData(rx, ry, rw, rh);
  const S = ctxOf(src).getImageData(0, 0, rw, rh);
  blendBuffers(A.data, S.data, rw, rh, mode, eff, rx + ox, ry + oy);
  g.putImageData(A, rx, ry);
}

function layerBounds(L, live) {
  let b = L.canvas ? { x: L.x, y: L.y, w: L.canvas.width, h: L.canvas.height } : null;
  if (live && live.layer === L) {
    const lb = { x: live.ox, y: live.oy, w: live.canvas.width, h: live.canvas.height };
    if (!b) b = lb; else { const x0 = Math.min(b.x, lb.x), y0 = Math.min(b.y, lb.y); b = { x: x0, y: y0, w: Math.max(b.x + b.w, lb.x + lb.w) - x0, h: Math.max(b.y + b.h, lb.y + lb.h) - y0 }; }
  }
  return b;
}

function drawRaster(L, g, tf, W, H, live, org) {
  const hasLive = live && live.layer === L;
  if (!L.canvas && !hasLive) return;
  const eff = L.opacity * L.fill;
  const b = layerBounds(L, live);
  const z = tf.zoom;
  const x0 = Math.max(0, Math.floor(b.x * z + tf.tx)), y0 = Math.max(0, Math.floor(b.y * z + tf.ty));
  const x1 = Math.min(W, Math.ceil((b.x + b.w) * z + tf.tx)), y1 = Math.min(H, Math.ceil((b.y + b.h) * z + tf.ty));
  const rw = x1 - x0, rh = y1 - y0;
  if (rw <= 0 || rh <= 0) return;
  const smooth = z < 1;
  const masked = !!(L.mask && L.maskOn);
  if (L.blend === 'normal' && !hasLive && !masked) {
    g.globalAlpha = eff;
    g.setTransform(z, 0, 0, z, tf.tx, tf.ty);
    g.imageSmoothingEnabled = smooth; if (smooth) g.imageSmoothingQuality = 'high';
    g.drawImage(L.canvas, L.x, L.y);
    g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1;
    return;
  }
  const S = takeCanvas(rw, rh);
  const sg = ctxOf(S);
  sg.setTransform(z, 0, 0, z, tf.tx - x0, tf.ty - y0);
  sg.imageSmoothingEnabled = smooth; if (smooth) sg.imageSmoothingQuality = 'high';
  if (L.canvas) sg.drawImage(L.canvas, L.x, L.y);
  if (hasLive) {
    sg.globalAlpha = live.opacity;
    sg.globalCompositeOperation = live.erase ? 'destination-out' : (L.lockTrans ? 'source-atop' : 'source-over');
    sg.drawImage(live.show || live.canvas, live.ox, live.oy);
    sg.globalAlpha = 1; sg.globalCompositeOperation = 'source-over';
  }
  if (masked) {   // mask canvas stores how much is hidden (alpha); outside the mask the layer is fully visible
    sg.globalCompositeOperation = 'destination-out';
    sg.imageSmoothingEnabled = smooth; if (smooth) sg.imageSmoothingQuality = 'high';
    sg.drawImage(L.mask.canvas, L.x + L.mask.x, L.y + L.mask.y);
    sg.globalCompositeOperation = 'source-over';
  }
  sg.setTransform(1, 0, 0, 1, 0, 0);
  blendOnto(g, S, x0, y0, rw, rh, L.blend, eff, org.x, org.y);
  releaseCanvas(S);
}

function drawGroup(G, g, tf, W, H, live, org) {
  if (!G.children || !G.children.length) return;
  const eff = G.opacity;
  if (G.blend === 'pass' || !G.blend) {
    if (eff >= 1) { drawList(G.children, g, tf, W, H, live, org); return; }
    const snap = takeCanvas(W, H);
    ctxOf(snap).drawImage(g.canvas, 0, 0);
    drawList(G.children, g, tf, W, H, live, org);
    const out = takeCanvas(W, H);
    const og = ctxOf(out);
    og.globalAlpha = 1 - eff; og.drawImage(snap, 0, 0);
    og.globalCompositeOperation = 'lighter'; og.globalAlpha = eff; og.drawImage(g.canvas, 0, 0);
    g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, W, H); g.drawImage(out, 0, 0);
    releaseCanvas(snap); releaseCanvas(out);
    return;
  }
  const sub = takeCanvas(W, H);
  drawList(G.children, ctxOf(sub), tf, W, H, live, org);
  blendOnto(g, sub, 0, 0, W, H, G.blend, eff, org.x, org.y);
  releaseCanvas(sub);
}

function drawList(layers, g, tf, W, H, live, org) {
  for (const L of layers) {
    if (!L.visible) continue;
    if (L.type === 'group') drawGroup(L, g, tf, W, H, live, org);
    else drawRaster(L, g, tf, W, H, live, org);
  }
}

/**
 * Composite `layers` (bottom -> top) into a new W x H canvas.
 * Device x = docX * tf.zoom + tf.tx, device y = docY * tf.zoom + tf.ty.
 * live: optional in-progress brush stroke {layer, canvas, ox, oy, opacity, erase}.
 * org: pixel origin of this canvas in the full output (only used so Dissolve noise lines up between tiles).
 */
export function compose(layers, tf, W, H, live = null, org = { x: 0, y: 0 }) {
  const acc = takeCanvas(W, H);
  drawList(layers, ctxOf(acc), tf, W, H, live, org);
  return acc;
}

/** Full-size render of a document (or any layer list) in horizontal tiles, to keep memory flat. */
export function renderFull(layers, w, h, { bg = null, tile = 512 } = {}) {
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const og = out.getContext('2d');
  if (bg) { og.fillStyle = bg; og.fillRect(0, 0, w, h); }
  for (let y = 0; y < h; y += tile) {
    const th = Math.min(tile, h - y);
    const c = compose(layers, { zoom: 1, tx: 0, ty: -y }, w, th, null, { x: 0, y });
    og.drawImage(c, 0, y);
    releaseCanvas(c);
  }
  return out;
}
