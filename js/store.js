// Crash-proof autosave in IndexedDB ("effigies-db"). Layers are saved as lossless PNG blobs under versioned keys;
// the document record that points at them is written last, so a crash mid-save always leaves the previous good state.
import { Doc, Layer, layerMeta } from './doc.js';
import { canvasBytes } from './doc.js';
import { makeCanvas, ctxOf, canvasToBlob } from './util.js';

const DB_NAME = 'effigies-db', DB_VERSION = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('docs')) db.createObjectStore('docs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.onblocked = () => rej(new Error('Database blocked by another tab'));
  });
  return dbp;
}
const wrap = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
const txDone = (tx) => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error || new Error('aborted')); });

export async function metaGet(k) { const db = await open(); return wrap(db.transaction('meta').objectStore('meta').get(k)); }
export async function metaSet(k, v) { const db = await open(); const tx = db.transaction('meta', 'readwrite'); tx.objectStore('meta').put(v, k); return txDone(tx); }

const blobKey = (docId, L) => `${docId}|${L.id}|${L.savedVer}`;

function treeRecord(docId, list) {
  return list.map((L) => {
    const m = layerMeta(L);
    if (L.type === 'group') m.children = treeRecord(docId, L.children);
    else {
      if (L.canvas && L.savedVer) m.blob = blobKey(docId, L);
      if (L.mask && L.savedMver) m.mask = { ...m.mask, blob: `${docId}|${L.id}|m${L.savedMver}` };
      else m.mask = null;
    }
    return m;
  });
}
function collectKeys(list, out) { for (const m of list) { if (m.blob) out.add(m.blob); if (m.mask && m.mask.blob) out.add(m.mask.blob); if (m.children) collectKeys(m.children, out); } }

let chain = Promise.resolve();
/** Save one document (serialized so two saves never overlap). Resolves when durable. */
export function saveDoc(doc) {
  const run = async () => {
    const rev = doc.rev;
    if (doc.savedRev === rev) return false;
    const db = await open();
    // 1. layer pixels (only layers that changed since their last save)
    for (const L of doc.allLayers()) {
      if (L.type !== 'group' && L.mask && L.savedMver !== L.mver) {
        const v = L.mver, blob = await canvasToBlob(L.mask.canvas);
        const tx = db.transaction('blobs', 'readwrite'); tx.objectStore('blobs').put(blob, `${doc.id}|${L.id}|m${v}`); await txDone(tx);
        L.savedMver = v;
      }
      if (L.type !== 'raster' || !L.canvas) continue;
      if (L.savedVer === L.ver && L.savedCanvasBytes === canvasBytes(L.canvas)) continue;
      const v = L.ver;
      const blob = await canvasToBlob(L.canvas);
      const key = `${doc.id}|${L.id}|${v}`;
      const tx = db.transaction('blobs', 'readwrite'); tx.objectStore('blobs').put(blob, key); await txDone(tx);
      L.savedVer = v; L.savedCanvasBytes = canvasBytes(L.canvas);
    }
    // 2. the record that references them
    const rec = {
      id: doc.id, name: doc.name, w: doc.w, h: doc.h, created: doc.created, modified: doc.modified,
      view: { ...doc.view }, activeId: doc.activeId, seq: doc.seq, gseq: doc.gseq, songRef: doc.songRef, guides: doc.guides || [],
      layers: treeRecord(doc.id, doc.layers),
    };
    const keep = new Set(); collectKeys(rec.layers, keep);
    const tx = db.transaction(['docs', 'blobs'], 'readwrite');
    tx.objectStore('docs').put(rec);
    // 3. drop blobs of this doc that the new record no longer references
    const bs = tx.objectStore('blobs');
    const range = IDBKeyRange.bound(doc.id + '|', doc.id + '|￿');
    const keys = await wrap(bs.getAllKeys(range));
    for (const k of keys) if (!keep.has(k)) bs.delete(k);
    await txDone(tx);
    doc.savedRev = rev;
    return true;
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

export async function deleteDocStored(id) {
  const db = await open();
  const tx = db.transaction(['docs', 'blobs'], 'readwrite');
  tx.objectStore('docs').delete(id);
  tx.objectStore('blobs').delete(IDBKeyRange.bound(id + '|', id + '|￿'));
  return txDone(tx);
}

async function layersFromRecord(db, list) {
  const out = [];
  for (const m of list) {
    const L = new Layer({ ...m, canvas: null, children: null, mask: null });
    L.id = m.id; L.type = m.type; if (m.type === 'group') L.children = [];
    if (m.type === 'group') L.children = await layersFromRecord(db, m.children || []);
    else {
      if (m.mask && m.mask.blob) {
        const mb = await wrap(db.transaction('blobs').objectStore('blobs').get(m.mask.blob));
        if (mb) {
          const bmp = await createImageBitmap(mb), c = makeCanvas(bmp.width, bmp.height); ctxOf(c).drawImage(bmp, 0, 0); bmp.close && bmp.close();
          L.mask = { canvas: c, x: m.mask.x, y: m.mask.y }; L.mver = L.savedMver = Number(m.mask.blob.split('|m').pop());
        }
      }
    }
    if (m.type !== 'group' && m.blob) {
      const blob = await wrap(db.transaction('blobs').objectStore('blobs').get(m.blob));
      if (blob) {
        const bmp = await createImageBitmap(blob);
        const c = makeCanvas(bmp.width, bmp.height); ctxOf(c).drawImage(bmp, 0, 0); bmp.close && bmp.close();
        L.canvas = c; L.x = m.x; L.y = m.y;
        L.savedVer = Number(m.blob.split('|').pop()); L.ver = L.savedVer; L.savedCanvasBytes = canvasBytes(c);
      }
    }
    out.push(L);
  }
  return out;
}

export async function loadDoc(id) {
  const db = await open();
  const rec = await wrap(db.transaction('docs').objectStore('docs').get(id));
  if (!rec) return null;
  const doc = new Doc({ id: rec.id, name: rec.name, w: rec.w, h: rec.h });
  doc.created = rec.created; doc.modified = rec.modified; doc.view = { ...rec.view, fit: !!rec.view.fit };
  doc.seq = rec.seq || 1; doc.gseq = rec.gseq || 1; doc.songRef = rec.songRef || null; doc.guides = Array.isArray(rec.guides) ? rec.guides : [];
  doc.layers = await layersFromRecord(db, rec.layers);
  doc.activeId = rec.activeId && doc.find(rec.activeId) ? rec.activeId : (doc.layers.length ? doc.layers[doc.layers.length - 1].id : null);
  doc.savedRev = doc.rev;
  return doc;
}

export async function listStoredDocs() {
  const db = await open();
  return wrap(db.transaction('docs').objectStore('docs').getAllKeys());
}

export async function persistRequest() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      if (await navigator.storage.persisted()) return true;
      return await navigator.storage.persist();
    }
  } catch { /* ignore */ }
  return false;
}
export async function storageEstimate() {
  try { return await navigator.storage.estimate(); } catch { return null; }
}

// generic blob helpers (used by the pattern library; keys must not start with a document id)
export async function blobGet(k) { const db = await open(); return wrap(db.transaction('blobs').objectStore('blobs').get(k)); }
export async function blobPut(k, blob) { const db = await open(); const tx = db.transaction('blobs', 'readwrite'); tx.objectStore('blobs').put(blob, k); return txDone(tx); }
export async function blobDelete(k) { const db = await open(); const tx = db.transaction('blobs', 'readwrite'); tx.objectStore('blobs').delete(k); return txDone(tx); }
