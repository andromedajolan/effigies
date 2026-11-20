// Contours: curves from 0..255 to 0..255 used to shape bevels, shadows, glows and satin. Same point format as Curves.
import { curveLut } from './adjust.js';

const half = [];
for (let i = 0; i <= 8; i++) { const x = (i / 8) * 255; half.push([Math.round(x), Math.round(255 * Math.sqrt(1 - Math.pow(1 - x / 255, 2)))]); }

export const CONTOURS = [
  ['linear', 'Linear', [[0, 0], [255, 255]]],
  ['cone', 'Cone', [[0, 0], [128, 255], [255, 0]]],
  ['coneInv', 'Cone - Inverted', [[0, 255], [128, 0], [255, 255]]],
  ['coveDeep', 'Cove - Deep', [[0, 0], [40, 150], [100, 215], [180, 245], [255, 255]]],
  ['coveShallow', 'Cove - Shallow', [[0, 0], [50, 100], [130, 190], [255, 255]]],
  ['gaussian', 'Gaussian', [[0, 0], [64, 20], [128, 128], [192, 235], [255, 255]]],
  ['halfRound', 'Half Round', half],
  ['ring', 'Ring', [[0, 0], [70, 255], [150, 0], [255, 0]]],
  ['ringDouble', 'Ring - Double', [[0, 0], [40, 255], [80, 0], [130, 255], [170, 0], [255, 0]]],
  ['slope', 'Rolling Slope - Descending', [[0, 255], [90, 190], [170, 60], [255, 0]]],
  ['steps', 'Rounded Steps', [[0, 0], [50, 0], [70, 85], [120, 85], [140, 170], [190, 170], [210, 255], [255, 255]]],
  ['saw1', 'Sawtooth 1', [[0, 0], [85, 255], [86, 0], [170, 255], [171, 0], [255, 255]]],
  ['saw2', 'Sawtooth 2', [[0, 0], [64, 255], [65, 0], [128, 255], [129, 0], [192, 255], [193, 0], [255, 255]]],
];

export const LINEAR = () => [[0, 0], [255, 255]];
export const contourById = (id) => { const c = CONTOURS.find((x) => x[0] === id); return c ? c[2].map((p) => p.slice()) : LINEAR(); };
export const isLinear = (pts) => !pts || (pts.length === 2 && pts[0][0] === 0 && pts[0][1] === 0 && pts[1][0] === 255 && pts[1][1] === 255);

const cache = new Map();
/** 256-entry lookup table for a point list (cached by content). */
export function contourLut(pts) {
  if (isLinear(pts)) return null;
  const key = JSON.stringify(pts);
  let l = cache.get(key);
  if (!l) { l = curveLut(pts); if (cache.size > 64) cache.clear(); cache.set(key, l); }
  return l;
}
