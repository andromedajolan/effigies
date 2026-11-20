// Custom brush tips (imported from Photoshop .abr files). Tips are white-on-transparent PNGs in IndexedDB (effigies-db, keys "brush|<id>")
// with an index in meta "brushes". A tip is chosen by setting the brush option tip to "c:<id>".
import { parseAbr, buildAbr } from './abr.js';
import { metaGet, metaSet, blobGet, blobPut, blobDelete } from './store.js';
import { canvasToBlob, makeCanvas, ctxOf } from './util.js';

const alphas = new Map(), pending = new Map();
let index = [];       // [{id, name, set, spacing, w, h}]
export const brushEvents = { onChange: () => {} };
export const listBrushes = () => index.slice();
export const brushInfo = (id) => index.find((b) => b.id === id) || null;
const uid = () => 'br-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

/** Canvas holding the tip (white ink with alpha) or null while it loads (brushEvents.onChange fires on arrival). */
export function getBrushAlpha(id) {
  if (alphas.has(id)) return alphas.get(id);
  if (!pending.has(id) && index.some((b) => b.id === id)) {
    pending.set(id, (async () => {
      try { const b = await blobGet('brush|' + id); if (b) { const bmp = await createImageBitmap(b), c = makeCanvas(bmp.width, bmp.height, true); ctxOf(c).drawImage(bmp, 0, 0); bmp.close && bmp.close(); alphas.set(id, c); brushEvents.onChange(); } } catch { /* missing */ }
      pending.delete(id);
    })());
  }
  return null;
}
export async function initBrushes() { try { index = (await metaGet('brushes')) || []; } catch { index = []; } brushEvents.onChange(); }
async function saveIndex() { try { await metaSet('brushes', index); } catch { /* quota */ } }

function toCanvas(b) {
  let w = b.width, h = b.height; const k = Math.min(1, 2000 / Math.max(w, h));
  const c = makeCanvas(w, h, true), g = ctxOf(c), im = g.createImageData(w, h);
  for (let i = 0; i < w * h; i++) { im.data[i * 4] = im.data[i * 4 + 1] = im.data[i * 4 + 2] = 255; im.data[i * 4 + 3] = b.alpha[i]; }
  g.putImageData(im, 0, 0);
  if (k >= 1) return c;
  const s = makeCanvas(Math.round(w * k), Math.round(h * k), true); ctxOf(s).drawImage(c, 0, 0, s.width, s.height); return s;
}
/** Import an .abr file. Returns {added, skipped, ids}. */
export async function importAbr(buf, setName = 'Imported') {
  const r = parseAbr(buf), ids = [];
  for (const b of r.brushes) {
    const c = toCanvas(b), id = uid();
    await blobPut('brush|' + id, await canvasToBlob(c));
    alphas.set(id, c); ids.push(id);
    index.push({ id, name: b.name, set: setName, spacing: b.spacing, w: c.width, h: c.height });
  }
  await saveIndex(); brushEvents.onChange();
  return { added: r.brushes.length, skipped: r.skipped, ids };
}
export async function deleteBrush(id) {
  index = index.filter((b) => b.id !== id); alphas.delete(id);
  try { await blobDelete('brush|' + id); } catch { /* ignore */ }
  await saveIndex(); brushEvents.onChange();
}
/** Build an .abr from the given tip ids (all imported tips when omitted). Resolves to a Blob. */
export async function exportAbr(ids) {
  const list = (ids ? ids.map(brushInfo).filter(Boolean) : index), out = [];
  for (const b of list) {
    let c = alphas.get(b.id);
    if (!c) { const bl = await blobGet('brush|' + b.id); if (!bl) continue; const bmp = await createImageBitmap(bl); c = makeCanvas(bmp.width, bmp.height, true); ctxOf(c).drawImage(bmp, 0, 0); bmp.close && bmp.close(); }
    const d = ctxOf(c).getImageData(0, 0, c.width, c.height).data, a = new Uint8Array(c.width * c.height);
    for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3];
    out.push({ name: b.name, width: c.width, height: c.height, alpha: a, spacing: b.spacing });
  }
  return buildAbr(out);
}
