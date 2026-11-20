// Editors for adjustment parameters. Used by the Adjustments panel (adjustment layers) and by the Image > Adjustments dialogs.
// buildEditor mutates `params` in place and calls onInput while a control moves and onChange when it is released.
import { h } from './util.js';
import { ADJ, curveLut } from './adjust.js';

const val = (v, step) => (step && step < 1 ? Number(v).toFixed(step < 0.1 ? 2 : 1) : String(Math.round(v)));

function slider({ label, min, max, step = 1, suffix = '' }, get, set, cb) {
  const num = h('input', { type: 'number', min, max, step, value: get(), class: 'adj-num' });
  const rng = h('input', { type: 'range', min, max, step, value: get() });
  const sync = (v) => { rng.value = v; num.value = val(v, step); };
  rng.oninput = () => { set(Number(rng.value)); num.value = val(rng.value, step); cb.input(); };
  rng.onchange = () => cb.change();
  num.onchange = () => { const v = Math.max(min, Math.min(max, Number(num.value) || 0)); set(v); sync(v); cb.input(); cb.change(); };
  const row = h('div', { class: 'adj-row' }, h('label', null, label), rng, h('span', { class: 'adj-val' }, num, suffix));
  row.refresh = () => sync(get());
  return row;
}

function simpleControl(c, params, cb) {
  if (c.type === 'check') {
    const i = h('input', { type: 'checkbox' }); i.checked = !!params[c.key];
    i.onchange = () => { params[c.key] = i.checked; cb.input(); cb.change(); };
    const row = h('label', { class: 'adj-row chk' }, i, ' ' + c.label); row.refresh = () => { i.checked = !!params[c.key]; }; return row;
  }
  if (c.type === 'color') {
    const i = h('input', { type: 'color', value: params[c.key] });
    i.oninput = () => { params[c.key] = i.value; cb.input(); }; i.onchange = () => cb.change();
    const row = h('div', { class: 'adj-row' }, h('label', null, c.label), i); row.refresh = () => { i.value = params[c.key]; }; return row;
  }
  if (c.type === 'select') {
    const s = h('select', null, ...c.choices.map((g) => h('option', { value: g[0] }, g[1])));
    s.value = params[c.key];
    s.onchange = () => { params[c.key] = s.value; cb.input(); cb.change(); };
    const row = h('div', { class: 'adj-row' }, h('label', null, c.label), s); row.refresh = () => { s.value = params[c.key]; }; return row;
  }
  return slider(c, () => params[c.key], (v) => { params[c.key] = v; }, cb);
}

const CH = [['rgb', 'RGB'], ['r', 'Red'], ['g', 'Green'], ['b', 'Blue']];
const CH_COL = { rgb: '#ddd', r: '#e55', g: '#5c5', b: '#58f' };
const chSelect = (cur, on) => {
  const s = h('select', null, ...CH.map((c) => h('option', { value: c[0] }, c[1]))); s.value = cur; s.onchange = () => on(s.value); return s;
};

function levelsEditor(params, cb, ctx) {
  let ch = 'rgb';
  const hist = h('canvas', { class: 'adj-hist', width: 256, height: 60 });
  const draw = () => {
    const g = hist.getContext('2d'); g.clearRect(0, 0, 256, 60); g.fillStyle = '#222'; g.fillRect(0, 0, 256, 60);
    const H = ctx.getHistogram && ctx.getHistogram();
    if (H) {
      const a = ch === 'rgb' ? H.l : H[ch]; let mx = 1; for (let i = 1; i < 255; i++) mx = Math.max(mx, a[i]);
      g.fillStyle = CH_COL[ch] === '#ddd' ? '#999' : CH_COL[ch];
      for (let i = 0; i < 256; i++) g.fillRect(i, 60 - Math.min(60, (a[i] / mx) * 58), 1, 60);
    }
    const c = params[ch]; g.fillStyle = '#000'; g.fillRect(c.ib, 54, 3, 6); g.fillStyle = '#fff'; g.fillRect(c.iw - 2, 54, 3, 6);
  };
  const box = h('div', { class: 'adj-box' });
  let rows = [];
  const build = () => {
    box.innerHTML = ''; rows = [];
    const c = params[ch], mk = (spec, key) => { const r = slider(spec, () => c[key], (v) => { c[key] = v; draw(); }, cb); rows.push(r); box.appendChild(r); };
    mk({ label: 'Input black', min: 0, max: 254 }, 'ib');
    mk({ label: 'Gamma', min: 0.1, max: 9.99, step: 0.01 }, 'g');
    mk({ label: 'Input white', min: 1, max: 255 }, 'iw');
    mk({ label: 'Output black', min: 0, max: 255 }, 'ob');
    mk({ label: 'Output white', min: 0, max: 255 }, 'ow');
    draw();
  };
  build();
  const el = h('div', null, h('div', { class: 'adj-row' }, h('label', null, 'Channel'), chSelect(ch, (v) => { ch = v; build(); })), hist, box);
  el.refresh = () => { rows.forEach((r) => r.refresh()); draw(); };
  return el;
}

function curvesEditor(params, cb) {
  let ch = 'rgb', drag = -1;
  const S = 256, cv = h('canvas', { class: 'adj-curve', width: S, height: S });
  const pts = () => params[ch];
  const draw = () => {
    const g = cv.getContext('2d'); g.fillStyle = '#222'; g.fillRect(0, 0, S, S);
    g.strokeStyle = '#3a3a3a'; g.lineWidth = 1; g.beginPath();
    for (let i = 1; i < 4; i++) { g.moveTo(i * 64 + 0.5, 0); g.lineTo(i * 64 + 0.5, S); g.moveTo(0, i * 64 + 0.5); g.lineTo(S, i * 64 + 0.5); }
    g.stroke(); g.strokeStyle = '#555'; g.beginPath(); g.moveTo(0, S); g.lineTo(S, 0); g.stroke();
    const lut = curveLut(pts()); g.strokeStyle = CH_COL[ch]; g.lineWidth = 2; g.beginPath();
    for (let x = 0; x < S; x++) { const y = S - 1 - lut[x]; x ? g.lineTo(x, y) : g.moveTo(x, y); } g.stroke();
    g.fillStyle = '#fff'; for (const p of pts()) { g.beginPath(); g.arc(p[0], S - 1 - p[1], 4, 0, 7); g.fill(); }
  };
  const at = (e) => { const r = cv.getBoundingClientRect(); return [Math.max(0, Math.min(255, Math.round(((e.clientX - r.left) / r.width) * S))), Math.max(0, Math.min(255, Math.round(255 - ((e.clientY - r.top) / r.height) * S)))]; };
  cv.onpointerdown = (e) => {
    const [x, y] = at(e), P = pts(); cv.setPointerCapture(e.pointerId);
    drag = P.findIndex((p) => Math.hypot(p[0] - x, p[1] - y) < 9);
    if (e.button === 2 || e.altKey) { if (drag > 0 && drag < P.length - 1) { P.splice(drag, 1); cb.input(); cb.change(); } drag = -1; draw(); return; }
    if (drag < 0) { P.push([x, y]); P.sort((a, b) => a[0] - b[0]); drag = P.findIndex((p) => p[0] === x && p[1] === y); cb.input(); }
    draw();
  };
  cv.onpointermove = (e) => {
    if (drag < 0) return;
    const P = pts(), [x, y] = at(e), lo = drag > 0 ? P[drag - 1][0] + 1 : 0, hi = drag < P.length - 1 ? P[drag + 1][0] - 1 : 255;
    P[drag] = [Math.max(lo, Math.min(hi, x)), y]; cb.input(); draw();
  };
  cv.onpointerup = () => { if (drag >= 0) { drag = -1; cb.change(); } };
  cv.oncontextmenu = (e) => e.preventDefault();
  const reset = h('button', { class: 'btn', onclick: () => { params[ch] = [[0, 0], [255, 255]]; draw(); cb.input(); cb.change(); } }, 'Reset channel');
  const el = h('div', null, h('div', { class: 'adj-row' }, h('label', null, 'Channel'), chSelect(ch, (v) => { ch = v; draw(); })), cv, h('div', { class: 'adj-row' }, reset, h('small', null, 'Click to add a point, Alt-click to remove.')));
  draw(); el.refresh = draw; return el;
}

function balanceEditor(params, cb) {
  let tone = 'mid';
  const names = [['Cyan ↔ Red'], ['Magenta ↔ Green'], ['Yellow ↔ Blue']];
  const box = h('div'); let rows = [];
  const build = () => {
    box.innerHTML = ''; rows = names.map((n, i) => { const r = slider({ label: n[0], min: -100, max: 100 }, () => params[tone][i], (v) => { params[tone][i] = v; }, cb); box.appendChild(r); return r; });
  };
  const sel = h('select', null, h('option', { value: 'shadows' }, 'Shadows'), h('option', { value: 'mid' }, 'Midtones'), h('option', { value: 'high' }, 'Highlights'));
  sel.value = tone; sel.onchange = () => { tone = sel.value; build(); };
  const pres = simpleControl({ key: 'preserve', label: 'Preserve luminosity', type: 'check' }, params, cb);
  build();
  const el = h('div', null, h('div', { class: 'adj-row' }, h('label', null, 'Tone'), sel), box, pres);
  el.refresh = () => { rows.forEach((r) => r.refresh()); pres.refresh(); }; return el;
}

function mixerEditor(params, cb) {
  let out = 'r';
  const labels = ['Red', 'Green', 'Blue', 'Constant'];
  const box = h('div'); let rows = [];
  const key = () => (params.mono ? 'gray' : out);
  const build = () => {
    box.innerHTML = ''; rows = labels.map((n, i) => { const r = slider({ label: n, min: i === 3 ? -100 : -200, max: i === 3 ? 100 : 200 }, () => params[key()][i], (v) => { params[key()][i] = v; }, cb); box.appendChild(r); return r; });
  };
  const sel = h('select', null, h('option', { value: 'r' }, 'Output: Red'), h('option', { value: 'g' }, 'Output: Green'), h('option', { value: 'b' }, 'Output: Blue'));
  sel.onchange = () => { out = sel.value; build(); };
  const mono = simpleControl({ key: 'mono', label: 'Monochrome', type: 'check' }, params, { input: () => { sel.disabled = params.mono; build(); cb.input(); }, change: cb.change });
  build();
  const el = h('div', null, mono, h('div', { class: 'adj-row' }, sel), box);
  el.refresh = () => { sel.disabled = params.mono; build(); mono.refresh(); }; return el;
}

const CUSTOM = { levels: levelsEditor, curves: curvesEditor, balance: balanceEditor, mixer: mixerEditor };

export function buildEditor(adjId, params, cb0 = {}) {
  const cb = { input: cb0.onInput || (() => {}), change: cb0.onChange || (() => {}) };
  const ctx = { getHistogram: cb0.getHistogram };
  const root = h('div', { class: 'adj-editor' }), parts = [];
  const def = typeof adjId === 'string' ? ADJ[adjId] : adjId;
  for (const c of def.controls) {
    const el = c.type && CUSTOM[c.type] ? CUSTOM[c.type](params, cb, ctx) : simpleControl(c, params, cb);
    parts.push(el); root.appendChild(el);
  }
  if (!def.controls.length) root.appendChild(h('div', { class: 'adj-row' }, h('small', null, 'This adjustment has no settings.')));
  root.refresh = () => parts.forEach((p) => p.refresh && p.refresh());
  return root;
}
