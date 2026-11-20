// Filters: pure functions on RGBA pixel data (img = {data, width, height}, straight alpha).
// run(img, p, s, ctx): s is the scale of the data relative to document pixels (1 when applying; the zoom for live previews),
// ctx = {u0, v0, k, aw, ah, fg, bg}: pixel (i, j) sits at (u0 + i*k, v0 + j*k) document px inside an area of aw x ah, for filters with a centre or a pattern.
// reach(p) is how many document px around a pixel a filter looks, so selections can be filtered with the right surroundings.

const clamp8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const lerp = (a, b, t) => a + (b - a) * t;
const hex = (c) => { const n = parseInt(String(c).slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const hash2 = (x, y, s = 0) => { let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 1274126177); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };

// ── premultiplied helpers ──
function premul(d) { for (let i = 0; i < d.length; i += 4) { const a = d[i + 3]; if (a < 255) { d[i] = (d[i] * a + 127) / 255; d[i + 1] = (d[i + 1] * a + 127) / 255; d[i + 2] = (d[i + 2] * a + 127) / 255; } } }
function unpremul(d) { for (let i = 0; i < d.length; i += 4) { const a = d[i + 3]; if (a > 0 && a < 255) { const k = 255 / a; d[i] = d[i] * k; d[i + 1] = d[i + 1] * k; d[i + 2] = d[i + 2] * k; } } }

/** One box-blur pass along x (horizontal) or y, edge pixels repeated. */
function boxPass(src, dst, w, h, r, vertical) {
  if (r < 1) { dst.set(src); return; }
  const n = vertical ? h : w, lines = vertical ? w : h, step = vertical ? w * 4 : 4, lineStep = vertical ? 4 : w * 4, win = 2 * r + 1;
  for (let l = 0; l < lines; l++) {
    const base = l * lineStep;
    for (let c = 0; c < 4; c++) {
      const o = base + c; let sum = src[o] * (r + 1);
      for (let i = 0; i < r; i++) sum += src[o + Math.min(i, n - 1) * step];
      for (let i = 0; i < n; i++) {
        sum += src[o + Math.min(i + r, n - 1) * step] - src[o + Math.max(i - r - 1, 0) * step];
        dst[o + i * step] = sum / win;
      }
    }
  }
}
function boxesForGauss(sigma, n = 3) {
  const w = Math.sqrt((12 * sigma * sigma) / n + 1); let wl = Math.floor(w); if (wl % 2 === 0) wl--;
  const wu = wl + 2, m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4)), out = [];
  for (let i = 0; i < n; i++) out.push(((i < m ? wl : wu) - 1) / 2);
  return out;
}
/** Gaussian blur of premultiplied data (sigma in data px). Works in place. */
function gaussPremul(d, w, h, sigma) {
  if (sigma < 0.35) return;
  const tmp = new Uint8ClampedArray(d.length);
  for (const r of boxesForGauss(sigma)) { boxPass(d, tmp, w, h, r, false); boxPass(tmp, d, w, h, r, true); }
}
function blurCopy(img, sigma) { const c = new Uint8ClampedArray(img.data); premul(c); gaussPremul(c, img.width, img.height, sigma); return c; }

// bilinear sample of straight RGBA (edge clamped) into out[0..3]
function sample(d, w, h, x, y, out) {
  x = x < 0 ? 0 : x > w - 1 ? w - 1 : x; y = y < 0 ? 0 : y > h - 1 ? h - 1 : y;
  const x0 = x | 0, y0 = y | 0, x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1), fx = x - x0, fy = y - y0;
  const i00 = (y0 * w + x0) * 4, i10 = (y0 * w + x1) * 4, i01 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4;
  const a00 = d[i00 + 3] * (1 - fx) * (1 - fy), a10 = d[i10 + 3] * fx * (1 - fy), a01 = d[i01 + 3] * (1 - fx) * fy, a11 = d[i11 + 3] * fx * fy, A = a00 + a10 + a01 + a11;
  out[3] = A;
  if (A <= 0) { out[0] = out[1] = out[2] = 0; return; }
  for (let c = 0; c < 3; c++) out[c] = (d[i00 + c] * a00 + d[i10 + c] * a10 + d[i01 + c] * a01 + d[i11 + c] * a11) / A;
}
/** Remap: for each output pixel call map(i, j, o) to set o.x, o.y (source position) and return false to keep the pixel. */
function remap(img, map) {
  const { width: w, height: h } = img, src = new Uint8ClampedArray(img.data), d = img.data, o = { x: 0, y: 0 }, px = [0, 0, 0, 0];
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    if (map(i, j, o) === false) continue;
    sample(src, w, h, o.x, o.y, px); const k = (j * w + i) * 4;
    d[k] = px[0]; d[k + 1] = px[1]; d[k + 2] = px[2]; d[k + 3] = px[3];
  }
}
function lumaOf(r, g, b) { return 0.299 * r + 0.587 * g + 0.114 * b; }

// ── value-noise (clouds) ──
function vnoise(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi, u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed), c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}
function fbm(x, y, seed) { let s = 0, a = 0.5, f = 1, tot = 0; for (let o = 0; o < 7; o++) { s += a * vnoise(x * f, y * f, seed + o * 17); tot += a; a *= 0.5; f *= 2; } return s / tot; }

const sl = (key, label, min, max, step = 1, suffix = '') => ({ key, label, min, max, step, suffix });
const sel = (key, label, choices) => ({ type: 'select', key, label, choices });
const chk = (key, label) => ({ type: 'check', key, label });
const ctr = () => [sl('cx', 'Center X', 0, 100, 1, '%'), sl('cy', 'Center Y', 0, 100, 1, '%')];
const centre = (c, p) => [(p.cx / 100) * c.aw, (p.cy / 100) * c.ah];

export const FILTER_CATS = ['Blur', 'Sharpen', 'Noise', 'Stylize', 'Pixelate', 'Distort', 'Render', 'Other'];

export const FILTERS = {
  // ───── Blur ─────
  gaussian: { name: 'Gaussian Blur', cat: 'Blur', defaults: () => ({ radius: 8 }), controls: [sl('radius', 'Radius', 0.1, 250, 0.1, 'px')], reach: (p) => p.radius * 3,
    run(img, p, s) { const d = img.data; premul(d); gaussPremul(d, img.width, img.height, p.radius * s); unpremul(d); } },
  box: { name: 'Box Blur', cat: 'Blur', defaults: () => ({ radius: 8 }), controls: [sl('radius', 'Radius', 1, 250, 1, 'px')], reach: (p) => p.radius * 2,
    run(img, p, s) { const d = img.data, t = new Uint8ClampedArray(d.length), r = Math.max(1, Math.round(p.radius * s)); premul(d); boxPass(d, t, img.width, img.height, r, false); boxPass(t, d, img.width, img.height, r, true); unpremul(d); } },
  blur: { name: 'Blur', cat: 'Blur', noDialog: true, defaults: () => ({}), controls: [], reach: () => 4, run(img, p, s) { FILTERS.gaussian.run(img, { radius: 0.9 }, s); } },
  blurMore: { name: 'Blur More', cat: 'Blur', noDialog: true, defaults: () => ({}), controls: [], reach: () => 8, run(img, p, s) { FILTERS.gaussian.run(img, { radius: 2.4 }, s); } },
  motion: { name: 'Motion Blur', cat: 'Blur', defaults: () => ({ angle: 0, distance: 30 }), controls: [sl('angle', 'Angle', -90, 90, 1, '°'), sl('distance', 'Distance', 1, 400, 1, 'px')], reach: (p) => p.distance,
    run(img, p, s) {
      const { width: w, height: h } = img, d = img.data, src = new Uint8ClampedArray(d); premul(src);
      const N = Math.max(1, Math.round(p.distance * s)), taps = Math.min(N, 96), a = (p.angle * Math.PI) / 180, dx = Math.cos(a) * (N / taps), dy = -Math.sin(a) * (N / taps), half = (taps - 1) / 2;
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
        let r = 0, g = 0, b = 0, al = 0;
        for (let t = 0; t < taps; t++) {
          let x = Math.round(i + (t - half) * dx), y = Math.round(j + (t - half) * dy); x = x < 0 ? 0 : x >= w ? w - 1 : x; y = y < 0 ? 0 : y >= h ? h - 1 : y;
          const k = (y * w + x) * 4; r += src[k]; g += src[k + 1]; b += src[k + 2]; al += src[k + 3];
        }
        const k = (j * w + i) * 4; d[k] = r / taps; d[k + 1] = g / taps; d[k + 2] = b / taps; d[k + 3] = al / taps;
      }
      unpremul(d);
    } },
  radial: { name: 'Radial Blur', cat: 'Blur', defaults: () => ({ mode: 'spin', amount: 20, cx: 50, cy: 50 }), controls: [sel('mode', 'Method', [['spin', 'Spin'], ['zoom', 'Zoom']]), sl('amount', 'Amount', 1, 100), ...ctr()], reach: () => 9999,
    run(img, p, s, c) {
      const { width: w, height: h } = img, d = img.data, src = new Uint8ClampedArray(d); premul(src);
      const [cx0, cy0] = centre(c, p), taps = 24, px = [0, 0, 0, 0];
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
        const u = c.u0 + i * c.k - cx0, v = c.v0 + j * c.k - cy0; let r = 0, g = 0, b = 0, al = 0;
        for (let t = 0; t < taps; t++) {
          const f = t / (taps - 1) - 0.5; let x, y;
          if (p.mode === 'spin') { const ang = (f * p.amount * Math.PI) / 90, cs = Math.cos(ang), sn = Math.sin(ang); x = u * cs - v * sn; y = u * sn + v * cs; }
          else { const k = 1 + f * (p.amount / 100) * 0.8; x = u * k; y = v * k; }
          x = (x + cx0 - c.u0) / c.k; y = (y + cy0 - c.v0) / c.k;
          x = x < 0 ? 0 : x > w - 1 ? w - 1 : x; y = y < 0 ? 0 : y > h - 1 ? h - 1 : y;
          const k2 = (Math.round(y) * w + Math.round(x)) * 4; r += src[k2]; g += src[k2 + 1]; b += src[k2 + 2]; al += src[k2 + 3];
        }
        const k = (j * w + i) * 4; d[k] = r / taps; d[k + 1] = g / taps; d[k + 2] = b / taps; d[k + 3] = al / taps;
      }
      unpremul(d);
    } },
  surface: { name: 'Surface Blur', cat: 'Blur', defaults: () => ({ radius: 6, threshold: 30 }), controls: [sl('radius', 'Radius', 1, 60, 1, 'px'), sl('threshold', 'Threshold', 2, 255, 1)], reach: (p) => p.radius,
    run(img, p, s) {
      const { width: w, height: h } = img, d = img.data, src = new Uint8ClampedArray(d), R = Math.max(1, Math.round(p.radius * s)), st = Math.max(1, Math.ceil(R / 6)), th = p.threshold, inv = 1 / (2 * th * th * 0.5);
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
        const k = (j * w + i) * 4, r0 = src[k], g0 = src[k + 1], b0 = src[k + 2]; let sr = 0, sg = 0, sb = 0, sw = 0;
        for (let y = -R; y <= R; y += st) { const yy = Math.min(h - 1, Math.max(0, j + y)); for (let x = -R; x <= R; x += st) {
          const xx = Math.min(w - 1, Math.max(0, i + x)), q = (yy * w + xx) * 4, dr = src[q] - r0, dg = src[q + 1] - g0, db = src[q + 2] - b0;
          const wt = Math.exp(-(dr * dr + dg * dg + db * db) * inv * 0.33); sr += src[q] * wt; sg += src[q + 1] * wt; sb += src[q + 2] * wt; sw += wt; } }
        d[k] = sr / sw; d[k + 1] = sg / sw; d[k + 2] = sb / sw;
      }
    } },

  // ───── Sharpen ─────
  sharpen: { name: 'Sharpen', cat: 'Sharpen', noDialog: true, defaults: () => ({}), controls: [], reach: () => 4, run(img, p, s) { FILTERS.unsharp.run(img, { amount: 80, radius: 1, threshold: 0 }, s); } },
  sharpenMore: { name: 'Sharpen More', cat: 'Sharpen', noDialog: true, defaults: () => ({}), controls: [], reach: () => 4, run(img, p, s) { FILTERS.unsharp.run(img, { amount: 200, radius: 1, threshold: 0 }, s); } },
  unsharp: { name: 'Unsharp Mask', cat: 'Sharpen', defaults: () => ({ amount: 100, radius: 2, threshold: 0 }), controls: [sl('amount', 'Amount', 1, 500, 1, '%'), sl('radius', 'Radius', 0.1, 100, 0.1, 'px'), sl('threshold', 'Threshold', 0, 255, 1)], reach: (p) => p.radius * 3,
    run(img, p, s) {
      const d = img.data, b = blurCopy(img, p.radius * s), k = p.amount / 100; premul(d);
      for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) { const df = d[i + c] - b[i + c]; if (Math.abs(df) >= p.threshold) d[i + c] = clamp8(d[i + c] + df * k); }
      for (let i = 0; i < d.length; i += 4) { const a = d[i + 3]; for (let c = 0; c < 3; c++) if (d[i + c] > a) d[i + c] = a; }
      unpremul(d);
    } },

  // ───── Noise ─────
  noise: { name: 'Add Noise', cat: 'Noise', defaults: () => ({ amount: 12, gaussian: true, mono: false }), controls: [sl('amount', 'Amount', 0.1, 400, 0.1, '%'), chk('gaussian', 'Gaussian'), chk('mono', 'Monochromatic')], reach: () => 0,
    run(img, p, s, c) {
      const d = img.data, A = p.amount * 2.55 * 0.5, r = rng(1234 + img.height), g = () => (p.gaussian ? (r() + r() + r() + r() - 2) * 1.7 : r() * 2 - 1);
      for (let i = 0; i < d.length; i += 4) { if (!d[i + 3]) continue; const n = g() * A; if (p.mono) { d[i] = clamp8(d[i] + n); d[i + 1] = clamp8(d[i + 1] + n); d[i + 2] = clamp8(d[i + 2] + n); } else { d[i] = clamp8(d[i] + g() * A); d[i + 1] = clamp8(d[i + 1] + g() * A); d[i + 2] = clamp8(d[i + 2] + g() * A); } }
    } },
  median: { name: 'Median', cat: 'Noise', defaults: () => ({ radius: 2 }), controls: [sl('radius', 'Radius', 1, 10, 1, 'px')], reach: (p) => p.radius,
    run(img, p, s) {
      const { width: w, height: h } = img, d = img.data, src = new Uint8ClampedArray(d), R = Math.max(1, Math.min(10, Math.round(p.radius * s))), hist = new Uint16Array(256);
      for (let c = 0; c < 4; c++) for (let j = 0; j < h; j++) {
        hist.fill(0); let cnt = 0;
        const add = (x, sign) => { for (let y = -R; y <= R; y++) { const yy = Math.min(h - 1, Math.max(0, j + y)); hist[src[(yy * w + Math.min(w - 1, Math.max(0, x))) * 4 + c]] += sign; } };
        for (let x = -R; x <= R; x++) add(x, 1);
        const total = (2 * R + 1) * (2 * R + 1), half = total >> 1; let med = 0, below = 0;
        for (let v = 0; v < 256; v++) { if (below + hist[v] > half) { med = v; break; } below += hist[v]; }
        d[(j * w) * 4 + c] = med;
        for (let i = 1; i < w; i++) {
          add(i - R - 1, -1); add(i + R, 1);
          // recompute median starting from the previous one
          let b2 = 0; for (let v = 0; v < med; v++) b2 += hist[v];
          while (b2 > half) { med--; b2 -= hist[med]; }
          while (b2 + hist[med] <= half) { b2 += hist[med]; med++; }
          d[(j * w + i) * 4 + c] = med;
        }
      }
    } },
  despeckle: { name: 'Despeckle', cat: 'Noise', noDialog: true, defaults: () => ({}), controls: [], reach: () => 2, run(img, p, s) { FILTERS.median.run(img, { radius: 1 }, s); } },

  // ───── Stylize ─────
  emboss: { name: 'Emboss', cat: 'Stylize', defaults: () => ({ angle: 135, height: 3, amount: 100 }), controls: [sl('angle', 'Angle', -180, 180, 1, '°'), sl('height', 'Height', 1, 10, 1, 'px'), sl('amount', 'Amount', 1, 500, 1, '%')], reach: () => 12,
    run(img, p, s) {
      const { width: w, height: h } = img, d = img.data, src = new Uint8ClampedArray(d), a = (p.angle * Math.PI) / 180, dx = Math.cos(a), dy = -Math.sin(a), H = Math.max(1, Math.round(p.height * s)), k = p.amount / 100;
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
        const x1 = Math.min(w - 1, Math.max(0, Math.round(i + dx * H))), y1 = Math.min(h - 1, Math.max(0, Math.round(j + dy * H))), x2 = Math.min(w - 1, Math.max(0, Math.round(i - dx * H))), y2 = Math.min(h - 1, Math.max(0, Math.round(j - dy * H)));
        const a1 = (y1 * w + x1) * 4, a2 = (y2 * w + x2) * 4, k0 = (j * w + i) * 4;
        const v = clamp8(128 + (lumaOf(src[a1], src[a1 + 1], src[a1 + 2]) - lumaOf(src[a2], src[a2 + 1], src[a2 + 2])) * k);
        d[k0] = d[k0 + 1] = d[k0 + 2] = v;
      }
    } },
  findEdges: { name: 'Find Edges', cat: 'Stylize', noDialog: true, defaults: () => ({}), controls: [], reach: () => 2,
    run(img) {
      const { width: w, height: h } = img, d = img.data, src = new Uint8ClampedArray(d), at = (x, y, c) => src[(Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))) * 4 + c];
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) for (let c = 0; c < 3; c++) {
        const gx = -at(i - 1, j - 1, c) - 2 * at(i - 1, j, c) - at(i - 1, j + 1, c) + at(i + 1, j - 1, c) + 2 * at(i + 1, j, c) + at(i + 1, j + 1, c);
        const gy = -at(i - 1, j - 1, c) - 2 * at(i, j - 1, c) - at(i + 1, j - 1, c) + at(i - 1, j + 1, c) + 2 * at(i, j + 1, c) + at(i + 1, j + 1, c);
        d[(j * w + i) * 4 + c] = clamp8(255 - Math.sqrt(gx * gx + gy * gy));
      }
    } },
  solarize: { name: 'Solarize', cat: 'Stylize', noDialog: true, defaults: () => ({}), controls: [], reach: () => 0,
    run(img) { const d = img.data; for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) if (d[i + c] > 127) d[i + c] = 255 - d[i + c]; } },

  // ───── Pixelate ─────
  mosaic: { name: 'Mosaic', cat: 'Pixelate', defaults: () => ({ size: 16 }), controls: [sl('size', 'Cell size', 2, 200, 1, 'px')], reach: (p) => p.size,
    run(img, p, s, c) {
      const { width: w, height: h } = img, d = img.data, S = Math.max(1, p.size), out = new Uint8ClampedArray(d), sums = new Map();
      premul(out);
      const cellX = (i) => Math.floor((c.u0 + i * c.k) / S), cellY = (j) => Math.floor((c.v0 + j * c.k) / S);
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { const key = cellY(j) * 100003 + cellX(i), k = (j * w + i) * 4; let e = sums.get(key); if (!e) { e = [0, 0, 0, 0, 0]; sums.set(key, e); } e[0] += out[k]; e[1] += out[k + 1]; e[2] += out[k + 2]; e[3] += out[k + 3]; e[4]++; }
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { const e = sums.get(cellY(j) * 100003 + cellX(i)), k = (j * w + i) * 4; d[k] = e[0] / e[4]; d[k + 1] = e[1] / e[4]; d[k + 2] = e[2] / e[4]; d[k + 3] = e[3] / e[4]; }
      unpremul(d);
    } },
  crystallize: { name: 'Crystallize', cat: 'Pixelate', defaults: () => ({ size: 24, seed: 1 }), controls: [sl('size', 'Cell size', 3, 200, 1, 'px'), sl('seed', 'Seed', 1, 99)], reach: (p) => p.size * 2,
    run(img, p, s, c) {
      const { width: w, height: h } = img, d = img.data, src = new Uint8ClampedArray(d), S = Math.max(2, p.size);
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
        const u = c.u0 + i * c.k, v = c.v0 + j * c.k, cx = Math.floor(u / S), cy = Math.floor(v / S); let best = 1e18, bx = 0, by = 0;
        for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
          const gx = cx + ox, gy = cy + oy, sx = (gx + 0.15 + 0.7 * hash2(gx, gy, p.seed)) * S, sy = (gy + 0.15 + 0.7 * hash2(gx, gy, p.seed + 50)) * S, dd = (sx - u) * (sx - u) + (sy - v) * (sy - v);
          if (dd < best) { best = dd; bx = sx; by = sy; }
        }
        const x = Math.min(w - 1, Math.max(0, Math.round((bx - c.u0) / c.k))), y = Math.min(h - 1, Math.max(0, Math.round((by - c.v0) / c.k))), a = (y * w + x) * 4, k = (j * w + i) * 4;
        d[k] = src[a]; d[k + 1] = src[a + 1]; d[k + 2] = src[a + 2]; d[k + 3] = src[a + 3];
      }
    } },
  halftone: { name: 'Color Halftone', cat: 'Pixelate', defaults: () => ({ radius: 8, a1: 108, a2: 162, a3: 90 }), controls: [sl('radius', 'Max radius', 4, 60, 1, 'px'), sl('a1', 'Red screen angle', 0, 180, 1, '°'), sl('a2', 'Green screen angle', 0, 180, 1, '°'), sl('a3', 'Blue screen angle', 0, 180, 1, '°')], reach: (p) => p.radius * 2,
    run(img, p, s, c) {
      const { width: w, height: h } = img, d = img.data, src = new Uint8ClampedArray(d), S = Math.max(2, p.radius * 2 * 0.9), angs = [p.a1, p.a2, p.a3].map((a) => (a * Math.PI) / 180);
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
        const u = c.u0 + i * c.k, v = c.v0 + j * c.k, k = (j * w + i) * 4;
        for (let ch = 0; ch < 3; ch++) {
          const cs = Math.cos(angs[ch]), sn = Math.sin(angs[ch]), ru = u * cs + v * sn, rv = -u * sn + v * cs, gu = (Math.floor(ru / S) + 0.5) * S, gv = (Math.floor(rv / S) + 0.5) * S;
          const cu = gu * cs - gv * sn, cv = gu * sn + gv * cs, x = Math.min(w - 1, Math.max(0, Math.round((cu - c.u0) / c.k))), y = Math.min(h - 1, Math.max(0, Math.round((cv - c.v0) / c.k)));
          const ink = 1 - src[(y * w + x) * 4 + ch] / 255, rad = p.radius * 1.15 * Math.sqrt(ink), dd = Math.hypot(ru - gu, rv - gv);
          d[k + ch] = clamp8(127.5 + ((dd - rad) / c.k) * 127.5);
        }
      }
    } },

  // ───── Distort ─────
  twirl: { name: 'Twirl', cat: 'Distort', defaults: () => ({ angle: 180, radius: 100, cx: 50, cy: 50 }), controls: [sl('angle', 'Angle', -999, 999, 1, '°'), sl('radius', 'Radius', 5, 200, 1, '%'), ...ctr()], reach: () => 9999,
    run(img, p, s, c) {
      const [cx, cy] = centre(c, p), R = (Math.min(c.aw, c.ah) / 2) * (p.radius / 100), A = (p.angle * Math.PI) / 180;
      remap(img, (i, j, o) => { const u = c.u0 + i * c.k - cx, v = c.v0 + j * c.k - cy, r = Math.hypot(u, v); if (r >= R) return false; const t = 1 - r / R, a = Math.atan2(v, u) + A * t * t, rr = r; o.x = (cx + rr * Math.cos(a) - c.u0) / c.k; o.y = (cy + rr * Math.sin(a) - c.v0) / c.k; });
    } },
  spherize: { name: 'Spherize / Pinch', cat: 'Distort', defaults: () => ({ amount: 60, cx: 50, cy: 50 }), controls: [sl('amount', 'Amount (− pinch, + bulge)', -100, 100, 1, '%'), ...ctr()], reach: () => 9999,
    run(img, p, s, c) {
      const [cx, cy] = centre(c, p), R = Math.min(c.aw, c.ah) / 2, e = p.amount >= 0 ? 1 + (p.amount / 100) * 1.5 : 1 / (1 + (-p.amount / 100) * 1.5);
      remap(img, (i, j, o) => { const u = c.u0 + i * c.k - cx, v = c.v0 + j * c.k - cy, r = Math.hypot(u, v); if (r >= R || r === 0) return false; const nr = Math.pow(r / R, e) * R, f = nr / r; o.x = (cx + u * f - c.u0) / c.k; o.y = (cy + v * f - c.v0) / c.k; });
    } },
  ripple: { name: 'Ripple', cat: 'Distort', defaults: () => ({ amount: 12, size: 60 }), controls: [sl('amount', 'Amount', 1, 200, 1, 'px'), sl('size', 'Wavelength', 4, 500, 1, 'px')], reach: (p) => p.amount,
    run(img, p, s, c) { remap(img, (i, j, o) => { const u = c.u0 + i * c.k, v = c.v0 + j * c.k; o.x = i + (p.amount * Math.sin((2 * Math.PI * v) / p.size)) / c.k; o.y = j + (p.amount * Math.sin((2 * Math.PI * u) / p.size)) / c.k; }); } },
  polar: { name: 'Polar Coordinates', cat: 'Distort', defaults: () => ({ mode: 'toPolar' }), controls: [sel('mode', 'Mode', [['toPolar', 'Rectangular to Polar'], ['toRect', 'Polar to Rectangular']])], reach: () => 9999,
    run(img, p, s, c) {
      const aw = c.aw, ah = c.ah, cx = aw / 2, cy = ah / 2, R = Math.min(aw, ah) / 2;
      remap(img, (i, j, o) => {
        const u = c.u0 + i * c.k, v = c.v0 + j * c.k; let su, sv;
        if (p.mode === 'toPolar') { const dx = u - cx, dy = v - cy, r = Math.hypot(dx, dy), a = Math.atan2(dx, -dy); su = ((a / (2 * Math.PI) + 0.5) % 1) * aw; sv = Math.min(1, r / R) * ah; }
        else { const a = (u / aw - 0.5) * 2 * Math.PI, r = (v / ah) * R; su = cx + r * Math.sin(a); sv = cy - r * Math.cos(a); }
        o.x = (su - c.u0) / c.k; o.y = (sv - c.v0) / c.k;
      });
    } },
  rgbSplit: { name: 'RGB Split', cat: 'Distort', defaults: () => ({ distance: 8, angle: 0 }), controls: [sl('distance', 'Distance', 0, 100, 0.5, 'px'), sl('angle', 'Angle', -180, 180, 1, '°')], reach: (p) => p.distance,
    run(img, p, s) {
      const { width: w, height: h } = img, d = img.data, src = new Uint8ClampedArray(d), a = (p.angle * Math.PI) / 180, dx = Math.cos(a) * p.distance * s, dy = -Math.sin(a) * p.distance * s, px = [0, 0, 0, 0];
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
        const k = (j * w + i) * 4; sample(src, w, h, i - dx, j - dy, px); const rr = px[0], ra = px[3]; sample(src, w, h, i + dx, j + dy, px);
        d[k] = rr; d[k + 2] = px[2]; d[k + 3] = Math.max(src[k + 3], ra, px[3]);
      }
    } },
  glow: { name: 'Diffuse Glow', cat: 'Distort', defaults: () => ({ radius: 12, amount: 60 }), controls: [sl('radius', 'Radius', 1, 100, 1, 'px'), sl('amount', 'Glow', 0, 100, 1, '%')], reach: (p) => p.radius * 3,
    run(img, p, s) {
      const d = img.data, b = blurCopy(img, p.radius * s), k = p.amount / 100; premul(d);
      for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) { const o = d[i + c] / 255, g = (b[i + c] / 255) * k; d[i + c] = 255 * (1 - (1 - o) * (1 - g)); }
      for (let i = 0; i < d.length; i += 4) { const a = d[i + 3]; for (let c = 0; c < 3; c++) if (d[i + c] > a) d[i + c] = a; }
      unpremul(d);
    } },

  // ───── Render ─────
  clouds: { name: 'Clouds', cat: 'Render', defaults: () => ({ scale: 220, seed: 1 }), controls: [sl('scale', 'Scale', 10, 2000, 1, 'px'), sl('seed', 'Seed', 1, 99)], reach: () => 0, usesColors: true,
    run(img, p, s, c) {
      const d = img.data, f = hex(c.fg || '#000000'), b = hex(c.bg || '#ffffff'), w = img.width;
      for (let k = 0, i = 0; k < d.length; k += 4, i++) { const x = i % w, y = (i / w) | 0, t = fbm((c.u0 + x * c.k) / p.scale, (c.v0 + y * c.k) / p.scale, p.seed), q = Math.min(1, Math.max(0, (t - 0.25) * 2)); d[k] = lerp(f[0], b[0], q); d[k + 1] = lerp(f[1], b[1], q); d[k + 2] = lerp(f[2], b[2], q); d[k + 3] = 255; }
    } },
  diffClouds: { name: 'Difference Clouds', cat: 'Render', defaults: () => ({ scale: 220, seed: 1 }), controls: [sl('scale', 'Scale', 10, 2000, 1, 'px'), sl('seed', 'Seed', 1, 99)], reach: () => 0, usesColors: true,
    run(img, p, s, c) {
      const d = img.data, f = hex(c.fg || '#000000'), b = hex(c.bg || '#ffffff'), w = img.width;
      for (let k = 0, i = 0; k < d.length; k += 4, i++) { const x = i % w, y = (i / w) | 0, t = fbm((c.u0 + x * c.k) / p.scale, (c.v0 + y * c.k) / p.scale, p.seed), q = Math.min(1, Math.max(0, (t - 0.25) * 2)); for (let ch = 0; ch < 3; ch++) d[k + ch] = Math.abs(d[k + ch] - lerp(f[ch], b[ch], q)); d[k + 3] = 255; }
    } },
  vignette: { name: 'Vignette', cat: 'Render', defaults: () => ({ amount: 60, size: 70, feather: 60, color: '#000000' }), controls: [sl('amount', 'Amount', 1, 100, 1, '%'), sl('size', 'Midpoint', 5, 150, 1, '%'), sl('feather', 'Feather', 1, 100, 1, '%'), { type: 'color', key: 'color', label: 'Color' }], reach: () => 0,
    run(img, p, s, c) {
      const { width: w, height: h } = img, d = img.data, col = hex(p.color), cx = c.aw / 2, cy = c.ah / 2, R = Math.hypot(cx, cy) * (p.size / 100), F = Math.max(1, Math.hypot(cx, cy) * (p.feather / 100));
      for (let j = 0; j < h; j++) { const v = c.v0 + j * c.k - cy; for (let i = 0; i < w; i++) {
        const u = c.u0 + i * c.k - cx, r = Math.hypot(u, v), t = Math.min(1, Math.max(0, (r - R * 0.5) / (R * 0.5 + F))), q = t * t * (3 - 2 * t) * (p.amount / 100), k = (j * w + i) * 4;
        d[k] = lerp(d[k], col[0], q); d[k + 1] = lerp(d[k + 1], col[1], q); d[k + 2] = lerp(d[k + 2], col[2], q);
      } }
    } },

  // ───── Other ─────
  highPass: { name: 'High Pass', cat: 'Other', defaults: () => ({ radius: 4 }), controls: [sl('radius', 'Radius', 0.1, 250, 0.1, 'px')], reach: (p) => p.radius * 3,
    run(img, p, s) { const d = img.data, b = blurCopy(img, p.radius * s); for (let i = 0; i < d.length; i += 4) { const k = d[i + 3] ? 255 / d[i + 3] : 1; for (let c = 0; c < 3; c++) d[i + c] = clamp8(d[i + c] - b[i + c] * k + 128); } } },
  minimum: { name: 'Minimum (Erode)', cat: 'Other', defaults: () => ({ radius: 2 }), controls: [sl('radius', 'Radius', 1, 60, 1, 'px')], reach: (p) => p.radius, run(img, p, s) { morph(img, Math.round(p.radius * s), false); } },
  maximum: { name: 'Maximum (Dilate)', cat: 'Other', defaults: () => ({ radius: 2 }), controls: [sl('radius', 'Radius', 1, 60, 1, 'px')], reach: (p) => p.radius, run(img, p, s) { morph(img, Math.round(p.radius * s), true); } },
  offset: { name: 'Offset', cat: 'Other', defaults: () => ({ dx: 100, dy: 0, mode: 'wrap' }), controls: [sl('dx', 'Horizontal', -2000, 2000, 1, 'px'), sl('dy', 'Vertical', -2000, 2000, 1, 'px'), sel('mode', 'Undefined areas', [['wrap', 'Wrap around'], ['edge', 'Repeat edge pixels'], ['clear', 'Transparent']])], reach: () => 99999,
    run(img, p, s) {
      const { width: w, height: h } = img, d = img.data, src = new Uint8ClampedArray(d), ox = Math.round(p.dx * s), oy = Math.round(p.dy * s);
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
        let x = i - ox, y = j - oy; const k = (j * w + i) * 4;
        if (p.mode === 'wrap') { x = ((x % w) + w) % w; y = ((y % h) + h) % h; } else if (p.mode === 'edge') { x = Math.min(w - 1, Math.max(0, x)); y = Math.min(h - 1, Math.max(0, y)); } else if (x < 0 || y < 0 || x >= w || y >= h) { d[k] = d[k + 1] = d[k + 2] = d[k + 3] = 0; continue; }
        const q = (y * w + x) * 4; d[k] = src[q]; d[k + 1] = src[q + 1]; d[k + 2] = src[q + 2]; d[k + 3] = src[q + 3];
      }
    } },
};

function morph(img, R, max) {
  if (R < 1) return;
  const { width: w, height: h } = img, d = img.data; premul(d);
  const t = new Uint8ClampedArray(d.length), pass = (src, dst, vertical) => {
    const n = vertical ? h : w, lines = vertical ? w : h, step = vertical ? w * 4 : 4, ls = vertical ? 4 : w * 4;
    for (let l = 0; l < lines; l++) for (let c = 0; c < 4; c++) { const o = l * ls + c; for (let i = 0; i < n; i++) { let m = max ? 0 : 255; const a = Math.max(0, i - R), b = Math.min(n - 1, i + R); for (let q = a; q <= b; q++) { const v = src[o + q * step]; if (max ? v > m : v < m) m = v; } dst[o + i * step] = m; } }
  };
  pass(d, t, false); pass(t, d, true); unpremul(d);
}

export const FILTER_ORDER = Object.keys(FILTERS);
/** Run a filter on ImageData-like {data,width,height}. */
export function runFilter(id, img, params, scale = 1, ctx = null) {
  const f = FILTERS[id]; if (!f) return;
  const c = ctx || { u0: 0, v0: 0, k: 1, aw: img.width, ah: img.height };
  f.run(img, params, scale, c);
}
