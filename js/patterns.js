// Pattern library for Pattern Overlay. A few built-in tiles are drawn in code; imported .pat patterns are stored as PNG blobs in
// IndexedDB (effigies-db, keys "pat|<id>") with an index in meta "patterns". Projects embed the patterns they use, so they travel.
import { parsePat } from './pat.js';
import { metaGet, metaSet, blobGet, blobPut, blobDelete } from './store.js';
import { canvasToBlob, makeCanvas, ctxOf } from './util.js';

const tiles = new Map();          // id -> canvas (loaded)
const pending = new Map();        // id -> Promise
let index = [];                   // [{id, name, set, w, h}] imported ones
export const patternEvents = { onChange: () => {} };

function tile(w, h, draw) { const c = makeCanvas(w, h, true), g = ctxOf(c); draw(g, w, h); return c; }
const BUILTIN = [
  ['b-dots', 'Dots', 24, 24, (g) => { g.fillStyle = '#000'; g.fillRect(0, 0, 24, 24); g.fillStyle = '#fff'; g.beginPath(); g.arc(12, 12, 6, 0, 7); g.fill(); }],
  ['b-stripes', 'Stripes', 16, 16, (g) => { g.fillStyle = '#fff'; g.fillRect(0, 0, 16, 16); g.fillStyle = '#000'; g.fillRect(0, 0, 8, 16); }],
  ['b-diag', 'Diagonal Lines', 16, 16, (g) => { g.fillStyle = '#fff'; g.fillRect(0, 0, 16, 16); g.strokeStyle = '#000'; g.lineWidth = 3; g.beginPath(); g.moveTo(-4, 20); g.lineTo(20, -4); g.moveTo(-4, 4); g.lineTo(4, -4); g.moveTo(12, 20); g.lineTo(20, 12); g.stroke(); }],
  ['b-checker', 'Checkerboard', 32, 32, (g) => { g.fillStyle = '#fff'; g.fillRect(0, 0, 32, 32); g.fillStyle = '#000'; g.fillRect(0, 0, 16, 16); g.fillRect(16, 16, 16, 16); }],
  ['b-grid', 'Grid', 24, 24, (g) => { g.fillStyle = '#fff'; g.fillRect(0, 0, 24, 24); g.fillStyle = '#000'; g.fillRect(0, 0, 24, 2); g.fillRect(0, 0, 2, 24); }],
  ['b-noise', 'Noise', 128, 128, (g, w, h) => { const im = g.createImageData(w, h); let s = 12345; for (let i = 0; i < w * h; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; const v = (s >> 16) & 255; im.data[i * 4] = im.data[i * 4 + 1] = im.data[i * 4 + 2] = v; im.data[i * 4 + 3] = 255; } g.putImageData(im, 0, 0); }],
  ['b-weave', 'Weave', 24, 24, (g) => { g.fillStyle = '#888'; g.fillRect(0, 0, 24, 24); g.fillStyle = '#fff'; g.fillRect(0, 0, 11, 11); g.fillRect(12, 12, 11, 11); g.fillStyle = '#222'; g.fillRect(12, 0, 11, 11); g.fillRect(0, 12, 11, 11); }],
  ['b-hex', 'Hexagons', 28, 48, (g) => { g.fillStyle = '#fff'; g.fillRect(0, 0, 28, 48); g.strokeStyle = '#000'; g.lineWidth = 2; g.beginPath(); g.moveTo(14, 0); g.lineTo(28, 8); g.lineTo(28, 24); g.lineTo(14, 32); g.lineTo(0, 24); g.lineTo(0, 8); g.closePath(); g.moveTo(14, 32); g.lineTo(14, 48); g.moveTo(0, 24); g.lineTo(-14, 32); g.moveTo(28, 24); g.lineTo(42, 32); g.stroke(); }],
];
for (const [id, , w, h, d] of BUILTIN) tiles.set(id, tile(w, h, d));

/** Everything in the library: [{id, name, set, w, h, builtin}] */
export const listPatterns = () => [
  ...BUILTIN.map(([id, name, w, h]) => ({ id, name, set: 'Built-in', w, h, builtin: true })),
  ...index.map((p) => ({ ...p, builtin: false })),
];
export const patternInfo = (id) => listPatterns().find((p) => p.id === id) || null;

/** The pattern's canvas if it is loaded, else null (and a load is started; patternEvents.onChange fires when it arrives). */
export function getTile(id) {
  if (tiles.has(id)) return tiles.get(id);
  if (!pending.has(id) && index.some((p) => p.id === id)) {
    pending.set(id, (async () => {
      try {
        const b = await blobGet('pat|' + id);
        if (b) { const bmp = await createImageBitmap(b), c = makeCanvas(bmp.width, bmp.height, true); ctxOf(c).drawImage(bmp, 0, 0); bmp.close && bmp.close(); tiles.set(id, c); patternEvents.onChange(); }
      } catch { /* missing blob */ }
      pending.delete(id);
    })());
  }
  return null;
}

export async function initPatterns() {
  try { index = (await metaGet('patterns')) || []; } catch { index = []; }
  patternEvents.onChange();
}

async function saveIndex() { try { await metaSet('patterns', index); } catch { /* quota */ } }

function toCanvas(p) { const c = makeCanvas(p.width, p.height, true); ctxOf(c).putImageData(new ImageData(p.data, p.width, p.height), 0, 0); return c; }

/** Import a .pat file (ArrayBuffer). Returns {added, replaced, skipped:[{name, reason}]}. */
export async function importPat(buf, setName = 'Imported') {
  const { patterns, skipped } = parsePat(buf);
  let added = 0, replaced = 0;
  for (const p of patterns) {
    const c = toCanvas(p), blob = await canvasToBlob(c);
    await blobPut('pat|' + p.id, blob);
    tiles.set(p.id, c);
    const row = { id: p.id, name: p.name, set: setName, w: p.width, h: p.height };
    const i = index.findIndex((x) => x.id === p.id);
    if (i >= 0) { index[i] = row; replaced++; } else { index.push(row); added++; }
  }
  await saveIndex(); patternEvents.onChange();
  return { added, replaced, skipped };
}

export async function deletePattern(id) {
  const i = index.findIndex((x) => x.id === id); if (i < 0) return false;
  index.splice(i, 1); tiles.delete(id);
  try { await blobDelete('pat|' + id); } catch { /* ignore */ }
  await saveIndex(); patternEvents.onChange(); return true;
}

/** For project export: PNG data URL of a pattern. */
export async function patternDataUrl(id) {
  const c = tiles.get(id) || (await (async () => { getTile(id); await (pending.get(id) || Promise.resolve()); return tiles.get(id); })());
  if (!c) return null;
  return c.toDataURL('image/png');
}
/** From a project file: add any patterns the library does not have yet. */
export async function adoptPatterns(list) {
  let n = 0;
  for (const p of list || []) {
    if (!p || !p.id || !p.image || patternInfo(p.id)) continue;
    try {
      const img = await createImageBitmap(await (await fetch(p.image)).blob()), c = makeCanvas(img.width, img.height, true);
      ctxOf(c).drawImage(img, 0, 0); img.close && img.close();
      await blobPut('pat|' + p.id, await canvasToBlob(c)); tiles.set(p.id, c);
      index.push({ id: p.id, name: p.name || 'Pattern', set: 'From project', w: c.width, h: c.height }); n++;
    } catch { /* skip */ }
  }
  if (n) { await saveIndex(); patternEvents.onChange(); }
  return n;
}
