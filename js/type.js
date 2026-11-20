// Type: text rendering, the Type tool (click to type on the canvas, drag for a text box), and the font picker.
// A type layer is an ordinary raster layer plus `layer.text` (its settings). The pixels are a cache of renderText(), so masks,
// blend modes, adjustments, clipping and layer styles all work on it. Painting on it turns it into plain pixels.
import { h, clamp, toast } from './util.js';
import { FONT_LIST, FONT_CATS, DEFAULT_FONT, loadFont, pickWeight, weightsOf, hasFont } from './fonts.js';

export const TEXT_DEFAULTS = () => ({ content: '', family: DEFAULT_FONT, bold: false, italic: false, size: 96, color: '#ffffff', align: 'left', lineHeight: 1.2, tracking: 0, boxW: null, ox: 0, oy: 0 });

const fontCss = (t, size) => `${t.italic ? 'italic ' : ''}${pickWeight(t.family, t.bold ? 700 : 400)} ${size}px "${t.family}", sans-serif`;
let mctx = null;
const measureCtx = () => (mctx ||= document.createElement('canvas').getContext('2d'));

let mctx2 = null;
function metrics(t) {
  const g = (mctx2 ||= document.createElement('canvas').getContext('2d')); g.font = fontCss(t, 100);
  const m = g.measureText('Hg');
  const asc = (m.fontBoundingBoxAscent ?? 90) / 100, desc = (m.fontBoundingBoxDescent ?? 25) / 100;
  return { asc, desc };
}
function wrapLines(t, g) {
  const out = [];
  for (const para of String(t.content).split('\n')) {
    if (!t.boxW) { out.push(para); continue; }
    let line = '';
    for (const word of para.split(/(\s+)/)) {
      const test = line + word;
      if (line && g.measureText(test.trimEnd()).width > t.boxW) { out.push(line.trimEnd()); line = word.trimStart(); } else line = test;
    }
    out.push(line.trimEnd());
  }
  return out;
}

/** Render text settings to a canvas. Returns {canvas, ox, oy}: (ox, oy) is where the anchor (first baseline, alignment point) sits inside the canvas. */
export function renderText(t) {
  const size = clamp(t.size, 4, 1500), g = measureCtx();
  g.font = fontCss(t, size); g.letterSpacing = ((t.tracking / 1000) * size).toFixed(2) + 'px';
  const lines = wrapLines(t, g), { asc, desc } = metrics(t), lh = size * t.lineHeight;
  const widths = lines.map((l) => g.measureText(l).width);
  const W = t.boxW || Math.max(1, ...widths);
  const xLeft = t.boxW ? 0 : t.align === 'center' ? -W / 2 : t.align === 'right' ? -W : 0;
  const pad = Math.ceil(size * 0.35) + 4;
  const w = clamp(Math.ceil(W + pad * 2), 1, 8192), hh = clamp(Math.ceil(asc * size + (lines.length - 1) * lh + desc * size + pad * 2), 1, 8192);
  const c = document.createElement('canvas'); c.width = w; c.height = hh;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.font = fontCss(t, size); ctx.letterSpacing = ((t.tracking / 1000) * size).toFixed(2) + 'px';
  ctx.fillStyle = t.color; ctx.textBaseline = 'alphabetic';
  const ox = pad - xLeft, oy = pad + asc * size;
  lines.forEach((l, i) => {
    const lw = widths[i];
    const x = t.align === 'center' ? pad + (W - lw) / 2 : t.align === 'right' ? pad + (W - lw) : pad;
    ctx.fillText(l, x, oy + i * lh);
  });
  return { canvas: c, ox: Math.round(ox), oy: Math.round(oy) };
}

// ───────────── font picker ─────────────
export function fontPicker(current, onPick) {
  const btn = h('button', { class: 'btn font-btn', title: 'Font', type: 'button' });
  const show = (fam) => { btn.textContent = fam; btn.style.fontFamily = `"${fam}", sans-serif`; loadFont(fam, 400); };
  show(current);
  btn.addEventListener('click', () => {
    document.querySelectorAll('.font-pop').forEach((e) => e.remove());
    const pop = h('div', { class: 'font-pop', role: 'listbox' });
    const search = h('input', { type: 'search', placeholder: 'Search fonts…', 'aria-label': 'Search fonts' });
    const list = h('div', { class: 'font-list' });
    const draw = () => {
      list.textContent = ''; const q = search.value.trim().toLowerCase();
      for (const cat of FONT_CATS) {
        const rows = FONT_LIST.filter((r) => r[3] === cat && (!q || r[0].toLowerCase().includes(q)));
        if (!rows.length) continue;
        list.append(h('div', { class: 'font-cat' }, cat));
        for (const r of rows) {
          const it = h('div', { class: 'font-item' + (r[0] === btn.textContent ? ' cur' : ''), role: 'option', style: `font-family:"${r[0]}",sans-serif` }, r[0]);
          loadFont(r[0], 400);
          it.addEventListener('click', () => { pop.remove(); show(r[0]); onPick(r[0]); });
          list.append(it);
        }
      }
      if (!list.firstChild) list.append(h('div', { class: 'font-cat' }, 'No match'));
    };
    search.addEventListener('input', draw); draw();
    pop.append(search, list);
    const r = btn.getBoundingClientRect(); pop.style.left = r.left + 'px'; pop.style.top = r.bottom + 2 + 'px';
    document.body.append(pop); search.focus();
    const off = (e) => { if (!pop.contains(e.target) && e.target !== btn) { pop.remove(); document.removeEventListener('pointerdown', off, true); } };
    setTimeout(() => document.addEventListener('pointerdown', off, true), 0);
    pop.addEventListener('keydown', (e) => { if (e.key === 'Escape') pop.remove(); });
  });
  btn.setFamily = show;
  return btn;
}

const ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 6V4h14v2M12 4v16M9 20h6"/></svg>';

// ───────────── the Type tool ─────────────
export class TypeTool {
  constructor(app) {
    this.app = app; this.id = 'type'; this.name = 'Horizontal Type Tool'; this.key = 't'; this.group = 'type'; this.icon = ICON;
    this.defaults = TEXT_DEFAULTS();
    this.cursor = 'text'; this.session = null; this.drag = null;
    this.hint = 'Click to type. Drag to make a text box. Esc or Ctrl+Enter finishes.';
    this.options = [{ type: 'custom', build: () => this.optionsUI() }];
  }
  get o() { return this.app.opts('type', this.defaults); }
  /** The text settings the controls currently describe: the layer being edited, the active type layer, or the defaults. */
  current() {
    if (this.session) return this.session.text;
    const L = this.app.doc && this.app.doc.active;
    return L && L.text ? L.text : this.o;
  }
  change(patch) {
    const o = this.o; Object.assign(o, patch); this.app.savePrefs();
    if (this.session) { Object.assign(this.session.text, patch); this.styleBox(); this.fit(); return; }
    const L = this.app.doc && this.app.doc.active;
    if (L && L.text) {
      const t = { ...L.text, ...patch };
      loadFont(t.family, t.bold ? 700 : 400).then(() => this.app.doc.setText(L, t, 'Change Text'));
    }
  }
  optionsUI() {
    const t = this.current(), wrap = h('span', { class: 'type-opts' });
    const fp = fontPicker(t.family, (f) => this.change({ family: f, bold: this.current().bold && weightsOf(f).includes(700) }));
    const bold = h('button', { class: 'btn small tgl' + (t.bold ? ' on' : ''), title: 'Bold (uses the bold file where the font has one)', type: 'button', onclick: (e) => { const v = !this.current().bold; e.currentTarget.classList.toggle('on', v); this.change({ bold: v }); } }, 'B');
    bold.style.fontWeight = '700';
    const ital = h('button', { class: 'btn small tgl' + (t.italic ? ' on' : ''), title: 'Italic (slanted)', type: 'button', onclick: (e) => { const v = !this.current().italic; e.currentTarget.classList.toggle('on', v); this.change({ italic: v }); } }, 'I');
    ital.style.fontStyle = 'italic';
    const num = (label, key, min, max, step = 1, suffix = '') => {
      const i = h('input', { type: 'number', min, max, step, value: t[key], 'aria-label': label });
      i.addEventListener('change', () => { const v = clamp(Number(i.value) || min, min, max); i.value = v; this.change({ [key]: v }); });
      return h('label', null, label + ':', i, suffix);
    };
    const aligns = [['left', '⇤'], ['center', '↔'], ['right', '⇥']].map(([a, ch]) => h('button', { class: 'btn small tgl' + (t.align === a ? ' on' : ''), title: 'Align ' + a, type: 'button', onclick: () => { this.change({ align: a }); this.app.emit('toolopts'); } }, ch));
    const col = h('input', { type: 'color', value: t.color, title: 'Text color', 'aria-label': 'Text color' });
    col.addEventListener('input', () => this.change({ color: col.value }));
    wrap.append(fp, bold, ital, num('Size', 'size', 4, 1500, 1, 'px'), num('Leading', 'lineHeight', 0.6, 3, 0.05), num('Tracking', 'tracking', -200, 1000, 10), ...aligns, col);
    return wrap;
  }
  // ── on-canvas editing ──
  hit(x, y) {
    const d = this.app.doc; let found = null;
    d.allLayers().forEach((L) => { if (L.text && L.visible && x >= L.x && y >= L.y && x <= L.x + L.w && y <= L.y + L.h) found = L; });
    return found;
  }
  down(c) {
    if (!this.app.doc) return;
    if (this.session) this.commit();
    const L = this.hit(c.x, c.y);
    if (L && !(L.lockAll)) { this.begin({ layer: L, text: { ...L.text }, ax: L.x + L.text.ox, ay: L.y + L.text.oy }); return; }
    this.drag = { x: c.x, y: c.y, cx: c.x, cy: c.y };
  }
  move(c) { if (this.drag) { this.drag.cx = c.x; this.drag.cy = c.y; this.app.vp.drawOverlay(); } }
  up(c) {
    const d = this.drag; this.drag = null; this.app.vp.drawOverlay(); if (!d) return;
    const w = Math.abs(c.x - d.x), o = this.o;
    const t = { ...TEXT_DEFAULTS(), ...o, content: '', ox: 0, oy: 0 };
    let ax = d.x, ay = d.y;
    if (w > 12) { t.boxW = Math.round(w); ax = Math.min(d.x, c.x); ay = Math.min(d.y, c.y) + metrics(t).asc * t.size; }
    else t.boxW = null;
    this.begin({ layer: null, text: t, ax, ay });
  }
  cancel() { if (this.session) this.commit(); this.drag = null; }
  drawOverlay(g, vp) {   // dashed rubber band for a new text box
    const d = this.drag; if (!d) return;
    const a = vp.toDev(Math.min(d.x, d.cx), d.y), b = vp.toDev(Math.max(d.x, d.cx), d.cy);
    g.save(); g.strokeStyle = '#5aa0ff'; g.setLineDash([6, 4]); g.strokeRect(a.x + 0.5, a.y + 0.5, b.x - a.x, b.y - a.y); g.restore();
  }
  begin(s) {
    this.session = s; const L = s.layer; if (L) { L.hideForEdit = true; this.app.doc.changed({ tree: true }); }
    const ta = h('textarea', { class: 'type-edit', spellcheck: 'false', wrap: 'off', 'aria-label': 'Text' });
    ta.value = s.text.content; s.ta = ta;
    ta.addEventListener('input', () => { s.text.content = ta.value; this.fit(); });
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); this.commit(); this.app.emit('toolopts'); }
    });
    ta.addEventListener('pointerdown', (e) => e.stopPropagation());
    document.getElementById('stage').append(ta);
    loadFont(s.text.family, s.text.bold ? 700 : 400).then(() => { this.styleBox(); this.fit(); });
    this.styleBox(); this.fit(); ta.focus(); ta.select();
    setTimeout(() => { if (this.session === s) { ta.focus(); ta.select(); } }, 40);   // the canvas grabs focus after pointer-down; take it back
    this.app.emit('toolopts');
  }
  styleBox() {
    const s = this.session; if (!s) return;
    const v = this.app.doc.view, dpr = this.app.vp.dpr, t = s.text, size = t.size * v.zoom / dpr, { asc, desc } = metrics(t), lh = t.size * t.lineHeight * v.zoom / dpr;
    const half = (lh - (asc + desc) * size) / 2, baseline = half + asc * size;
    const dev = this.app.vp.toDev(s.ax, s.ay), ta = s.ta;
    Object.assign(ta.style, {
      font: fontCss(t, size), lineHeight: lh + 'px', color: t.color, textAlign: t.align, letterSpacing: ((t.tracking / 1000) * size) + 'px',
      top: dev.y / dpr - baseline - 2 + 'px', whiteSpace: t.boxW ? 'pre-wrap' : 'pre',
    });
    s.baseline = baseline;
    ta.style.setProperty('--pad', '2px');
  }
  fit() {
    const s = this.session; if (!s) return; const ta = s.ta, t = s.text, v = this.app.doc.view, dpr = this.app.vp.dpr;
    ta.style.width = '1px'; ta.style.height = '1px';
    const w = t.boxW ? t.boxW * v.zoom / dpr + 4 : Math.max(40, ta.scrollWidth + 8);
    ta.style.width = w + 'px'; ta.style.height = ta.scrollHeight + 'px';
    const dev = this.app.vp.toDev(s.ax, s.ay);
    const left = t.boxW || t.align === 'left' ? dev.x / dpr : t.align === 'center' ? dev.x / dpr - w / 2 : dev.x / dpr - w;
    ta.style.left = left - 2 + 'px';
  }
  async commit() {
    const s = this.session; if (!s) return; this.session = null;
    s.ta.remove();
    const d = this.app.doc, L = s.layer, t = s.text;
    if (L) L.hideForEdit = false;
    const empty = !t.content.trim();
    await loadFont(t.family, t.bold ? 700 : 400);
    if (L) {
      if (empty) { d.deleteLayer(L); }
      else if (JSON.stringify({ ...t, ox: 0, oy: 0 }) !== JSON.stringify({ ...L.text, ox: 0, oy: 0 })) { d.setText(L, t, 'Edit Text'); }
      else d.changed({ tree: true });
    } else if (!empty) d.addTextLayer(t, s.ax, s.ay);
    this.app.emit('toolopts');
  }
}
