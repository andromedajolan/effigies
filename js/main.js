// Effigies: app core. Wires documents, tools, UI, autosave, clipboard, shortcuts and the service worker together.
import { h, $, toast, debounce, clamp, makeCanvas, ctxOf, canvasToBlob, download, fmtBytes, uid } from './util.js';
import { Doc, Layer, cloneLayer, cloneCanvas, walkLayers } from './doc.js';
import { Viewport } from './viewport.js';
import { createTools } from './tools.js';
import { buildDock } from './panels.js';
import { buildMenus, buildAppbar, buildToolbox, buildOptionsBar, buildTabs, buildStatusbar, closeMenus } from './chrome.js';
import { openDialog, confirmDialog, alertDialog, newDocDialog, imageSizeDialog, canvasSizeDialog, exportDialog, prefsDialog, helpDialog } from './dialogs.js';
import { saveDoc, loadDoc, deleteDocStored, listStoredDocs, metaGet, metaSet, persistRequest, storageEstimate } from './store.js';
import { exportProject, importProject } from './project.js';
import { renderFull } from './render.js';

export const APP_VERSION = '0.1.0'; // keep in sync with VERSION in sw.js

const PREF_KEY = 'effigies.prefs';
const DEFAULT_PREFS = { wheel: 'zoom', undoMode: 'cs5', historyStates: 50, guideCenter: false, guideThirds: false, guideSafe: false, panels: {}, toolOpts: {}, fg: '#000000', bg: '#ffffff', tool: 'brush', groupCurrent: {} };

const listeners = {};
const app = {
  version: APP_VERSION, docs: [], doc: null, prefs: null, tool: null, tools: null, vp: null, fg: '#000000', bg: '#ffffff', colorTarget: 'fg',
  theme: 'gray', clip: null, installEvent: null, groupCurrent: {}, dockEls: {}, actions: {},
  on(ev, fn) { (listeners[ev] ||= []).push(fn); },
  emit(ev, d) { for (const fn of listeners[ev] || []) { try { fn(d); } catch (e) { console.error(e); } } },
};
window.__effigies = app;

// ───────────── prefs ─────────────
function loadPrefs() {
  let p = {};
  try { p = JSON.parse(localStorage.getItem(PREF_KEY) || '{}'); } catch { /* ignore */ }
  app.prefs = { ...DEFAULT_PREFS, ...p, panels: { ...(p.panels || {}) }, toolOpts: { ...(p.toolOpts || {}) }, groupCurrent: { ...(p.groupCurrent || {}) } };
  app.fg = app.prefs.fg; app.bg = app.prefs.bg; app.groupCurrent = app.prefs.groupCurrent;
}
const savePrefsNow = () => { try { app.prefs.fg = app.fg; app.prefs.bg = app.bg; app.prefs.tool = app.tool ? app.tool.id : app.prefs.tool; app.prefs.groupCurrent = app.groupCurrent; localStorage.setItem(PREF_KEY, JSON.stringify(app.prefs)); } catch { /* quota */ } };
app.savePrefs = debounce(savePrefsNow, 300);
app.opts = (id, defaults) => { const o = (app.prefs.toolOpts[id] ||= {}); for (const [k, v] of Object.entries(defaults || {})) if (!(k in o)) o[k] = v; return o; };

// ───────────── theme ─────────────
function applyTheme(t, persist) {
  app.theme = t === 'dark' ? 'dark' : 'gray';
  document.documentElement.dataset.theme = app.theme;
  if (persist) { try { localStorage.setItem('studio.theme', app.theme); } catch { /* ignore */ } }
  const cs = getComputedStyle(document.documentElement);
  if (app.vp) { app.vp.surround = cs.getPropertyValue('--stage').trim() || '#555'; app.vp.invalidate(); }
  const m = document.querySelector('meta[name="theme-color"]'); if (m) m.setAttribute('content', cs.getPropertyValue('--bg3').trim());
  app.emit('theme', app.theme);
}

// ───────────── colors / tools ─────────────
app.setFg = (c) => { app.fg = c; app.savePrefs(); app.emit('color'); };
app.setBg = (c) => { app.bg = c; app.savePrefs(); app.emit('color'); };
app.setColorTarget = (t) => { app.colorTarget = t; app.emit('color'); };
app.setTool = (id, opts = {}) => {
  const t = app.tools[id]; if (!t || t === app.tool) return;
  if (app.tool && app.tool.cancel) app.tool.cancel();
  app.tool = t; if (!opts.temp) app.groupCurrent[t.group] = id;
  app.refreshCursor(); app.savePrefs(); app.emit('tool', t); app.vp.drawOverlay();
};
app.refreshCursor = () => { if (!app.vp) return; const t = app.tool; app.vp.setCursorStyle(app.vp.space ? 'grab' : (t.id === 'brush' || t.id === 'eraser') ? 'none' : (t.cursor || 'default')); };

// ───────────── documents ─────────────
function attach(doc) {
  doc.hist.limit = app.prefs.historyStates;
  doc._lw = doc.w; doc._lh = doc.h;
  doc.on((info) => app.onDocChanged(doc, info));
}
app.onDocChanged = (doc, info) => {
  if (info.history && !app._inUndo) app._zToggle = false;
  if (doc === app.doc) {
    if (doc._lw !== doc.w || doc._lh !== doc.h) { doc._lw = doc.w; doc._lh = doc.h; app.vp.fit(false); app.vp.invalidate(); }
    else if (!info.skipRender) app.vp.invalidate(info.rect);
    app.emit('docchange', info);
  }
  scheduleSave();
};
app.onViewChanged = () => { if (app.doc) { app.doc.rev++; scheduleSave(2500); } app.emit('view'); };
app.onRendered = (rect) => { app.emit('rendered', rect); };

app.openDoc = (doc, activate = true) => {
  attach(doc); app.docs.push(doc); app.emit('tabs');
  if (activate) app.switchDoc(doc.id);
  scheduleSave();
};
app.switchDoc = (id) => {
  const d = app.docs.find((x) => x.id === id); if (!d) return;
  app.flushPending();
  if (app.tool && app.tool.cancel) app.tool.cancel();
  app.doc = d; app.vp.setDoc(d);
  app.emit('doc'); app.emit('tabs'); app.vp.drawOverlay();
  document.title = d.name + ' — Effigies'; saveSession();
};
app.reorderDoc = (id, beforeId) => {
  const i = app.docs.findIndex((d) => d.id === id), j = app.docs.findIndex((d) => d.id === beforeId); if (i < 0 || j < 0) return;
  const [d] = app.docs.splice(i, 1); app.docs.splice(j, 0, d); app.emit('tabs'); saveSession();
};
app.memoryEstimate = () => { let n = 0; for (const d of app.docs) n += d.estimateBytes() + d.hist.bytes; if (app.doc && app.doc.live) n += app.doc.live.canvas.width * app.doc.live.canvas.height * 4; return n; };
async function confirmMemory(extra) {
  if (app.memoryEstimate() + extra < 1.8e9) return true;
  return !!(await confirmDialog(`This needs about ${fmtBytes(extra)} more and you are already near ${fmtBytes(app.memoryEstimate())}. A 4 GB Chromebook may reload the page. Continue anyway?`, 'Continue', 'Low on memory'));
}

let pendingNudge = null;
app.flushPending = () => {
  if (!pendingNudge) return; const p = pendingNudge; pendingNudge = null; clearTimeout(p.t);
  if (p.layer.x !== p.old.x || p.layer.y !== p.old.y) p.doc.pushProps('Nudge', [{ layer: p.layer, old: p.old, now: { x: p.layer.x, y: p.layer.y } }]);
};
function nudge(dx, dy) {
  const d = app.doc, L = d && d.active; if (!L || L.type !== 'raster' || L.lockPos || L.lockAll) return;
  if (!pendingNudge || pendingNudge.layer !== L) { app.flushPending(); pendingNudge = { doc: d, layer: L, old: { x: L.x, y: L.y } }; }
  L.x += dx; L.y += dy; L.touch(); app.vp.invalidate();
  clearTimeout(pendingNudge.t); pendingNudge.t = setTimeout(app.flushPending, 600);
}

app.copyLayerToDoc = async (L, dstId) => {
  const dst = app.docs.find((d) => d.id === dstId); if (!dst) return;
  let bytes = 0; walkLayers([L], (k) => { if (k.canvas) bytes += k.canvas.width * k.canvas.height * 4; });
  if (!(await confirmMemory(bytes))) return;
  const t = dst.begin('Drag Layer');
  const n = cloneLayer(L, true, '');
  if (n.type === 'raster' && n.canvas) { n.x = Math.round((dst.w - n.w) / 2); n.y = Math.round((dst.h - n.h) / 2); }
  dst._insertAbove(n); dst.activeId = n.id; t.end();
  app.switchDoc(dst.id); toast(`Copied “${L.name}” into ${dst.name}.`);
};

// ───────────── new / open / import ─────────────
async function newDocument(spec) {
  const w = spec.w, hh = spec.h;
  if (!(await confirmMemory(w * hh * 4))) return;
  const doc = new Doc({ name: spec.name, w, h: hh });
  const L = new Layer({ name: 'Layer ' + doc.seq++ }); doc.layers.push(L); doc.activeId = L.id;
  app.openDoc(doc);
}
async function openImageFile(file) {
  try {
    const bmp = await createImageBitmap(file);
    if (bmp.width > 12000 || bmp.height > 12000) { toast('That image is too large for this device (limit 12000 px per side).'); bmp.close && bmp.close(); return; }
    if (!(await confirmMemory(bmp.width * bmp.height * 4))) { bmp.close && bmp.close(); return; }
    const c = makeCanvas(bmp.width, bmp.height); ctxOf(c).drawImage(bmp, 0, 0); const w = bmp.width, hh = bmp.height; bmp.close && bmp.close();
    const name = file.name.replace(/\.[^.]+$/, '') || 'Image';
    const doc = new Doc({ name, w, h: hh });
    const L = new Layer({ name, canvas: c }); doc.layers.push(L); doc.activeId = L.id; doc.seq = 2;
    app.openDoc(doc);
  } catch (e) { toast('Could not open ' + file.name + ' as an image.'); }
}
async function openProjectFile(file, forceCopy = false) {
  try {
    const text = await file.text();
    let doc = await importProject(text, { newId: forceCopy });
    if (app.docs.some((d) => d.id === doc.id)) {
      const copy = await confirmDialog(`“${doc.name}” is already open. Open the file as a separate copy?`, 'Open as copy');
      if (!copy) return; doc = await importProject(text, { newId: true });
    }
    app.openDoc(doc); toast(`Opened project “${doc.name}”.`);
  } catch (e) { toast(e.message || 'Could not open that project file.', 5000); }
}
async function pasteImageBlob(blob, name = 'Pasted') {
  const bmp = await createImageBitmap(blob);
  const c = makeCanvas(bmp.width, bmp.height); ctxOf(c).drawImage(bmp, 0, 0); const w = bmp.width, hh = bmp.height; bmp.close && bmp.close();
  if (!app.doc) { const doc = new Doc({ name, w, h: hh }); const L = new Layer({ name, canvas: c }); doc.layers.push(L); doc.activeId = L.id; app.openDoc(doc); return; }
  if (!(await confirmMemory(w * hh * 4))) return;
  const d = app.doc; d.addImageLayer(c, name, Math.round((d.w - w) / 2), Math.round((d.h - hh) / 2), { historyName: 'Paste' });
}

// ───────────── actions (menus, buttons, shortcuts) ─────────────
const A = app.actions;
A.newDoc = async () => { const v = await newDocDialog('Untitled-' + (app.docs.length + 1)); if (v) await newDocument(v); };
A.openImage = () => $('#file-image').click();
A.openProject = () => $('#file-project').click();
A.closeDoc = async (d = app.doc) => {
  if (!d) return;
  const ok = await confirmDialog(`Close “${d.name}”? Its autosaved copy is removed from this browser. Export a project file first if you want to keep it.`, 'Close document', 'Close');
  if (!ok) return;
  app.flushPending();
  const i = app.docs.indexOf(d); app.docs.splice(i, 1);
  await deleteDocStored(d.id).catch(() => {});
  if (app.doc === d) { const n = app.docs[Math.min(i, app.docs.length - 1)]; if (n) app.switchDoc(n.id); else { app.doc = null; app.vp.setDoc(null); app.emit('doc'); document.title = 'Effigies'; } }
  app.emit('tabs'); saveSession();
};
A.saveNow = async () => { await doSave(); toast('All changes are saved in this browser. Use Export Project File for a backup.'); };
A.exportProject = async () => {
  const d = app.doc; if (!d) return;
  toast('Building project file…', 8000);
  try { const blob = await exportProject(d, APP_VERSION); download(blob, d.name.replace(/[\\/:*?"<>|]+/g, '_') + '.effigies.json'); toast(`Project exported (${fmtBytes(blob.size)}).`); } catch (e) { toast('Export failed: ' + e.message, 6000); }
};
A.exportImage = async () => {
  const d = app.doc; if (!d) return;
  const v = await exportDialog(d); if (!v) return;
  toast('Rendering full size…', 15000); await new Promise((r) => setTimeout(r, 30));
  try {
    const jpg = v.format === 'jpg';
    const canvas = renderFull(d.layers, d.w, d.h, { bg: jpg ? '#ffffff' : null });
    const blob = await canvasToBlob(canvas, jpg ? 'image/jpeg' : 'image/png', v.quality);
    download(blob, `${v.name}.${jpg ? 'jpg' : 'png'}`); toast(`Exported ${d.w} × ${d.h} ${jpg ? 'JPG' : 'PNG'} (${fmtBytes(blob.size)}).`);
  } catch (e) { toast('Export failed: ' + e.message, 6000); }
};
A.renameDoc = async (d = app.doc) => {
  if (!d) return;
  const inp = h('input', { type: 'text', value: d.name });
  const v = await openDialog({ title: 'Rename Document', body: h('div', null, inp), collect: () => inp.value.trim() });
  if (v) { d.name = v; d.changed({ skipRender: true }); app.emit('tabs'); if (d === app.doc) document.title = v + ' — Effigies'; }
};
A.duplicateDoc = async () => {
  const d = app.doc; if (!d) return;
  if (!(await confirmMemory(d.estimateBytes()))) return;
  const n = new Doc({ name: d.name + ' copy', w: d.w, h: d.h });
  n.layers = d.layers.map((L) => cloneLayer(L, true, '')); n.seq = d.seq; n.gseq = d.gseq; n.songRef = d.songRef;
  // keep the same active position
  const flatOld = d.allLayers(), flatNew = []; walkLayers(n.layers, (L) => flatNew.push(L));
  const idx = flatOld.findIndex((L) => L.id === d.activeId); n.activeId = flatNew[idx] ? flatNew[idx].id : null;
  app.openDoc(n);
};

// history
A.undo = () => { app.flushPending(); app._inUndo = true; app.doc && app.doc.hist.undo(); app._inUndo = false; };
A.redo = () => { app.flushPending(); app._inUndo = true; app.doc && app.doc.hist.redo(); app._inUndo = false; };
A.undoToggle = () => {
  const d = app.doc; if (!d) return; app.flushPending();
  if (app.prefs.undoMode === 'cs5') {
    app._inUndo = true;
    if (app._zToggle && d.hist.canRedo) { d.hist.redo(); app._zToggle = false; } else if (d.hist.canUndo) { d.hist.undo(); app._zToggle = true; }
    app._inUndo = false;
  } else A.undo();
};

// clipboard
A.copy = async (merged = false) => {
  const d = app.doc; if (!d) return;
  let canvas, x = 0, y = 0, name;
  if (merged) { canvas = renderFull(d.layers, d.w, d.h); name = 'Merged'; }
  else { const L = d.active; if (!L || L.type !== 'raster' || !L.canvas) { toast('Nothing to copy on this layer.'); return; } canvas = cloneCanvas(L.canvas); x = L.x; y = L.y; name = L.name; }
  app.clip = { canvas, x, y, name };
  try { const blob = await canvasToBlob(canvas); await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); } catch { /* system clipboard is optional */ }
  toast(merged ? 'Copied merged image.' : 'Copied layer.');
};
A.copyMerged = () => A.copy(true);
A.cut = async () => { await A.copy(false); const d = app.doc; if (d && d.active) d.clearLayer(d.active); };
A.paste = async () => {
  const d = app.doc;
  try {
    const items = await navigator.clipboard.read();
    for (const it of items) { const type = it.types.find((t) => t.startsWith('image/')); if (type) { await pasteImageBlob(await it.getType(type)); return; } }
  } catch { /* fall back to the internal clipboard */ }
  if (!app.clip) { toast('Nothing to paste.'); return; }
  if (!d) return;
  const c = cloneCanvas(app.clip.canvas);
  d.addImageLayer(c, app.clip.name, Math.round((d.w - c.width) / 2), Math.round((d.h - c.height) / 2), { historyName: 'Paste' });
};
A.fill = (which) => { const d = app.doc; if (!d || !d.active) return; if (!d.fillLayer(d.active, which === 'fg' ? app.fg : app.bg, 'Fill')) toast('That layer cannot be filled (group or locked).'); };

// image
A.imageSize = async () => {
  const d = app.doc; if (!d) return; const v = await imageSizeDialog(d); if (!v) return;
  if (v.w === d.w && v.h === d.h) return;
  if (!(await confirmMemory(d.estimateBytes() + v.w * v.h * 4 * d.allLayers().length))) return;
  toast('Resizing…', 6000); await new Promise((r) => setTimeout(r, 20));
  d.resizeImage(v.w, v.h, { smooth: v.smooth, sharpen: v.sharpen });
};
A.canvasSize = async () => { const d = app.doc; if (!d) return; const v = await canvasSizeDialog(d); if (!v) return; if (v.w === d.w && v.h === d.h) return; d.resizeCanvas(v.w, v.h, v.ax, v.ay); };
A.rotate = (k) => { const d = app.doc; if (d) d.transformImage(k); };

// layers
A.newLayer = () => { const d = app.doc; if (d) d.newLayer(); };
A.newGroup = () => { const d = app.doc; if (d) d.newLayer({ type: 'group' }); };
A.viaCopy = () => { const d = app.doc; if (d && d.active) d.duplicateLayer(d.active, ''); };
A.duplicateLayer = () => { const d = app.doc; if (d && d.active) d.duplicateLayer(); };
A.deleteLayer = () => { const d = app.doc; if (d && d.active) d.deleteLayer(); };
A.group = () => { const d = app.doc; if (d && d.active) d.group(); };
A.ungroup = () => { const d = app.doc; if (d) d.ungroup(); };
A.arrange = (how) => { const d = app.doc; if (d && d.active) d.arrange(d.active, how); };
A.mergeDown = () => { const d = app.doc; if (d && !d.mergeDown()) toast('Merge Down needs a visible layer with a regular layer directly below it.'); };
A.mergeVisible = () => { const d = app.doc; if (d && !d.mergeVisible()) toast('Merge Visible needs at least two visible layers.'); };
A.flatten = async () => {
  const d = app.doc; if (!d) return;
  const hidden = d.allLayers().some((L) => !L.visible);
  if (hidden && !(await confirmDialog('Hidden layers are discarded when you flatten. Continue?', 'Flatten'))) return;
  if (!d.flatten()) toast('Already flat.');
};

// view / window
A.zoom = (dir) => { if (app.doc) app.vp.stepZoom(dir); };
A.fit = () => { if (app.doc) app.vp.fit(); };
A.actual = () => { if (app.doc) app.vp.zoomTo(1); };
A.toggleGuide = (k, cycle) => {
  if (cycle) { const any = app.prefs.guideCenter || app.prefs.guideThirds || app.prefs.guideSafe; app.prefs.guideCenter = app.prefs.guideSafe = !any; app.prefs.guideThirds = false; }
  else app.prefs[k] = !app.prefs[k];
  app.savePrefs(); app.emit('prefs'); app.vp.drawOverlay();
};
A.togglePanel = (id) => app.dockEls[id].setCollapsed(!app.dockEls[id].classList.contains('collapsed'));
A.togglePanels = () => document.body.classList.toggle('panels-hidden');
A.resetPanels = () => { for (const [id, el] of Object.entries(app.dockEls)) el.setCollapsed(id === 'history'); document.body.classList.remove('panels-hidden'); };
A.setTheme = (t) => applyTheme(t, true);
A.swapColors = () => { const f = app.fg; app.fg = app.bg; app.bg = f; app.savePrefs(); app.emit('color'); };
A.resetColors = () => { app.fg = '#000000'; app.bg = '#ffffff'; app.savePrefs(); app.emit('color'); };
A.prefs = async () => {
  const v = await prefsDialog(app.prefs); if (!v) return;
  Object.assign(app.prefs, v); app.savePrefs();
  for (const d of app.docs) d.hist.limit = v.historyStates;
  app.emit('prefs');
};
A.help = () => helpDialog();
A.install = async () => { const e = app.installEvent; if (!e) return; e.prompt(); await e.userChoice.catch(() => {}); app.installEvent = null; app.emit('install'); };
A.about = async () => {
  const est = await storageEstimate();
  const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : false;
  const body = h('div', { style: 'display:grid;gap:6px' },
    h('div', null, 'Effigies is an offline, ad-free image editor for album covers, lettering and effects. Part of the Abditum suite.'),
    h('div', { class: 'small muted' }, `Version ${APP_VERSION} (stage 1 of 5)`),
    h('div', { class: 'small' }, `Storage: ${persisted ? 'persistent (Chrome will not clear it)' : 'not yet marked persistent — export project files as a backup'}${est ? `, using ${fmtBytes(est.usage || 0)} of ${fmtBytes(est.quota || 0)}` : ''}.`),
    h('div', { class: 'small muted' }, 'Storage names: database effigies-db, cache effigies-cache-<version>, keys effigies.* plus the shared studio.theme.'));
  openDialog({ title: 'About Effigies', body, ok: 'Close', cancel: null });
};

// ───────────── autosave ─────────────
let saveTimer = 0, firstDirty = 0, saveFailedOnce = false;
function scheduleSave(delay = 700) {
  if (!firstDirty) firstDirty = Date.now();
  clearTimeout(saveTimer);
  const wait = Math.max(0, Math.min(delay, 6000 - (Date.now() - firstDirty)));
  saveTimer = setTimeout(doSave, wait);
  if (app.setSaveState) app.setSaveState('Unsaved changes…');
}
async function saveSession() { try { await metaSet('session', { open: app.docs.map((d) => d.id), active: app.doc ? app.doc.id : null }); } catch { /* ignore */ } }
async function doSave() {
  clearTimeout(saveTimer); firstDirty = 0;
  if (app.setSaveState) app.setSaveState('Saving…');
  try {
    for (const d of [...app.docs]) await saveDoc(d);
    await saveSession();
    if (app.setSaveState) app.setSaveState('All changes saved');
    saveFailedOnce = false;
  } catch (e) {
    console.error('autosave failed', e);
    if (app.setSaveState) app.setSaveState('Autosave failed');
    if (!saveFailedOnce) { saveFailedOnce = true; toast('Autosave failed (' + (e && e.name === 'QuotaExceededError' ? 'storage is full' : e.message) + '). Export a project file now to be safe.', 9000); }
  }
}
app.saveNow = doSave;

// ───────────── keyboard ─────────────
let tempFrom = null, keyDownAt = 0;
function isTyping(t) { return t && (t.matches && t.matches('input[type=text],input[type=number],input:not([type]),textarea,select,[contenteditable="true"]')); }
document.addEventListener('keydown', (e) => {
  if (document.querySelector('dialog[open]')) return;
  if (isTyping(e.target)) return;
  const mod = e.ctrlKey || e.metaKey, k = e.key, lk = k.length === 1 ? k.toLowerCase() : k;
  if (k === 'Escape') { closeMenus(); return; }
  if (k === 'Tab') { e.preventDefault(); A.togglePanels(); return; }
  if (k === ' ' && !mod) { e.preventDefault(); if (!e.repeat && app.vp) { app.vp.space = true; app.refreshCursor(); } return; }
  if (mod) {
    const sh = e.shiftKey, alt = e.altKey;
    const map = {
      n: () => (sh ? A.newLayer() : A.newDoc()), o: A.openImage, w: () => A.closeDoc(), s: () => (sh ? A.exportProject() : A.saveNow()),
      z: () => (alt ? A.undo() : sh ? A.redo() : (app.prefs.undoMode === 'cs5' ? A.undoToggle() : A.undo())),
      y: A.redo, j: A.viaCopy, g: () => (sh ? A.ungroup() : A.group()), e: () => (sh ? A.mergeVisible() : A.mergeDown()),
      c: () => A.copy(sh), x: () => A.cut(),
      '=': () => A.zoom(1), '+': () => A.zoom(1), '-': () => A.zoom(-1), _: () => A.zoom(-1), '0': A.fit, '1': A.actual,
      '[': () => A.arrange(sh ? 'back' : 'backward'), ']': () => A.arrange(sh ? 'front' : 'forward'), '{': () => A.arrange('back'), '}': () => A.arrange('front'),
      Backspace: () => A.fill('bg'),
    };
    if (lk === 'v') return; // let the paste event fire
    const fn = map[lk] || map[k];
    if (fn) { e.preventDefault(); fn(); }
    return;
  }
  if (e.altKey && k === 'Backspace') { e.preventDefault(); A.fill('fg'); return; }
  if (e.altKey && e.shiftKey && lk === 'n') { e.preventDefault(); A.newLayer(); return; }
  if (e.altKey && (k === 'Alt')) { if (app.tool.id === 'brush' && !e.repeat) { tempFrom = app.tool.id; app.setTool('eyedropper', { temp: true }); } return; }
  const d = app.doc;
  if (k === '[' || k === ']') { const t = app.tool; if (t.options && t.options.some((o) => o.key === 'size')) { e.preventDefault(); const o = app.opts(t.id, t.defaults); if (e.shiftKey) o.hardness = clamp(o.hardness + (k === ']' ? 10 : -10), 0, 100); else { const f = o.size < 20 ? 1 : o.size < 100 ? 5 : o.size < 400 ? 20 : 50; o.size = clamp(o.size + (k === ']' ? f : -f), 1, 5000); } app.savePrefs(); app.emit('toolopts'); app.vp.drawOverlay(); } return; }
  if (lk === 'x') { A.swapColors(); return; } if (lk === 'd') { A.resetColors(); return; }
  if (/^[0-9]$/.test(k) && d) {
    const pct = k === '0' ? 100 : Number(k) * 10, t = app.tool;
    if (t.id === 'brush' || t.id === 'eraser') { app.opts(t.id, t.defaults).opacity = pct; app.savePrefs(); app.emit('toolopts'); }
    else if (t.id === 'move' && d.active) { const L = d.active, o = L.opacity; L.opacity = pct / 100; d.pushProps('Layer Opacity', [{ layer: L, old: { opacity: o }, now: { opacity: L.opacity } }]); }
    return;
  }
  if (k.startsWith('Arrow') && app.tool.id === 'move' && d) {
    e.preventDefault(); const s = e.shiftKey ? 10 : 1;
    nudge(k === 'ArrowLeft' ? -s : k === 'ArrowRight' ? s : 0, k === 'ArrowUp' ? -s : k === 'ArrowDown' ? s : 0); return;
  }
  const tool = Object.values(app.tools).find((t) => t.key === lk);
  if (tool) {
    e.preventDefault();
    if (e.repeat) return;
    const grp = app.toolGroups && app.toolGroups.get(tool.group);
    let target = tool;
    if (e.shiftKey && grp && grp.length > 1) { const cur = grp.findIndex((t) => t.id === app.tool.id); target = grp[(cur + 1) % grp.length]; }
    tempFrom = app.tool.id; keyDownAt = performance.now(); app.setTool(target.id, { temp: true }); app._tempKey = lk;
  }
});
document.addEventListener('keyup', (e) => {
  const lk = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (lk === ' ') { if (app.vp) { app.vp.space = false; app.refreshCursor(); } return; }
  if (lk === 'Alt' && tempFrom === 'brush' && app.tool.id === 'eyedropper') { app.setTool('brush'); tempFrom = null; return; }
  if (app._tempKey && lk === app._tempKey) {
    const held = performance.now() - keyDownAt; app._tempKey = null;
    if (held > 350 && tempFrom && app.tools[tempFrom]) app.setTool(tempFrom, { temp: true }); // held: temporary, go back
    else if (app.tool) { app.groupCurrent[app.tool.group] = app.tool.id; app.savePrefs(); app.emit('tool', app.tool); }
    tempFrom = null;
  }
});

// ───────────── paste / drop / lifecycle ─────────────
document.addEventListener('paste', async (e) => {
  if (isTyping(e.target) || document.querySelector('dialog[open]')) return;
  const files = [...(e.clipboardData ? e.clipboardData.files : [])].filter((f) => f.type.startsWith('image/'));
  if (files.length) { e.preventDefault(); for (const f of files) await pasteImageBlob(f, 'Pasted'); return; }
  if (app.clip && app.doc) { e.preventDefault(); const c = cloneCanvas(app.clip.canvas); app.doc.addImageLayer(c, app.clip.name, Math.round((app.doc.w - c.width) / 2), Math.round((app.doc.h - c.height) / 2), { historyName: 'Paste' }); }
});
window.addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
window.addEventListener('drop', async (e) => {
  if (!e.dataTransfer || !e.dataTransfer.files.length) return;
  e.preventDefault();
  for (const f of e.dataTransfer.files) { if (/\.(json|effigies)$/i.test(f.name)) await openProjectFile(f); else if (f.type.startsWith('image/')) await openImageFile(f); }
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') { app.flushPending(); doSave(); } });
window.addEventListener('pagehide', () => { app.flushPending(); doSave(); });
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); app.installEvent = e; app.emit('install'); });
window.addEventListener('appinstalled', () => { app.installEvent = null; app.emit('install'); toast('Effigies installed.'); });
window.addEventListener('storage', (e) => { if (e.key === 'studio.theme' && (e.newValue === 'dark' || e.newValue === 'gray' || e.newValue === 'light')) applyTheme(e.newValue === 'dark' ? 'dark' : 'gray', false); });
window.addEventListener('error', (e) => { console.error('Effigies error:', e.message); });

// ───────────── boot ─────────────
async function boot() {
  loadPrefs();
  app.tools = createTools(app);
  app.tool = app.tools[app.prefs.tool] || app.tools.brush;
  app.vp = new Viewport($('#stage'), app);
  const dock = buildDock(app); app.dockEls = dock.panels;
  buildMenus(app); buildAppbar(app); buildToolbox(app); buildOptionsBar(app); buildTabs(app); buildStatusbar(app);
  let t = 'gray'; try { t = localStorage.getItem('studio.theme') === 'dark' ? 'dark' : 'gray'; } catch { /* ignore */ }
  applyTheme(t, false);
  app.refreshCursor();
  $('#empty-new').addEventListener('click', A.newDoc); $('#empty-open').addEventListener('click', A.openImage);
  $('#file-image').addEventListener('change', async (e) => { for (const f of e.target.files) await openImageFile(f); e.target.value = ''; });
  $('#file-project').addEventListener('change', async (e) => { for (const f of e.target.files) await openProjectFile(f); e.target.value = ''; });

  // reopen exactly where she left off
  try {
    const sess = await metaGet('session');
    const stored = await listStoredDocs();
    const ids = [...(sess && sess.open ? sess.open.filter((id) => stored.includes(id)) : []), ...stored.filter((id) => !(sess && sess.open && sess.open.includes(id)))];
    if (ids.length) $('#empty p').textContent = 'Restoring your work…';
    for (const id of ids) { try { const d = await loadDoc(id); if (d) { attach(d); app.docs.push(d); } } catch (err) { console.error('could not restore', id, err); } }
    const active = (sess && sess.active && app.docs.find((d) => d.id === sess.active)) || app.docs[0];
    app.emit('tabs');
    if (active) app.switchDoc(active.id);
    if (ids.length && app.docs.length) toast(`Restored ${app.docs.length} document${app.docs.length === 1 ? '' : 's'}.`);
  } catch (e) { console.error('restore failed', e); }
  if (!app.docs.length) $('#empty p').textContent = 'Offline image editor for album covers, lettering and effects.';
  persistRequest().then((ok) => { app.persisted = ok; });
  if (app.setSaveState) app.setSaveState(app.docs.length ? 'All changes saved' : '');
  app.ready = true;

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('sw registration failed', e));
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) toast('Effigies was updated.', 10000, { label: 'Reload', run: () => location.reload() }); });
  }
}
boot().catch((e) => { console.error(e); alertDialog('Effigies could not start: ' + e.message); });
