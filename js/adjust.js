// Image adjustments: pure pixel math on straight (non-premultiplied) RGBA data. No DOM.
// Every adjustment is { name, defaults(), controls, run(data, params) }. run() changes RGB in place and never touches alpha.
import { clamp, hexToRgb } from './util.js';
import { stopsFor, lut as gradLut, GRADIENTS } from './gradients.js';

const c8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

function lutRun(d, lr, lg, lb) {
  for (let i = 0; i < d.length; i += 4) { d[i] = lr[d[i]]; d[i + 1] = lg[d[i + 1]]; d[i + 2] = lb[d[i + 2]]; }
}
const mkLut = (fn) => { const t = new Uint8ClampedArray(256); for (let i = 0; i < 256; i++) t[i] = Math.round(fn(i)); return t; };

// ── colour-space helpers ──
export function rgb2hsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, dd = mx - mn;
  if (!dd) return [0, 0, l];
  const s = l > 0.5 ? dd / (2 - mx - mn) : dd / (mx + mn);
  let h = mx === r ? (g - b) / dd + (g < b ? 6 : 0) : mx === g ? (b - r) / dd + 2 : (r - g) / dd + 4;
  return [h * 60, s, l];
}
const hue2 = (p, q, t) => { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; };
export function hsl2rgb(h, s, l) {
  h = (((h % 360) + 360) % 360) / 360;
  if (!s) { const v = l * 255; return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  return [hue2(p, q, h + 1 / 3) * 255, hue2(p, q, h) * 255, hue2(p, q, h - 1 / 3) * 255];
}

// ── curves: monotone cubic interpolation through control points ──
export function curveLut(points) {
  const pts = [...points].sort((a, b) => a[0] - b[0]);
  const n = pts.length, out = new Uint8ClampedArray(256);
  if (n < 2) { for (let i = 0; i < 256; i++) out[i] = i; return out; }
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const dx = [], m = [], tg = new Array(n);
  for (let i = 0; i < n - 1; i++) { dx.push(Math.max(1e-6, xs[i + 1] - xs[i])); m.push((ys[i + 1] - ys[i]) / dx[i]); }
  tg[0] = m[0]; tg[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) tg[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) { tg[i] = 0; tg[i + 1] = 0; continue; }
    const a = tg[i] / m[i], b = tg[i + 1] / m[i], s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); tg[i] = t * a * m[i]; tg[i + 1] = t * b * m[i]; }
  }
  let seg = 0;
  for (let x = 0; x < 256; x++) {
    if (x <= xs[0]) { out[x] = ys[0]; continue; }
    if (x >= xs[n - 1]) { out[x] = ys[n - 1]; continue; }
    while (seg < n - 2 && x > xs[seg + 1]) seg++;
    const h = dx[seg], t = (x - xs[seg]) / h, t2 = t * t, t3 = t2 * t;
    out[x] = Math.round((2 * t3 - 3 * t2 + 1) * ys[seg] + (t3 - 2 * t2 + t) * h * tg[seg] + (-2 * t3 + 3 * t2) * ys[seg + 1] + (t3 - t2) * h * tg[seg + 1]);
  }
  return out;
}

export const levelsChannel = () => ({ ib: 0, iw: 255, g: 1, ob: 0, ow: 255 });
function levelsLut(c) {
  const span = Math.max(1, c.iw - c.ib), inv = 1 / Math.max(0.01, c.g);
  return mkLut((v) => c.ob + Math.pow(clamp((v - c.ib) / span, 0, 1), inv) * (c.ow - c.ob));
}
const chain = (a, b) => { const o = new Uint8ClampedArray(256); for (let i = 0; i < 256; i++) o[i] = b[a[i]]; return o; };

export const GRAY_PRIMARIES = ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas'];

export const ADJ = {
  brightnessContrast: {
    name: 'Brightness/Contrast', defaults: () => ({ brightness: 0, contrast: 0 }),
    controls: [{ key: 'brightness', label: 'Brightness', min: -150, max: 150 }, { key: 'contrast', label: 'Contrast', min: -50, max: 100 }],
    run(d, p) {
      const cc = p.contrast / 100, slope = cc >= 1 ? 255 : cc >= 0 ? 1 / (1 - cc) : 1 + cc, delta = p.brightness * 1.7;
      const t = mkLut((v) => (v - 127.5) * slope + 127.5 + delta); lutRun(d, t, t, t);
    },
  },
  levels: {
    name: 'Levels', defaults: () => ({ rgb: levelsChannel(), r: levelsChannel(), g: levelsChannel(), b: levelsChannel() }),
    controls: [{ type: 'levels' }],
    run(d, p) {
      const m = levelsLut(p.rgb);
      lutRun(d, chain(levelsLut(p.r), m), chain(levelsLut(p.g), m), chain(levelsLut(p.b), m));
    },
  },
  curves: {
    name: 'Curves', defaults: () => ({ rgb: [[0, 0], [255, 255]], r: [[0, 0], [255, 255]], g: [[0, 0], [255, 255]], b: [[0, 0], [255, 255]] }),
    controls: [{ type: 'curves' }],
    run(d, p) {
      const m = curveLut(p.rgb);
      lutRun(d, chain(curveLut(p.r), m), chain(curveLut(p.g), m), chain(curveLut(p.b), m));
    },
  },
  exposure: {
    name: 'Exposure', defaults: () => ({ exposure: 0, offset: 0, gamma: 1 }),
    controls: [{ key: 'exposure', label: 'Exposure', min: -5, max: 5, step: 0.05 }, { key: 'offset', label: 'Offset', min: -0.5, max: 0.5, step: 0.005 }, { key: 'gamma', label: 'Gamma', min: 0.1, max: 3, step: 0.01 }],
    run(d, p) {
      const k = Math.pow(2, p.exposure), ig = 1 / Math.max(0.01, p.gamma);
      const t = mkLut((v) => { let lin = Math.pow(v / 255, 2.2) * k + p.offset; lin = clamp(lin, 0, 1); return Math.pow(Math.pow(lin, 1 / 2.2), ig) * 255; });
      lutRun(d, t, t, t);
    },
  },
  vibrance: {
    name: 'Vibrance', defaults: () => ({ vibrance: 0, saturation: 0 }),
    controls: [{ key: 'vibrance', label: 'Vibrance', min: -100, max: 100 }, { key: 'saturation', label: 'Saturation', min: -100, max: 100 }],
    run(d, p) {
      const vib = p.vibrance / 100, sat = 1 + p.saturation / 100;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b), s = mx ? (mx - mn) / mx : 0;
        const f = (vib >= 0 ? 1 + vib * (1 - s) * 1.2 : 1 + vib) * sat, y = luma(r, g, b);
        d[i] = c8(y + (r - y) * f); d[i + 1] = c8(y + (g - y) * f); d[i + 2] = c8(y + (b - y) * f);
      }
    },
  },
  hueSat: {
    name: 'Hue/Saturation', defaults: () => ({ hue: 0, sat: 0, light: 0, colorize: false }),
    controls: [{ key: 'hue', label: 'Hue', min: -180, max: 180, suffix: '°' }, { key: 'sat', label: 'Saturation', min: -100, max: 100 }, { key: 'light', label: 'Lightness', min: -100, max: 100 }, { key: 'colorize', label: 'Colorize', type: 'check' }],
    run(d, p) {
      const sat = p.sat / 100, lt = p.light / 100;
      for (let i = 0; i < d.length; i += 4) {
        let [h, s, l] = rgb2hsl(d[i], d[i + 1], d[i + 2]);
        if (p.colorize) { h = ((p.hue % 360) + 360) % 360; s = clamp(0.25 + sat * 0.75, 0, 1); if (!(sat > -1)) s = 0; }
        else { h += p.hue; s = sat >= 0 ? Math.min(1, s * (1 + sat)) : s * (1 + sat); }
        l = lt >= 0 ? l + (1 - l) * lt : l * (1 + lt);
        const o = hsl2rgb(h, s, l); d[i] = o[0]; d[i + 1] = o[1]; d[i + 2] = o[2];
      }
    },
  },
  colorBalance: {
    name: 'Color Balance', defaults: () => ({ shadows: [0, 0, 0], mid: [0, 0, 0], high: [0, 0, 0], preserve: true }),
    controls: [{ type: 'balance' }],
    run(d, p) {
      const S = p.shadows, M = p.mid, H = p.high;   // each: [cyan-red, magenta-green, yellow-blue], -100..100 (about 1 level per unit at full weight)
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2], l = luma(r, g, b) / 255, sw = (1 - l) * (1 - l), hw = l * l, mw = 2 * l * (1 - l);
        let nr = r + S[0] * sw + M[0] * mw + H[0] * hw, ng = g + S[1] * sw + M[1] * mw + H[1] * hw, nb = b + S[2] * sw + M[2] * mw + H[2] * hw;
        if (p.preserve) { const y0 = luma(r, g, b), y1 = luma(nr, ng, nb) || 1, f = y0 / y1; nr *= f; ng *= f; nb *= f; }
        d[i] = c8(nr); d[i + 1] = c8(ng); d[i + 2] = c8(nb);
      }
    },
  },
  blackWhite: {
    name: 'Black & White', defaults: () => ({ reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80, tint: false, tintColor: '#c9a46e' }),
    controls: [...GRAY_PRIMARIES.map((k) => ({ key: k, label: k[0].toUpperCase() + k.slice(1), min: -200, max: 300 })), { key: 'tint', label: 'Tint', type: 'check' }, { key: 'tintColor', label: 'Tint color', type: 'color' }],
    run(d, p) {
      const w = GRAY_PRIMARIES.map((k) => p[k] / 100), tc = hexToRgb(p.tintColor || '#c9a46e');
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        let gray = mn;
        if (mx !== mn) {
          let h = mx === r ? (g - b) / (mx - mn) + (g < b ? 6 : 0) : mx === g ? (b - r) / (mx - mn) + 2 : (r - g) / (mx - mn) + 4;
          const idx = Math.floor(h) % 6, t = h - Math.floor(h), wt = w[idx] * (1 - t) + w[(idx + 1) % 6] * t;
          gray = mn + (mx - mn) * wt;
        }
        gray = c8(gray);
        if (p.tint) {
          const u = gray / 255;
          if (u < 0.5) { const f = u * 2; d[i] = tc[0] * f; d[i + 1] = tc[1] * f; d[i + 2] = tc[2] * f; }
          else { const f = (u - 0.5) * 2; d[i] = tc[0] + (255 - tc[0]) * f; d[i + 1] = tc[1] + (255 - tc[1]) * f; d[i + 2] = tc[2] + (255 - tc[2]) * f; }
        } else d[i] = d[i + 1] = d[i + 2] = gray;
      }
    },
  },
  photoFilter: {
    name: 'Photo Filter', defaults: () => ({ color: '#ec8a00', density: 25, preserve: true }),
    controls: [{ key: 'color', label: 'Color', type: 'color' }, { key: 'density', label: 'Density', min: 1, max: 100, suffix: '%' }, { key: 'preserve', label: 'Preserve luminosity', type: 'check' }],
    run(d, p) {
      const c = hexToRgb(p.color), den = p.density / 100, ly = luma(c[0], c[1], c[2]) / 255 || 1, m = [c[0] / 255, c[1] / 255, c[2] / 255];
      for (let i = 0; i < d.length; i += 4) {
        for (let k = 0; k < 3; k++) { const v = d[i + k], f = p.preserve ? (v * m[k]) / ly : v * m[k] * 1.0; d[i + k] = c8(v * (1 - den) + f * den); }
      }
    },
  },
  channelMixer: {
    name: 'Channel Mixer', defaults: () => ({ mono: false, r: [100, 0, 0, 0], g: [0, 100, 0, 0], b: [0, 0, 100, 0], gray: [40, 40, 20, 0] }),
    controls: [{ type: 'mixer' }],
    run(d, p) {
      const mix = (row, r, g, b) => (row[0] * r + row[1] * g + row[2] * b) / 100 + (row[3] * 255) / 100;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        if (p.mono) { const v = c8(mix(p.gray, r, g, b)); d[i] = d[i + 1] = d[i + 2] = v; }
        else { d[i] = c8(mix(p.r, r, g, b)); d[i + 1] = c8(mix(p.g, r, g, b)); d[i + 2] = c8(mix(p.b, r, g, b)); }
      }
    },
  },
  gradientMap: {
    name: 'Gradient Map', defaults: () => ({ preset: 'bw', reverse: false, fg: '#000000', bg: '#ffffff' }),
    controls: [{ key: 'preset', label: 'Gradient', type: 'select', choices: GRADIENTS.filter((g) => g[0] !== 'fgt') }, { key: 'reverse', label: 'Reverse', type: 'check' }],
    run(d, p) {
      const t = gradLut(stopsFor(p.preset, p.fg, p.bg), p.reverse);
      for (let i = 0; i < d.length; i += 4) { const k = Math.round(luma(d[i], d[i + 1], d[i + 2])) * 4; d[i] = t[k]; d[i + 1] = t[k + 1]; d[i + 2] = t[k + 2]; }
    },
  },
  invert: { name: 'Invert', defaults: () => ({}), controls: [], run(d) { for (let i = 0; i < d.length; i += 4) { d[i] = 255 - d[i]; d[i + 1] = 255 - d[i + 1]; d[i + 2] = 255 - d[i + 2]; } } },
  desaturate: { name: 'Desaturate', defaults: () => ({}), controls: [], run(d) { for (let i = 0; i < d.length; i += 4) { const y = luma(d[i], d[i + 1], d[i + 2]); d[i] = d[i + 1] = d[i + 2] = y; } } },
  posterize: {
    name: 'Posterize', defaults: () => ({ levels: 4 }), controls: [{ key: 'levels', label: 'Levels', min: 2, max: 255 }],
    run(d, p) { const n = Math.max(2, Math.round(p.levels)); const t = mkLut((v) => (Math.min(n - 1, Math.floor((v / 256) * n)) / (n - 1)) * 255); lutRun(d, t, t, t); },
  },
  threshold: {
    name: 'Threshold', defaults: () => ({ level: 128 }), controls: [{ key: 'level', label: 'Threshold Level', min: 1, max: 255 }],
    run(d, p) { for (let i = 0; i < d.length; i += 4) { const v = luma(d[i], d[i + 1], d[i + 2]) >= p.level ? 255 : 0; d[i] = d[i + 1] = d[i + 2] = v; } },
  },
};

/** Order used by menus and the Adjustments panel. */
export const ADJ_ORDER = ['brightnessContrast', 'levels', 'curves', 'exposure', 'vibrance', 'hueSat', 'colorBalance', 'blackWhite', 'photoFilter', 'channelMixer', 'gradientMap', 'invert', 'posterize', 'threshold', 'desaturate'];
/** Adjustments with no controls (they apply immediately, no dialog). */
export const NO_DIALOG = new Set(['invert', 'desaturate']);

export const cloneParams = (p) => JSON.parse(JSON.stringify(p));

export function runAdjust(id, data, params) {
  const a = ADJ[id]; if (!a) return;
  a.run(data, params);
}

/** Histogram of straight RGBA data, ignoring fully transparent pixels. */
export function histogram(data) {
  const r = new Uint32Array(256), g = new Uint32Array(256), b = new Uint32Array(256), l = new Uint32Array(256);
  for (let i = 0; i < data.length; i += 4) {
    if (!data[i + 3]) continue;
    r[data[i]]++; g[data[i + 1]]++; b[data[i + 2]]++; l[Math.round(luma(data[i], data[i + 1], data[i + 2]))]++;
  }
  return { r, g, b, l };
}

/** Auto Tone / Auto Contrast: Levels params that stretch the histogram, clipping 0.1% at each end. */
export function autoLevels(data, perChannel) {
  const h = histogram(data), p = ADJ.levels.defaults();
  const ends = (hist) => {
    let total = 0; for (let i = 0; i < 256; i++) total += hist[i];
    if (!total) return [0, 255];
    const cut = total * 0.001; let lo = 0, hi = 255, acc = 0;
    for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc > cut) { lo = i; break; } }
    acc = 0; for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc > cut) { hi = i; break; } }
    return [lo, Math.max(hi, lo + 1)];
  };
  if (perChannel) for (const k of ['r', 'g', 'b']) { const [lo, hi] = ends(h[k]); p[k].ib = lo; p[k].iw = hi; }
  else { const [lo, hi] = ends(h.l); for (const k of ['r', 'g', 'b']) { p[k].ib = lo; p[k].iw = hi; } }
  return p;
}
