// Project file: documented, versioned JSON with layer images as PNG data URLs. See docs/DATA_FORMAT.md.
import { Doc, Layer } from './doc.js';
import { makeCanvas, ctxOf, canvasToBlob, blobToDataURL, uid } from './util.js';
import { patternInfo, patternDataUrl, adoptPatterns } from './patterns.js';

export const FORMAT = 'effigies-project';
export const FORMAT_VERSION = 1;

export async function exportProject(doc, appVersion) {
  const images = [];
  const enc = async (list) => {
    const out = [];
    for (const L of list) {
      const o = {
        id: L.id, type: L.type, name: L.name, visible: L.visible, opacity: L.opacity, fill: L.fill, blend: L.blend,
        lock: { transparentPixels: L.lockTrans, imagePixels: L.lockPix, position: L.lockPos, all: L.lockAll },
        x: L.x, y: L.y, width: L.w, height: L.h,
      };
      if (L.clip) o.clip = true;
      if (L.text) o.text = L.text;
      if (L.styles) o.styles = L.styles;
      if (L.type === 'adjust') o.adjustment = { id: L.adj.id, params: L.adj.params };
      if (L.type === 'group') { o.collapsed = L.collapsed; o.children = await enc(L.children); }
      else if (L.canvas) { images.push(await blobToDataURL(await canvasToBlob(L.canvas))); o.image = `@@IMG${images.length - 1}@@`; }
      else o.image = null;
      if (L.type !== 'group' && L.mask) { images.push(await blobToDataURL(await canvasToBlob(L.mask.canvas))); o.mask = { x: L.mask.x, y: L.mask.y, width: L.mask.canvas.width, height: L.mask.canvas.height, enabled: L.maskOn, image: `@@IMG${images.length - 1}@@` }; }
      out.push(o);
    }
    return out;
  };
  const project = {
    format: FORMAT, version: FORMAT_VERSION, app: 'Effigies', appVersion,
    projectId: doc.id, name: doc.name, created: new Date(doc.created).toISOString(), modified: new Date(doc.modified).toISOString(),
    width: doc.w, height: doc.h, colorMode: 'RGB', bitDepth: 8,
    activeLayerId: doc.activeId, songRef: doc.songRef || null,
    guides: (doc.guides || []).map((g) => ({ orientation: g.o === 'h' ? 'horizontal' : 'vertical', position: g.p })),
    layers: await enc(doc.layers),
  };
  const used = new Set();
  const scan = (list) => { for (const L of list) { const po = L.styles && L.styles.patternOverlay; if (po && po.on) used.add(po.pattern); if (L.children) scan(L.children); } };
  scan(doc.layers);
  const pats = [];
  for (const id of used) { const info = patternInfo(id); if (!info || info.builtin) continue; const url = await patternDataUrl(id); if (url) pats.push({ id, name: info.name, image: url }); }
  if (pats.length) project.patterns = pats;
  const text = JSON.stringify(project, null, 1);
  const parts = []; let last = 0;
  const re = /"@@IMG(\d+)@@"/g; let m;
  while ((m = re.exec(text))) {
    parts.push(text.slice(last, m.index)); parts.push('"' + images[Number(m[1])] + '"'); last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  return new Blob(parts, { type: 'application/json' });
}

async function decodeImage(url) {
  const blob = await (await fetch(url)).blob();
  const bmp = await createImageBitmap(blob);
  const c = makeCanvas(bmp.width, bmp.height); ctxOf(c).drawImage(bmp, 0, 0); bmp.close && bmp.close();
  return c;
}

export async function importProject(text, { newId = false } = {}) {
  let p;
  try { p = JSON.parse(text); } catch { throw new Error('That file is not valid JSON.'); }
  if (!p || p.format !== FORMAT) throw new Error('That is not an Effigies project file.');
  if (typeof p.version !== 'number' || p.version > FORMAT_VERSION) throw new Error('This project was saved by a newer version of Effigies. Update the app first.');
  if (!(p.width > 0 && p.height > 0) || !Array.isArray(p.layers)) throw new Error('The project file is incomplete.');
  if (Array.isArray(p.patterns)) await adoptPatterns(p.patterns);
  const doc = new Doc({ id: newId ? uid() : p.projectId, name: p.name || 'Untitled', w: p.width, h: p.height });
  if (p.created) doc.created = Date.parse(p.created) || doc.created;
  doc.songRef = p.songRef || null;
  doc.guides = Array.isArray(p.guides) ? p.guides.filter((g) => g && Number.isFinite(g.position)).map((g) => ({ o: g.orientation === 'horizontal' ? 'h' : 'v', p: g.position })) : [];
  const dec = async (list) => {
    const out = [];
    for (const o of list) {
      const lk = o.lock || {};
      const L = new Layer({
        id: o.id, type: o.type === 'group' ? 'group' : o.type === 'adjust' && o.adjustment ? 'adjust' : 'raster', clip: !!o.clip, text: o.text || null, styles: o.styles || null, adj: o.type === 'adjust' ? o.adjustment : null, name: o.name, visible: o.visible !== false, opacity: o.opacity ?? 1, fill: o.fill ?? 1, blend: o.blend,
        lockTrans: lk.transparentPixels, lockPix: lk.imagePixels, lockPos: lk.position, lockAll: lk.all, x: o.x || 0, y: o.y || 0, collapsed: o.collapsed,
      });
      if (L.type === 'group') L.children = await dec(o.children || []);
      else {
        if (o.image) L.canvas = await decodeImage(o.image);
        if (o.mask && o.mask.image) { L.mask = { canvas: await decodeImage(o.mask.image), x: o.mask.x || 0, y: o.mask.y || 0 }; L.maskOn = o.mask.enabled !== false; }
      }
      out.push(L);
    }
    return out;
  };
  doc.layers = await dec(p.layers);
  doc.activeId = p.activeLayerId && doc.find(p.activeLayerId) ? p.activeLayerId : (doc.layers.length ? doc.layers[doc.layers.length - 1].id : null);
  return doc;
}
