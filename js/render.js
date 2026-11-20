// Compositor: layers -> one canvas, for any zoom/offset. Used by the viewport, thumbnails, merges and export.
// Normal-mode layers go through the browser's canvas (fast); every other blend mode is done per pixel in blend.js.
import { blendBuffers } from './blend.js';
import { ctxOf } from './util.js';
import { runAdjust } from './adjust.js';
import { runFilter } from './filters.js';
import { activeStyles, styleExtent, applyStyles } from './styles.js';

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
  if (live && live.canvas && live.layer === L) {
    const lb = { x: live.ox, y: live.oy, w: live.canvas.width, h: live.canvas.height };
    if (!b) b = lb; else { const x0 = Math.min(b.x, lb.x), y0 = Math.min(b.y, lb.y); b = { x: x0, y: y0, w: Math.max(b.x + b.w, lb.x + lb.w) - x0, h: Math.max(b.y + b.h, lb.y + lb.h) - y0 }; }
  }
  return b;
}

function drawRaster(L, g, tf, W, H, live, org, ov = null) {
  if (L.hideForEdit) return;
  const hasLive = !!(live && live.canvas && live.layer === L);
  const pv = live && live.preview && live.layer === L ? live.preview : null;
  if (!L.canvas && !hasLive) return;
  const st = ov && ov.plain ? null : activeStyles(L);   // plain = the alpha reference of a clipping group (no effects)
  const eff = ov ? ov.eff : L.opacity * L.fill, blend = ov ? ov.blend : L.blend;
  const b0 = layerBounds(L, live);
  const z = tf.zoom;
  const pad = st ? styleExtent(st) : 0, b = pad ? { x: b0.x - pad, y: b0.y - pad, w: b0.w + 2 * pad, h: b0.h + 2 * pad } : b0;
  const mg = st ? Math.ceil(pad * z) + 2 : 0;      // keep a margin outside the visible tile so blurs near its edges are right
  const x0 = Math.max(-mg, Math.floor(b.x * z + tf.tx)), y0 = Math.max(-mg, Math.floor(b.y * z + tf.ty));
  const x1 = Math.min(W + mg, Math.ceil((b.x + b.w) * z + tf.tx)), y1 = Math.min(H + mg, Math.ceil((b.y + b.h) * z + tf.ty));
  const rw = x1 - x0, rh = y1 - y0;
  if (rw <= 0 || rh <= 0) return;
  const smooth = z < 1;
  const masked = !!(L.mask && L.maskOn);
  if (blend === 'normal' && !hasLive && !masked && !pv && !st) {
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
  if (pv) {   // live preview of a destructive adjustment or filter (dialog open)
    const im = sg.getImageData(0, 0, rw, rh), d = im.data, orig = pv.sel ? new Uint8ClampedArray(d) : null;
    sg.setTransform(1, 0, 0, 1, 0, 0);
    if (pv.filter) runFilter(pv.filter.id, im, pv.filter.params, z, { u0: (x0 - tf.tx) / z - L.x, v0: (y0 - tf.ty) / z - L.y, k: 1 / z, aw: L.w, ah: L.h, fg: pv.fg, bg: pv.bg });
    else runAdjust(pv.adj.id, d, pv.adj.params);
    if (pv.sel) {
      const T = takeCanvas(rw, rh), tg = ctxOf(T); tg.setTransform(z, 0, 0, z, tf.tx - x0, tf.ty - y0); tg.imageSmoothingEnabled = smooth; tg.drawImage(pv.sel.canvas, pv.sel.x, pv.sel.y);
      const sa = tg.getImageData(0, 0, rw, rh).data; releaseCanvas(T);
      for (let i = 0; i < d.length; i += 4) { const a = sa[i + 3] / 255; if (a < 1) { d[i] = orig[i] + (d[i] - orig[i]) * a; d[i + 1] = orig[i + 1] + (d[i + 1] - orig[i + 1]) * a; d[i + 2] = orig[i + 2] + (d[i + 2] - orig[i + 2]) * a; } }
    }
    sg.putImageData(im, 0, 0);
    sg.setTransform(z, 0, 0, z, tf.tx - x0, tf.ty - y0);
  }
  if (masked) {   // mask canvas stores how much is hidden (alpha); outside the mask the layer is fully visible
    sg.globalCompositeOperation = 'destination-out';
    sg.imageSmoothingEnabled = smooth; if (smooth) sg.imageSmoothingQuality = 'high';
    sg.drawImage(L.mask.canvas, L.x + L.mask.x, L.y + L.mask.y);
    sg.globalCompositeOperation = 'source-over';
  }
  sg.setTransform(1, 0, 0, 1, 0, 0);
  if (st) {   // effects: draw around/over the content, then crop to what is on screen
    const bounds = { x: b0.x * z + tf.tx - x0, y: b0.y * z + tf.ty - y0, w: b0.w * z, h: b0.h * z };
    const Rr = applyStyles(S, st, z, ov ? 1 : L.fill, bounds, { L, ox: tf.tx - x0, oy: tf.ty - y0 }); releaseCanvas(S);
    const vx = Math.max(0, x0), vy = Math.max(0, y0), vw = Math.min(W, x0 + rw) - vx, vh = Math.min(H, y0 + rh) - vy;
    if (vw > 0 && vh > 0) {
      const V = takeCanvas(vw, vh); ctxOf(V).drawImage(Rr, x0 - vx, y0 - vy);
      blendOnto(g, V, vx, vy, vw, vh, blend, ov ? ov.eff : L.opacity, org.x, org.y); releaseCanvas(V);
    }
    releaseCanvas(Rr); return;
  }
  blendOnto(g, S, x0, y0, rw, rh, blend, eff, org.x, org.y);
  releaseCanvas(S);
}

function drawGroup(G, g, tf, W, H, live, org, ov = null) {
  if (!G.children || !G.children.length) return;
  if (ov) { drawList(G.children, g, tf, W, H, live, org); return; }
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

/** An adjustment layer: adjust everything drawn so far on `g`, weighted by opacity and the layer mask. */
function drawAdjust(L, g, tf, W, H) {
  if (!L.adj) return;
  const eff = L.opacity;
  if (eff <= 0) return;
  g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
  const im = g.getImageData(0, 0, W, H), d = im.data;
  let cov = null;
  if (L.mask && L.maskOn) {
    const T = takeCanvas(W, H), tg = ctxOf(T), z = tf.zoom;
    tg.fillStyle = '#000'; tg.fillRect(0, 0, W, H);
    tg.globalCompositeOperation = 'destination-out'; tg.imageSmoothingEnabled = z < 1; if (z < 1) tg.imageSmoothingQuality = 'high';
    tg.setTransform(z, 0, 0, z, tf.tx, tf.ty); tg.drawImage(L.mask.canvas, L.x + L.mask.x, L.y + L.mask.y);
    cov = tg.getImageData(0, 0, W, H).data; releaseCanvas(T);
  }
  const orig = (eff < 1 || cov) ? new Uint8ClampedArray(d) : null;
  runAdjust(L.adj.id, d, L.adj.params);
  if (orig) {
    for (let i = 0; i < d.length; i += 4) {
      const a = eff * (cov ? cov[i + 3] / 255 : 1);
      if (a >= 1) continue;
      d[i] = orig[i] + (d[i] - orig[i]) * a; d[i + 1] = orig[i + 1] + (d[i + 1] - orig[i + 1]) * a; d[i + 2] = orig[i + 2] + (d[i + 2] - orig[i + 2]) * a;
    }
  }
  g.putImageData(im, 0, 0);
}

function drawOne(L, g, tf, W, H, live, org, ov = null) {
  if (L.type === 'group') drawGroup(L, g, tf, W, H, live, org, ov);
  else if (L.type === 'adjust') drawAdjust(L, g, tf, W, H);
  else drawRaster(L, g, tf, W, H, live, org, ov);
}

const effOf = (L) => (L.type === 'group' ? L.opacity : L.opacity * L.fill);
const modeOf = (L) => (L.blend === 'pass' || !L.blend ? 'normal' : L.blend);

function drawList(layers, g, tf, W, H, live, org) {
  for (let i = 0; i < layers.length; i++) {
    const L = layers[i];
    const chain = [];
    while (i + 1 < layers.length && layers[i + 1].clip) chain.push(layers[++i]);   // layers clipped to L
    if (!L.visible) continue;                                                      // hiding the base hides its clipped layers
    const vis = chain.filter((c) => c.visible);
    if (!vis.length || L.type === 'adjust') {                                      // nothing clipped (or the base is itself an adjustment): plain order
      drawOne(L, g, tf, W, H, live, org);
      for (const c of vis) drawOne(c, g, tf, W, H, live, org);
      continue;
    }
    // clipping group: draw the base alone, blend each clipped layer into it (only where the base has pixels), then place the result
    const G = takeCanvas(W, H), gg = ctxOf(G);
    drawOne(L, gg, tf, W, H, live, org, { blend: 'normal', eff: 1, plain: true });   // G: the base's own pixels, the clip reference
    const P = activeStyles(L) ? takeCanvas(W, H) : G, pg = P === G ? gg : ctxOf(P);   // P: what gets placed (the base with its effects)
    if (P !== G) drawOne(L, pg, tf, W, H, live, org, { blend: 'normal', eff: 1 });
    for (const c of vis) {
      if (c.type === 'adjust') { drawAdjust(c, pg, tf, W, H); continue; }
      const T = takeCanvas(W, H), tg = ctxOf(T);
      drawOne(c, tg, tf, W, H, live, org, { blend: 'normal', eff: 1 });
      tg.setTransform(1, 0, 0, 1, 0, 0); tg.globalCompositeOperation = 'destination-in'; tg.drawImage(G, 0, 0); tg.globalCompositeOperation = 'source-over';
      blendOnto(pg, T, 0, 0, W, H, modeOf(c), effOf(c), org.x, org.y);
      releaseCanvas(T);
    }
    blendOnto(g, P, 0, 0, W, H, modeOf(L), effOf(L), org.x, org.y);
    if (P !== G) releaseCanvas(P);
    releaseCanvas(G);
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
