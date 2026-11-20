// Bevel & Emboss: builds a height map from a layer's shape (distance to its edge, shaped by a contour, softened), lights it from
// an angle and altitude, and returns separate highlight and shadow overlays. Computed in document space at a reduced scale when
// zoomed out, then cached per layer so panning and repainting other layers cost nothing.
import { contourLut } from './contours.js';
import { makeCanvas, ctxOf } from './util.js';

export const BEVEL_DEFAULTS = () => ({
  style: 'inner', technique: 'smooth', depth: 100, direction: 'up', size: 6, soften: 1, angle: 120, altitude: 30,
  contour: [[0, 0], [255, 255]], gloss: [[0, 0], [255, 255]],
  hiColor: '#ffffff', hiBlend: 'screen', hiOpacity: 75, shColor: '#000000', shBlend: 'multiply', shOpacity: 75,
});

const INF = 1e20;
/** Squared Euclidean distance transform (Felzenszwalb & Huttenlocher). `f` has 0 at target pixels and INF elsewhere; result in place. */
function edt2(f, w, h) {
  const n = Math.max(w, h), v = new Int32Array(n), z = new Float32Array(n + 1), d = new Float32Array(n);
  const pass = (get, set, len) => {
    for (let i = 0; i < len; i++) d[i] = get(i);
    let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < len; q++) {
      let s;
      for (;;) { const p = v[k]; s = ((d[q] + q * q) - (d[p] + p * p)) / (2 * q - 2 * p); if (s <= z[k] && k > 0) k--; else break; }
      if (s <= z[k]) { v[k] = q; z[k] = -INF; z[k + 1] = INF; } else { k++; v[k] = q; z[k] = s; z[k + 1] = INF; }
    }
    k = 0;
    for (let q = 0; q < len; q++) { while (z[k + 1] < q) k++; const p = v[k]; set(q, (q - p) * (q - p) + d[p]); }
  };
  for (let x = 0; x < w; x++) pass((y) => f[y * w + x], (y, val) => { f[y * w + x] = val; }, h);
  for (let y = 0; y < h; y++) pass((x) => f[y * w + x], (x, val) => { f[y * w + x] = val; }, w);
}

function boxBlur(a, w, h, r) {   // three box passes ~ gaussian
  if (r < 0.5) return;
  const t = new Float32Array(a.length), rr = Math.max(1, Math.round(r * 0.6));
  const hpass = (src, dst) => {
    for (let y = 0; y < h; y++) {
      let sum = 0; const row = y * w;
      for (let x = -rr; x <= rr; x++) sum += src[row + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        dst[row + x] = sum / (2 * rr + 1);
        sum += src[row + Math.min(w - 1, x + rr + 1)] - src[row + Math.max(0, x - rr)];
      }
    }
  };
  const vpass = (src, dst) => {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let y = -rr; y <= rr; y++) sum += src[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        dst[y * w + x] = sum / (2 * rr + 1);
        sum += src[Math.min(h - 1, y + rr + 1) * w + x] - src[Math.max(0, y - rr) * w + x];
      }
    }
  };
  for (let i = 0; i < 2; i++) { hpass(a, t); vpass(t, a); }
}

const hex = (s) => { const n = parseInt(s.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
const lutFn = (pts) => { const l = contourLut(pts); return l ? (t) => l[Math.max(0, Math.min(255, Math.round(t * 255)))] / 255 : (t) => t; };

/**
 * canvas: the layer's pixels. s: scale (<=1). Returns {hi, sh, pad, s} with canvases covering the layer plus `pad` scaled px on every side.
 */
export function buildBevel(canvas, p, s) {
  const size = Math.max(0.5, p.size * s), soft = p.soften * s;
  const pad = Math.ceil(size + soft * 2) + 3;
  const w = Math.max(1, Math.ceil(canvas.width * s)) + pad * 2, h = Math.max(1, Math.ceil(canvas.height * s)) + pad * 2;
  const src = makeCanvas(w, h, true), sg = ctxOf(src);
  sg.imageSmoothingQuality = 'high'; sg.drawImage(canvas, pad, pad, w - pad * 2, h - pad * 2);
  const A = sg.getImageData(0, 0, w, h).data, N = w * h;
  const alpha = new Float32Array(N); for (let i = 0; i < N; i++) alpha[i] = A[i * 4 + 3] / 255;
  const needIn = p.style !== 'outer', needOut = p.style !== 'inner';
  const gShape = lutFn(p.contour), half = p.style === 'emboss' || p.style === 'pillow' ? size / 2 : size;
  let dIn = null, dOut = null;
  if (needIn) { dIn = new Float32Array(N); for (let i = 0; i < N; i++) dIn[i] = alpha[i] > 0.5 ? INF : 0; edt2(dIn, w, h); }
  if (needOut || p.style === 'outer') { dOut = new Float32Array(N); for (let i = 0; i < N; i++) dOut[i] = alpha[i] > 0.5 ? 0 : INF; edt2(dOut, w, h); }
  const H = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const inside = alpha[i] > 0.5;
    const di = inside && dIn ? Math.sqrt(dIn[i]) - 0.5 + (alpha[i] - 0.5) : 0, dO = !inside && dOut ? Math.sqrt(dOut[i]) - 0.5 : 0;
    let v = 0;
    if (p.style === 'inner') v = inside ? gShape(Math.min(1, Math.max(0, di) / size)) : 0;
    else if (p.style === 'outer') v = inside ? 1 : 1 - gShape(Math.min(1, dO / size));
    else if (p.style === 'emboss') v = inside ? 0.5 + 0.5 * gShape(Math.min(1, Math.max(0, di) / half)) : 0.5 - 0.5 * gShape(Math.min(1, dO / half));
    else v = inside ? gShape(Math.min(1, Math.max(0, di) / half)) : gShape(Math.min(1, dO / half));   // pillow: a trench along the edge
    H[i] = v;
  }
  dIn = dOut = null;
  const blur = p.technique === 'smooth' ? Math.max(1, size * 0.3) + soft : p.technique === 'soft' ? size * 0.1 + soft : soft;
  boxBlur(H, w, h, blur);
  // lighting
  const a = (p.angle * Math.PI) / 180, alt = (p.altitude * Math.PI) / 180, lx = Math.cos(alt) * Math.cos(a), ly = -Math.cos(alt) * Math.sin(a), lz = Math.sin(alt);
  const k = (p.depth / 100) * size * 1.3 * (p.direction === 'down' ? -1 : 1);
  const gloss = lutFn(p.gloss), hc = hex(p.hiColor), sc = hex(p.shColor);
  const hi = new Uint8ClampedArray(N * 4), sh = new Uint8ClampedArray(N * 4), ha = p.hiOpacity / 100, sa = p.shOpacity / 100;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const dx = (H[i + 1] - H[i - 1]) * 0.5 * k, dy = (H[i + w] - H[i - w]) * 0.5 * k;
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1), dot = (-dx * lx - dy * ly + lz) * inv;
      let v = 0.5 + (dot - lz) * 1.6; v = Math.max(0, Math.min(1, v)); v = gloss(v);
      const dlt = (v - 0.5) * 2;                                    // -1 .. 1
      let m = 1; const al = alpha[i];
      if (p.style === 'inner') m = al; else if (p.style === 'outer') m = 1 - al;
      if (dlt > 0) { const o = i * 4; hi[o] = hc[0]; hi[o + 1] = hc[1]; hi[o + 2] = hc[2]; hi[o + 3] = Math.min(255, dlt * m * ha * 255 * 1.4); }
      else if (dlt < 0) { const o = i * 4; sh[o] = sc[0]; sh[o + 1] = sc[1]; sh[o + 2] = sc[2]; sh[o + 3] = Math.min(255, -dlt * m * sa * 255 * 1.4); }
    }
  }
  const mkc = (data) => { const c = makeCanvas(w, h, true); ctxOf(c).putImageData(new ImageData(data, w, h), 0, 0); return c; };
  return { hi: mkc(hi), sh: mkc(sh), pad, s };
}

const cache = new WeakMap();
/** Cached bevel for a layer; recomputed when its pixels, bevel settings or scale change. */
export function getBevel(L, p, s) {
  const key = L.ver + '|' + s.toFixed(3) + '|' + JSON.stringify(p) + '|' + L.canvas.width + 'x' + L.canvas.height;
  const c = cache.get(L);
  if (c && c.key === key) return c.val;
  const val = buildBevel(L.canvas, p, s);
  cache.set(L, { key, val });
  return val;
}
