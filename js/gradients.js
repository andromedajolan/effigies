// Gradient presets shared by the Gradient tool and the Gradient Map adjustment.
import { clamp, hexToRgb } from './util.js';

export const GRADIENTS = [['fgbg', 'Foreground to Background'], ['fgt', 'Foreground to Transparent'], ['bw', 'Black, White'], ['wb', 'White, Black'], ['sunset', 'Sunset (magenta, orange, yellow)'], ['neon', 'Neon (cyan, violet, pink)'], ['rainbow', 'Rainbow']];
export function stopsFor(id, fg, bg) {
  const f = hexToRgb(fg), b = hexToRgb(bg);
  const rgb = (c, a = 1) => [c[0], c[1], c[2], a];
  switch (id) {
    case 'fgt': return [[0, rgb(f)], [1, rgb(f, 0)]];
    case 'bw': return [[0, [0, 0, 0, 1]], [1, [255, 255, 255, 1]]];
    case 'wb': return [[0, [255, 255, 255, 1]], [1, [0, 0, 0, 1]]];
    case 'sunset': return [[0, [190, 40, 200, 1]], [0.5, [255, 120, 50, 1]], [1, [255, 225, 90, 1]]];
    case 'neon': return [[0, [40, 220, 255, 1]], [0.5, [140, 70, 255, 1]], [1, [255, 70, 190, 1]]];
    case 'rainbow': return [[0, [255, 60, 60, 1]], [0.2, [255, 190, 50, 1]], [0.4, [90, 220, 90, 1]], [0.6, [60, 200, 255, 1]], [0.8, [110, 90, 255, 1]], [1, [230, 70, 220, 1]]];
    default: return [[0, rgb(f)], [1, rgb(b)]];
  }
}
export function lut(stops, reverse) {
  const out = new Uint8ClampedArray(256 * 4);
  const st = reverse ? stops.map(([t, c]) => [1 - t, c]).reverse() : stops;
  for (let i = 0; i < 256; i++) {
    const t = i / 255; let k = 0; while (k < st.length - 2 && t > st[k + 1][0]) k++;
    const [t0, c0] = st[k], [t1, c1] = st[k + 1], u = clamp((t - t0) / Math.max(1e-6, t1 - t0), 0, 1);
    for (let j = 0; j < 4; j++) out[i * 4 + j] = j < 3 ? c0[j] + (c1[j] - c0[j]) * u : (c0[3] + (c1[3] - c0[3]) * u) * 255;
  }
  return out;
}
