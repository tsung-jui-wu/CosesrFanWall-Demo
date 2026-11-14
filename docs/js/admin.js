import { api, el, toast, copyText, url, segmentAfter, STATIC } from './api.js';
import { t, lang, setText, setTitle, errorKey, formatDateTime, onLangChange, useEventLang } from './i18n.js';
import { STYLE_IDS } from './styles.js';
import { prepareImage } from './upload.js';

const token = segmentAfter('admin');
const base = `/api/admin/${encodeURIComponent(token)}`;
const $ = (id) => document.getElementById(id);

let state = null;
const filter = { cosplayer: 'all', status: 'pending' };
// Where we are: the home page and one of its tabs, or one cosplayer's page and one of its tabs.
// It lives in the address's #, so the back button and bookmarks work: #review, #c/<id>, #c/<id>/add, #c/<id>/share.
const view = { cid: null, tab: 'cosplayers' };
let homeCos = 'all'; // the cosplayer picked in the home Review tab's pills

if (new URLSearchParams(location.search).has('new')) {
  $('new-notice').hidden = false;
  history.replaceState(null, '', location.pathname);
}

async function load() {
  try {
    state = await api(base);
    lastJson = JSON.stringify(state);
    await useEventLang(state.event.lang);
    route();
  } catch (err) {
    if (err.status === 404) {
      $('dash-body').hidden = true;
      $('admin-error').hidden = false;
    } else {
      toast(err.message, { error: true });
    }
  }
}

// The dashboard keeps itself up to date: it checks for new submissions every half minute while the tab
// is showing, and as soon as you come back to it. It only redraws when something changed, and never
// while you are typing or moving through the review queue with the keyboard.
const POLL_MS = 30e3;
let lastJson = '';
async function refreshQuietly() {
  if (!state || document.hidden || STATIC) return;
  try {
    const next = await api(base);
    const json = JSON.stringify(next);
    if (json === lastJson) return;
    const a = document.activeElement;
    if (a?.matches('input, textarea, select') || $('grid').contains(a)) return; // try again on the next tick
    if (!$('cos-more-options').hidden || $('remove-dialog').open) return; // the ⋯ menu or Remove dialog is open
    if (!view.cid && view.tab === 'settings') return; // unsaved settings edits would be refilled
    lastJson = json;
    state = next;
    if (view.cid && !cosplayer(view.cid)) route();
    else render();
  } catch {} // a missed check is fine; the next one tries again
}
setInterval(refreshQuietly, POLL_MS);
document.addEventListener('visibilitychange', refreshQuietly);

function render() {
  renderAccess();
  renderEvent();
  renderBase();
  renderPeople();
  renderGrid();
}

// ---------- views and tabs ----------
// A link to a view on this page. Full path, not a bare "#…": the static demo sets <base>, which would
// send a bare hash link to the demo's front page.
const hashHref = (h) => `${location.pathname}${location.search}#${h}`;
const cosplayer = (id) => state?.cosplayers.find((c) => c.id === id);

function route() {
  if (!state) return;
  const [a, b, c] = decodeURIComponent(location.hash.slice(1)).split('/');
  if (a === 'c' && cosplayer(b)) Object.assign(view, { cid: b, tab: ['add', 'share'].includes(c) ? c : 'review' });
  else Object.assign(view, { cid: null, tab: ['review', 'settings'].includes(a) ? a : 'cosplayers' });
  // A cosplayer's page shows only theirs; the home Review tab keeps its own pick.
  if (!cosplayer(homeCos)) homeCos = 'all';
  filter.cosplayer = view.cid ?? homeCos;
  $('view-home').hidden = Boolean(view.cid);
  $('view-cosplayer').hidden = !view.cid;
  // The home view shows only the section picked in the sidebar, and the numbers on the overview only.
  for (const tab of ['cosplayers', 'review', 'settings']) $(`panel-${tab}`).hidden = view.tab !== tab;
  $('stats').hidden = view.tab !== 'cosplayers';
  // The review queue is one piece of the page, moved to whichever view shows it.
  const reviewHome = !view.cid && view.tab === 'review', reviewCos = view.cid && view.tab === 'review';
  if (reviewHome) $('panel-review').append($('review'));
  if (reviewCos) $('panel-c-review').append($('review'));
  $('review').hidden = !(reviewHome || reviewCos);
  $('f-cos').hidden = Boolean(view.cid);
  render();
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);

// The sidebar: links to the home sections, then one row per cosplayer, the current one marked. The rows
// are rebuilt only when who is listed (or their picture) changes; reviewing with A/R just updates the
// one line that says what needs doing.
let sideKey = '';
let addOpened = false; // the add form opens by itself once, on an event with nobody in it yet
const markCurrent = (node, on) => (on ? node.setAttribute('aria-current', 'page') : node.removeAttribute('aria-current'));
function renderNav() {
  for (const link of document.querySelectorAll('.side-link')) {
    const tab = link.dataset.tab;
    link.href = hashHref(tab === 'cosplayers' ? '' : tab);
    markCurrent(link, !view.cid && view.tab === tab);
  }
  const key = JSON.stringify([location.pathname, state.event.baseUrl,
    state.cosplayers.map((c) => [c.id, c.name, c.character, c.baseUrl])]);
  if (key !== sideKey) {
    sideKey = key;
    $('side-cos').replaceChildren(...state.cosplayers.map((c) =>
      el('a', { class: 'side-person', href: hashHref(`c/${c.id}`), 'data-id': c.id },
        picture(c, 'side-pic'),
        el('span', { class: 'side-who' },
          el('span', { class: 'side-name', text: c.name }),
          c.character ? el('span', { class: 'side-char', text: c.character }) : null),
        el('span', { class: 'side-state' }))));
  }
  for (const row of $('side-cos').children) {
    const c = cosplayer(row.dataset.id);
    const pending = !c.optOut && c.counts.pending > 0;
    const stateEl = row.querySelector('.side-state');
    stateEl.className = `side-state${pending ? ' warn' : c.released && !c.optOut ? ' ok' : ''}`;
    stateEl.textContent = pending ? t('admin.folder.toReview', { count: c.counts.pending }) : t(badgeOf(c).key);
    markCurrent(row, view.cid === c.id);
  }
}

// Tabs are links to views; the arrow keys move between them, as in any tab list.
function renderTabs(list, current, hrefOf) {
  for (const tab of list.querySelectorAll('[role="tab"]')) {
    const on = tab.dataset.tab === current;
    tab.href = hrefOf(tab.dataset.tab);
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    $(tab.getAttribute('aria-controls')).hidden = !on;
  }
}
$('cos-tabs').addEventListener('keydown', (e) => {
  const tabs = [...$('cos-tabs').querySelectorAll('[role="tab"]')];
  const i = tabs.indexOf(document.activeElement);
  const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
  if (i < 0 || to === undefined) return;
  e.preventDefault();
  const next = tabs[(to + tabs.length) % tabs.length];
  next.focus();
  next.click();
});

// "Keys: [A] approve, [R] reject, ...": the bracketed letters become <kbd>, in any language.
function renderKeysHint() {
  const parts = t('admin.keys').split(/\[(.+?)\]/);
  $('keys-hint').replaceChildren(...parts.map((p, i) => (i % 2 ? el('kbd', { text: p }) : p)));
}

// ---------- access ----------
// Events made with an invite code close when the code runs out (60 days unless the owner sets otherwise).
// The top bar counts down the days.
const DAY = 86400e3;
function renderAccess() {
  const end = state.event.accessEndsAt;
  const node = $('access-left');
  node.hidden = !end;
  if (!end) return;
  const left = Math.max(0, Math.ceil((end - Date.now()) / DAY));
  node.textContent = left ? t('admin.access.left', { count: left }) : t('admin.access.ended');
  node.title = t('admin.access.about', { date: formatDateTime(end) });
  node.classList.toggle('is-soon', left <= 5);
  node.classList.toggle('is-ended', !left);
}

// ---------- event ----------
function renderEvent() {
  const ev = state.event;
  setTitle('admin.docTitleFor', { name: view.cid ? cosplayer(view.cid).name : ev.name });
  $('event-title').textContent = ev.name;
  $('event-state').textContent = ev.open
    ? t('admin.state.open')
    : t('admin.state.closed', { date: formatDateTime(ev.closedAt), count: ev.retentionDays });
  $('event-state').classList.toggle('is-open', ev.open);
  $('stat-days').textContent = ev.retentionDays;
  $('stat-days-unit').textContent = t('admin.stats.days', { count: ev.retentionDays });
  // Only fill the form when the user isn't editing it.
  if (!$('settings').contains(document.activeElement)) {
    $('ev-name').value = ev.name;
    $('ev-retention').value = ev.retentionDays;
    $('ev-lang').value = ev.lang ?? '';
    $('ev-style').value = ev.style;
    $('ev-open').checked = ev.open;
  }
  // After the invite code's days are up the event can't be opened again.
  $('ev-open').disabled = !ev.open && Boolean(ev.accessEnded);
  renderStyleAbout();
}

// One line on what the chosen reveal style looks like.
const renderStyleAbout = () => setText($('ev-style-about'), `style.${$('ev-style').value}.about`);
$('ev-style').addEventListener('change', renderStyleAbout);

$('settings').addEventListener('submit', async (e) => {
  e.preventDefault();
  const open = $('ev-open').checked;
  if (!open && state.event.open && !confirm(t('admin.settings.confirmClose'))) return;
  try {
    const { event } = await api(`${base}/event`, {
      method: 'PATCH',
      json: {
        name: $('ev-name').value, retentionDays: Number($('ev-retention').value), lang: $('ev-lang').value || null,
        style: $('ev-style').value, open,
      },
    });
    state.event = event;
    document.activeElement?.blur();
    await useEventLang(event.lang);
    renderEvent();
    renderPeople();
    toast(t('admin.settings.saved'));
  } catch (err) {
    toast(err.message, { error: true });
  }
});

// ---------- base image ----------
function renderBase() {
  const img = $('base-preview');
  img.hidden = !state.event.baseUrl;
  if (state.event.baseUrl && img.getAttribute('src') !== state.event.baseUrl) img.src = state.event.baseUrl;
}

$('base-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const file = $('base-file').files[0];
  if (!file) return;
  const form = new FormData();
  form.append('image', file);
  const button = $('base-form').querySelector('button'); // not e.submitter: missing in older Safari
  button.disabled = true;
  try {
    const { event } = await api(`${base}/base`, { method: 'POST', form });
    state.event = event;
    renderBase();
    renderPeople();
    $('base-form').reset();
    toast(t('admin.base.updated'));
  } catch (err) {
    toast(err.message, { error: true });
  } finally {
    button.disabled = false;
  }
});

// ---------- overview (counts belong on these pages only) ----------
function renderStats() {
  const sum = (k) => state.cosplayers.reduce((n, c) => n + c.counts[k], 0);
  const released = state.cosplayers.filter((c) => c.released).length;
  $('stat-pending').textContent = sum('pending');
  $('stat-approved').textContent = sum('approved');
  $('stat-cosplayers').textContent = state.cosplayers.length;
  $('stat-released').textContent = state.cosplayers.length ? t('admin.stats.released', { count: released }) : t('admin.stats.releasedNone');
  $('tab-review-n').textContent = sum('pending') ? String(sum('pending')) : '';
}

// Everything that shows cosplayers: the numbers, the folders, the open cosplayer's page, the tabs.
function renderPeople() {
  renderStats();
  renderFolders();
  if (view.cid && cosplayer(view.cid)) renderCosplayer(cosplayer(view.cid));
  renderNav();
  if (view.cid) renderTabs($('cos-tabs'), view.tab, (tab) => hashHref(`c/${view.cid}${tab === 'review' ? '' : `/${tab}`}`));
  const releasable = state.cosplayers.filter((c) => !c.released && !c.optOut);
  $('release-all').hidden = releasable.length === 0;
  setText($('release-all'), 'admin.releaseAll.labelCount', { count: releasable.length });
}

const fullUrl = (p) => new URL(url(p), document.baseURI).href;
const imageOf = (c) => c.baseUrl ?? state.event.baseUrl; // their own mosaic image, else the event's
const badgeOf = (c) => (c.optOut
  ? { cls: 'badge bad', key: 'admin.cos.optedOut' }
  : { cls: `badge ${c.released ? 'ok' : ''}`, key: c.released ? 'admin.cos.released' : 'admin.cos.notReleased' });

// The picture on top of a folder or a cosplayer's page: their image, the event's, or their initial.
function picture(c, cls) {
  const src = imageOf(c);
  return el('div', { class: `${cls}${src ? '' : ' no-image'}${c.baseUrl ? '' : ' event-image'}` },
    src ? el('img', { src, alt: '', loading: 'lazy' }) : el('span', { class: 'initial', text: Array.from(c.name)[0] ?? '?' }));
}

// ---------- the folders ----------
function renderFolders() {
  const cards = state.cosplayers.map((c) => {
    const b = badgeOf(c);
    return el('a', { class: 'folder', href: hashHref(`c/${c.id}`) },
      picture(c, 'folder-image'),
      el('div', { class: 'folder-body' },
        el('div', { class: 'spread' },
          el('h3', { text: c.name }),
          el('span', { class: b.cls, text: t(b.key) })),
        c.character ? el('div', { class: 'small muted', text: c.character }) : null,
        el('div', { class: 'folder-counts' },
          c.counts.pending ? el('span', { class: 'chip-count warn', text: t('admin.folder.toReview', { count: c.counts.pending }) }) : null,
          el('span', { class: 'chip-count', text: t('admin.folder.approved', { count: c.counts.approved }) }),
          el('span', { class: 'chip-count style', text: t(`style.${styleOfCos(c)}.name`) }))));
  });
  $('folders').replaceChildren(...cards);
  if (!state.cosplayers.length) {
    $('folders').replaceChildren(el('p', { class: 'empty', text: t('admin.cos.empty') }));
    // Nothing to show yet, so the add form is the next step: open it once, and let it stay closed after.
    if (!addOpened) { addOpened = true; $('side-add').open = true; }
  }
}
$('cos-form').addEventListener('submit', addCosplayer);

async function addCosplayer(e) {
  e.preventDefault();
  try {
    await api(`${base}/cosplayers`, {
      method: 'POST',
      json: { name: $('cos-name').value, character: $('cos-character').value },
    });
    $('cos-name').value = $('cos-character').value = '';
    await load();
    $('cos-name').focus();
  } catch (err) {
    toast(err.message, { error: true });
  }
}

// ---------- one cosplayer's page ----------
function renderCosplayer(c) {
  $('back').href = hashHref('');
  $('cos-pic').replaceChildren(picture(c, 'cos-pic-image'));
  $('cos-base-label').textContent = t(c.baseUrl ? 'admin.cos.baseOwn' : 'admin.cos.baseEvent');
  $('cos-title').textContent = c.name;
  $('cos-subtitle').textContent = c.character;
  $('cos-subtitle').hidden = !c.character;
  const b = badgeOf(c);
  $('cos-badge').className = b.cls;
  $('cos-badge').textContent = t(b.key);
  const input = el('input', { type: 'file', accept: 'image/*', hidden: true, onchange: () => uploadCosplayerBase(c, input) });
  // The picture choices live in the ⋯ menu beside the name, above Remove. Each closes the menu.
  $('cos-more-image').replaceChildren(...[input,
    el('button', { type: 'button', text: t(c.baseUrl ? 'admin.cos.baseReplace' : 'admin.cos.baseUseOwn'), onclick: () => { closeMoreMenu(); input.click(); }, disabled: c.optOut }),
    c.baseUrl && el('button', { type: 'button', text: t('admin.cos.baseUseEvent'), onclick: () => { closeMoreMenu(); clearCosplayerBase(c); } })].filter(Boolean));
  $('tab-c-review-n').textContent = c.counts.pending ? String(c.counts.pending) : '';
  renderAdd(c);

  const releaseId = `rel-${c.id}`, styleId = `style-${c.id}`, linkId = `link-${c.id}`;
  const linkInput = el('input', {
    id: linkId, type: 'text', inputmode: 'url', autocomplete: 'off', spellcheck: false, value: c.link ?? '',
    placeholder: t('admin.cos.linkPlaceholder'), disabled: c.optOut, 'aria-describedby': `${linkId}-note`,
  });
  const styleSelect = el('select', { id: styleId, onchange: (e) => setStyle(c, e.target) },
    el('option', { value: '', text: t('admin.cos.styleDefault', { style: t(`style.${state.event.style}.name`) }) }),
    ...STYLE_IDS.map((s) => el('option', { value: s, text: t(`style.${s}.name`) })));
  styleSelect.value = c.style ?? '';
  $('share-cards').replaceChildren(
    el('section', { class: 'panel' },
      el('h2', { text: t('admin.share.revealHeading') }),
      el('p', { class: 'muted', text: t('admin.share.revealText') }),
      el('div', { class: 'field' },
        el('label', { for: styleId, text: t('admin.cos.style') }),
        styleSelect,
        el('p', { class: 'small', text: t(`style.${styleOfCos(c)}.about`) })),
      el('label', { class: 'check', for: releaseId },
        el('input', { id: releaseId, type: 'checkbox', checked: c.released, disabled: c.optOut, onchange: (e) => setReleased(c, e.target) }),
        t('admin.cos.canOpen')),
      el('div', { class: 'row' },
        // The static demo has no organizer API to preview through; there it opens the demo reveal.
        el('a', {
          class: 'button primary', target: '_blank', rel: 'noopener', text: t('admin.cos.preview'),
          href: STATIC ? url(c.revealPath) : url(`/admin/${encodeURIComponent(token)}/preview/${c.id}/`),
        }),
        el('button', { type: 'button', text: t('admin.cos.copyReveal'), onclick: () => copyText(fullUrl(c.revealPath)) })),
      el('p', { class: 'small muted', text: t('admin.cos.previewNote') })),
    el('section', { class: 'panel' },
      el('h2', { text: t('admin.share.fanHeading') }),
      el('p', { class: 'muted', text: t('admin.share.fanText') }),
      el('img', { class: 'qr-preview', src: url(`${base}/qr/${c.id}.svg`), alt: t('admin.share.qrAlt', { name: c.name }) }),
      el('div', { class: 'row' },
        el('a', {
          class: 'button primary', href: url(`/admin/${encodeURIComponent(token)}/print/${c.id}/`), target: '_blank',
          rel: 'noopener', text: t('admin.cos.printSign'),
        }),
        el('a', { class: 'button', href: url(`${base}/qr/${c.id}.svg`), download: `qr-${slug(c.name)}.svg`, text: t('admin.cos.downloadQr') }),
        el('button', { type: 'button', text: t('admin.cos.copyFan'), onclick: () => copyText(fullUrl(c.fanPath)) })),
      // The cosplayer's own page, shown to fans as a "Follow" link. Optional: ask the cosplayer first.
      el('form', { class: 'field link-form', onsubmit: (e) => { e.preventDefault(); setLink(c, linkInput); } },
        el('label', { for: linkId, text: t('admin.cos.link') }),
        el('div', { class: 'row link-row' }, linkInput,
          el('button', { type: 'submit', text: t('admin.cos.linkSave'), disabled: c.optOut })),
        el('p', { class: 'small muted', id: `${linkId}-note`, text: t('admin.cos.linkNote') }))));
}

// The ⋯ menu beside the cosplayer's name. It holds Remove, which asks once more in a dialog.
function closeMoreMenu() {
  $('cos-more-options').hidden = true;
  $('cos-more-toggle').setAttribute('aria-expanded', 'false');
}
$('cos-more-toggle').addEventListener('click', () => {
  const open = $('cos-more-options').hidden;
  $('cos-more-options').hidden = !open;
  $('cos-more-toggle').setAttribute('aria-expanded', String(open));
  if (open) $('cos-more-options').querySelector('button:not(:disabled)')?.focus();
});
document.addEventListener('click', (e) => { if (!e.target.closest('#cos-more')) closeMoreMenu(); });
$('cos-more').addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || $('cos-more-options').hidden) return;
  e.stopPropagation();
  closeMoreMenu();
  $('cos-more-toggle').focus();
});
$('cos-remove').addEventListener('click', () => {
  closeMoreMenu();
  const c = view.cid && cosplayer(view.cid);
  if (c) askRemoveCosplayer(c);
});

let removing = null; // the cosplayer the open dialog is about
function askRemoveCosplayer(c) {
  removing = c;
  const total = c.counts.pending + c.counts.approved + c.counts.rejected;
  setText($('remove-title'), 'admin.cos.removeTitle', { name: c.name });
  setText($('remove-text'), 'admin.cos.confirmRemove', { name: c.name, count: total });
  $('remove-confirm').disabled = false;
  $('remove-dialog').showModal();
  $('remove-cancel').focus(); // the safe choice has focus, so a stray Enter doesn't delete
}
$('remove-cancel').addEventListener('click', () => $('remove-dialog').close());
$('remove-dialog').addEventListener('close', () => {
  removing = null;
  if (!$('view-cosplayer').hidden) $('cos-more-toggle').focus(); // after a removal the page has moved on
});
$('remove-confirm').addEventListener('click', async () => {
  if (!removing) return;
  $('remove-confirm').disabled = true;
  const ok = await removeCosplayer(removing);
  if (ok) $('remove-dialog').close();
  else $('remove-confirm').disabled = false;
});

// ---------- the organizer's own photos ----------
// Picked (or dropped) photos go up one at a time, each resized first like on the fan page, so a big
// batch never sits in memory at once and one bad file only costs itself. They arrive approved.
let batch = null; // { cid, name, total, done, failed: [{ file, key, vars }] }: the last batch sent
let uploading = false;
let addFor = null; // the cosplayer the picked files and the ticked box are for
let addConsentLang = null; // the language of the statement when the box was ticked

const isImageFile = (f) => /^image\//.test(f.type) || /\.(heic|heif)$/i.test(f.name);

function renderAdd(c) {
  if (addFor !== c.id && !uploading) { // a new cosplayer's page starts with nothing picked or ticked
    addFor = c.id;
    $('add-form').reset();
  }
  // The statement shown is the one agreed to, so a language switch asks again.
  if ($('add-consent').checked && addConsentLang !== lang) $('add-consent').checked = false;
  const copy = state.uploadConsent?.[lang] ?? state.uploadConsent?.en;
  $('add-text').textContent = copy ? copy.text.replaceAll('{name}', c.name) : '';
  $('add-checkbox').textContent = copy?.checkbox ?? '';
  const count = $('add-files').files.length;
  setText($('add-chosen'), count ? 'admin.add.chosen' : 'admin.add.dropHint', count ? { count } : undefined);
  setText($('add-submit'), count ? 'admin.add.upload' : 'admin.add.uploadNone', count ? { count } : undefined);
  const closed = c.optOut || state.event.accessEnded;
  $('add-files').disabled = $('add-consent').disabled = uploading || closed;
  $('add-submit').disabled = uploading || closed || !count || !$('add-consent').checked;
  renderBatch();
}

function renderBatch() {
  $('add-status').hidden = !uploading;
  if (uploading) {
    $('add-progress').value = batch.done / batch.total;
    setText($('add-progress-text'), 'admin.add.progress', { name: batch.name, done: batch.done, total: batch.total });
  }
  const failed = !uploading && batch?.cid === view.cid ? batch.failed : [];
  $('add-failed').hidden = !failed.length;
  if (!failed.length) return;
  setText($('add-failed-text'), 'admin.add.failed', { count: failed.length });
  $('add-failed-list').replaceChildren(...failed.map((f) =>
    el('li', { text: t('admin.add.failedItem', { file: f.file.name, message: t(f.key, f.vars) }) })));
  $('add-retry').disabled = !$('add-consent').checked;
}

async function sendBatch(c, files) {
  uploading = true;
  batch = { cid: c.id, name: c.name, total: files.length, done: 0, failed: [] };
  const consentLang = addConsentLang;
  renderAdd(c);
  let stop = null; // an error every later photo would get too
  for (const file of files) {
    if (!stop) {
      const form = new FormData();
      form.append('consent', '1');
      form.append('consentLang', consentLang);
      form.append('photo', (await prepareImage(file)) ?? file, 'photo');
      try {
        await api(`${base}/cosplayers/${c.id}/photos`, { method: 'POST', form });
      } catch (err) {
        const e = err.key ? { key: err.key, vars: err.vars } : errorKey(null, 0);
        batch.failed.push({ file, ...e });
        // Closed page, full page, ended access, removed cosplayer, or the view-only demo.
        if ([403, 404, 409].includes(err.status) || err.key === 'error.view_only') stop = e;
      }
    } else {
      batch.failed.push({ file, ...stop });
    }
    batch.done++;
    renderBatch();
  }
  uploading = false;
  $('add-files').value = '';
  const added = batch.total - batch.failed.length;
  if (added) toast(t('admin.add.done', { count: added, name: c.name }));
  else toast(t('admin.add.failed', { count: batch.failed.length }), { error: true });
  // The new photos show through the quiet refresh, which never redraws over typing, an open menu, the
  // Settings form, or keyboard review (it tries again on its next tick). The panel itself updates now.
  await refreshQuietly();
  const cur = cosplayer(view.cid);
  if (cur) renderAdd(cur);
}

$('add-files').addEventListener('change', () => { const c = cosplayer(view.cid); if (c) renderAdd(c); });
$('add-consent').addEventListener('change', () => {
  addConsentLang = lang;
  const c = cosplayer(view.cid);
  if (c) renderAdd(c);
});
$('add-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const c = cosplayer(view.cid);
  const files = [...$('add-files').files].filter(isImageFile);
  if (c && files.length && $('add-consent').checked && !uploading) sendBatch(c, files);
});
$('add-retry').addEventListener('click', () => {
  const c = cosplayer(view.cid);
  if (c && batch?.cid === c.id && $('add-consent').checked && !uploading) sendBatch(c, batch.failed.map((f) => f.file));
});
// Photos can also be dropped onto the panel, e.g. a folder's worth from the file manager.
const drop = $('add-drop');
drop.addEventListener('dragover', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault(); // even while busy: an unhandled drop would open the file and leave the page
  if (!uploading && !$('add-files').disabled) drop.classList.add('dragging');
});
drop.addEventListener('dragleave', (e) => { if (!drop.contains(e.relatedTarget)) drop.classList.remove('dragging'); });
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('dragging');
  const c = cosplayer(view.cid);
  if (!c || uploading || $('add-files').disabled) return;
  const picked = new DataTransfer();
  for (const f of e.dataTransfer.files) if (isImageFile(f)) picked.items.add(f);
  $('add-files').files = picked.files;
  renderAdd(c);
});
window.addEventListener('beforeunload', (e) => { if (uploading) { e.preventDefault(); e.returnValue = ''; } });

// The reveal style a cosplayer gets: their own, else the event's default.
const styleOfCos = (c) => c.style ?? state.event.style;

async function setStyle(c, select) {
  const style = select.value || null;
  try {
    ({ style: c.style } = await api(`${base}/cosplayers/${c.id}`, { method: 'PATCH', json: { style } }));
    toast(t('admin.cos.styleSaved', { name: c.name, style: t(`style.${styleOfCos(c)}.name`) }));
  } catch (err) {
    toast(err.message, { error: true });
  }
  renderPeople();
}

async function setLink(c, input) {
  try {
    ({ link: c.link } = await api(`${base}/cosplayers/${c.id}`, { method: 'PATCH', json: { link: input.value } }));
    input.value = c.link ?? ''; // as the server tidied it, e.g. with https:// added
    toast(t(c.link ? 'admin.cos.linkSaved' : 'admin.cos.linkRemoved', { name: c.name }));
  } catch (err) {
    toast(err.message, { error: true });
  }
}

async function uploadCosplayerBase(c, input) {
  const file = input.files[0];
  if (!file) return;
  const form = new FormData();
  form.append('image', file);
  toast(t('admin.toast.uploading'));
  try {
    ({ baseUrl: c.baseUrl } = await api(`${base}/cosplayers/${c.id}/base`, { method: 'POST', form }));
    toast(t('admin.cos.baseSet', { name: c.name }));
  } catch (err) {
    toast(err.message, { error: true });
  }
  renderPeople();
}

async function clearCosplayerBase(c) {
  try {
    ({ baseUrl: c.baseUrl } = await api(`${base}/cosplayers/${c.id}/base`, { method: 'DELETE' }));
    toast(t('admin.cos.baseCleared', { name: c.name }));
  } catch (err) {
    toast(err.message, { error: true });
  }
  renderPeople();
}

$('release-all').addEventListener('click', async () => {
  const targets = state.cosplayers.filter((c) => !c.released && !c.optOut);
  const pending = targets.reduce((n, c) => n + c.counts.pending, 0);
  let question = t('admin.releaseAll.confirm', { count: targets.length });
  if (pending) question += `\n\n${t('admin.releaseAll.pendingNote', { count: pending })}`;
  if (!targets.length || !confirm(question)) return;
  try {
    const { updated } = await api(`${base}/release-all`, { method: 'POST', json: { released: true } });
    const ids = new Set(updated);
    for (const c of state.cosplayers) if (ids.has(c.id)) c.released = true;
    toast(t('admin.releaseAll.done', { count: updated.length }));
  } catch (err) {
    toast(err.message, { error: true });
  }
  renderPeople();
});

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'cosplayer';

async function setReleased(c, input) {
  const released = input.checked;
  if (released && c.counts.pending > 0 && !confirm(t('admin.cos.releasePending', { name: c.name, count: c.counts.pending }))) {
    input.checked = false;
    return;
  }
  input.disabled = true;
  try {
    await api(`${base}/cosplayers/${c.id}/release`, { method: 'POST', json: { released } });
    c.released = released;
    toast(t(released ? 'admin.cos.releasedToast' : 'admin.cos.unreleasedToast', { name: c.name }));
  } catch (err) {
    input.checked = !released;
    toast(err.message, { error: true });
  }
  renderPeople();
}

// Called from the confirm dialog only. True when the cosplayer is gone.
async function removeCosplayer(c) {
  try {
    await api(`${base}/cosplayers/${c.id}`, { method: 'DELETE' });
  } catch (err) {
    toast(err.message, { error: true });
    return false;
  }
  toast(t('admin.cos.removed', { name: c.name }));
  history.replaceState(null, '', hashHref(''));
  await load();
  return true;
}

// ---------- moderation ----------
// One pill per cosplayer, each with how many items match the status filter (home Review tab only).
function renderFilters() {
  const count = (id) => state.submissions.filter((s) =>
    (id === 'all' || s.cosplayerId === id) && (filter.status === 'all' || s.status === filter.status)).length;
  const focused = document.activeElement?.closest?.('#f-cos button')?.dataset.value;
  $('f-cos').replaceChildren(...[{ id: 'all', name: t('admin.filter.all') }, ...state.cosplayers].map((c) =>
    el('button', {
      type: 'button', 'data-value': c.id, 'aria-pressed': String(filter.cosplayer === c.id),
      onclick: () => { filter.cosplayer = homeCos = c.id; renderGrid(); },
    }, c.name, el('span', { class: 'n', text: String(count(c.id)) }))));
  if (focused) $('f-cos').querySelector(`[data-value="${CSS.escape(focused)}"]`)?.focus();
  $('f-status').value = filter.status;
}

$('f-status').addEventListener('change', (e) => { filter.status = e.target.value; renderGrid(); });

const visible = () => state.submissions.filter((s) =>
  (filter.cosplayer === 'all' || s.cosplayerId === filter.cosplayer) &&
  (filter.status === 'all' || s.status === filter.status));

const STATUS_BADGE = { pending: 'warn', approved: 'ok', rejected: 'bad' };

function renderGrid(focusIndex = null) {
  renderFilters();
  const items = visible();
  const names = new Map(state.cosplayers.map((c) => [c.id, c.name]));
  const pendingShown = items.filter((s) => s.status === 'pending').length;
  $('bulk-approve').disabled = pendingShown === 0;
  setText($('bulk-approve'), pendingShown ? 'admin.bulk.labelCount' : 'admin.bulk.label', pendingShown ? { count: pendingShown } : undefined);

  const grid = $('grid');
  if (!items.length) {
    grid.replaceChildren(el('p', { class: 'empty', text: t(`admin.grid.empty.${filter.status}`) }));
    return;
  }
  grid.replaceChildren(...items.map((s) => {
    const who = s.fromOrganizer ? t('admin.card.fromOrganizer')
      : s.name ? (s.credit ? s.name : t('admin.card.notCredited', { name: s.name })) : t('admin.card.noName');
    const status = t(`status.${s.status}`);
    const cosplayerName = names.get(s.cosplayerId) ?? t('admin.card.unknown');
    return el('article', {
      class: `card${s.thumbUrl ? '' : ' note-only'}`, tabIndex: 0, 'data-id': s.id, 'data-status': s.status,
      'aria-label': t(s.thumbUrl ? 'admin.card.labelPhoto' : 'admin.card.labelNote', { cosplayer: cosplayerName, status }),
    },
      s.thumbUrl
        ? el('a', { class: 'thumb', href: s.fullUrl, target: '_blank', rel: 'noopener', tabIndex: -1 },
          el('img', {
            src: s.thumbUrl, loading: 'lazy',
            alt: s.fromOrganizer ? t('admin.card.altOrganizer')
              : s.message ? t('admin.card.altMessage', { message: s.message }) : t('admin.card.alt'),
          }))
        : null,
      el('div', { class: 'body' },
        s.message ? el('p', { class: 'message', text: s.message }) : null,
        el('div', { class: 'meta' },
          el('span', { class: `badge ${STATUS_BADGE[s.status]}`, text: status }), ' ',
          `${view.cid ? '' : `${names.get(s.cosplayerId) ?? ''} · `}${who} · ${formatDateTime(s.createdAt)}`)),
      // Reject on the left, Approve on the right, split across the card's foot.
      el('div', { class: 'actions' },
        el('button', {
          type: 'button', class: 'reject', text: t('admin.card.reject'), disabled: s.status === 'rejected',
          onclick: () => setStatus(s.id, 'rejected'),
        }),
        el('button', {
          type: 'button', class: 'approve', text: t('admin.card.approve'), disabled: s.status === 'approved',
          onclick: () => setStatus(s.id, 'approved'),
        })));
  }));
  if (focusIndex !== null) {
    const cards = grid.querySelectorAll('.card');
    cards[Math.min(focusIndex, cards.length - 1)]?.focus();
  }
}

function applyStatus(ids, status) {
  const set = new Set(ids);
  for (const s of state.submissions) if (set.has(s.id)) s.status = status;
  const counts = new Map(state.cosplayers.map((c) => [c.id, { pending: 0, approved: 0, rejected: 0 }]));
  for (const s of state.submissions) { const k = counts.get(s.cosplayerId); if (k) k[s.status]++; }
  for (const c of state.cosplayers) c.counts = counts.get(c.id);
}

async function setStatus(id, status) {
  const cards = [...$('grid').querySelectorAll('.card')];
  const index = cards.findIndex((c) => c.dataset.id === id);
  try {
    await api(`${base}/submissions/${encodeURIComponent(id)}`, { method: 'PATCH', json: { status } });
    applyStatus([id], status);
    renderPeople();
    // Keep focus on the same slot so the next item is ready for A/R.
    renderGrid(index < 0 ? null : index);
  } catch (err) {
    toast(err.message, { error: true });
  }
}

$('bulk-approve').addEventListener('click', async () => {
  const ids = visible().filter((s) => s.status === 'pending').map((s) => s.id);
  if (!ids.length || !confirm(t('admin.bulk.confirm', { count: ids.length }))) return;
  let done = 0;
  try {
    for (let i = 0; i < ids.length; i += 1000) {
      const { updated } = await api(`${base}/submissions/bulk`, {
        method: 'POST', json: { ids: ids.slice(i, i + 1000), status: 'approved' },
      });
      applyStatus(updated, 'approved');
      done += updated.length;
    }
    toast(t('admin.bulk.done', { count: done }));
  } catch (err) {
    toast(err.message, { error: true });
  }
  renderPeople();
  renderGrid();
});

$('grid').addEventListener('keydown', (e) => {
  const card = e.target.closest?.('.card');
  if (!card || e.target !== card || e.ctrlKey || e.metaKey || e.altKey) return;
  const cards = [...$('grid').querySelectorAll('.card')];
  const i = cards.indexOf(card);
  const perRow = cards.filter((c) => c.offsetTop === cards[0].offsetTop).length || 1;
  const move = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: perRow, ArrowUp: -perRow }[e.key];
  if (move) {
    e.preventDefault();
    cards[Math.max(0, Math.min(cards.length - 1, i + move))].focus();
  } else if (e.key === 'a' || e.key === 'A') {
    e.preventDefault();
    setStatus(card.dataset.id, 'approved');
  } else if (e.key === 'r' || e.key === 'R') {
    e.preventDefault();
    setStatus(card.dataset.id, 'rejected');
  }
});


onLangChange(() => {
  renderKeysHint();
  if (state) render();
});

renderKeysHint();
load();
