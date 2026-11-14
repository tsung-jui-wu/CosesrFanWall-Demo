// The year in review: the cosplayer picks the "Download all" ZIPs they saved, and gets one spread per
// event, grouped by year, then a closing page. Everything runs on this device: the ZIPs are read in the
// browser (bundle-read.js), nothing is uploaded, and no counts or comparisons between events appear.
import { el, toast, saveOrShare } from './api.js';
import { readBundle, BundleError } from './bundle-read.js';
import { planReview } from './review-plan.js';
import { renderPicture } from './render.js';
import { isStyle, DEFAULT_STYLE } from './styles.js';
import { t, setText, formatDate, onLangChange } from './i18n.js';

const $ = (id) => document.getElementById(id);
let bundles = []; // [{ name, bundle }] in the order they were picked
let errors = []; // [{ name, code }]
const pictures = new Map(); // spread seed -> canvas, drawn once

$('files').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  $('reading').hidden = false;
  setText($('reading'), 'review.reading');
  for (const file of files) {
    try {
      bundles.push({ name: file.name, bundle: await readBundle({ kind: 'file', file }) });
    } catch (err) {
      errors.push({ name: file.name, code: err instanceof BundleError ? err.code : 'not_zip' });
    }
  }
  $('reading').hidden = true;
  await render();
});

function renderErrors() {
  $('errors').replaceChildren(...errors.map((x) => el('li', { text: t(`review.error.${x.code}`, { name: x.name }) })));
}

async function render() {
  renderErrors();
  const years = planReview(bundles.map((b) => b.bundle.manifest));
  if (!years.length) { $('spreads').replaceChildren(); return; }
  $('spreads').replaceChildren(
    ...years.map((y) => el('section', { class: 'review-year' },
      el('h2', { class: 'review-year-h', text: y.year === '0000' ? t('review.undated') : y.year }),
      ...y.spreads.map(spread))),
    el('section', { class: 'spotlight review-end' },
      el('h2', { text: t('review.end.title') }),
      el('p', { text: t('review.end.text') })));
  for (const y of years) for (const s of y.spreads) await drawSpread(s);
}

// One event: its picture in its style, a few notes (favorites first), and Save image.
function spread(s) {
  const m = bundles[s.index].bundle.manifest;
  return el('article', { class: 'review-spread' },
    el('div', { class: 'review-picture', 'data-picture': s.index },
      el('p', { class: 'muted small', text: t('review.drawing') })),
    el('div', { class: 'review-text' },
      el('p', { class: 'eyebrow', text: s.date === '0000-00-00' ? m.event.name : `${m.event.name} · ${formatDate(Date.parse(`${s.date}T12:00:00`))}` }),
      el('h3', { text: t('reveal.thankYou', { name: m.cosplayer?.name ?? '' }) }),
      el('div', { class: 'review-notes' }, ...s.notes.map((n) => el('blockquote', {},
        el('p', { text: n.note }),
        n.credit ? el('footer', { text: t('reveal.from', { name: n.credit }) }) : null))),
      el('button', { type: 'button', class: 'primary', 'data-save': s.index, text: t('reveal.controls.saveImage'), hidden: true })));
}

async function drawSpread(s) {
  // Looked up by bundle index: the seed holds characters a selector can't carry.
  const box = document.querySelector(`[data-picture="${s.index}"]`);
  const button = document.querySelector(`[data-save="${s.index}"]`);
  if (!box) return;
  let canvas = pictures.get(s.seed);
  if (!canvas) {
    const { bundle } = bundles[s.index];
    const m = bundle.manifest;
    const decode = async (path) => (bundle.has(path) ? createImageBitmap(await bundle.blob(path)) : null);
    try {
      const photos = (await Promise.all(s.photos.map((p) => decode(p.thumb ?? p.file).catch(() => null)))).filter(Boolean);
      if (!photos.length) { box.replaceChildren(); return; } // notes only: nothing to draw
      const picture = m.picture ? await decode(m.picture).catch(() => null) : null;
      canvas = renderPicture(m.revealStyle, { photos, picture, seed: s.seed });
      photos.forEach((p) => p.close?.());
      picture?.close?.();
      pictures.set(s.seed, canvas);
    } catch (err) {
      console.error(err);
      box.replaceChildren(el('p', { class: 'muted small', text: t('review.drawFailed') }));
      return;
    }
  }
  canvas.setAttribute('role', 'img');
  const style = bundles[s.index].bundle.manifest.revealStyle;
  canvas.setAttribute('aria-label', t(`reveal.stage.${isStyle(style) ? style : DEFAULT_STYLE}`));
  box.replaceChildren(canvas);
  button.hidden = false;
  button.onclick = () => save(s, canvas, button);
}

// The picture only, as on the reveal page: no notes or names in an image that may be posted.
async function save(s, canvas, button) {
  button.disabled = true;
  try {
    const blob = await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/jpeg', 0.92));
    const m = bundles[s.index].bundle.manifest;
    await saveOrShare(blob, `fanwall-${s.date}.jpg`, t('reveal.thankYou', { name: m.cosplayer?.name ?? '' }));
  } catch (err) {
    console.error(err);
    toast(t('reveal.toast.exportFailed'), { error: true });
  } finally {
    button.disabled = false;
  }
}

onLangChange(() => { if (bundles.length || errors.length) render(); });
