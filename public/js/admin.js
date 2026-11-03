import { api, el, toast, copyText, url, segmentAfter } from './api.js';

const token = segmentAfter('admin');
const base = `/api/admin/${encodeURIComponent(token)}`;
const $ = (id) => document.getElementById(id);

let state = null;
const filter = { cosplayer: 'all', status: 'pending' };

if (new URLSearchParams(location.search).has('new')) {
  $('new-notice').hidden = false;
  history.replaceState(null, '', location.pathname);
}

async function load() {
  try {
    state = await api(base);
    render();
  } catch (err) {
    toast(err.message, { error: true });
  }
}

function render() {
  renderEvent();
  renderBase();
  renderCosplayers();
  renderGrid();
}

// ---------- event ----------
function renderEvent() {
  const ev = state.event;
  document.title = `${ev.name} · FanWall`;
  $('event-title').textContent = ev.name;
  $('event-state').textContent = ev.open
    ? 'Open: fans can send photos and notes.'
    : `Closed ${new Date(ev.closedAt).toLocaleString()}. Submissions are deleted ${ev.retentionDays} days after closing.`;
  $('event-state').classList.toggle('is-open', ev.open);
  $('stat-days').textContent = ev.retentionDays;
  // Only fill the form when the user isn't editing it.
  if (!$('settings').contains(document.activeElement)) {
    $('ev-name').value = ev.name;
    $('ev-retention').value = ev.retentionDays;
    $('ev-open').checked = ev.open;
  }
}

$('settings').addEventListener('submit', async (e) => {
  e.preventDefault();
  const open = $('ev-open').checked;
  if (!open && state.event.open &&
      !confirm('Close the event? Fans will no longer be able to send anything, and the retention countdown starts.')) return;
  try {
    const { event } = await api(`${base}/event`, {
      method: 'PATCH',
      json: { name: $('ev-name').value, retentionDays: Number($('ev-retention').value), open },
    });
    state.event = event;
    document.activeElement?.blur();
    renderEvent();
    toast('Settings saved.');
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
    $('base-form').reset();
    toast('Mosaic image updated.');
  } catch (err) {
    toast(err.message, { error: true });
  } finally {
    button.disabled = false;
  }
});

// ---------- overview (counts belong on this page only) ----------
function renderStats() {
  const sum = (k) => state.cosplayers.reduce((n, c) => n + c.counts[k], 0);
  const released = state.cosplayers.filter((c) => c.released).length;
  $('stat-pending').textContent = sum('pending');
  $('stat-approved').textContent = sum('approved');
  $('stat-cosplayers').textContent = state.cosplayers.length;
  $('stat-released').textContent = state.cosplayers.length ? `${released} ${released === 1 ? 'link' : 'links'} released` : 'none yet';
}

// ---------- cosplayers ----------
const fullUrl = (p) => new URL(url(p), document.baseURI).href;

function renderCosplayers() {
  renderStats();
  const list = $('cosplayers');
  const releasable = state.cosplayers.filter((c) => !c.released && !c.optOut);
  $('release-all').hidden = releasable.length === 0;
  $('release-all').textContent = `Release all (${releasable.length})`;
  if (!state.cosplayers.length) {
    list.replaceChildren(el('p', { class: 'empty', text: 'Add a cosplayer to get their QR sign and reveal link.' }));
    return;
  }
  list.replaceChildren(...state.cosplayers.map((c) => {
    const n = c.counts;
    const releaseId = `rel-${c.id}`;
    return el('article', { class: 'cosplayer', 'aria-label': c.name },
      el('div', { class: 'spread' },
        el('div', {},
          el('h3', { text: c.name }),
          c.character ? el('div', { class: 'small muted', text: c.character }) : null),
        c.optOut
          ? el('span', { class: 'badge bad', text: 'Opted out' })
          : el('span', { class: `badge ${c.released ? 'ok' : ''}`, text: c.released ? 'Released' : 'Not released' })),
      el('div', { class: 'counts', text: `${n.pending} pending · ${n.approved} approved · ${n.rejected} rejected` }),
      el('label', { class: 'check', for: releaseId },
        el('input', {
          id: releaseId, type: 'checkbox', checked: c.released, disabled: c.optOut,
          onchange: (e) => setReleased(c, e.target),
        }),
        'Cosplayer can open their reveal link'),
      cosplayerBase(c),
      el('div', { class: 'row' },
        el('button', { type: 'button', text: 'Copy reveal link', onclick: () => copyText(fullUrl(c.revealPath)) }),
        el('button', { type: 'button', text: 'Copy fan link', onclick: () => copyText(fullUrl(c.fanPath)) })),
      el('div', { class: 'row' },
        el('a', { class: 'button', href: url(`${base}/qr/${c.id}.svg`), download: `qr-${slug(c.name)}.svg`, text: 'Download QR' }),
        el('a', {
          class: 'button', href: url(`/admin/${encodeURIComponent(token)}/print/${c.id}/`), target: '_blank',
          rel: 'noopener', text: 'Print sign',
        }),
        el('button', { type: 'button', class: 'danger', text: 'Remove', onclick: () => removeCosplayer(c) })));
  }));
}

// Optional per-cosplayer mosaic image; falls back to the event image.
function cosplayerBase(c) {
  const input = el('input', { type: 'file', accept: 'image/*', hidden: true, onchange: () => uploadCosplayerBase(c, input) });
  return el('div', { class: 'cos-base' },
    c.baseUrl ? el('img', { src: c.baseUrl, alt: `Mosaic image for ${c.name}` }) : null,
    el('div', {},
      el('div', { class: 'small muted', text: c.baseUrl ? 'Own mosaic image' : 'Uses the event mosaic image' }),
      el('div', { class: 'row' },
        input,
        el('button', { type: 'button', text: c.baseUrl ? 'Replace image' : 'Use own image', onclick: () => input.click() }),
        c.baseUrl ? el('button', { type: 'button', text: 'Use event image', onclick: () => clearCosplayerBase(c) }) : null)));
}

async function uploadCosplayerBase(c, input) {
  const file = input.files[0];
  if (!file) return;
  const form = new FormData();
  form.append('image', file);
  toast('Uploading…');
  try {
    ({ baseUrl: c.baseUrl } = await api(`${base}/cosplayers/${c.id}/base`, { method: 'POST', form }));
    toast(`Mosaic image set for ${c.name}.`);
  } catch (err) {
    toast(err.message, { error: true });
  }
  renderCosplayers();
}

async function clearCosplayerBase(c) {
  try {
    ({ baseUrl: c.baseUrl } = await api(`${base}/cosplayers/${c.id}/base`, { method: 'DELETE' }));
    toast(`${c.name} now uses the event image.`);
  } catch (err) {
    toast(err.message, { error: true });
  }
  renderCosplayers();
}

$('release-all').addEventListener('click', async () => {
  const targets = state.cosplayers.filter((c) => !c.released && !c.optOut);
  const pending = targets.reduce((n, c) => n + c.counts.pending, 0);
  const note = pending ? ` ${pending} item(s) are still pending and won't be shown until approved.` : '';
  if (!targets.length || !confirm(`Release the reveal to ${targets.length} cosplayer(s) at once?${note}`)) return;
  try {
    const { updated } = await api(`${base}/release-all`, { method: 'POST', json: { released: true } });
    const ids = new Set(updated);
    for (const c of state.cosplayers) if (ids.has(c.id)) c.released = true;
    toast(`Released to ${updated.length} cosplayer(s).`);
  } catch (err) {
    toast(err.message, { error: true });
  }
  renderCosplayers();
});

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'cosplayer';

async function setReleased(c, input) {
  const released = input.checked;
  if (released && c.counts.pending > 0 &&
      !confirm(`${c.name} still has ${c.counts.pending} pending item(s), which they won't see until approved. Release anyway?`)) {
    input.checked = false;
    return;
  }
  input.disabled = true;
  try {
    await api(`${base}/cosplayers/${c.id}/release`, { method: 'POST', json: { released } });
    c.released = released;
    toast(released ? `${c.name} can now open their reveal.` : `Reveal hidden from ${c.name}.`);
  } catch (err) {
    input.checked = !released;
    toast(err.message, { error: true });
  }
  renderCosplayers();
}

async function removeCosplayer(c) {
  const total = c.counts.pending + c.counts.approved + c.counts.rejected;
  if (!confirm(`Remove ${c.name} and permanently delete their ${total} submission(s)? This can't be undone.`)) return;
  try {
    await api(`${base}/cosplayers/${c.id}`, { method: 'DELETE' });
    toast(`${c.name} removed.`);
    await load();
  } catch (err) {
    toast(err.message, { error: true });
  }
}

$('cos-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api(`${base}/cosplayers`, {
      method: 'POST',
      json: { name: $('cos-name').value, character: $('cos-character').value },
    });
    $('cos-form').reset();
    $('cos-name').focus();
    await load();
  } catch (err) {
    toast(err.message, { error: true });
  }
});

// ---------- moderation ----------
// One pill per cosplayer, each with how many items match the status filter.
function renderFilters() {
  if (filter.cosplayer !== 'all' && !state.cosplayers.some((c) => c.id === filter.cosplayer)) filter.cosplayer = 'all';
  const count = (id) => state.submissions.filter((s) =>
    (id === 'all' || s.cosplayerId === id) && (filter.status === 'all' || s.status === filter.status)).length;
  const focused = document.activeElement?.closest?.('#f-cos button')?.dataset.value;
  $('f-cos').replaceChildren(...[{ id: 'all', name: 'All' }, ...state.cosplayers].map((c) =>
    el('button', {
      type: 'button', 'data-value': c.id, 'aria-pressed': String(filter.cosplayer === c.id),
      onclick: () => { filter.cosplayer = c.id; renderGrid(); },
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
  $('bulk-approve').textContent = pendingShown ? `Approve all shown (${pendingShown})` : 'Approve all shown';

  const grid = $('grid');
  if (!items.length) {
    grid.replaceChildren(el('p', { class: 'empty', text: `No ${filter.status === 'all' ? '' : filter.status + ' '}submissions here.` }));
    return;
  }
  grid.replaceChildren(...items.map((s) => {
    const who = s.name ? `${s.name}${s.credit ? '' : ' (not credited)'}` : 'No name';
    const label = `${s.thumbUrl ? 'Photo' : 'Note'} for ${names.get(s.cosplayerId) ?? 'unknown'}, ${s.status}`;
    return el('article', {
      class: `card${s.thumbUrl ? '' : ' note-only'}`, tabIndex: 0, 'data-id': s.id, 'data-status': s.status,
      'aria-label': label,
    },
      s.thumbUrl
        ? el('a', { class: 'thumb', href: s.fullUrl, target: '_blank', rel: 'noopener', tabIndex: -1 },
          el('img', { src: s.thumbUrl, alt: s.message ? `Fan photo. Message: ${s.message}` : 'Fan photo', loading: 'lazy' }))
        : null,
      el('div', { class: 'body' },
        s.message ? el('p', { class: 'message', text: s.message }) : null,
        el('div', { class: 'meta' },
          el('span', { class: `badge ${STATUS_BADGE[s.status]}`, text: s.status }), ' ',
          `${names.get(s.cosplayerId) ?? ''} · ${who} · ${new Date(s.createdAt).toLocaleString()}`),
        el('div', { class: 'actions' },
          el('button', {
            type: 'button', text: 'Approve', disabled: s.status === 'approved',
            onclick: () => setStatus(s.id, 'approved'),
          }),
          el('button', {
            type: 'button', class: 'danger', text: 'Reject', disabled: s.status === 'rejected',
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
    renderCosplayers();
    // Keep focus on the same slot so the next item is ready for A/R.
    renderGrid(index < 0 ? null : index);
  } catch (err) {
    toast(err.message, { error: true });
  }
}

$('bulk-approve').addEventListener('click', async () => {
  const ids = visible().filter((s) => s.status === 'pending').map((s) => s.id);
  if (!ids.length || !confirm(`Approve ${ids.length} item(s)?`)) return;
  let done = 0;
  try {
    for (let i = 0; i < ids.length; i += 1000) {
      const { updated } = await api(`${base}/submissions/bulk`, {
        method: 'POST', json: { ids: ids.slice(i, i + 1000), status: 'approved' },
      });
      applyStatus(updated, 'approved');
      done += updated.length;
    }
    toast(`Approved ${done} item(s).`);
  } catch (err) {
    toast(err.message, { error: true });
  }
  renderCosplayers();
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

load();
