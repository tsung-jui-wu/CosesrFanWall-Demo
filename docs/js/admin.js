import { api, el, toast, copyText, url, segmentAfter, STATIC } from './api.js';
import { t, setText, setTitle, formatDateTime, onLangChange, useEventLang } from './i18n.js';
import { STYLE_IDS } from './styles.js';

const token = segmentAfter('admin');
const base = `/api/admin/${encodeURIComponent(token)}`;
const $ = (id) => document.getElementById(id);

let state = null;
const filter = { cosplayer: 'all', status: 'pending' };
// Where we are: the home page and one of its tabs, or one cosplayer's page and one of its tabs.
// It lives in the address's #, so the back button and bookmarks work: #review, #c/<id>, #c/<id>/share.
const view = { cid: null, tab: 'cosplayers' };
let homeCos = 'all'; // the cosplayer picked in the home Review tab's pills

if (new URLSearchParams(location.search).has('new')) {
  $('new-notice').hidden = false;
  history.replaceState(null, '', location.pathname);
}

async function load() {
  try {
    state = await api(base);
    await useEventLang(state.event.lang);
    route();
  } catch (err) {
    if (err.status === 404) {
      $('dash-body').hidden = true;
      $('admin-error').hidden = false;
      $('refresh').hidden = true;
    } else {
      toast(err.message, { error: true });
    }
  }
}

function render() {
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
  if (a === 'c' && cosplayer(b)) Object.assign(view, { cid: b, tab: c === 'share' ? 'share' : 'review' });
  else Object.assign(view, { cid: null, tab: ['review', 'settings'].includes(a) ? a : 'cosplayers' });
  // A cosplayer's page shows only theirs; the home Review tab keeps its own pick.
  if (!cosplayer(homeCos)) homeCos = 'all';
  filter.cosplayer = view.cid ?? homeCos;
  $('view-home').hidden = Boolean(view.cid);
  $('view-cosplayer').hidden = !view.cid;
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
for (const list of [$('home-tabs'), $('cos-tabs')]) {
  list.addEventListener('keydown', (e) => {
    const tabs = [...list.querySelectorAll('[role="tab"]')];
    const i = tabs.indexOf(document.activeElement);
    const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (i < 0 || to === undefined) return;
    e.preventDefault();
    const next = tabs[(to + tabs.length) % tabs.length];
    next.focus();
    next.click();
  });
}

// "Keys: [A] approve, [R] reject, ...": the bracketed letters become <kbd>, in any language.
function renderKeysHint() {
  const parts = t('admin.keys').split(/\[(.+?)\]/);
  $('keys-hint').replaceChildren(...parts.map((p, i) => (i % 2 ? el('kbd', { text: p }) : p)));
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
  renderTabs($('home-tabs'), view.tab, (tab) => hashHref(tab === 'cosplayers' ? '' : tab));
  if (view.cid) renderTabs($('cos-tabs'), view.tab, (tab) => hashHref(`c/${view.cid}${tab === 'share' ? '/share' : ''}`));
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
  const add = el('form', { class: 'folder folder-add', id: 'cos-form' },
    el('h3', { text: t('admin.cos.addHeading') }),
    el('div', { class: 'field' },
      el('label', { for: 'cos-name', text: t('admin.cos.name') }),
      el('input', { id: 'cos-name', type: 'text', maxLength: 60, required: true, autocomplete: 'off' })),
    el('div', { class: 'field' },
      el('label', { for: 'cos-character' }, t('admin.cos.character'), ' ', el('span', { class: 'muted', text: t('common.optionalInline') })),
      el('input', { id: 'cos-character', type: 'text', maxLength: 60, autocomplete: 'off' })),
    el('button', { type: 'submit', class: 'primary', text: t('admin.cos.add') }));
  add.addEventListener('submit', addCosplayer);
  // Keep what's being typed in the add form across a re-render.
  const typing = $('cos-form') && { name: $('cos-name').value, character: $('cos-character').value, focus: document.activeElement?.id };
  $('folders').replaceChildren(...cards, add);
  if (typing) {
    $('cos-name').value = typing.name;
    $('cos-character').value = typing.character;
    if (typing.focus === 'cos-name' || typing.focus === 'cos-character') $(typing.focus).focus();
  }
  if (!state.cosplayers.length) $('folders').prepend(el('p', { class: 'empty', text: t('admin.cos.empty') }));
}

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
  $('cos-banner').replaceChildren(picture(c, 'cos-banner-image'),
    el('span', { class: 'banner-label', text: t(c.baseUrl ? 'admin.cos.baseOwn' : 'admin.cos.baseEvent') }));
  $('cos-title').textContent = c.name;
  $('cos-subtitle').textContent = c.character;
  $('cos-subtitle').hidden = !c.character;
  const b = badgeOf(c);
  $('cos-badge').className = b.cls;
  $('cos-badge').textContent = t(b.key);
  const input = el('input', { type: 'file', accept: 'image/*', hidden: true, onchange: () => uploadCosplayerBase(c, input) });
  $('cos-image-row').replaceChildren(...[input,
    el('button', { type: 'button', text: t(c.baseUrl ? 'admin.cos.baseReplace' : 'admin.cos.baseUseOwn'), onclick: () => input.click(), disabled: c.optOut }),
    c.baseUrl && el('button', { type: 'button', text: t('admin.cos.baseUseEvent'), onclick: () => clearCosplayerBase(c) })].filter(Boolean));
  $('tab-c-review-n').textContent = c.counts.pending ? String(c.counts.pending) : '';

  const releaseId = `rel-${c.id}`, styleId = `style-${c.id}`;
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
        el('button', { type: 'button', text: t('admin.cos.copyFan'), onclick: () => copyText(fullUrl(c.fanPath)) }))),
    el('section', { class: 'panel danger-card' },
      el('h2', { text: t('admin.share.removeHeading') }),
      el('p', { class: 'muted', text: t('admin.share.removeText') }),
      el('button', { type: 'button', class: 'danger', text: t('admin.cos.remove'), onclick: () => removeCosplayer(c) })));
}

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

async function removeCosplayer(c) {
  const total = c.counts.pending + c.counts.approved + c.counts.rejected;
  if (!confirm(t('admin.cos.confirmRemove', { name: c.name, count: total }))) return;
  try {
    await api(`${base}/cosplayers/${c.id}`, { method: 'DELETE' });
    toast(t('admin.cos.removed', { name: c.name }));
    history.replaceState(null, '', hashHref(''));
    await load();
  } catch (err) {
    toast(err.message, { error: true });
  }
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
    const who = s.name ? (s.credit ? s.name : t('admin.card.notCredited', { name: s.name })) : t('admin.card.noName');
    const status = t(`status.${s.status}`);
    const cosplayerName = names.get(s.cosplayerId) ?? t('admin.card.unknown');
    return el('article', {
      class: `card${s.thumbUrl ? '' : ' note-only'}`, tabIndex: 0, 'data-id': s.id, 'data-status': s.status,
      'aria-label': t(s.thumbUrl ? 'admin.card.labelPhoto' : 'admin.card.labelNote', { cosplayer: cosplayerName, status }),
    },
      s.thumbUrl
        ? el('a', { class: 'thumb', href: s.fullUrl, target: '_blank', rel: 'noopener', tabIndex: -1 },
          el('img', { src: s.thumbUrl, alt: s.message ? t('admin.card.altMessage', { message: s.message }) : t('admin.card.alt'), loading: 'lazy' }))
        : null,
      el('div', { class: 'body' },
        s.message ? el('p', { class: 'message', text: s.message }) : null,
        el('div', { class: 'meta' },
          el('span', { class: `badge ${STATUS_BADGE[s.status]}`, text: status }), ' ',
          `${view.cid ? '' : `${names.get(s.cosplayerId) ?? ''} · `}${who} · ${formatDateTime(s.createdAt)}`),
        el('div', { class: 'actions' },
          el('button', {
            type: 'button', text: t('admin.card.approve'), disabled: s.status === 'approved',
            onclick: () => setStatus(s.id, 'approved'),
          }),
          el('button', {
            type: 'button', class: 'danger', text: t('admin.card.reject'), disabled: s.status === 'rejected',
            onclick: () => setStatus(s.id, 'rejected'),
          }))));
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

$('refresh').addEventListener('click', load);

onLangChange(() => {
  renderKeysHint();
  if (state) render();
});

renderKeysHint();
load();
