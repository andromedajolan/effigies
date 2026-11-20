// Layer styles (effects). Pure canvas work: given the layer's rendered pixels (already masked, at screen scale) this
// returns the same canvas with the enabled effects drawn around and over it. Sizes are in document pixels and scale with zoom.
import { stopsFor } from './gradients.js';
import { takeCanvas, releaseCanvas } from './render.js';
import { contourLut } from './contours.js';
import { BEVEL_DEFAULTS, getBevel } from './bevel.js';
import { getTile } from './patterns.js';

const rgba = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };
const OPS = { normal: 'source-over', multiply: 'multiply', screen: 'screen', overlay: 'overlay', darken: 'darken', lighten: 'lighten', colorDodge: 'color-dodge', colorBurn: 'color-burn', hardLight: 'hard-light', softLight: 'soft-light', difference: 'difference', exclusion: 'exclusion', hue: 'hue', saturation: 'saturation', color: 'color', luminosity: 'luminosity' };
export const STYLE_BLENDS = [['normal', 'Normal'], ['multiply', 'Multiply'], ['screen', 'Screen'], ['overlay', 'Overlay'], ['softLight', 'Soft Light'], ['hardLight', 'Hard Light'], ['colorDodge', 'Color Dodge'], ['colorBurn', 'Color Burn'], ['darken', 'Darken'], ['lighten', 'Lighten'], ['difference', 'Difference'], ['color', 'Color'], ['luminosity', 'Luminosity']];

/** Order here is the stacking order of the dialog list (top of list = drawn last). */
export const STYLE_ORDER = ['bevel', 'stroke', 'innerShadow', 'innerGlow', 'satin', 'colorOverlay', 'gradientOverlay', 'patternOverlay', 'outerGlow', 'dropShadow'];
export const STYLE_NAMES = { bevel: 'Bevel & Emboss', stroke: 'Stroke', innerShadow: 'Inner Shadow', innerGlow: 'Inner Glow', satin: 'Satin', patternOverlay: 'Pattern Overlay', colorOverlay: 'Color Overlay', gradientOverlay: 'Gradient Overlay', outerGlow: 'Outer Glow', dropShadow: 'Drop Shadow' };

const LIN = () => [[0, 0], [255, 255]];
/** Defaults and control descriptions for each effect (used by the dialog). */
export const STYLE_DEFS = {
  dropShadow: { defaults: () => ({ color: '#000000', opacity: 75, angle: 120, distance: 10, size: 10, contour: LIN() }),
    controls: [['color', 'Color', 'color'], ['opacity', 'Opacity', 1, 100, '%'], ['angle', 'Angle', -180, 180, '°'], ['distance', 'Distance', 0, 200, 'px'], ['size', 'Size', 0, 200, 'px'], ['contour', 'Contour', 'contour']] },
  outerGlow: { defaults: () => ({ color: '#fff3a8', opacity: 75, size: 16, contour: LIN() }),
    controls: [['color', 'Color', 'color'], ['opacity', 'Opacity', 1, 100, '%'], ['size', 'Size', 0, 200, 'px'], ['contour', 'Contour', 'contour']] },
  innerShadow: { defaults: () => ({ color: '#000000', opacity: 75, blend: 'multiply', angle: 120, distance: 8, size: 8, contour: LIN() }),
    controls: [['color', 'Color', 'color'], ['blend', 'Blend', 'blend'], ['opacity', 'Opacity', 1, 100, '%'], ['angle', 'Angle', -180, 180, '°'], ['distance', 'Distance', 0, 200, 'px'], ['size', 'Size', 0, 200, 'px'], ['contour', 'Contour', 'contour']] },
  innerGlow: { defaults: () => ({ color: '#fff3a8', opacity: 75, blend: 'screen', size: 12, contour: LIN() }),
    controls: [['color', 'Color', 'color'], ['blend', 'Blend', 'blend'], ['opacity', 'Opacity', 1, 100, '%'], ['size', 'Size', 0, 200, 'px'], ['contour', 'Contour', 'contour']] },
  bevel: { defaults: BEVEL_DEFAULTS,
    controls: [['style', 'Style', 'select', [['inner', 'Inner Bevel'], ['outer', 'Outer Bevel'], ['emboss', 'Emboss'], ['pillow', 'Pillow Emboss']]], ['technique', 'Technique', 'select', [['smooth', 'Smooth'], ['soft', 'Chisel Soft'], ['hard', 'Chisel Hard']]],
      ['depth', 'Depth', 1, 500, '%'], ['direction', 'Direction', 'select', [['up', 'Up'], ['down', 'Down']]], ['size', 'Size', 1, 120, 'px'], ['soften', 'Soften', 0, 16, 'px'],
      ['angle', 'Angle', -180, 180, '°'], ['altitude', 'Altitude', 1, 89, '°'], ['contour', 'Shape contour', 'contour'], ['gloss', 'Gloss contour', 'contour'],
      ['hiColor', 'Highlight', 'color'], ['hiBlend', 'Highlight mode', 'blend'], ['hiOpacity', 'Highlight opacity', 0, 100, '%'],
      ['shColor', 'Shadow', 'color'], ['shBlend', 'Shadow mode', 'blend'], ['shOpacity', 'Shadow opacity', 0, 100, '%']] },
  satin: { defaults: () => ({ color: '#000000', blend: 'multiply', opacity: 50, angle: 19, distance: 11, size: 14, contour: LIN(), invert: false }),
    controls: [['color', 'Color', 'color'], ['blend', 'Blend', 'blend'], ['opacity', 'Opacity', 1, 100, '%'], ['angle', 'Angle', -180, 180, '°'], ['distance', 'Distance', 0, 100, 'px'], ['size', 'Size', 0, 100, 'px'], ['contour', 'Contour', 'contour'], ['invert', 'Invert', 'check']] },
  patternOverlay: { defaults: () => ({ pattern: 'b-dots', scale: 100, opacity: 100, blend: 'normal' }),
    controls: [['pattern', 'Pattern', 'pattern'], ['scale', 'Scale', 5, 1000, '%'], ['blend', 'Blend', 'blend'], ['opacity', 'Opacity', 1, 100, '%']] },
  colorOverlay: { defaults: () => ({ color: '#ff4d6d', opacity: 100, blend: 'normal' }),
    controls: [['color', 'Color', 'color'], ['blend', 'Blend', 'blend'], ['opacity', 'Opacity', 1, 100, '%']] },
  gradientOverlay: { defaults: () => ({ preset: 'sunset', reverse: false, angle: 90, opacity: 100, blend: 'normal', fg: '#000000', bg: '#ffffff' }),
    controls: [['preset', 'Gradient', 'gradient'], ['reverse', 'Reverse', 'check'], ['blend', 'Blend', 'blend'], ['opacity', 'Opacity', 1, 100, '%'], ['angle', 'Angle', -180, 180, '°']] },
  stroke: { defaults: () => ({ color: '#000000', size: 4, position: 'outside', opacity: 100, blend: 'normal' }),
    controls: [['size', 'Size', 1, 100, 'px'], ['position', 'Position', 'select', [['outside', 'Outside'], ['inside', 'Inside'], ['center', 'Center']]], ['color', 'Color', 'color'], ['blend', 'Blend', 'blend'], ['opacity', 'Opacity', 1, 100, '%']] },
};

export const cloneStyles = (s) => (s ? JSON.parse(JSON.stringify(s)) : null);
/** The enabled effects of a layer as [[key, params]] in drawing order, or null when there are none. */
export function activeStyles(L) {
  if (!L.styles) return null;
  const out = STYLE_ORDER.filter((k) => L.styles[k] && L.styles[k].on).map((k) => [k, L.styles[k]]);
  return out.length ? out : null;
}
/** How far (document px) the effects reach beyond the layer's pixels. */
export function styleExtent(list) {
  let e = 0;
  for (const [k, p] of list) {
    if (k === 'dropShadow') e = Math.max(e, p.distance + p.size * 1.6);
    else if (k === 'outerGlow') e = Math.max(e, p.size * 1.6);
    else if (k === 'stroke') e = Math.max(e, p.size);
    else if (k === 'innerShadow') e = Math.max(e, p.distance + p.size * 1.6);
    else if (k === 'innerGlow') e = Math.max(e, p.size * 1.6);
    else if (k === 'bevel') e = Math.max(e, (p.size || 6) + (p.soften || 0) * 2 + 4);
    else if (k === 'satin') e = Math.max(e, p.distance + p.size);
  }
  return Math.ceil(e) + 2;
}

// ── canvas helpers (screen-space pixels) ──
const cvs = (w, h) => takeCanvas(w, h);
const g2 = (c) => c.getContext('2d');

function silhouette(S, color) {   // S's alpha, filled with `color`
  const T = cvs(S.width, S.height), g = g2(T);
  g.drawImage(S, 0, 0); g.globalCompositeOperation = 'source-in'; g.fillStyle = color; g.fillRect(0, 0, T.width, T.height);
  g.globalCompositeOperation = 'source-over'; return T;
}
function inverse(S, color) {      // colour everywhere S is transparent
  const T = cvs(S.width, S.height), g = g2(T);
  g.fillStyle = color; g.fillRect(0, 0, T.width, T.height);
  g.globalCompositeOperation = 'destination-out'; g.drawImage(S, 0, 0); g.globalCompositeOperation = 'source-over'; return T;
}
function blurShift(T, dx, dy, blur) {
  const E = cvs(T.width, T.height), g = g2(E);
  if (blur > 0.3) g.filter = `blur(${blur}px)`;
  g.drawImage(T, dx, dy); g.filter = 'none'; return E;
}
/** Grow a silhouette by r px (stamps it around a ring or two; plenty smooth for stroke widths). */
function dilate(T, r) {
  const D = cvs(T.width, T.height), g = g2(D);
  g.drawImage(T, 0, 0);
  const rings = r > 6 ? [r, r * 0.66, r * 0.33] : [r];
  for (const rr of rings) {
    const n = Math.min(72, Math.max(12, Math.ceil(rr * 6)));
    for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; g.drawImage(T, Math.cos(a) * rr, Math.sin(a) * rr); }
  }
  return D;
}
function put(R, E, alpha, blend) {
  const g = g2(R); g.globalAlpha = alpha; g.globalCompositeOperation = OPS[blend] || 'source-over'; g.drawImage(E, 0, 0);
  g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
}
function clipTo(E, S) { const g = g2(E); g.globalCompositeOperation = 'destination-in'; g.drawImage(S, 0, 0); g.globalCompositeOperation = 'source-over'; }

function lutAlpha(c, lut) {   // remap a canvas's alpha through a 256-entry table (contours)
  if (!lut) return;
  const g = g2(c), im = g.getImageData(0, 0, c.width, c.height), d = im.data;
  for (let i = 3; i < d.length; i += 4) d[i] = lut[d[i]];
  g.putImageData(im, 0, 0);
}

/**
 * S: the layer's pixels (screen scale). z: zoom. fill: 0..1 (applies to S only, not the effects).
 * bounds: the layer's rectangle inside S ({x,y,w,h}, screen px) for gradient placement.
 * ctx: {L, ox, oy}: the layer and where document (0,0) sits inside S (document x -> ox + x*z), for bevels and patterns.
 * Returns a pooled canvas the same size as S.
 */
export function applyStyles(S, list, z, fill, bounds, ctx = {}) {
  const R = cvs(S.width, S.height), rg = g2(R);
  const by = (k) => list.find((e) => e[0] === k);
  const rad = (deg) => (deg * Math.PI) / 180;
  let e;
  if ((e = by('dropShadow'))) {
    const p = e[1], T = silhouette(S, p.color), B = blurShift(T, -Math.cos(rad(p.angle)) * p.distance * z, Math.sin(rad(p.angle)) * p.distance * z, p.size * z * 0.5);
    lutAlpha(B, contourLut(p.contour)); put(R, B, p.opacity / 100, 'normal'); releaseCanvas(T); releaseCanvas(B);
  }
  if ((e = by('outerGlow'))) {
    const p = e[1], T = silhouette(S, p.color), B = blurShift(T, 0, 0, p.size * z * 0.5);
    lutAlpha(B, contourLut(p.contour)); put(R, B, p.opacity / 100, 'normal'); put(R, B, (p.opacity / 100) * 0.6, 'normal'); releaseCanvas(T); releaseCanvas(B);
  }
  rg.globalAlpha = fill; rg.drawImage(S, 0, 0); rg.globalAlpha = 1;
  if ((e = by('innerShadow'))) {
    const p = e[1], U = inverse(S, p.color), B = blurShift(U, -Math.cos(rad(p.angle)) * p.distance * z, Math.sin(rad(p.angle)) * p.distance * z, p.size * z * 0.5);
    lutAlpha(B, contourLut(p.contour)); clipTo(B, S); put(R, B, p.opacity / 100, p.blend); releaseCanvas(U); releaseCanvas(B);
  }
  if ((e = by('innerGlow'))) {
    const p = e[1], U = inverse(S, p.color), B = blurShift(U, 0, 0, p.size * z * 0.5);
    lutAlpha(B, contourLut(p.contour)); clipTo(B, S); put(R, B, p.opacity / 100, p.blend); put(R, B, (p.opacity / 100) * 0.6, p.blend); releaseCanvas(U); releaseCanvas(B);
  }
  if ((e = by('satin'))) {   // two blurred copies of the shape, offset opposite ways; where they differ gets the colour
    const p = e[1], dx = Math.cos(rad(p.angle)) * p.distance * z, dy = -Math.sin(rad(p.angle)) * p.distance * z, bl = Math.max(0, p.size * z * 0.5);
    const P = blurShift(S, dx, dy, bl), Q = blurShift(S, -dx, -dy, bl);
    const pd = g2(P).getImageData(0, 0, S.width, S.height), qd = g2(Q).getImageData(0, 0, S.width, S.height).data, d = pd.data, lut = contourLut(p.contour);
    const n = parseInt(p.color.slice(1), 16), cr = n >> 16, cg = (n >> 8) & 255, cb = n & 255;
    for (let i = 0; i < d.length; i += 4) {
      let v = Math.abs(d[i + 3] - qd[i + 3]); if (p.invert) v = 255 - v; if (lut) v = lut[v];
      d[i] = cr; d[i + 1] = cg; d[i + 2] = cb; d[i + 3] = v;
    }
    g2(P).putImageData(pd, 0, 0); clipTo(P, S); put(R, P, p.opacity / 100, p.blend); releaseCanvas(P); releaseCanvas(Q);
  }
  if ((e = by('colorOverlay'))) {
    const p = e[1], T = silhouette(S, p.color); put(R, T, p.opacity / 100, p.blend); releaseCanvas(T);
  }
  if ((e = by('gradientOverlay'))) {
    const p = e[1], E = cvs(S.width, S.height), g = g2(E), b = bounds || { x: 0, y: 0, w: S.width, h: S.height };
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2, a = rad(p.angle), dx = Math.cos(a), dy = -Math.sin(a);
    const half = (Math.abs(b.w * dx) + Math.abs(b.h * dy)) / 2 || 1;
    const gr = g.createLinearGradient(cx - dx * half, cy - dy * half, cx + dx * half, cy + dy * half);
    const st = stopsFor(p.preset, p.fg, p.bg), ord = p.reverse ? st.map(([t, c]) => [1 - t, c]).reverse() : st;
    for (const [t, c] of ord) gr.addColorStop(Math.max(0, Math.min(1, t)), `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${c[3]})`);
    g.fillStyle = gr; g.fillRect(0, 0, E.width, E.height); clipTo(E, S);
    put(R, E, p.opacity / 100, p.blend); releaseCanvas(E);
  }
  if ((e = by('patternOverlay'))) {
    const p = e[1], tile = getTile(p.pattern);
    if (tile) {
      const E = cvs(S.width, S.height), g = g2(E), pat = g.createPattern(tile, 'repeat'), sc = z * (p.scale / 100);
      if (pat.setTransform) pat.setTransform(new DOMMatrix([sc, 0, 0, sc, ctx.ox || 0, ctx.oy || 0]));
      g.fillStyle = pat; g.fillRect(0, 0, E.width, E.height); clipTo(E, S);
      put(R, E, p.opacity / 100, p.blend); releaseCanvas(E);
    }
  }
  if ((e = by('bevel')) && ctx.L && ctx.L.canvas) {
    const p = { ...BEVEL_DEFAULTS(), ...e[1] }, sc = Math.min(1, z), bv = getBevel(ctx.L, p, sc), f = z / bv.s;
    const dx = (ctx.ox || 0) + ctx.L.x * z - bv.pad * f, dy = (ctx.oy || 0) + ctx.L.y * z - bv.pad * f, w = bv.hi.width * f, h = bv.hi.height * f;
    for (const [cv, blend, op] of [[bv.hi, p.hiBlend, p.hiOpacity], [bv.sh, p.shBlend, p.shOpacity]]) {
      if (!op) continue;
      const E = cvs(S.width, S.height), g = g2(E); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high'; g.drawImage(cv, dx, dy, w, h);
      if (p.style === 'inner') clipTo(E, S);
      put(R, E, 1, blend); releaseCanvas(E);
    }
  }
  if ((e = by('stroke'))) {
    const p = e[1], r = Math.max(0.5, p.size * z), col = p.color;
    const E = cvs(S.width, S.height), eg = g2(E);
    if (p.position !== 'inside') {   // outside half: grown silhouette minus the layer
      const T = silhouette(S, col), D = dilate(T, p.position === 'center' ? r / 2 : r);
      const dg = g2(D); dg.globalCompositeOperation = 'destination-out'; dg.drawImage(S, 0, 0); dg.globalCompositeOperation = 'source-over';
      eg.drawImage(D, 0, 0); releaseCanvas(T); releaseCanvas(D);
    }
    if (p.position !== 'outside') {  // inside half: layer pixels within r of the edge
      const U = inverse(S, col), D = dilate(U, p.position === 'center' ? r / 2 : r); clipTo(D, S);
      eg.drawImage(D, 0, 0); releaseCanvas(U); releaseCanvas(D);
    }
    put(R, E, p.opacity / 100, p.blend); releaseCanvas(E);
  }
  return R;
}
