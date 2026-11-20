// Layer Style dialog: effect list on the left (tick to enable), settings on the right, live preview on the canvas.
import { h } from './util.js';
import { STYLE_ORDER, STYLE_NAMES, STYLE_DEFS, STYLE_BLENDS, cloneStyles } from './styles.js';
import { GRADIENTS } from './gradients.js';
import { openDialog } from './dialogs.js';

function control(def, p, onInput) {
  const [key, label, a, b, c] = def;
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
    for (const c of STYLE_DEFS[cur].controls) pane.append(control(c, p, () => { if (!p.on) { p.on = true; ei.checked = true; drawList(); } live(); }));
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
