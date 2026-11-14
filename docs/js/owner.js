// The site owner's page: every event, and the invite codes organizers use to create events.
// The owner key lives in sessionStorage (this tab only) and goes out as a header, never in the address.
import { api, el, toast, copyText } from './api.js';
import { t, setText, formatDate, onLangChange } from './i18n.js';

const KEY_STORE = 'fanwall:owner';
const $ = (id) => document.getElementById(id);
let key = '';
let data = null;
// The server sends its limits with the list; these are only the fallbacks until it answers.
let limits = { inviteDays: 60, maxInviteDays: 365, maxRetentionDays: 90 };
let daysFilled = false;

const readKey = () => { try { return sessionStorage.getItem(KEY_STORE) || ''; } catch { return ''; } };
const writeKey = (v) => { try { v ? sessionStorage.setItem(KEY_STORE, v) : sessionStorage.removeItem(KEY_STORE); } catch {} };
const call = (path, opts = {}) => api(`/api/owner${path}`, { ...opts, headers: { 'x-owner-key': key } });

// Also empties the lists: they hold every organizer's dashboard link, which must not stay in the page.
function showLogin() {
  data = null;
  $('events').replaceChildren();
  $('invites').replaceChildren();
  $('new-code-value').textContent = '';
  $('new-code').hidden = true;
  $('login').hidden = false;
  $('owner-body').hidden = true;
  $('lock').hidden = true;
}

async function load() {
  try {
    data = await call('');
  } catch (err) {
    if (err.status === 403 || err.status === 404) { writeKey(''); key = ''; showLogin(); }
    toast(err.message, { error: true });
    return;
  }
  writeKey(key);
  if (data.limits) limits = data.limits;
  $('invite-days').max = String(limits.maxInviteDays);
  if (!daysFilled) { $('invite-days').value = String(limits.inviteDays); daysFilled = true; }
  $('login').hidden = true;
  $('owner-body').hidden = false;
  $('lock').hidden = false;
  render();
}

function render() {
  if (!data) return;
  const invites = $('invites');
  invites.replaceChildren(...(data.invites.length ? data.invites.map(inviteRow) : [el('li', { class: 'muted', text: t('owner.invites.empty') })]));
  const events = $('events');
  events.replaceChildren(...(data.events.length ? data.events.map(eventRow) : [el('li', { class: 'muted', text: t('owner.events.empty') })]));
}

function inviteRow(inv) {
  const meta = [
    t('owner.invites.meta', { date: formatDate(inv.createdAt) }),
    t(inv.expired ? 'owner.invites.expired' : 'owner.invites.expires', { date: formatDate(inv.expiresAt) }),
    t('owner.invites.events', { count: inv.events }),
  ].join(' · ');
  const action = inv.revoked
    ? el('span', { class: 'small muted', text: t('owner.invites.revoked') })
    : el('button', { type: 'button', class: 'danger', text: t('owner.invites.revoke'), onclick: () => revoke(inv) });
  return el('li', {},
    el('div', {}, el('h3', { text: inv.label }), el('p', { class: 'small muted', text: meta })),
    el('div', { class: 'row' }, inv.revoked ? null : daysLeftForm(inv), action));
}

// A small "<label> [number] Set" form for a row. onSet gets the number and does the saving.
function daysForm({ label, ariaLabel, value, max, onSet }) {
  const input = el('input', {
    type: 'number', min: '1', max: String(max), required: true, value: String(value), class: 'days-input', 'aria-label': ariaLabel,
  });
  const form = el('form', { class: 'days-form' },
    el('span', { class: 'small muted', text: label }), input,
    el('button', { type: 'submit', text: t('owner.invites.setDays') }));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await onSet(Number(input.value));
      await load();
    } catch (err) { toast(err.message, { error: true }); }
  });
  return form;
}

// "Days left": set how long the code still works, counted from today. A code that ran out starts at the default.
const DAY = 86400e3;
function daysLeftForm(inv) {
  const left = Math.max(0, Math.ceil((inv.expiresAt - Date.now()) / DAY));
  return daysForm({
    label: t('owner.invites.daysLeftShort'), ariaLabel: t('owner.invites.daysLeft', { label: inv.label }),
    value: left || limits.inviteDays, max: limits.maxInviteDays,
    onSet: async (days) => {
      const out = await call(`/invites/${encodeURIComponent(inv.id)}`, { method: 'PATCH', json: { days } });
      toast(t('owner.invites.daysSaved', { label: out.label, date: formatDate(out.expiresAt) }));
    },
  });
}

// "Days kept": how long the event keeps submissions after it closes.
function keptForm(ev) {
  return daysForm({
    label: t('owner.events.keptShort'), ariaLabel: t('owner.events.kept', { name: ev.name }),
    value: ev.retentionDays, max: limits.maxRetentionDays,
    onSet: async (retentionDays) => {
      await call(`/events/${encodeURIComponent(ev.id)}`, { method: 'PATCH', json: { retentionDays } });
      toast(t('owner.events.keptSaved', { name: ev.name, count: retentionDays }));
    },
  });
}

function eventRow(ev) {
  const meta = [
    t(ev.open ? 'owner.events.open' : 'owner.events.closed'),
    t('owner.events.made', { date: formatDate(ev.createdAt) }),
    t('owner.events.cosplayers', { count: ev.cosplayers }),
    ev.pending ? t('owner.events.pending', { count: ev.pending }) : null,
    ev.invite ? t('owner.events.via', { label: ev.invite }) : null,
  ].filter(Boolean).join(' · ');
  return el('li', {},
    el('div', {}, el('h3', { text: ev.name }), el('p', { class: 'small muted', text: meta })),
    el('div', { class: 'row' },
      keptForm(ev),
      el('a', { class: 'button', href: ev.adminPath, target: '_blank', rel: 'noopener', text: t('owner.events.dashboard') }),
      el('button', { type: 'button', class: 'danger', text: t('common.delete'), onclick: () => removeEvent(ev) })));
}

async function revoke(inv) {
  if (!confirm(t('owner.invites.confirmRevoke', { label: inv.label }))) return;
  try {
    await call(`/invites/${encodeURIComponent(inv.id)}`, { method: 'DELETE' });
    await load();
  } catch (err) { toast(err.message, { error: true }); }
}

async function removeEvent(ev) {
  if (!confirm(t('owner.events.confirmDelete', { name: ev.name }))) return;
  try {
    await call(`/events/${encodeURIComponent(ev.id)}`, { method: 'DELETE' });
    toast(t('common.deleted'));
    await load();
  } catch (err) { toast(err.message, { error: true }); }
}

$('login-form').addEventListener('submit', (e) => {
  e.preventDefault();
  key = $('owner-key').value.trim(); // a key pasted from a .env file often carries a space or newline
  $('owner-key').value = '';
  load();
});

$('lock').addEventListener('click', () => {
  writeKey('');
  key = '';
  showLogin();
});

$('invite-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const button = e.target.querySelector('button');
  button.disabled = true;
  try {
    const inv = await call('/invites', { method: 'POST', json: { label: $('invite-label').value, days: Number($('invite-days').value) } });
    $('invite-label').value = '';
    $('invite-days').value = String(limits.inviteDays);
    setText($('new-code-title'), 'owner.invites.newTitle', { label: inv.label });
    $('new-code-value').textContent = inv.code;
    $('new-code').hidden = false;
    await load();
  } catch (err) {
    toast(err.message, { error: true });
  } finally {
    button.disabled = false;
  }
});

$('copy-code').addEventListener('click', () => copyText($('new-code-value').textContent, 'invite'));

onLangChange(render);

key = readKey();
if (key) load();
