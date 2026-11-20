// Layer Style dialog: effect list on the left (tick to enable), settings on the right, live preview on the canvas.
import { h, toast } from './util.js';
import { curveLut } from './adjust.js';
import { CONTOURS, contourById } from './contours.js';
import { listPatterns, getTile, importPat, deletePattern, patternInfo } from './patterns.js';
import { STYLE_ORDER, STYLE_NAMES, STYLE_DEFS, STYLE_BLENDS, cloneStyles } from './styles.js';
import { GRADIENTS } from './gradients.js';
import { openDialog } from './dialogs.js';

function contourControl(label, p, key, onInput) {
  const S = 120, cv = h('canvas', { class: 'adj-curve ctr', width: S, height: S }), pts = () => p[key];
  const sel = h('select', null, ...CONTOURS.map((c) => h('option', { value: c[0] }, c[1])), h('option', { value: 'custom' }, 'Custom'));
  const guess = () => { const j = JSON.stringify(pts()); const m = CONTOURS.find((c) => JSON.stringify(c[2]) === j); return m ? m[0] : 'custom'; };
  sel.value = guess();
  let drag = -1;
  const draw = () => {
    const g = cv.getContext('2d'); g.fillStyle = '#222'; g.fillRect(0, 0, S, S); g.strokeStyle = '#444'; g.beginPath();
    for (let i = 1; i < 4; i++) { g.moveTo(i * S / 4 + 0.5, 0); g.lineTo(i * S / 4 + 0.5, S); g.moveTo(0, i * S / 4 + 0.5); g.lineTo(S, i * S / 4 + 0.5); } g.stroke();
    const lut = curveLut(pts()); g.strokeStyle = '#ddd'; g.lineWidth = 2; g.beginPath();
    for (let x = 0; x < S; x++) { const y = S - 1 - (lut[Math.round(x * 255 / (S - 1))] * (S - 1)) / 255; x ? g.lineTo(x, y) : g.moveTo(x, y); } g.stroke();
    g.fillStyle = '#fff'; for (const q of pts()) { g.beginPath(); g.arc(q[0] * (S - 1) / 255, S - 1 - q[1] * (S - 1) / 255, 3.5, 0, 7); g.fill(); }
  };
  const at = (e) => { const r = cv.getBoundingClientRect(); return [Math.max(0, Math.min(255, Math.round(((e.clientX - r.left) / r.width) * 255))), Math.max(0, Math.min(255, Math.round(255 - ((e.clientY - r.top) / r.height) * 255)))]; };
  cv.onpointerdown = (e) => {
    const [x, y] = at(e), P = pts(); cv.setPointerCapture(e.pointerId);
    drag = P.findIndex((q) => Math.hypot(q[0] - x, q[1] - y) < 16);
    if (e.button === 2 || e.altKey) { if (drag > 0 && drag < P.length - 1) { P.splice(drag, 1); sel.value = 'custom'; onInput(); } drag = -1; draw(); return; }
    if (drag < 0) { P.push([x, y]); P.sort((u, v) => u[0] - v[0]); drag = P.findIndex((q) => q[0] === x && q[1] === y); sel.value = 'custom'; onInput(); }
    draw();
  };
  cv.onpointermove = (e) => {
    if (drag < 0) return; const P = pts(), [x, y] = at(e), lo = drag > 0 ? P[drag - 1][0] + 1 : 0, hi = drag < P.length - 1 ? P[drag + 1][0] - 1 : 255;
    P[drag] = [Math.max(lo, Math.min(hi, x)), y]; sel.value = 'custom'; onInput(); draw();
  };
  cv.onpointerup = () => { drag = -1; }; cv.oncontextmenu = (e) => e.preventDefault();
  sel.onchange = () => { if (sel.value !== 'custom') { p[key] = contourById(sel.value); onInput(); draw(); } };
  draw();
  return h('div', { class: 'adj-row ctr-row' }, h('label', null, label), h('div', null, cv, sel, h('div', null, h('small', null, 'Click to add a point, Alt-click removes.'))));
}

function patternControl(app, p, key, onInput) {
  const wrap = h('div', { class: 'pat-ui' }), grid = h('div', { class: 'pat-grid' }), msg = h('div', { class: 'adj-hint' });
  const file = h('input', { type: 'file', accept: '.pat', multiple: true, style: 'display:none' });
  const imp = h('button', { class: 'btn', type: 'button', onclick: () => file.click() }, 'Import .pat…');
  const del = h('button', { class: 'btn', type: 'button' }, 'Delete pattern'); let armed = 0;
  const thumb = (info) => {
    const c = h('canvas', { width: 44, height: 44, class: 'pat-th' + (info.id === p[key] ? ' sel' : ''), title: `${info.name} (${info.w}×${info.h})` });
    const t = getTile(info.id), g = c.getContext('2d');
    g.fillStyle = '#555'; g.fillRect(0, 0, 44, 44);
    if (t) { const k = Math.max(44 / t.width, 44 / t.height); g.drawImage(t, 0, 0, Math.min(t.width, 44 / k), Math.min(t.height, 44 / k), 0, 0, Math.min(44, t.width * k), Math.min(44, t.height * k)); }
    c.onclick = () => { p[key] = info.id; onInput(); draw(); };
    return c;
  };
  const draw = () => {
    grid.textContent = ''; let last = null;
    for (const info of listPatterns()) {
      if (info.set !== last) { grid.append(h('div', { class: 'font-cat pat-set' }, info.set)); last = info.set; }
      grid.append(thumb(info));
    }
    const cur = patternInfo(p[key]); del.disabled = !cur || cur.builtin; del.textContent = 'Delete pattern'; armed = 0;
    msg.textContent = cur ? `${cur.name} — ${cur.w}×${cur.h}px` : 'Pick a pattern';
  };
  del.onclick = async () => {
    if (!armed) { armed = 1; del.textContent = 'Click again to delete'; setTimeout(() => { armed = 0; del.textContent = 'Delete pattern'; }, 3000); return; }
    await deletePattern(p[key]); p[key] = 'b-dots'; onInput(); draw(); toast('Pattern deleted from the library.');
  };
  file.onchange = async () => {
    let added = 0, skipped = 0;
    for (const f of file.files) {
      try { const r = await importPat(await f.arrayBuffer(), f.name.replace(/\.pat$/i, '')); added += r.added + r.replaced; skipped += r.skipped.length; }
      catch (e) { toast(f.name + ': ' + e.message); }
    }
    file.value = ''; draw(); if (added) toast(`Imported ${added} pattern${added === 1 ? '' : 's'}${skipped ? ` (${skipped} skipped: not RGB, grayscale or indexed)` : ''}.`);
  };
  wrap.pending = draw; draw();
  wrap.append(grid, msg, h('div', { class: 'adj-row' }, imp, del), file);
  app.on('patterns', () => { if (wrap.isConnected) draw(); });
  return h('div', { class: 'adj-row ctr-row' }, h('label', null, 'Pattern'), wrap);
}

function control(def, p, onInput, app) {
  const [key, label, a, b, c] = def;
  if (a === 'contour') return contourControl(label, p, key, onInput);
  if (a === 'pattern') return patternControl(app, p, key, onInput);
  if (a === 'color') { const i = h('input', { type: 'color', value: p[key] }); i.oninput = () => { p[key] = i.value; onInput(); }; return h('div', { class: 'adj-row' }, h('label', null, label), i); }
  if (a === 'blend' || a === 'select' || a === 'gradient') {
    const ch = a === 'blend' ? STYLE_BLENDS : a === 'gradient' ? GRADIENTS.filter((g) => g[0] !== 'fgt') : b;
    const s = h('select', null, ...ch.map((x) => h('option', { value: x[0] }, x[1]))); s.value = p[key];
    s.onchange = () => { p[key] = s.value; onInput(); return; };
    return h('div', { class: 'adj-row' }, h('label', null, label), s);
  }
  if (a === 'check') { const i = h('input', { type: 'checkbox' }); i.checked = !!p[key]; i.onchange = () => { p[key] = i.checked; onInput(); }; return h('label', { class: 'adj-row chk' }, i, ' ' + label); }
  const step = key === 'lineHeight' ? 0.05 : 1;
  const rng = h('input', { type: 'range', min: a, max: b, step, value: p[key] }), num = h('input', { type: 'number', min: a, max: b, step, value: p[key], class: 'adj-num' });
  rng.oninput = () => { p[key] = Number(rng.value); num.value = rng.value; onInput(); };
  num.onchange = () => { const v = Math.max(a, Math.min(b, Number(num.value) || 0)); p[key] = v; rng.value = v; num.value = v; onInput(); };
  return h('div', { class: 'adj-row' }, h('label', null, label), rng, h('span', { class: 'adj-val' }, num, c || ''));
}

export async function openStyleDialog(app, L, focus) {
  const d = app.doc, original = cloneStyles(L.styles), work = cloneStyles(L.styles) || {};
  let cur = focus && STYLE_DEFS[focus] ? focus : (STYLE_ORDER.find((k) => work[k] && work[k].on) || 'dropShadow');
  const live = () => { L.styles = cloneStyles(work); L.touch(); app.vp.invalidate(); };
  const list = h('div', { class: 'ls-list', role: 'listbox' }), pane = h('div', { class: 'ls-pane' });
  const ensure = (k) => { if (!work[k]) { work[k] = { on: false, ...STYLE_DEFS[k].defaults() }; if (k === 'gradientOverlay') { work[k].fg = app.fg; work[k].bg = app.bg; } } return work[k]; };
  const drawList = () => {
    list.textContent = '';
    for (const k of STYLE_ORDER) {
      const on = !!(work[k] && work[k].on), chk = h('input', { type: 'checkbox', 'aria-label': STYLE_NAMES[k] + ' on' }); chk.checked = on;
      chk.onclick = (e) => e.stopPropagation();
      chk.onchange = () => { ensure(k).on = chk.checked; cur = k; live(); drawList(); drawPane(); };
      const it = h('div', { class: 'ls-item' + (k === cur ? ' sel' : ''), role: 'option', onclick: () => { cur = k; drawList(); drawPane(); } }, chk, STYLE_NAMES[k]);
      list.append(it);
    }
  };
  const drawPane = () => {
    pane.textContent = ''; const p = ensure(cur);
    pane.append(h('h4', null, STYLE_NAMES[cur]));
    const en = h('label', { class: 'adj-row chk' }, '', ' Enabled'); const ei = h('input', { type: 'checkbox' }); ei.checked = !!p.on; en.prepend(ei);
    ei.onchange = () => { p.on = ei.checked; live(); drawList(); };
    pane.append(en);
    for (const c of STYLE_DEFS[cur].controls) pane.append(control(c, p, () => { if (!p.on) { p.on = true; ei.checked = true; drawList(); } live(); }, app));
  };
  drawList(); drawPane();
  const reset = h('button', { class: 'btn', onclick: () => { const k = cur, on = ensure(k).on; work[k] = { on, ...STYLE_DEFS[k].defaults() }; if (k === 'gradientOverlay') { work[k].fg = app.fg; work[k].bg = app.bg; } live(); drawPane(); } }, 'Reset effect');
  const body = h('div', { class: 'ls-dialog' }, list, h('div', { style: 'flex:1;min-width:0' }, pane, h('div', { class: 'adj-row' }, reset)));
  const ok = await openDialog({ title: 'Layer Style — ' + L.name, body, ok: 'OK', width: 620, collect: () => true });
  L.styles = cloneStyles(original); L.touch();
  if (ok) {
    const out = {}; for (const k of STYLE_ORDER) if (work[k] && work[k].on) out[k] = work[k];
    d.setStyles(L, Object.keys(out).length ? out : null);
  }
  app.vp.invalidate();
}
