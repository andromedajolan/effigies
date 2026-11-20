// Window chrome: menu bar, application bar, toolbox, options bar, document tabs, status bar.
import { h, $, fmtBytes, clamp } from './util.js';
import { BLEND_LABEL } from './blend.js';
import { canMask } from './doc.js';
import { ADJ, ADJ_ORDER, NO_DIALOG } from './adjust.js';
import { FILTERS, FILTER_CATS } from './filters.js';

// ───────────── menus ─────────────
let openPop = null, openTop = null;
export function closeMenus() { if (openPop) { openPop.remove(); openPop = null; } document.querySelectorAll('.menu-pop').forEach((p) => p.remove()); if (openTop) { openTop.classList.remove('open'); openTop = null; } }

function popup(items, x, y, app, depth = 0) {
  const pop = h('div', { class: 'menu-pop', role: 'menu' });
  for (const it of items) {
    if (it === '---') { pop.append(h('div', { class: 'menu-sep' })); continue; }
    const enabled = it.stage ? false : (it.enabled ? it.enabled() : true);
    const checked = it.checked ? it.checked() : false;
    const label = typeof it.label === 'function' ? it.label() : it.label;
    const el = h('div', { class: 'menu-item' + (enabled ? '' : ' disabled') + (it.checked ? ' check' + (checked ? ' on' : '') : '') + (it.sub ? ' sub' : ''), role: 'menuitem', title: it.tip || (it.stage ? `Arrives in stage ${it.stage}` : '') },
      h('span', null, label), it.key ? h('span', { class: 'key' }, it.key) : null);
    if (it.sub && enabled) {
      let child = null;
      el.addEventListener('mouseenter', () => { document.querySelectorAll('.menu-pop').forEach((p) => { if (+p.dataset.depth > depth) p.remove(); }); const r = el.getBoundingClientRect(); child = popup(it.sub, r.right - 2, r.top - 3, app, depth + 1); });
    } else {
      el.addEventListener('mouseenter', () => document.querySelectorAll('.menu-pop').forEach((p) => { if (+p.dataset.depth > depth) p.remove(); }));
      if (enabled) el.addEventListener('click', () => { closeMenus(); it.run(); });
    }
    pop.append(el);
  }
  pop.dataset.depth = depth;
  pop.style.left = x + 'px'; pop.style.top = y + 'px';
  document.body.append(pop);
  const r = pop.getBoundingClientRect();
  if (r.right > innerWidth) pop.style.left = Math.max(0, innerWidth - r.width - 4) + 'px';
  if (r.bottom > innerHeight) pop.style.top = Math.max(0, innerHeight - r.height - 4) + 'px';
  openPop = pop;
  return pop;
}

export function buildMenus(app) {
  const A = app.actions, has = () => !!app.doc, lay = () => app.doc && app.doc.active;
  const dyn = (txt) => () => txt();
  const MENUS = [
    ['File', () => [
      { label: 'New…', key: 'Ctrl+N', run: A.newDoc },
      { label: 'Open Image…', key: 'Ctrl+O', run: A.openImage },
      { label: 'Open Project File…', run: A.openProject },
      '---',
      { label: 'Close', key: 'Ctrl+W', run: A.closeDoc, enabled: has },
      { label: 'Save Now (autosave is always on)', key: 'Ctrl+S', run: A.saveNow, enabled: has },
      '---',
      { label: 'Export Image (PNG / JPG)…', run: A.exportImage, enabled: has },
      { label: 'Export Project File…', key: 'Ctrl+Shift+S', run: A.exportProject, enabled: has },
    ]],
    ['Edit', () => [
      { label: dyn(() => (app.prefs.undoMode === 'cs5' ? (app.doc && app.doc.hist.canRedo && !app.doc.hist.canUndo ? 'Redo' : 'Undo / Redo') : 'Undo')), key: 'Ctrl+Z', run: A.undoToggle, enabled: () => has() && (app.doc.hist.canUndo || app.doc.hist.canRedo) },
      { label: 'Step Forward', key: 'Ctrl+Shift+Z', run: A.redo, enabled: () => has() && app.doc.hist.canRedo },
      { label: 'Step Backward', key: 'Ctrl+Alt+Z', run: A.undo, enabled: () => has() && app.doc.hist.canUndo },
      '---',
      { label: 'Cut', key: 'Ctrl+X', run: A.cut, enabled: lay }, { label: 'Copy', key: 'Ctrl+C', run: A.copy, enabled: lay },
      { label: 'Copy Merged', key: 'Ctrl+Shift+C', run: A.copyMerged, enabled: has }, { label: 'Paste', key: 'Ctrl+V', run: A.paste, enabled: has },
      '---',
      { label: 'Fill with Foreground Color', key: 'Alt+Backspace', run: () => A.fill('fg'), enabled: lay },
      { label: 'Fill with Background Color', key: 'Ctrl+Backspace', run: () => A.fill('bg'), enabled: lay },
      '---',
      { label: 'Free Transform', key: 'Ctrl+T', run: A.freeTransform, enabled: lay },
      { label: 'Transform', enabled: lay, sub: [
        { label: 'Flip Horizontal', run: () => A.layerTurn('fliph') }, { label: 'Flip Vertical', run: () => A.layerTurn('flipv') }, '---',
        { label: 'Rotate 180°', run: () => A.layerTurn('r180') }, { label: 'Rotate 90° CW', run: () => A.layerTurn('cw') }, { label: 'Rotate 90° CCW', run: () => A.layerTurn('ccw') },
      ] },
      '---',
      { label: 'Preferences…', run: A.prefs },
    ]],
    ['Image', () => [
      { label: 'Adjustments', enabled: lay, sub: [
        ...ADJ_ORDER.slice(0, 11).map((id) => ({ label: ADJ[id].name + (NO_DIALOG.has(id) ? '' : '…'), key: ({ levels: 'Ctrl+L', curves: 'Ctrl+M', hueSat: 'Ctrl+U', colorBalance: 'Ctrl+B' })[id], run: () => A.imageAdjust(id) })),
        '---',
        ...['invert', 'posterize', 'threshold', 'desaturate'].map((id) => ({ label: ADJ[id].name + (NO_DIALOG.has(id) ? '' : '…'), key: ({ invert: 'Ctrl+I', desaturate: 'Ctrl+Shift+U' })[id], run: () => A.imageAdjust(id) })),
        '---',
        { label: 'Auto Tone', run: () => A.autoTone(true) }, { label: 'Auto Contrast', run: () => A.autoTone(false) },
        '---',
        ...['Selective Color', 'Shadows/Highlights', 'Match Color', 'Replace Color', 'Equalize', 'Variations', 'HDR Toning'].map((n) => ({ label: n, stage: 3, tip: 'Not included yet' })),
      ] },
      '---',
      { label: 'Image Size…', run: A.imageSize, enabled: has }, { label: 'Canvas Size…', run: A.canvasSize, enabled: has },
      { label: 'Image Rotation', enabled: has, sub: [
        { label: '180°', run: () => A.rotate('r180') }, { label: '90° Clockwise', run: () => A.rotate('cw') }, { label: '90° Counter Clockwise', run: () => A.rotate('ccw') },
        '---', { label: 'Flip Canvas Horizontal', run: () => A.rotate('fliph') }, { label: 'Flip Canvas Vertical', run: () => A.rotate('flipv') }] },
      { label: 'Crop to Selection', run: A.cropToSel, enabled: () => has() && !!app.doc.sel },
      '---',
      { label: 'Duplicate Document', run: A.duplicateDoc, enabled: has },
    ]],
    ['Layer', () => [
      { label: 'New Layer', key: 'Ctrl+Shift+N', run: A.newLayer, enabled: has },
      { label: 'New Group', run: A.newGroup, enabled: has },
      { label: 'Layer via Copy', key: 'Ctrl+J', run: A.viaCopy, enabled: lay },
      { label: 'Duplicate Layer', run: A.duplicateLayer, enabled: lay },
      { label: 'Delete Layer', run: A.deleteLayer, enabled: lay },
      '---',
      { label: 'Layer Style…', run: () => A.layerStyle(), enabled: () => lay() && lay().type !== 'group' && lay().type !== 'adjust' },
      { label: 'Copy Layer Style', run: A.copyStyle, enabled: () => lay() && !!lay().styles },
      { label: 'Paste Layer Style', run: A.pasteStyle, enabled: () => lay() && !!app.styleClip },
      { label: 'Clear Layer Style', run: A.clearStyle, enabled: () => lay() && !!lay().styles },
      { label: 'Layer Mask', enabled: lay, sub: [
        { label: 'Reveal All', run: () => A.maskAdd('reveal'), enabled: () => lay() && canMask(lay()) && !lay().mask },
        { label: 'Hide All', run: () => A.maskAdd('hide'), enabled: () => lay() && canMask(lay()) && !lay().mask },
        { label: 'Reveal Selection', run: () => A.maskAdd('revealSel'), enabled: () => lay() && canMask(lay()) && !lay().mask && !!app.doc.sel },
        { label: 'Hide Selection', run: () => A.maskAdd('hideSel'), enabled: () => lay() && canMask(lay()) && !lay().mask && !!app.doc.sel },
        '---',
        { label: () => (lay() && lay().maskOn === false ? 'Enable' : 'Disable'), run: A.maskToggle, enabled: () => lay() && !!lay().mask },
        { label: 'Invert Mask', run: A.maskInvert, enabled: () => lay() && !!lay().mask },
        { label: 'Apply Layer Mask', run: A.maskApply, enabled: () => lay() && !!lay().mask },
        { label: 'Delete', run: A.maskDelete, enabled: () => lay() && !!lay().mask }] },
      { label: 'New Adjustment Layer', enabled: has, sub: ADJ_ORDER.map((id) => ({ label: ADJ[id].name, run: () => A.newAdjustLayer(id) })) },
      { label: () => (lay() && lay().clip ? 'Release Clipping Mask' : 'Create Clipping Mask'), key: 'Ctrl+Alt+G', run: A.clipToggle, enabled: lay },
      '---',
      { label: 'Group Layers', key: 'Ctrl+G', run: A.group, enabled: lay },
      { label: 'Ungroup Layers', key: 'Ctrl+Shift+G', run: A.ungroup, enabled: () => lay() && lay().type === 'group' },
      { label: 'Arrange', enabled: lay, sub: [
        { label: 'Bring to Front', key: 'Ctrl+Shift+]', run: () => A.arrange('front') }, { label: 'Bring Forward', key: 'Ctrl+]', run: () => A.arrange('forward') },
        { label: 'Send Backward', key: 'Ctrl+[', run: () => A.arrange('backward') }, { label: 'Send to Back', key: 'Ctrl+Shift+[', run: () => A.arrange('back') }] },
      '---',
      { label: 'Merge Down', key: 'Ctrl+E', run: A.mergeDown, enabled: lay },
      { label: 'Merge Visible', key: 'Ctrl+Shift+E', run: A.mergeVisible, enabled: has },
      { label: 'Flatten Image', run: A.flatten, enabled: has },
    ]],
    ['Type', () => [
      { label: 'Horizontal Type Tool', key: 'T', run: () => app.setTool('type') },
      { label: 'Rasterize Type Layer', run: () => { const d = app.doc; if (d && d.active && d.active.text) d.rasterizeText(d.active); }, enabled: () => lay() && !!lay().text },
    ]],
    ['Select', () => [
      { label: 'All', key: 'Ctrl+A', run: A.selectAll, enabled: has },
      { label: 'Deselect', key: 'Ctrl+D', run: A.deselect, enabled: () => has() && !!app.doc.sel },
      { label: 'Reselect', key: 'Ctrl+Shift+D', run: A.reselect, enabled: () => has() && !app.doc.sel && !!app.doc.lastSel },
      { label: 'Inverse', key: 'Ctrl+Shift+I', run: A.inverseSel, enabled: has },
      '---',
      { label: 'Feather…', run: A.featherSel, enabled: () => has() && !!app.doc.sel },
      { label: 'Modify', enabled: () => has() && !!app.doc.sel, sub: [
        { label: 'Expand…', run: () => A.growSel(1) }, { label: 'Contract…', run: () => A.growSel(-1) }] },
    ]],
    ['Filter', () => [
      { label: () => (app.lastFilter ? 'Last Filter: ' + FILTERS[app.lastFilter.id].name : 'Last Filter'), key: 'Ctrl+F', run: () => A.lastFilter(false), enabled: () => lay() && !!app.lastFilter },
      { label: 'Last Filter Settings…', key: 'Ctrl+Alt+F', run: () => A.lastFilter(true), enabled: () => lay() && !!app.lastFilter },
      '---',
      ...FILTER_CATS.map((cat) => ({ label: cat, enabled: lay, sub: Object.entries(FILTERS).filter(([, f]) => f.cat === cat).map(([id, f]) => ({ label: f.name + (f.noDialog ? '' : '…'), run: () => A.filter(id) })) })),
    ]],
    ['View', () => [
      { label: 'Zoom In', key: 'Ctrl++', run: () => A.zoom(1), enabled: has }, { label: 'Zoom Out', key: 'Ctrl+−', run: () => A.zoom(-1), enabled: has },
      { label: 'Fit on Screen', key: 'Ctrl+0', run: A.fit, enabled: has }, { label: 'Actual Pixels', key: 'Ctrl+1', run: A.actual, enabled: has },
      '---',
      { label: 'Center Guides', checked: () => app.prefs.guideCenter, run: () => A.toggleGuide('guideCenter') },
      { label: 'Thirds Guides', checked: () => app.prefs.guideThirds, run: () => A.toggleGuide('guideThirds') },
      { label: 'Safe Margin Guide (10%)', checked: () => app.prefs.guideSafe, run: () => A.toggleGuide('guideSafe') },
      '---',
      { label: 'Rulers', key: 'Ctrl+R', checked: () => !!app.prefs.rulers, run: A.toggleRulers },
      { label: 'Show Guides', key: 'Ctrl+;', checked: () => app.prefs.guidesShow !== false, run: A.toggleGuides, enabled: has },
      { label: 'Snap', key: 'Ctrl+Shift+;', checked: () => app.prefs.snap !== false, run: A.toggleSnap },
      { label: 'Lock Guides', checked: () => !!app.prefs.guidesLock, run: A.lockGuides },
      { label: 'New Guide…', run: A.newGuide, enabled: has },
      { label: 'Clear Guides', run: A.clearGuides, enabled: () => has() && !!(app.doc.guides && app.doc.guides.length) },
    ]],
    ['Window', () => [
      ...['color', 'preview', 'brush', 'adjust', 'layers', 'history'].map((id) => ({ label: { color: 'Color / Swatches', preview: 'Preview', brush: 'Brush', adjust: 'Adjustments', layers: 'Layers', history: 'History' }[id], checked: () => !app.dockEls[id].classList.contains('collapsed'), run: () => A.togglePanel(id) })),
      '---',
      { label: 'Hide / Show All Panels', key: 'Tab', run: A.togglePanels },
      { label: 'Reset Panels', run: A.resetPanels },
      '---',
      { label: 'Theme: CS5 Gray', checked: () => app.theme === 'gray', run: () => A.setTheme('gray') },
      { label: 'Theme: Dark', checked: () => app.theme === 'dark', run: () => A.setTheme('dark') },
    ]],
    ['Help', () => [
      { label: 'Keyboard Shortcuts', run: A.help },
      { label: 'Install Effigies as an app', run: A.install, enabled: () => !!app.installEvent },
      { label: 'About Effigies', run: A.about },
    ]],
  ];
  const bar = $('#menubar'); bar.textContent = '';
  bar.append(h('a', { class: 'menu-top ianua', href: '/', title: 'Back to the Ianua launcher' }, '← Ianua'));
  for (const [name, items] of MENUS) {
    const top = h('div', { class: 'menu-top', role: 'menuitem' }, name);
    const show = () => { closeMenus(); top.classList.add('open'); openTop = top; const r = top.getBoundingClientRect(); popup(items(), r.left, r.bottom, app); };
    top.addEventListener('mousedown', (e) => { e.preventDefault(); if (openTop === top) closeMenus(); else show(); });
    top.addEventListener('mouseenter', () => { if (openTop && openTop !== top) show(); });
    bar.append(top);
  }
  document.addEventListener('mousedown', (e) => { if (!e.target.closest('.menu-pop') && !e.target.closest('.menu-top')) closeMenus(); });
  window.addEventListener('blur', closeMenus);
}

// ───────────── application bar ─────────────
export function buildAppbar(app) {
  const bar = $('#appbar'); bar.textContent = '';
  const guides = h('button', { class: 'btn small', title: 'Square cover guides (center, thirds, safe margin)', onclick: () => app.actions.toggleGuide('guideSafe', true) }, '◫ Guides');
  const theme = h('button', { class: 'btn small', title: 'Switch between CS5 gray and dark', onclick: () => app.actions.setTheme(app.theme === 'dark' ? 'gray' : 'dark') });
  const install = h('button', { class: 'btn small', hidden: true, onclick: () => app.actions.install() }, 'Install');
  const upd = () => { theme.textContent = app.theme === 'dark' ? 'Theme: Dark' : 'Theme: Gray'; guides.classList.toggle('on', !!(app.prefs.guideCenter || app.prefs.guideThirds || app.prefs.guideSafe)); install.hidden = !app.installEvent; };
  bar.append(h('span', { class: 'brand' }, 'EFFIGIES'), h('button', { class: 'btn small', onclick: () => app.vp.fit() }, 'Fit'), h('button', { class: 'btn small', onclick: () => app.vp.zoomTo(1) }, '100%'), guides,
    h('span', { class: 'sp' }), install, theme);
  app.on('theme', upd); app.on('prefs', upd); app.on('install', upd); upd();
}

// ───────────── toolbox ─────────────
export function buildToolbox(app) {
  const box = $('#toolbox'); box.textContent = '';
  const groups = new Map();
  for (const t of Object.values(app.tools)) { if (!groups.has(t.group)) groups.set(t.group, []); groups.get(t.group).push(t); }
  app.toolGroups = groups; app.groupCurrent = app.groupCurrent || {};
  const btns = new Map();
  const spacerAfter = new Set(['move', 'crop', 'gradient', 'type', 'eyedropper']);
  for (const [g, list] of groups) {
    const cur = list.find((t) => t.id === app.groupCurrent[g]) || list[0];
    const b = h('button', { class: 'tool' + (list.length > 1 ? ' has-group' : ''), 'data-group': g, title: `${cur.name} (${cur.key.toUpperCase()})`, 'aria-label': cur.name, html: cur.icon });
    let hold = 0;
    b.addEventListener('click', () => { const c = list.find((t) => t.id === app.groupCurrent[g]) || list[0]; app.setTool(c.id); });
    if (list.length > 1) {
      b.addEventListener('pointerdown', () => { hold = setTimeout(() => flyout(b, list), 450); });
      b.addEventListener('pointerup', () => clearTimeout(hold)); b.addEventListener('pointerleave', () => clearTimeout(hold));
      b.addEventListener('contextmenu', (e) => { e.preventDefault(); flyout(b, list); });
    }
    btns.set(g, b); box.append(b);
    if (spacerAfter.has(g)) box.append(h('div', { class: 'tool-sep' }));
  }
  function flyout(b, list) {
    closeMenus();
    const r = b.getBoundingClientRect();
    const f = h('div', { class: 'flyout', style: `left:${r.right + 2}px;top:${r.top}px` }, list.map((t) => h('div', { class: 'fl-item', onclick: () => { app.setTool(t.id); f.remove(); } }, h('span', { html: t.icon }), `${t.name} (${t.key.toUpperCase()})`)));
    document.body.append(f);
    const off = (e) => { if (!f.contains(e.target)) { f.remove(); document.removeEventListener('pointerdown', off, true); } };
    setTimeout(() => document.addEventListener('pointerdown', off, true), 0);
  }
  // colors
  const fg = h('div', { class: 'sw fgc', title: 'Foreground color (click to edit)' }), bg = h('div', { class: 'sw bgc', title: 'Background color (click to edit)' });
  const swap = h('button', { class: 'swap', title: 'Swap colors (X)', 'aria-label': 'Swap colors', onclick: () => app.actions.swapColors() }, '⇄');
  const reset = h('button', { class: 'reset', title: 'Default colors (D)', 'aria-label': 'Default colors', onclick: () => app.actions.resetColors() }, '◩');
  fg.addEventListener('click', () => { app.setColorTarget('fg'); app.dockEls.color.setCollapsed(false); }); bg.addEventListener('click', () => { app.setColorTarget('bg'); app.dockEls.color.setCollapsed(false); });
  box.append(h('div', { class: 'colors' }, bg, fg, swap, reset));
  const upd = () => {
    fg.style.background = app.fg; bg.style.background = app.bg;
    fg.classList.toggle('sel', app.colorTarget === 'fg'); bg.classList.toggle('sel', app.colorTarget === 'bg');
    for (const [g, b] of btns) {
      const list = groups.get(g), on = list.some((t) => t.id === app.tool.id);
      b.classList.toggle('active', on);
      const shown = on ? app.tool : (list.find((t) => t.id === app.groupCurrent[g]) || list[0]);
      b.innerHTML = shown.icon; b.title = `${shown.name} (${shown.key.toUpperCase()})`;
    }
  };
  app.on('color', upd); app.on('tool', upd); upd();
}

// ───────────── options bar ─────────────
export function buildOptionsBar(app) {
  const bar = $('#optionsbar');
  function render() {
    const t = app.tool; bar.textContent = '';
    bar.append(h('div', { class: 'tname' }, h('span', { html: t.icon }), t.name));
    const o = app.opts(t.optKey || t.id, t.defaults);
    for (const d of t.options || []) {
      if (d.type === 'custom') { bar.append(d.build()); continue; }
      if (d.type === 'button') { bar.append(h('button', { class: 'btn small', onclick: () => d.run(app) }, d.label)); continue; }
      if (d.type === 'check') {
        const c = h('input', { type: 'checkbox', checked: !!o[d.key] }); c.addEventListener('change', () => { o[d.key] = c.checked; app.savePrefs(); });
        bar.append(h('label', null, c, d.label)); continue;
      }
      if (d.type === 'select') {
        const s = h('select', null, d.choices.map(([v, l]) => h('option', { value: v }, l))); s.value = o[d.key];
        s.addEventListener('change', () => { o[d.key] = isNaN(+s.value) ? s.value : +s.value; app.savePrefs(); });
        bar.append(h('label', null, d.label + ':', s)); continue;
      }
      const n = h('input', { type: 'number', min: d.min, max: d.max, value: o[d.key] });
      const set = (v) => { o[d.key] = clamp(Math.round(v) || d.min, d.min, d.max); n.value = o[d.key]; if (r) r.value = Math.min(o[d.key], d.slider ? d.slider[1] : d.max); app.savePrefs(); app.vp.drawOverlay(); };
      const r = d.slider ? h('input', { type: 'range', class: 'opt-slider', min: d.slider[0], max: d.slider[1], value: Math.min(o[d.key], d.slider[1]), 'aria-label': d.label + ' slider' }) : null;
      if (r) r.addEventListener('input', () => set(+r.value));
      n.addEventListener('change', () => set(+n.value)); n.addEventListener('input', () => { if (n.value !== '') set(+n.value); });
      bar.append(h('label', null, d.label + ':', n, d.suffix || '', r));
    }
    if (t.hint) bar.append(h('span', { class: 'hint', title: t.hint }, t.hint));
  }
  app.on('tool', render); app.on('toolopts', render);
  render();
}

// ───────────── tabs ─────────────
export function buildTabs(app) {
  const bar = $('#tabs');
  function render() {
    bar.textContent = '';
    for (const d of app.docs) {
      const t = h('div', { class: 'doc-tab' + (d === app.doc ? ' active' : ''), role: 'tab', 'aria-selected': d === app.doc ? 'true' : 'false', draggable: 'true', 'data-id': d.id, title: `${d.name} — ${d.w} × ${d.h}` },
        h('span', { class: 'tn' }, d.name), h('button', { class: 'x', title: 'Close', 'aria-label': 'Close ' + d.name, onclick: (e) => { e.stopPropagation(); app.actions.closeDoc(d); } }, '×'));
      t.addEventListener('click', () => app.switchDoc(d.id));
      t.addEventListener('dblclick', () => app.actions.renameDoc(d));
      t.addEventListener('dragstart', (e) => { e.dataTransfer.setData('application/x-effigies-tab', d.id); e.dataTransfer.effectAllowed = 'move'; });
      t.addEventListener('dragover', (e) => { const ty = e.dataTransfer.types; if (ty.includes('application/x-effigies-layer') || ty.includes('application/x-effigies-tab')) { e.preventDefault(); t.classList.add('drop'); } });
      t.addEventListener('dragleave', () => t.classList.remove('drop'));
      t.addEventListener('drop', (e) => {
        e.preventDefault(); t.classList.remove('drop');
        const lay = e.dataTransfer.getData('application/x-effigies-layer'), tab = e.dataTransfer.getData('application/x-effigies-tab');
        if (lay) { try { const j = JSON.parse(lay); const src = app.docs.find((x) => x.id === j.docId); const L = src && src.find(j.layerId); if (L && src !== d) app.copyLayerToDoc(L, d.id); } catch { /* ignore */ } }
        else if (tab && tab !== d.id) app.reorderDoc(tab, d.id);
      });
      bar.append(t);
    }
    bar.append(h('button', { class: 'btn small tab-add', title: 'New document (Ctrl+N)', 'aria-label': 'New document', onclick: () => app.actions.newDoc() }, '＋'));
    $('#empty').hidden = app.docs.length > 0;
  }
  app.on('tabs', render); app.on('doc', render); render();
  app.highlightTab = (id) => { bar.querySelectorAll('.doc-tab').forEach((t) => t.classList.toggle('drop', t.dataset.id === id)); };
}

// ───────────── status bar ─────────────
export function buildStatusbar(app) {
  const bar = $('#statusbar'); bar.textContent = '';
  const zoom = h('input', { type: 'text', class: 'zoom-in', value: '100%', 'aria-label': 'Zoom percent' });
  const size = h('span'), pos = h('span'), mem = h('span'), save = h('span'), hint = h('span', { class: 'sp' });
  zoom.addEventListener('change', () => { const v = parseFloat(zoom.value); if (app.doc && v > 0) app.vp.zoomTo(v / 100); upd(); });
  zoom.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') zoom.blur(); });
  bar.append(zoom, size, pos, hint, mem, save);
  function upd() {
    const d = app.doc;
    zoom.disabled = !d;
    if (!d) { zoom.value = ''; size.textContent = ''; mem.textContent = ''; save.textContent = ''; return; }
    if (document.activeElement !== zoom) zoom.value = (d.view.zoom * 100 >= 10 ? Math.round(d.view.zoom * 1000) / 10 : Math.round(d.view.zoom * 10000) / 100) + '%';
    size.textContent = `${d.w} × ${d.h} px · RGB/8`;
    const total = app.memoryEstimate();
    mem.textContent = `Memory ≈ ${fmtBytes(total)}`; mem.className = total > 1.6e9 ? 'bad' : total > 1.0e9 ? 'warn' : '';
    mem.title = 'Estimated pixel memory of layers, open documents and History. A 4 GB Chromebook is comfortable up to about 1 GB.';
  }
  app.setSaveState = (s) => { save.textContent = s; };
  app.on('docchange', upd); app.on('doc', upd); app.on('view', upd);
  app.onPointer = (p) => { pos.textContent = app.doc ? `${Math.floor(p.x)}, ${Math.floor(p.y)} px` : ''; };
  upd();
  app.updateStatus = upd;
}
