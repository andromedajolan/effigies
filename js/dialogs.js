// Modal dialogs. Each returns a Promise that resolves to the chosen values, or null when cancelled.
import { h } from './util.js';

export function openDialog({ title, body, ok = 'OK', cancel = 'Cancel', collect, danger = false, width }) {
  return new Promise((resolve) => {
    const dlg = h('dialog', { style: width ? `width:${width}px` : '' });
    const form = h('form', { method: 'dialog' },
      h('div', { class: 'dlg-h' }, title),
      h('div', { class: 'dlg-b' }, body),
      h('div', { class: 'dlg-f' },
        cancel ? h('button', { class: 'btn', value: 'cancel', formnovalidate: true }, cancel) : null,
        h('button', { class: 'btn primary' + (danger ? ' danger' : ''), value: 'ok' }, ok)));
    dlg.append(form);
    dlg.addEventListener('close', () => {
      const good = dlg.returnValue === 'ok';
      let v = null; if (good) { try { v = collect ? collect() : true; } catch (e) { v = null; } }
      dlg.remove(); resolve(v);
    });
    document.body.append(dlg);
    dlg.showModal();
    const first = dlg.querySelector('input, select');
    if (first) { first.focus(); if (first.select) first.select(); }
  });
}

export const confirmDialog = (msg, ok = 'OK', title = 'Effigies') => openDialog({ title, body: h('div', null, msg), ok });
export const alertDialog = (msg, title = 'Effigies') => openDialog({ title, body: h('div', null, msg), ok: 'OK', cancel: null });

const num = (v, min, max, extra = {}) => h('input', { type: 'number', value: v, min, max, step: 1, required: true, ...extra });

export const COVER_PRESETS = [
  ['cover', 'Album cover 3000 × 3000', 3000, 3000],
  ['cover1400', 'Album cover 1400 × 1400', 1400, 1400],
  ['cover4k', 'Album cover 4000 × 4000', 4000, 4000],
  ['story', 'Story / vertical 1080 × 1920', 1080, 1920],
  ['banner', 'Banner 1920 × 1080', 1920, 1080],
  ['custom', 'Custom', 0, 0],
];

export function newDocDialog(defName = 'Untitled') {
  const name = h('input', { type: 'text', value: defName });
  const sel = h('select', null, COVER_PRESETS.map(([id, l]) => h('option', { value: id }, l)));
  const w = num(3000, 1, 10000), hh = num(3000, 1, 10000);
  sel.addEventListener('change', () => { const p = COVER_PRESETS.find((x) => x[0] === sel.value); if (p && p[2]) { w.value = p[2]; hh.value = p[3]; } });
  const mark = () => { const p = COVER_PRESETS.find((x) => x[2] === Number(w.value) && x[3] === Number(hh.value)); sel.value = p ? p[0] : 'custom'; };
  w.addEventListener('input', mark); hh.addEventListener('input', mark);
  const body = h('div', { class: 'dlg-b', style: 'padding:0' },
    h('div', { class: 'fld' }, h('label', null, 'Name'), name),
    h('div', { class: 'fld' }, h('label', null, 'Preset'), sel),
    h('div', { class: 'fld' }, h('label', null, 'Width'), h('span', { class: 'inline' }, w, 'px')),
    h('div', { class: 'fld' }, h('label', null, 'Height'), h('span', { class: 'inline' }, hh, 'px')),
    h('div', { class: 'small muted' }, 'RGB, 8 bit, transparent background.'));
  return openDialog({ title: 'New Document', body, ok: 'Create', collect: () => ({ name: name.value.trim() || 'Untitled', w: Math.round(+w.value), h: Math.round(+hh.value) }) });
}

export function imageSizeDialog(doc) {
  let ratio = doc.w / doc.h, lock = true;
  const w = num(doc.w, 1, 10000), hh = num(doc.h, 1, 10000);
  const link = h('input', { type: 'checkbox', checked: true });
  w.addEventListener('input', () => { if (link.checked) hh.value = Math.max(1, Math.round(w.value / ratio)); });
  hh.addEventListener('input', () => { if (link.checked) w.value = Math.max(1, Math.round(hh.value * ratio)); });
  const method = h('select', null, h('option', { value: 'smooth' }, 'Smooth (best quality)'), h('option', { value: 'nearest' }, 'Nearest neighbor (hard edges)'));
  const sharp = h('input', { type: 'range', min: 0, max: 100, value: 20 });
  const sv = h('span', null, '20%'); sharp.addEventListener('input', () => { sv.textContent = sharp.value + '%'; });
  const body = h('div', { class: 'dlg-b', style: 'padding:0' },
    h('div', { class: 'small muted' }, `Current: ${doc.w} × ${doc.h} px`),
    h('div', { class: 'fld' }, h('label', null, 'Width'), h('span', { class: 'inline' }, w, 'px')),
    h('div', { class: 'fld' }, h('label', null, 'Height'), h('span', { class: 'inline' }, hh, 'px')),
    h('label', { class: 'inline' }, link, 'Constrain proportions'),
    h('div', { class: 'fld' }, h('label', null, 'Resample'), method),
    h('div', { class: 'fld' }, h('label', null, 'Sharpen after enlarging'), h('span', { class: 'inline' }, sharp, sv)));
  return openDialog({ title: 'Image Size', body, collect: () => ({ w: Math.round(+w.value), h: Math.round(+hh.value), smooth: method.value === 'smooth', sharpen: +sharp.value }) });
}

export function canvasSizeDialog(doc) {
  const w = num(doc.w, 1, 10000), hh = num(doc.h, 1, 10000);
  let ax = 1, ay = 1; const btns = [];
  const grid = h('div', { class: 'anchor' });
  for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) {
    const b = h('button', { type: 'button', class: x === 1 && y === 1 ? 'on' : '', onclick: () => { ax = x; ay = y; btns.forEach((q) => q.classList.remove('on')); b.classList.add('on'); } }, x === 1 && y === 1 ? '●' : '');
    btns.push(b); grid.append(b);
  }
  const body = h('div', { class: 'dlg-b', style: 'padding:0' },
    h('div', { class: 'small muted' }, `Current: ${doc.w} × ${doc.h} px. New area is transparent.`),
    h('div', { class: 'fld' }, h('label', null, 'Width'), h('span', { class: 'inline' }, w, 'px')),
    h('div', { class: 'fld' }, h('label', null, 'Height'), h('span', { class: 'inline' }, hh, 'px')),
    h('div', { class: 'fld' }, h('label', null, 'Anchor'), grid));
  return openDialog({ title: 'Canvas Size', body, collect: () => ({ w: Math.round(+w.value), h: Math.round(+hh.value), ax, ay }) });
}

export function exportDialog(doc) {
  const fmt = h('select', null, h('option', { value: 'png' }, 'PNG (lossless, keeps transparency)'), h('option', { value: 'jpg' }, 'JPG (white where transparent)'));
  const q = h('input', { type: 'range', min: 60, max: 100, value: 95 });
  const qv = h('span', null, '95'); q.addEventListener('input', () => { qv.textContent = q.value; });
  const name = h('input', { type: 'text', value: doc.name.replace(/[\\/:*?"<>|]+/g, '_') });
  const body = h('div', { class: 'dlg-b', style: 'padding:0' },
    h('div', { class: 'small muted' }, `Exports the full ${doc.w} × ${doc.h} px image, all visible layers.`),
    h('div', { class: 'fld' }, h('label', null, 'File name'), name),
    h('div', { class: 'fld' }, h('label', null, 'Format'), fmt),
    h('div', { class: 'fld' }, h('label', null, 'JPG quality'), h('span', { class: 'inline' }, q, qv)));
  return openDialog({ title: 'Export Image', body, ok: 'Export', collect: () => ({ format: fmt.value, quality: +q.value / 100, name: name.value.trim() || 'image' }) });
}

export function prefsDialog(prefs) {
  const wheel = h('select', null, h('option', { value: 'zoom' }, 'Zoom at the cursor (Shift = scroll sideways)'), h('option', { value: 'scroll' }, 'Scroll (Ctrl or Alt = zoom)'));
  wheel.value = prefs.wheel;
  const undo = h('select', null, h('option', { value: 'cs5' }, 'CS5: Ctrl+Z toggles undo/redo, Ctrl+Alt+Z steps back'), h('option', { value: 'modern' }, 'Modern: Ctrl+Z steps back, Ctrl+Shift+Z forward'));
  undo.value = prefs.undoMode;
  const states = num(prefs.historyStates, 5, 200);
  const body = h('div', { class: 'dlg-b', style: 'padding:0' },
    h('div', { class: 'fld wide' }, h('label', null, 'Mouse wheel'), wheel),
    h('div', { class: 'fld wide' }, h('label', null, 'Undo shortcuts'), undo),
    h('div', { class: 'fld' }, h('label', null, 'History states'), states),
    h('div', { class: 'small muted' }, 'History also stops early when it passes about 320 MB.'));
  return openDialog({ title: 'Preferences', body, collect: () => ({ wheel: wheel.value, undoMode: undo.value, historyStates: Math.round(+states.value) }) });
}

export function helpDialog() {
  const rows = [
    ['V B E I H Z', 'Move, Brush, Eraser, Eyedropper, Hand, Zoom (hold a letter for a temporary tool, Space = Hand)'],
    ['[  ]', 'Brush size smaller / larger (Shift for hardness)'], ['1 … 0', 'Brush opacity 10% … 100% (Move tool: layer opacity)'],
    ['X   D', 'Swap / reset foreground and background colors'], ['Alt + click (brush)', 'Pick a color'],
    ['Ctrl+N / O / W', 'New, open image, close'], ['Ctrl+Shift+S', 'Export project file'],
    ['Ctrl+Z', 'Undo / redo (CS5) — Ctrl+Alt+Z step back, Ctrl+Shift+Z step forward'],
    ['Ctrl+J', 'Layer via copy'], ['Ctrl+Shift+N', 'New layer'], ['Ctrl+G / Ctrl+Shift+G', 'Group / ungroup'],
    ['Ctrl+E / Ctrl+Shift+E', 'Merge down / merge visible'], ['Ctrl+[ / ]', 'Move layer back / forward (Shift = to back / front)'],
    ['Alt+Backspace / Ctrl+Backspace', 'Fill with foreground / background'],
    ['Ctrl + + / − / 0 / 1', 'Zoom in / out / fit / 100%'], ['Tab', 'Hide / show all panels'], ['Arrow keys (Move)', 'Nudge 1 px (Shift = 10 px)'],
    ['Ctrl+C / X / V', 'Copy / cut / paste a layer (also pastes images from other apps)'],
  ];
  const body = h('table', { class: 'keys' }, rows.map(([k, d]) => h('tr', null, h('td', null, h('span', { class: 'kbd' }, k)), h('td', null, d))));
  return openDialog({ title: 'Keyboard shortcuts', body, ok: 'Close', cancel: null, width: 560 });
}
