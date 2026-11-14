// Photo editor dialog: rotate, crop, Auto, and four sliders. Used by the reveal page (the
// cosplayer edits a fan photo) and the fan page (the fan edits their own photo before sending).
// The math is in edit.js (pure, shared with the server); this file is the canvas and the controls.
import { el, loadBitmap } from './api.js';
import { EMPTY_EDIT, normalizeEdit, rotatedSize, cropRect, colorOps, applyColor, analyze } from './edit.js';
import { t, lang } from './i18n.js';

const $ = (id) => document.getElementById(id);
const makeCanvas = (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h });
const PREVIEW_PX = 1280; // the editor works on a copy this size, so sliders stay smooth on phones
const DEFAULT_AUTO = 0.75;

// Draws src (an ImageBitmap or canvas) with the edit applied, at most maxEdge on the long side.
export function renderEdited(src, edit, maxEdge = Infinity) {
  const e = edit ?? EMPTY_EDIT;
  const r = cropRect(...rotatedSize(src.width, src.height, e.rot), e);
  const k = Math.min(1, maxEdge / Math.max(r.width, r.height));
  const out = makeCanvas(Math.max(1, Math.round(r.width * k)), Math.max(1, Math.round(r.height * k)));
  const g = out.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  g.scale(k, k);
  g.translate(-r.left, -r.top);
  // Clockwise turn about the origin, shifted back into view (matches sharp's rotate on the server).
  if (e.rot === 90) g.translate(src.height, 0);
  else if (e.rot === 180) g.translate(src.width, src.height);
  else if (e.rot === 270) g.translate(0, src.width);
  g.rotate((e.rot * Math.PI) / 180);
  g.drawImage(src, 0, 0);
  const ops = colorOps(e);
  if (ops) {
    const d = g.getImageData(0, 0, out.width, out.height);
    applyColor(d.data, 4, ops);
    g.putImageData(d, 0, 0);
  }
  return out;
}

export const canvasBlob = (c, quality = 0.92) =>
  new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/jpeg', quality));

// The full-size photo as a JPEG, with the cosplayer's edit applied if there is one.
export async function photoBlob(item) {
  if (!item.edit) {
    const res = await fetch(item.fullUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.blob();
  }
  const bmp = await loadBitmap(item.fullUrl);
  try { return await canvasBlob(renderEdited(bmp, item.edit)); } finally { bmp.close(); }
}

function shrink(src, maxEdge) {
  const k = Math.min(1, maxEdge / Math.max(src.width, src.height));
  const c = makeCanvas(Math.max(1, Math.round(src.width * k)), Math.max(1, Math.round(src.height * k)));
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

// ---------- the dialog ----------
const SLIDERS = ['exposure', 'contrast', 'warmth', 'saturation'];
let dialog = null, view = null;
let st = null; // { src, edit, analysis, save, onClose, saved, result, comparing }

const signed = (v) => (v > 0 ? `+${v}` : String(v));
const crop = () => st.edit.crop ?? { ratio: null, zoom: 1, cx: 0.5, cy: 0.5 };
const rotated = () => rotatedSize(st.src.width, st.src.height, st.edit.rot);

function setCrop(patch) {
  const c = { ...crop(), ...patch };
  // Keep the center where the crop can actually reach, so dragging past an edge doesn't build up.
  const [W, H] = rotated();
  const r = cropRect(W, H, { crop: c });
  c.cx = (r.left + r.width / 2) / W;
  c.cy = (r.top + r.height / 2) / H;
  st.edit.crop = c.ratio === null && c.zoom === 1 ? null : c;
}

function syncControls() {
  const e = st.edit;
  $('ed-auto').setAttribute('aria-pressed', String(Boolean(e.auto)));
  $('ed-auto-row').hidden = !e.auto;
  if (e.auto) setSlider('ed-auto-s', Math.round(e.auto.s * 100), `${Math.round(e.auto.s * 100)}%`);
  const c = crop();
  $('ed-ratio').value = c.ratio === null ? '' : String(c.ratio);
  setSlider('ed-zoom', Math.round(c.zoom * 100), `${(c.zoom).toFixed(1)}×`);
  for (const k of SLIDERS) setSlider(`ed-${k}`, Math.round(e[k] * 100), signed(Math.round(e[k] * 100)));
  const pannable = Boolean(e.crop);
  view.classList.toggle('pannable', pannable);
  $('ed-status').textContent = pannable ? t('editor.dragHint') : '';
}
function setSlider(id, value, label) {
  const input = $(id);
  input.value = String(value);
  input.nextElementSibling.textContent = label;
}

let drawQueued = false;
function draw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => {
    drawQueued = false;
    if (!st?.src) return;
    const out = renderEdited(st.src, st.comparing ? null : st.edit);
    view.width = out.width;
    view.height = out.height;
    view.getContext('2d').drawImage(out, 0, 0);
  });
}
const changed = () => { syncControls(); draw(); };

// Opens the editor. load() resolves to an ImageBitmap of the photo; edit is the starting edit
// (or null). save(edit) stores or applies the clean edit and resolves to what was kept;
// onClose(saved, result) runs once the dialog is gone.
export async function openEditor({ load, edit = null, title = t('editor.title'), saveLabel = t('editor.save') }, { save, onClose }) {
  build();
  st = { src: null, edit: structuredClone({ ...EMPTY_EDIT, ...edit }), analysis: null, save, onClose, saved: false, result: null, comparing: false };
  const mine = st;
  $('editor-h').textContent = title;
  $('ed-save').textContent = saveLabel;
  $('ed-tools').inert = true;
  $('ed-save').disabled = true;
  view.width = view.height = 1;
  $('ed-status').textContent = t('editor.loading');
  dialog.showModal();
  try {
    const bmp = await load();
    if (st !== mine) return bmp.close();
    st.src = shrink(bmp, PREVIEW_PX);
    bmp.close();
  } catch {
    if (st === mine) $('ed-status').textContent = t('editor.loadFailed');
    return;
  }
  $('ed-tools').inert = false;
  $('ed-save').disabled = false;
  syncControls();
  draw();
  view.focus();
}

// Built on first use so any page can include the editor with one import, and built again if the
// page language has changed since (the dialog is modal, so it can't change while it's open).
function build() {
  if (dialog?.lang === lang) return;
  dialog?.remove();
  const slider = (id, label, min, max, rowId = null) => el('label', { class: 'slider', id: rowId, hidden: Boolean(rowId) },
    el('span', { text: t(label) }), el('input', { type: 'range', id, min, max, step: 1 }), el('output'));
  const ratios = [['', 'editor.ratio.original'], ['1', 'editor.ratio.square'], ['0.8', 'editor.ratio.portrait'],
    ['0.5625', 'editor.ratio.story'], ['1.7778', 'editor.ratio.wide']];
  // No backdrop click to close: a crop drag that ends outside the box would lose the edits.
  dialog = el('dialog', { id: 'editor', class: 'editor', lang, 'aria-labelledby': 'editor-h' },
    el('div', { class: 'drawer-head' },
      el('h2', { id: 'editor-h', text: t('editor.title') }),
      el('button', { type: 'button', class: 'close', 'data-close': true, 'aria-label': t('editor.closeNoSave'), text: '✕' })),
    el('div', { class: 'ed-stage' },
      (view = el('canvas', { id: 'ed-canvas', tabindex: '0', role: 'img', 'aria-label': t('editor.preview') }))),
    el('p', { id: 'ed-status', class: 'small ed-status', 'aria-live': 'polite' }),
    el('div', { id: 'ed-tools', class: 'ed-tools' },
      el('div', { class: 'row' },
        el('button', { type: 'button', id: 'ed-auto', 'aria-pressed': 'false', text: t('editor.auto') }),
        el('button', { type: 'button', id: 'ed-rotate', text: t('editor.rotate') }),
        el('label', { class: 'visually-hidden', for: 'ed-ratio', text: t('editor.cropShape') }),
        el('select', { id: 'ed-ratio' }, ratios.map(([value, key]) => el('option', { value, text: t(key) }))),
        el('button', { type: 'button', id: 'ed-compare', text: t('editor.compare') })),
      slider('ed-auto-s', 'editor.autoStrength', 0, 100, 'ed-auto-row'),
      slider('ed-zoom', 'editor.zoom', 100, 300),
      slider('ed-exposure', 'editor.exposure', -100, 100),
      slider('ed-contrast', 'editor.contrast', -100, 100),
      slider('ed-warmth', 'editor.warmth', -100, 100),
      slider('ed-saturation', 'editor.saturation', -100, 100)),
    el('div', { class: 'row ed-actions' },
      el('button', { type: 'button', id: 'ed-reset', text: t('editor.reset') }),
      el('span', { class: 'spacer' }),
      el('button', { type: 'button', 'data-close': true, text: t('common.cancel') }),
      el('button', { type: 'button', class: 'primary', id: 'ed-save', text: t('editor.save') })));
  document.body.append(dialog);
  wire();
}

function wire() {
  dialog.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) dialog.close(); });
  dialog.addEventListener('close', () => {
    if (!st) return;
    const { onClose, saved, result } = st;
    st = null;
    onClose?.(saved, result);
  });

  $('ed-auto').addEventListener('click', () => {
    if (st.edit.auto) st.edit.auto = null;
    else {
      if (!st.analysis) {
        const small = shrink(st.src, 256);
        st.analysis = analyze(small.getContext('2d').getImageData(0, 0, small.width, small.height).data);
      }
      st.edit.auto = { s: DEFAULT_AUTO, ...st.analysis };
    }
    changed();
  });
  $('ed-auto-s').addEventListener('input', (e) => { st.edit.auto.s = Number(e.target.value) / 100; changed(); });

  $('ed-rotate').addEventListener('click', () => {
    const c = st.edit.crop;
    st.edit.rot = (st.edit.rot + 90) % 360;
    if (c) setCrop({ cx: 1 - c.cy, cy: c.cx }); // the same spot, turned with the photo
    changed();
  });
  $('ed-ratio').addEventListener('change', (e) => { setCrop({ ratio: e.target.value ? Number(e.target.value) : null }); changed(); });
  $('ed-zoom').addEventListener('input', (e) => { setCrop({ zoom: Number(e.target.value) / 100 }); changed(); });
  for (const k of SLIDERS) $(`ed-${k}`).addEventListener('input', (e) => { st.edit[k] = Number(e.target.value) / 100; changed(); });

  $('ed-reset').addEventListener('click', () => { st.edit = structuredClone(EMPTY_EDIT); changed(); });

  // Hold to see the original (mouse, touch, or Space/Enter held down).
  const compare = (on) => { if (st?.src && st.comparing !== on) { st.comparing = on; draw(); } };
  const cmp = $('ed-compare');
  cmp.addEventListener('pointerdown', (e) => { cmp.setPointerCapture(e.pointerId); compare(true); });
  for (const t of ['pointerup', 'pointercancel', 'lostpointercapture', 'blur']) cmp.addEventListener(t, () => compare(false));
  cmp.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); if (!e.repeat) compare(true); } });
  cmp.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); compare(false); } });
  cmp.addEventListener('contextmenu', (e) => e.preventDefault()); // long-press on phones

  // Drag the photo to move the crop. dx, dy are fractions of the visible crop.
  let drag = null;
  function panBy(dx, dy) {
    const [W, H] = rotated();
    const r = cropRect(W, H, st.edit);
    const c = crop();
    setCrop({ cx: c.cx + (dx * r.width) / W, cy: c.cy + (dy * r.height) / H });
    changed();
  }
  view.addEventListener('pointerdown', (e) => {
    if (!st?.edit.crop) return;
    view.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, y: e.clientY };
  });
  view.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const box = view.getBoundingClientRect();
    // Moving the photo right moves the crop left, by the same distance in photo terms.
    panBy(-(e.clientX - drag.x) / box.width, -(e.clientY - drag.y) / box.height);
    drag = { x: e.clientX, y: e.clientY };
  });
  for (const t of ['pointerup', 'pointercancel']) view.addEventListener(t, () => { drag = null; });
  view.addEventListener('keydown', (e) => {
    const step = { ArrowLeft: [-0.05, 0], ArrowRight: [0.05, 0], ArrowUp: [0, -0.05], ArrowDown: [0, 0.05] }[e.key];
    if (!step || !st?.edit.crop) return;
    e.preventDefault();
    panBy(...step);
  });

  $('ed-save').addEventListener('click', async () => {
    const mine = st;
    const button = $('ed-save');
    button.disabled = true;
    try {
      const result = await mine.save(normalizeEdit(mine.edit));
      if (st !== mine) return;
      Object.assign(mine, { saved: true, result });
      dialog.close();
    } catch (err) {
      // An API error is already in the page language (err.key); anything else gets the generic line.
      if (st === mine) $('ed-status').textContent = err.key ? err.message : t('editor.saveFailed');
    } finally {
      button.disabled = false;
    }
  });
}
