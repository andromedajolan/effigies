// The 27 Photoshop CS5 layer blend modes, done on straight (non-premultiplied) 8-bit RGBA.
// Formulas follow the W3C compositing spec / Photoshop conventions.

export const BLEND_GROUPS = [
  [['normal', 'Normal'], ['dissolve', 'Dissolve']],
  [['darken', 'Darken'], ['multiply', 'Multiply'], ['colorburn', 'Color Burn'], ['linearburn', 'Linear Burn'], ['darkercolor', 'Darker Color']],
  [['lighten', 'Lighten'], ['screen', 'Screen'], ['colordodge', 'Color Dodge'], ['lineardodge', 'Linear Dodge (Add)'], ['lightercolor', 'Lighter Color']],
  [['overlay', 'Overlay'], ['softlight', 'Soft Light'], ['hardlight', 'Hard Light'], ['vividlight', 'Vivid Light'], ['linearlight', 'Linear Light'], ['pinlight', 'Pin Light'], ['hardmix', 'Hard Mix']],
  [['difference', 'Difference'], ['exclusion', 'Exclusion'], ['subtract', 'Subtract'], ['divide', 'Divide']],
  [['hue', 'Hue'], ['saturation', 'Saturation'], ['color', 'Color'], ['luminosity', 'Luminosity']],
];
export const BLEND_IDS = BLEND_GROUPS.flat().map((m) => m[0]);
export const BLEND_LABEL = Object.fromEntries(BLEND_GROUPS.flat());

const colorBurn = (b, s) => (b >= 1 ? 1 : s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / s));
const colorDodge = (b, s) => (b <= 0 ? 0 : s >= 1 ? 1 : Math.min(1, b / (1 - s)));

const SEP = {
  normal: (b, s) => s,
  darken: (b, s) => (b < s ? b : s),
  multiply: (b, s) => b * s,
  colorburn: colorBurn,
  linearburn: (b, s) => Math.max(0, b + s - 1),
  lighten: (b, s) => (b > s ? b : s),
  screen: (b, s) => b + s - b * s,
  colordodge: colorDodge,
  lineardodge: (b, s) => Math.min(1, b + s),
  overlay: (b, s) => (b <= 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s)),
  softlight: (b, s) => {
    if (s <= 0.5) return b - (1 - 2 * s) * b * (1 - b);
    const d = b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b);
    return b + (2 * s - 1) * (d - b);
  },
  hardlight: (b, s) => (s <= 0.5 ? 2 * b * s : b + (2 * s - 1) - b * (2 * s - 1)),
  vividlight: (b, s) => (s <= 0.5 ? colorBurn(b, 2 * s) : colorDodge(b, 2 * (s - 0.5))),
  linearlight: (b, s) => Math.min(1, Math.max(0, b + 2 * s - 1)),
  pinlight: (b, s) => (s <= 0.5 ? Math.min(b, 2 * s) : Math.max(b, 2 * (s - 0.5))),
  hardmix: (b, s) => (b + s >= 1 ? 1 : 0),
  difference: (b, s) => Math.abs(b - s),
  exclusion: (b, s) => b + s - 2 * b * s,
  subtract: (b, s) => Math.max(0, b - s),
  divide: (b, s) => (s <= 0 ? 1 : Math.min(1, b / s)),
};
export const separableFn = (mode) => SEP[mode];

// ---- non-separable helpers (write into _o) ----
const _o = [0, 0, 0];
const lum = (r, g, b) => 0.3 * r + 0.59 * g + 0.11 * b;
function clipColor(r, g, b) {
  const l = lum(r, g, b), n = Math.min(r, g, b), x = Math.max(r, g, b);
  if (n < 0) { const k = l / (l - n); r = l + (r - l) * k; g = l + (g - l) * k; b = l + (b - l) * k; }
  if (x > 1) { const k = (1 - l) / (x - l); r = l + (r - l) * k; g = l + (g - l) * k; b = l + (b - l) * k; }
  _o[0] = r; _o[1] = g; _o[2] = b;
}
function setLum(r, g, b, l) { const d = l - lum(r, g, b); clipColor(r + d, g + d, b + d); }
const sat = (r, g, b) => Math.max(r, g, b) - Math.min(r, g, b);
function setSat(r, g, b, s) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  if (mx === mn) { _o[0] = _o[1] = _o[2] = 0; return; }
  const k = s / (mx - mn);
  _o[0] = (r - mn) * k; _o[1] = (g - mn) * k; _o[2] = (b - mn) * k;
}
function nonSep(mode, br, bg, bb, sr, sg, sb) {
  switch (mode) {
    case 'hue': setSat(sr, sg, sb, sat(br, bg, bb)); setLum(_o[0], _o[1], _o[2], lum(br, bg, bb)); return;
    case 'saturation': setSat(br, bg, bb, sat(sr, sg, sb)); setLum(_o[0], _o[1], _o[2], lum(br, bg, bb)); return;
    case 'color': setLum(sr, sg, sb, lum(br, bg, bb)); return;
    case 'luminosity': setLum(br, bg, bb, lum(sr, sg, sb)); return;
    case 'darkercolor': if (lum(sr, sg, sb) < lum(br, bg, bb)) { _o[0] = sr; _o[1] = sg; _o[2] = sb; } else { _o[0] = br; _o[1] = bg; _o[2] = bb; } return;
    case 'lightercolor': if (lum(sr, sg, sb) > lum(br, bg, bb)) { _o[0] = sr; _o[1] = sg; _o[2] = sb; } else { _o[0] = br; _o[1] = bg; _o[2] = bb; } return;
  }
}
const NONSEP = new Set(['hue', 'saturation', 'color', 'luminosity', 'darkercolor', 'lightercolor']);

function hash2(x, y) {
  let n = (x * 374761393 + y * 668265263) | 0;
  n = (n ^ (n >>> 13)) * 1274126177 | 0;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

/**
 * Blend source S onto backdrop A in place.
 * A, S: Uint8ClampedArray (RGBA, straight alpha), same w*h. opacity 0..1. ox/oy: pixel origin for Dissolve noise.
 */
export function blendBuffers(A, S, w, h, mode, opacity, ox = 0, oy = 0) {
  const n = w * h;
  const fn = SEP[mode];
  const ns = NONSEP.has(mode);
  const dissolve = mode === 'dissolve';
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    let sa = S[i + 3] / 255 * opacity;
    if (sa <= 0) continue;
    if (dissolve) {
      const x = p % w, y = (p / w) | 0;
      sa = hash2(x + ox, y + oy) < sa ? 1 : 0;
      if (sa === 0) continue;
    }
    const ba = A[i + 3] / 255;
    const ar = ba + sa - ba * sa;
    if (ar <= 0) continue;
    const k = sa / ar;
    const sr = S[i] / 255, sg = S[i + 1] / 255, sb = S[i + 2] / 255;
    if (ba === 0) { A[i] = S[i]; A[i + 1] = S[i + 1]; A[i + 2] = S[i + 2]; A[i + 3] = ar * 255 + 0.5; continue; }
    const br = A[i] / 255, bg = A[i + 1] / 255, bb = A[i + 2] / 255;
    let rr, rg, rb;
    if (dissolve) { rr = sr; rg = sg; rb = sb; }
    else if (ns) { nonSep(mode, br, bg, bb, sr, sg, sb); rr = _o[0]; rg = _o[1]; rb = _o[2]; }
    else { rr = fn(br, sr); rg = fn(bg, sg); rb = fn(bb, sb); }
    const m = 1 - ba;
    A[i] = (br * (1 - k) + k * (m * sr + ba * rr)) * 255 + 0.5;
    A[i + 1] = (bg * (1 - k) + k * (m * sg + ba * rg)) * 255 + 0.5;
    A[i + 2] = (bb * (1 - k) + k * (m * sb + ba * rb)) * 255 + 0.5;
    A[i + 3] = ar * 255 + 0.5;
  }
}

// Single-pixel helper used by tests and tooling.
export function blendPixel(b, s, mode, opacity = 1) {
  const A = new Uint8ClampedArray(b), S = new Uint8ClampedArray(s);
  blendBuffers(A, S, 1, 1, mode, opacity);
  return [...A];
}
