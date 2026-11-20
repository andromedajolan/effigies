// Glue between PSD files and Effigies documents.
import { Doc, Layer } from './doc.js';
import { makeCanvas } from './util.js';
import { renderFull } from './render.js';
import { parsePsd, buildPsd } from './psd.js';

export async function docFromPsd(buf, name) {
  const p = await parsePsd(buf);
  const doc = new Doc({ name, w: p.width, h: p.height });
  const make = (n) => {
    if (n.kind === 'group') return new Layer({ type: 'group', name: n.name, visible: n.visible, opacity: n.opacity, blend: n.blend, collapsed: n.collapsed, children: n.children.map(make) });
    const L = new Layer({ name: n.name, visible: n.visible, opacity: n.opacity, fill: n.fill, blend: n.blend, clip: n.clip, canvas: n.canvas || makeCanvas(1, 1) });
    L.x = n.canvas ? n.x : 0; L.y = n.canvas ? n.y : 0;
    if (n.mask && n.canvas) { L.mask = { canvas: n.mask.canvas, x: n.mask.x - L.x, y: n.mask.y - L.y }; L.maskOn = n.mask.enabled; }
    return L;
  };
  doc.layers.push(...p.layers.map(make));
  if (!doc.layers.length) doc.layers.push(new Layer({ name: 'Layer 1' }));
  doc.activeId = doc.layers[doc.layers.length - 1].id; doc.seq = 2;
  return { doc, skipped: p.skipped };
}

/** Returns {blob, baked, skipped}. */
export function psdFromDoc(d) {
  let baked = 0, skipped = 0;
  const conv = (L) => {
    if (L.type === 'group') return { kind: 'group', name: L.name, visible: L.visible, opacity: L.opacity, blend: L.blend, collapsed: L.collapsed, children: L.children.map(conv).filter(Boolean) };
    if (L.type === 'adjust' || !L.canvas) { skipped++; return null; }
    const styled = L.styles && Object.values(L.styles).some((s) => s && s.on);
    let canvas = L.canvas, x = L.x, y = L.y;
    if (styled) {
      const solo = new Layer({ name: L.name, canvas: L.canvas, styles: L.styles }); solo.x = L.x; solo.y = L.y;
      canvas = renderFull([solo], d.w, d.h, { bg: null }); x = 0; y = 0; baked++;
    }
    return { kind: 'raster', name: L.name, visible: L.visible, opacity: L.opacity, fill: styled ? 1 : L.fill, blend: L.blend, clip: L.clip, x, y, canvas, mask: L.mask ? { canvas: L.mask.canvas, x: L.x + L.mask.x, y: L.y + L.mask.y, enabled: L.maskOn } : null };
  };
  const tree = d.layers.map(conv).filter(Boolean);
  const flat = renderFull(d.layers, d.w, d.h, { bg: '#ffffff' });
  return { blob: buildPsd(d.w, d.h, tree, flat), baked, skipped };
}
