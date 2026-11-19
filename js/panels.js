// Right-hand dock: Color / Swatches, Preview, Layers, History.
import { h, clamp, debounce, hexToRgb, rgbToHex, rgbToHsv, hsvToRgb, fmtBytes, ctxOf, makeCanvas, toast } from './util.js';
import { BLEND_GROUPS } from './blend.js';
import { compose, releaseCanvas } from './render.js';

const DEFAULT_SWATCHES = ['#000000', '#1a1a1a', '#333333', '#4d4d4d', '#666666', '#808080', '#999999', '#b3b3b3', '#cccccc', '#e6e6e6', '#ffffff',
  '#ff0000', '#ff4d00', '#ff8000', '#ffbf00', '#ffff00', '#bfff00', '#80ff00', '#00ff00', '#00ff80', '#00ffbf', '#00ffff', '#00bfff', '#0080ff', '#0000ff', '#4000ff', '#8000ff', '#bf00ff', '#ff00ff', '#ff0080',
  '#7a0a0a', '#c1272d', '#e8590c', '#f59f00', '#fff3b0', '#0b1d3a', '#12408f', '#1e6fd9', '#5cc8ff', '#c9f1ff', '#2b0a3d', '#6a1b9a', '#b44cff', '#ff7bd5', '#3b2a1a', '#8d6e4a', '#d9b98c', '#f3e5d0'];

function panel(id, title, { grow = false, head, body, collapsed = false }, app) {
  const el = h('section', { class: 'panel' + (grow ? ' grow' : ''), id: 'panel-' + id });
  const caret = h('span', { class: 'caret' });
  const hd = h('div', { class: 'panel-head' }, caret, h('span', null, title), head || null, h('span', { class: 'sp' }));
  const bd = h('div', { class: 'panel-body' }, body);
  el.append(hd, bd);
  const set = (c) => { el.classList.toggle('collapsed', c); caret.textContent = c ? '▸' : '▾'; app.prefs.panels[id] = c; app.savePrefs(); };
  hd.addEventListener('dblclick', (e) => { if (e.target.closest('button')) return; set(!el.classList.contains('collapsed')); });
  caret.addEventListener('click', () => set(!el.classList.contains('collapsed')));
  caret.style.cursor = 'pointer';
  set(app.prefs.panels[id] === undefined ? collapsed : !!app.prefs.panels[id]);
  el.setCollapsed = set;
  return { el, hd, bd };
}

// ───────────── Color ─────────────
function colorPanel(app) {
  const sv = h('canvas', { width: 256, height: 128 }), hue = h('canvas', { class: 'hue', width: 22, height: 128 });
  const hex = h('input', { type: 'text', value: '#000000', maxlength: 7, style: 'width:100%' });
  const rgb = ['R', 'G', 'B'].map((c) => h('input', { type: 'number', min: 0, max: 255, 'aria-label': c }));
  const chipF = h('button', { class: 'btn small', onclick: () => app.setColorTarget('fg') }, 'Foreground');
  const chipB = h('button', { class: 'btn small', onclick: () => app.setColorTarget('bg') }, 'Background');
  let hsv = [0, 0, 0];
  const cur = () => (app.colorTarget === 'fg' ? app.fg : app.bg);
  const apply = (col) => (app.colorTarget === 'fg' ? app.setFg(col, true) : app.setBg(col, true));
  function drawHue() {
    const g = hue.getContext('2d'), gr = g.createLinearGradient(0, 0, 0, 128);
    for (let i = 0; i <= 6; i++) gr.addColorStop(i / 6, `hsl(${i * 60},100%,50%)`);
    g.fillStyle = gr; g.fillRect(0, 0, 22, 128);
    const y = (hsv[0] / 360) * 127; g.strokeStyle = '#000'; g.strokeRect(0, y - 1.5, 22, 3); g.strokeStyle = '#fff'; g.strokeRect(1, y - 0.5, 20, 1);
  }
  function drawSV() {
    const g = sv.getContext('2d'), W = 256, H = 128;
    g.fillStyle = `hsl(${hsv[0]},100%,50%)`; g.fillRect(0, 0, W, H);
    let gr = g.createLinearGradient(0, 0, W, 0); gr.addColorStop(0, '#fff'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, W, H);
    gr = g.createLinearGradient(0, 0, 0, H); gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, '#000'); g.fillStyle = gr; g.fillRect(0, 0, W, H);
    const x = hsv[1] * (W - 1), y = (1 - hsv[2]) * (H - 1);
    g.lineWidth = 2; g.strokeStyle = '#000'; g.beginPath(); g.arc(x, y, 6, 0, 6.3); g.stroke(); g.strokeStyle = '#fff'; g.lineWidth = 1; g.beginPath(); g.arc(x, y, 6, 0, 6.3); g.stroke();
  }
  function sync(fromHsv) {
    const col = cur(); const [r, g, b] = hexToRgb(col);
    if (!fromHsv) { const n = rgbToHsv(r, g, b); hsv = [n[1] === 0 || n[2] === 0 ? hsv[0] : n[0], n[1], n[2]]; }
    hex.value = col; rgb[0].value = r; rgb[1].value = g; rgb[2].value = b;
    chipF.classList.toggle('on', app.colorTarget === 'fg'); chipB.classList.toggle('on', app.colorTarget === 'bg');
    drawSV(); drawHue();
  }
  function fromHsv() { const [r, g, b] = hsvToRgb(...hsv); apply(rgbToHex(r, g, b)); sync(true); }
  const drag = (el, fn) => {
    el.addEventListener('pointerdown', (e) => { el.setPointerCapture(e.pointerId); fn(e); const mv = (ev) => fn(ev); const up = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); }; el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up); });
  };
  drag(sv, (e) => { const r = sv.getBoundingClientRect(); hsv[1] = clamp((e.clientX - r.left) / r.width, 0, 1); hsv[2] = 1 - clamp((e.clientY - r.top) / r.height, 0, 1); fromHsv(); });
  drag(hue, (e) => { const r = hue.getBoundingClientRect(); hsv[0] = clamp((e.clientY - r.top) / r.height, 0, 0.999) * 360; fromHsv(); });
  hex.addEventListener('change', () => { if (/^#?[0-9a-f]{6}$/i.test(hex.value.trim())) { apply('#' + hex.value.trim().replace('#', '').toLowerCase()); sync(); } else sync(); });
  rgb.forEach((i) => i.addEventListener('change', () => { apply(rgbToHex(...rgb.map((x) => clamp(+x.value || 0, 0, 255)))); sync(); }));
  const body = h('div', null, h('div', { style: 'display:flex;gap:6px;margin-bottom:6px' }, chipF, chipB),
    h('div', { class: 'cp' }, sv, hue),
    h('div', { class: 'cp-rgb' }, ...['R', 'G', 'B'].map((c, i) => h('label', null, c, rgb[i])), h('label', null, 'Hex', hex)));
  app.on('color', () => sync());
  sync();
  return body;
}

function swatchesPanel(app) {
  const wrap = h('div', { class: 'swatches' });
  const custom = () => { try { return JSON.parse(localStorage.getItem('effigies.swatches') || '[]'); } catch { return []; } };
  function render() {
    wrap.textContent = '';
    const all = [...DEFAULT_SWATCHES.map((c) => ({ c })), ...custom().map((c, i) => ({ c, i }))];
    for (const s of all) {
      const b = h('div', { class: 's', style: `background:${s.c}`, title: s.c + (s.i !== undefined ? ' (Shift-click removes)' : '') });
      b.addEventListener('click', (e) => {
        if (s.i !== undefined && e.shiftKey) { const l = custom(); l.splice(s.i, 1); localStorage.setItem('effigies.swatches', JSON.stringify(l)); render(); return; }
        if (e.altKey) app.setBg(s.c); else app.setFg(s.c);
      });
      wrap.append(b);
    }
  }
  const add = h('button', { class: 'btn small', onclick: () => { const l = custom(); if (!l.includes(app.fg)) l.push(app.fg); localStorage.setItem('effigies.swatches', JSON.stringify(l.slice(-60))); render(); } }, 'Add foreground color');
  render();
  return h('div', null, wrap, h('div', { style: 'margin-top:6px' }, add), h('div', { class: 'small muted', style: 'margin-top:4px' }, 'Click = foreground, Alt-click = background.'));
}

// ───────────── Preview ─────────────
function previewPanel(app) {
  const big = h('canvas', { width: 96, height: 96 }), mid = h('canvas', { width: 64, height: 64 }), sm = h('canvas', { width: 32, height: 32 });
  const draw = () => {
    const d = app.doc; if (!d) return;
    for (const [c, size] of [[big, 96], [mid, 56], [sm, 28]]) {
      const s = Math.min(size / d.w, size / d.h), w = Math.max(1, Math.round(d.w * s)), hh = Math.max(1, Math.round(d.h * s));
      c.width = w; c.height = hh;
      const out = compose(d.layers, { zoom: s, tx: 0, ty: 0 }, w, hh);
      const g = c.getContext('2d'); g.clearRect(0, 0, w, hh); g.drawImage(out, 0, 0); releaseCanvas(out);
    }
  };
  const later = debounce(draw, 350);
  app.on('rendered', later); app.on('doc', later);
  return h('div', null, h('div', { class: 'pv' }, big, h('div', { style: 'display:grid;gap:6px' }, mid, sm)), h('div', { class: 'small muted', style: 'margin-top:3px' }, 'Phone-size preview of the whole cover.'));
}

// ───────────── Layers ─────────────
function layersPanel(app) {
  const blendSel = h('select', { 'aria-label': 'Blend mode' }, h('option', { value: 'pass' }, 'Pass Through'),
    BLEND_GROUPS.map((g) => h('optgroup', { label: '' }, g.map(([id, l]) => h('option', { value: id }, l)))));
  const op = h('input', { type: 'range', min: 0, max: 100, value: 100 }), opN = h('input', { type: 'number', min: 0, max: 100, value: 100 });
  const fl = h('input', { type: 'range', min: 0, max: 100, value: 100 }), flN = h('input', { type: 'number', min: 0, max: 100, value: 100 });
  const lockDefs = [['lockTrans', '▨', 'Lock transparent pixels'], ['lockPix', '✎', 'Lock image pixels'], ['lockPos', '✥', 'Lock position'], ['lockAll', '🔒', 'Lock all']];
  const lockBtns = lockDefs.map(([k, ch, t]) => h('button', { class: 'lock-btn', title: t, 'aria-label': t, 'aria-pressed': 'false', onclick: () => toggleLock(k, t) }, ch));
  const list = h('div', { id: 'layer-list', tabindex: 0, role: 'listbox', 'aria-label': 'Layers' });
  const thumbs = new Map();
  let editing = false;

  const L = () => app.doc && app.doc.active;
  const setProp = (props, name) => {
    const l = L(); if (!l) return;
    const old = {}; for (const k of Object.keys(props)) old[k] = l[k];
    Object.assign(l, props);
    app.doc.pushProps(name, [{ layer: l, old, now: { ...props } }]);
  };
  function toggleLock(k, t) { const l = L(); if (!l) return; setProp({ [k]: !l[k] }, (l[k] ? 'Unlock' : 'Lock') + ' Layer'); }

  // sliders: live while dragging, one history entry on release
  function sliderPair(range, numIn, key, label) {
    let old = null;
    const live = (v) => { const l = L(); if (!l) return; if (!old) old = l[key]; l[key] = clamp(v, 0, 100) / 100; range.value = numIn.value = Math.round(l[key] * 100); app.doc.changed({ tree: false, props: true }); };
    const commit = () => { const l = L(); if (l && old !== null && old !== l[key]) app.doc.pushProps(label, [{ layer: l, old: { [key]: old }, now: { [key]: l[key] } }]); old = null; };
    range.addEventListener('input', () => live(+range.value)); range.addEventListener('change', commit);
    numIn.addEventListener('input', () => live(+numIn.value)); numIn.addEventListener('change', commit);
  }
  sliderPair(op, opN, 'opacity', 'Layer Opacity'); sliderPair(fl, flN, 'fill', 'Layer Fill');
  blendSel.addEventListener('change', () => setProp({ blend: blendSel.value }, 'Layer Blend Mode'));

  function thumbFor(l, d) {
    const key = l.id; let t = thumbs.get(key);
    if (t && t.ver === l.ver && t.w === d.w && t.h === d.h) return t.canvas;
    const w = d.w >= d.h ? 34 : Math.max(8, Math.round(34 * d.w / d.h)), hh = d.h > d.w ? 30 : Math.max(8, Math.round(30 * d.h / d.w));
    const c = t ? t.canvas : makeCanvas(w, hh, false); c.width = w; c.height = hh;
    const g = c.getContext('2d'); g.clearRect(0, 0, w, hh);
    if (l.canvas) { const s = w / d.w; g.imageSmoothingQuality = 'high'; g.drawImage(l.canvas, l.x * s, l.y * s, l.w * s, l.h * s); }
    thumbs.set(key, { ver: l.ver, canvas: c, w: d.w, h: d.h });
    return c;
  }

  function dropZone(e, row, l) {
    const r = row.getBoundingClientRect(), f = (e.clientY - r.top) / r.height;
    if (l.type === 'group' && f > 0.28 && f < 0.72) return 'into';
    return f < 0.5 ? 'above' : 'below';
  }
  function buildRow(l, depth, d) {
    const row = h('div', { class: 'lrow' + (l.id === d.activeId ? ' sel' : '') + (l.visible ? '' : ' hid'), draggable: 'true', role: 'option', 'aria-selected': l.id === d.activeId ? 'true' : 'false', style: `padding-left:${4 + depth * 14}px`, 'data-id': l.id });
    const twist = h('span', { class: 'twist' }, l.type === 'group' ? (l.collapsed ? '▸' : '▾') : '');
    twist.addEventListener('click', (e) => { e.stopPropagation(); l.collapsed = !l.collapsed; refresh(); });
    const eye = h('button', { class: 'eye', title: 'Show / hide (Alt-click: only this one)', 'aria-label': 'Toggle visibility' }, l.visible ? '👁' : '·');
    eye.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.altKey) {
        const all = d.allLayers().filter((x) => x !== l); const only = all.every((x) => !x.visible) && l.visible;
        const entries = [];
        for (const x of all) { const nv = only; if (x.visible !== nv) entries.push({ layer: x, old: { visible: x.visible }, now: { visible: nv } }); x.visible = nv; }
        if (!l.visible) { entries.push({ layer: l, old: { visible: false }, now: { visible: true } }); l.visible = true; }
        if (entries.length) d.pushProps('Show/Hide Layers', entries);
      } else { const o = l.visible; l.visible = !o; d.pushProps(o ? 'Hide Layer' : 'Show Layer', [{ layer: l, old: { visible: o }, now: { visible: !o } }]); }
    });
    const th = l.type === 'group' ? h('div', { class: 'thumb grp' }, '📁') : h('div', { class: 'thumb' }, thumbFor(l, d));
    const nm = h('div', { class: 'nm', title: l.name }, l.name);
    nm.addEventListener('dblclick', (e) => { e.stopPropagation(); rename(l, nm); });
    const lk = h('span', { class: 'lk' }, [l.lockAll && '🔒', !l.lockAll && l.lockTrans && '▨', !l.lockAll && l.lockPix && '✎', !l.lockAll && l.lockPos && '✥'].filter(Boolean).join(''));
    row.append(twist, eye, th, nm, lk);
    row.addEventListener('click', () => { if (d.activeId !== l.id) { d.activeId = l.id; d.changed({ skipRender: true, tree: true }); } });
    row.addEventListener('dragstart', (e) => { e.dataTransfer.setData('application/x-effigies-layer', JSON.stringify({ docId: d.id, layerId: l.id })); e.dataTransfer.effectAllowed = 'copyMove'; });
    row.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes('application/x-effigies-layer')) return;
      e.preventDefault(); const z = dropZone(e, row, l);
      row.classList.toggle('dropabove', z === 'above'); row.classList.toggle('dropbelow', z === 'below'); row.classList.toggle('dropinto', z === 'into');
    });
    row.addEventListener('dragleave', () => row.classList.remove('dropabove', 'dropbelow', 'dropinto'));
    row.addEventListener('drop', (e) => {
      e.preventDefault(); const z = dropZone(e, row, l); row.classList.remove('dropabove', 'dropbelow', 'dropinto');
      let data; try { data = JSON.parse(e.dataTransfer.getData('application/x-effigies-layer')); } catch { return; }
      if (data.docId !== d.id) return;
      const src = d.find(data.layerId); if (!src || src === l) return;
      const n = d.findNode(l.id);
      if (z === 'into') d.moveTo(src, l.children, l.children.length);
      else d.moveTo(src, n.list, z === 'above' ? n.index + 1 : n.index);
    });
    return row;
  }
  function rename(l, nm) {
    editing = true;
    const inp = h('input', { type: 'text', value: l.name });
    nm.textContent = ''; nm.append(inp); inp.focus(); inp.select();
    const done = (ok) => { if (!editing) return; editing = false; const v = inp.value.trim(); if (ok && v && v !== l.name) { const o = l.name; l.name = v; app.doc.pushProps('Rename Layer', [{ layer: l, old: { name: o }, now: { name: v } }]); } else refresh(); };
    inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') done(true); else if (e.key === 'Escape') done(false); });
    inp.addEventListener('blur', () => done(true));
  }
  function refresh() {
    if (editing) return;
    const d = app.doc;
    list.textContent = '';
    if (!d) { for (const el of [blendSel, op, opN, fl, flN, ...lockBtns]) el.disabled = true; return; }
    const walk = (arr, depth) => { for (let i = arr.length - 1; i >= 0; i--) { list.append(buildRow(arr[i], depth, d)); if (arr[i].type === 'group' && !arr[i].collapsed) walk(arr[i].children, depth + 1); } };
    walk(d.layers, 0);
    const alive = new Set(d.allLayers().map((x) => x.id)); for (const k of thumbs.keys()) if (!alive.has(k)) thumbs.delete(k);
    const l = d.active; const dis = !l;
    for (const el of [blendSel, op, opN, fl, flN, ...lockBtns]) el.disabled = dis;
    if (l) {
      const isG = l.type === 'group';
      [...blendSel.options].forEach((o) => { if (o.value === 'pass') o.hidden = !isG; });
      blendSel.value = l.blend;
      if (document.activeElement !== op && document.activeElement !== opN) op.value = opN.value = Math.round(l.opacity * 100);
      if (document.activeElement !== fl && document.activeElement !== flN) fl.value = flN.value = Math.round(l.fill * 100);
      fl.disabled = flN.disabled = isG;
      lockDefs.forEach(([k], i) => { lockBtns[i].classList.toggle('on', !!l[k]); lockBtns[i].setAttribute('aria-pressed', String(!!l[k])); });
    }
    const sel = list.querySelector('.sel'); if (sel) { const t = sel.offsetTop, b = t + sel.offsetHeight; if (t < list.scrollTop) list.scrollTop = t; else if (b > list.scrollTop + list.clientHeight) list.scrollTop = b - list.clientHeight; }
  }
  list.addEventListener('keydown', (e) => { if ((e.key === 'Delete' || e.key === 'Backspace') && app.doc && app.doc.active) { e.preventDefault(); app.doc.deleteLayer(); } });

  const foot = h('div', { class: 'lay-foot' },
    h('button', { class: 'btn icon', title: 'New group', 'aria-label': 'New group', onclick: () => app.doc && app.doc.newLayer({ type: 'group' }) }, '📁'),
    h('button', { class: 'btn icon', title: 'New layer (Ctrl+Shift+N)', 'aria-label': 'New layer', onclick: () => app.newLayer() }, '＋'),
    h('button', { class: 'btn icon', title: 'Delete layer', 'aria-label': 'Delete layer', onclick: () => app.doc && app.doc.deleteLayer() }, '🗑'));
  const body = h('div', { style: 'display:flex;flex-direction:column;min-height:0;flex:1' },
    h('div', { class: 'lay-ctl' }, h('div', { class: 'full' }, blendSel),
      h('div', { class: 'lay-row2 full' }, h('span', { class: 'lbl' }, 'Opacity'), op, h('span', { class: 'pct' }, opN, '%')),
      h('div', { class: 'lay-row2 full' }, h('span', { class: 'lbl' }, 'Fill'), fl, h('span', { class: 'pct' }, flN, '%')),
      h('div', { class: 'lay-row2 full' }, h('span', { class: 'lbl' }, 'Lock'), ...lockBtns)),
    list, foot);
  app.on('docchange', (info) => { if (!info || !info.rect || info.tree || info.layerId) refresh(); });
  app.on('doc', refresh);
  return { body, refresh };
}

// ───────────── History ─────────────
function historyPanel(app) {
  const list = h('div', { id: 'hist-list' }), info = h('div', { class: 'small muted', style: 'margin-top:4px' });
  function refresh() {
    list.textContent = '';
    const d = app.doc; if (!d) return;
    const hs = d.hist;
    const mk = (name, i, cls) => h('div', { class: 'hrow ' + cls, onclick: () => { app.flushPending(); d.hist.goto(i); } }, h('span', null, name));
    list.append(mk('Initial State', -1, hs.index === -1 ? 'cur' : ''));
    hs.items.forEach((e, i) => list.append(mk(e.name, i, i === hs.index ? 'cur' : i > hs.index ? 'future' : '')));
    info.textContent = `${hs.items.length} step${hs.items.length === 1 ? '' : 's'} · ${fmtBytes(hs.bytes)} (limit ${hs.limit} steps / ${fmtBytes(hs.budget)}). Not saved if the browser crashes; your layers are.`;
    const cur = list.querySelector('.cur'); if (cur) { const t = cur.offsetTop, b = t + cur.offsetHeight; if (t < list.scrollTop) list.scrollTop = t; else if (b > list.scrollTop + list.clientHeight) list.scrollTop = b - list.clientHeight; }
  }
  app.on('docchange', (i) => { if (!i || i.history) refresh(); });
  app.on('doc', refresh);
  return { body: h('div', null, list, info), refresh };
}

export function buildDock(app) {
  const dock = document.getElementById('dock');
  const colorTabs = h('span', { class: 'tabsel' });
  const cbody = h('div'); const cview = colorPanel(app), sview = swatchesPanel(app);
  const showTab = (t) => { cbody.textContent = ''; cbody.append(t === 'color' ? cview : sview); bc.classList.toggle('on', t === 'color'); bs.classList.toggle('on', t === 'swatches'); };
  const bc = h('button', { onclick: () => showTab('color') }, 'Color'), bs = h('button', { onclick: () => showTab('swatches') }, 'Swatches');
  colorTabs.append(bc, bs); showTab('color');
  const pColor = panel('color', '', { head: colorTabs, body: cbody }, app);
  const pPrev = panel('preview', 'Preview', { body: previewPanel(app) }, app);
  const lay = layersPanel(app);
  const pLay = panel('layers', 'Layers', { grow: true, body: lay.body }, app);
  const his = historyPanel(app);
  const pHis = panel('history', 'History', { body: his.body, collapsed: true }, app);
  dock.append(pColor.el, pPrev.el, pLay.el, pHis.el);
  lay.refresh(); his.refresh();
  return { panels: { color: pColor.el, preview: pPrev.el, layers: pLay.el, history: pHis.el }, refreshLayers: lay.refresh, refreshHistory: his.refresh };
}
