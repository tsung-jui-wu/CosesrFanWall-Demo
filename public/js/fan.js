import { api, el, toast, copyText, STATIC, VIEW_ONLY, segmentAfter } from './api.js';
import { openEditor, renderEdited, canvasBlob } from './editor.js';

const eid = segmentAfter('e'), cid = segmentAfter('c');
const $ = (id) => document.getElementById(id);
const STORE_KEY = 'fanwall:sent';
const MAX_EDGE = 2560; // matches PHOTO_MAX_EDGE in lib/images.js
const JPEG_QUALITY = 0.86;
const MAX_MESSAGE = 280;
const DAY = 86400e3;
const VIEWS = ['loading', 'error', 'form', 'sending', 'waiting', 'done'];

let info = null;
// The picked photo. base is the resized, unedited copy (kept so the fan can re-edit or reset
// without losing quality); blob is what gets sent, with the fan's edit applied.
let photo = null; // { base, edit, blob, url, editable }
const queue = []; // items waiting to upload, oldest first
let sending = false;
let foreground = null; // the item the person is watching on the sending/waiting screens
let retryTimer = null;
let retryDelay = 0;

function show(view) {
  for (const v of VIEWS) $(`view-${v}`).hidden = v !== view;
  $('hero').hidden = view === 'done'; // the Sent card takes its place: one gradient card per screen
  renderBanner();
}
const current = () => VIEWS.find((v) => !$(`view-${v}`).hidden);

function showError(title, text) {
  $('error-title').textContent = title;
  $('error-text').textContent = text;
  show('error');
}

// ---------- saved submissions (this device only) ----------
function loadSaved() {
  try {
    const list = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
    return Array.isArray(list) ? list.filter((e) => e && e.at > Date.now() - 90 * DAY) : [];
  } catch {
    return [];
  }
}
function writeSaved(list) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(list)); } catch {}
}
function remember(entry) {
  writeSaved([...loadSaved(), entry]);
  renderMine();
}
function forget(pred) {
  writeSaved(loadSaved().filter((e) => !pred(e)));
  renderMine();
}

function renderMine() {
  const mine = loadSaved().filter((e) => e.eid === eid && e.cid === cid).reverse();
  $('mine-empty').hidden = mine.length > 0;
  $('mine-list').replaceChildren(...mine.map((e) => el('li', {},
    el('div', {},
      el('strong', { text: e.kind === 'photo' ? 'Photo' : 'Note' }),
      el('span', { class: 'muted small', text: ` · ${new Date(e.at).toLocaleString()}` }),
      el('div', { class: 'small mono', text: e.code })),
    el('button', { type: 'button', class: 'danger', text: 'Delete', onclick: () => deleteSaved(e) }))));
}

async function deleteSaved(e) {
  if (!confirm('Delete this for good? The cosplayer will never see it.')) return;
  try {
    await api('/api/fan/delete', { method: 'POST', json: { id: e.id, code: e.code } });
    toast('Deleted.');
    forget((x) => x.id === e.id);
  } catch (err) {
    if (err.status === 404) {
      toast('It was already removed.');
      forget((x) => x.id === e.id);
    } else {
      toast(err.message, { error: true });
    }
  }
}

$('code-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = $('code-input').value.trim();
  if (!code) return;
  try {
    await api('/api/fan/delete', { method: 'POST', json: { code } });
    toast('Deleted.');
    $('code-input').value = '';
    const norm = (c) => c.toUpperCase().replace(/[^0-9A-Z]/g, '');
    forget((x) => norm(x.code) === norm(code));
  } catch (err) {
    toast(err.message, { error: true });
  }
});

// ---------- photo ----------
const canvasOf = (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h });

// Resize to MAX_EDGE before upload: smaller uploads survive bad venue Wi-Fi, and re-encoding
// through a canvas drops the photo's location data before it ever leaves the phone.
// Returns null on any failure (a format the browser can't decode, like HEIC on some browsers, or a
// canvas over the device's size limit); the caller then sends the file as is, and the server
// re-encodes everything anyway.
async function prepareImage(file) {
  let bmp;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
    const tw = Math.max(1, Math.round(bmp.width * scale)), th = Math.max(1, Math.round(bmp.height * scale));
    // Halve step by step so big reductions average pixels instead of aliasing.
    let source = bmp, w = bmp.width, h = bmp.height;
    while (w / 2 >= tw) {
      w = Math.round(w / 2); h = Math.round(h / 2);
      const step = canvasOf(w, h);
      step.getContext('2d').drawImage(source, 0, 0, w, h);
      source = step;
    }
    const out = canvasOf(tw, th);
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, tw, th);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, tw, th);
    return await canvasBlob(out, JPEG_QUALITY);
  } catch {
    return null;
  } finally {
    bmp?.close();
  }
}

// Same alphabet and length as the server's codes. Sent with the upload so a retry after a lost
// response is recognized as the same submission instead of creating a duplicate.
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
function newDeleteCode() {
  const s = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => CODE_ALPHABET[b & 31]).join('');
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}

function setPhoto(p) {
  if (photo) URL.revokeObjectURL(photo.url);
  photo = p ? { ...p, url: URL.createObjectURL(p.blob) } : null;
  $('preview').hidden = !photo;
  $('photo-edit').hidden = !photo?.editable;
  $('photo-edit').textContent = photo?.edit ? 'Change edit' : 'Edit photo';
  $('photo-pick').hidden = Boolean(photo);
  $('preview-missing').hidden = true;
  $('preview-img').hidden = false;
  if (photo) $('preview-img').src = photo.url;
  else $('preview-img').removeAttribute('src');
}

$('preview-img').addEventListener('error', () => {
  if (!photo) return;
  $('preview-img').hidden = true;
  $('preview-missing').hidden = false;
});

for (const input of [$('photo-camera'), $('photo-library')]) {
  input.addEventListener('change', async () => {
    const file = input.files[0];
    input.value = '';
    if (!file) return;
    if (file.type && !file.type.startsWith('image/')) return formError('Please choose an image file.');
    formError('');
    $('photo-busy').hidden = false;
    try {
      const base = await prepareImage(file);
      setPhoto({ base: base ?? file, edit: null, blob: base ?? file, editable: Boolean(base) });
    } finally {
      $('photo-busy').hidden = true;
    }
    $('photo-remove').focus();
  });
}

// The fan edits their own photo before sending, so the cosplayer doesn't have to fix every photo later.
// The edit is applied to the photo that gets sent; the cosplayer can still edit on top of it.
$('photo-edit').addEventListener('click', () => {
  const p = photo;
  let blob = null;
  openEditor({ load: () => createImageBitmap(p.base), edit: p.edit, title: 'Edit your photo', saveLabel: 'Done' }, {
    save: async (edit) => {
      if (edit) {
        const bmp = await createImageBitmap(p.base);
        try { blob = await canvasBlob(renderEdited(bmp, edit), JPEG_QUALITY); } finally { bmp.close(); }
      }
      return edit;
    },
    onClose: (saved, edit) => {
      if (saved && photo === p) setPhoto({ ...p, edit, blob: edit ? blob : p.base });
      $('photo-edit').focus();
    },
  });
});

$('photo-remove').addEventListener('click', () => {
  setPhoto(null);
  $('photo-library').focus();
});

// ---------- form ----------
function updateCounter() {
  const n = [...$('message').value].length;
  $('counter').textContent = `${n} / ${MAX_MESSAGE}`;
  $('counter').classList.toggle('near', n > MAX_MESSAGE - 20 && n <= MAX_MESSAGE);
  $('counter').classList.toggle('over', n > MAX_MESSAGE);
}
$('message').addEventListener('input', updateCounter);

function formError(text) {
  $('form-error').textContent = text;
}

function resetForm() {
  setPhoto(null);
  $('message').value = '';
  $('consent').checked = false; // consent is given per submission
  updateCounter();
  formError('');
}

function restoreForm(item) {
  setPhoto(item.photo);
  $('message').value = item.message;
  $('name').value = item.name;
  $('credit').checked = item.credit;
  updateCounter();
}

$('view-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (STATIC) return formError(`${VIEW_ONLY} Picking and editing a photo works; sending doesn't.`);
  const message = $('message').value.trim();
  if (!photo && !message) return formError('Add a photo or a message (or both).');
  if ([...message].length > MAX_MESSAGE) return formError(`Messages can be up to ${MAX_MESSAGE} characters.`);
  if (!$('consent').checked) {
    formError('Please tick the box to agree before sending.');
    return $('consent').focus();
  }
  const item = {
    message, name: $('name').value.trim(), credit: $('credit').checked,
    photo: photo && { base: photo.base, edit: photo.edit, blob: photo.blob, editable: photo.editable },
    blob: photo?.blob ?? null, kind: photo ? 'photo' : 'note', code: newDeleteCode(),
  };
  queue.push(item);
  foreground = item;
  resetForm();
  show(retryTimer ? 'waiting' : 'sending');
  $('progress').removeAttribute('value');
  processQueue();
});

// ---------- upload queue ----------
function upload(item, onProgress) {
  return new Promise((resolve) => {
    const form = new FormData();
    form.append('consent', '1');
    form.append('code', item.code);
    if (item.message) form.append('message', item.message);
    if (item.name) form.append('name', item.name);
    if (item.credit) form.append('credit', '1');
    if (item.blob) form.append('photo', item.blob, 'photo');
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/fan/${encodeURIComponent(eid)}/${encodeURIComponent(cid)}/submit`);
    xhr.responseType = 'json';
    xhr.timeout = 120e3;
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      const body = xhr.response ?? {};
      if (xhr.status === 201) return resolve({ ok: true, body });
      if (xhr.status === 429 || xhr.status >= 500) {
        return resolve({ transient: true, retryAfter: Number(xhr.getResponseHeader('Retry-After')) || 0, message: body.error });
      }
      resolve({ message: body.error || `Something went wrong (${xhr.status}).` });
    };
    xhr.onerror = xhr.ontimeout = () => resolve({ transient: true, retryAfter: 0 });
    xhr.send(form);
  });
}

async function processQueue() {
  if (sending || !queue.length) return renderBanner();
  clearTimeout(retryTimer);
  retryTimer = null;
  sending = true;
  const item = queue[0];
  if (item === foreground && current() === 'waiting') show('sending');
  const r = await upload(item, (p) => { if (item === foreground) $('progress').value = p; });
  sending = false;

  if (r.ok) {
    queue.shift();
    retryDelay = 0;
    remember({ id: r.body.id, code: r.body.deleteCode, eid, cid, kind: item.kind, at: Date.now() });
    if (item === foreground) {
      foreground = null;
      $('done-text').textContent = `${info.cosplayer.name} will see it once the organizer has reviewed it.`;
      $('done-code').textContent = r.body.deleteCode;
      show('done');
      $('send-another').focus();
    } else {
      toast('A waiting item was sent.');
    }
    return processQueue();
  }

  if (r.transient) {
    retryDelay = Math.min(60, retryDelay ? retryDelay * 2 : 5);
    retryTimer = setTimeout(processQueue, Math.max(r.retryAfter, retryDelay) * 1000);
    $('waiting-text').textContent = r.message
      ? `${r.message} We'll try again automatically; keep this page open.`
      : "We couldn't reach the server. Keep this page open and we'll send it automatically.";
    if (item === foreground || current() === 'sending') show('waiting');
    return renderBanner();
  }

  // Permanent failure (validation, closed, full): give the content back so nothing is lost.
  queue.shift();
  if (item === foreground) {
    foreground = null;
    restoreForm(item);
    show('form');
    formError(r.message);
    $('form-error').scrollIntoView({ block: 'center' });
  } else {
    toast(`A waiting item couldn't be sent: ${r.message}`, { error: true });
  }
  processQueue();
}

function renderBanner() {
  const waiting = queue.length;
  const banner = $('queue-banner');
  const onScreen = ['form', 'done'].includes(current());
  banner.hidden = !(waiting && onScreen);
  banner.textContent = `${waiting} item${waiting === 1 ? '' : 's'} waiting to send. Keep this page open.`;
}

window.addEventListener('online', () => { retryDelay = 0; processQueue(); });
window.addEventListener('beforeunload', (e) => {
  if (queue.length) { e.preventDefault(); e.returnValue = ''; }
});

$('retry-now').addEventListener('click', () => { retryDelay = 0; processQueue(); });
$('write-another').addEventListener('click', () => { foreground = null; show('form'); });
$('send-another').addEventListener('click', () => { show('form'); $('photo-library').focus(); });
$('copy-code').addEventListener('click', () => copyText($('done-code').textContent, 'code'));

// ---------- start ----------
function renderInfo() {
  const { event, cosplayer, consent } = info;
  document.title = `Send ${cosplayer.name} a thank-you · FanWall`;
  $('event-name').textContent = event.name;
  $('title').textContent = `Send ${cosplayer.name} a thank-you`;
  $('lead').textContent = `A photo, a note, or both. It reaches ${cosplayer.name} after the organizer has a look.`;
  $('character').textContent = cosplayer.character;
  $('character').hidden = !cosplayer.character;
  $('credit-text').textContent = `Show my name to ${cosplayer.name}`;
  $('send').textContent = `Send to ${cosplayer.name}`;
  $('consent-title').textContent = consent.title;
  $('consent-points').replaceChildren(...consent.points.map((p) =>
    el('div', {}, el('dt', { text: p.h }), el('dd', { text: p.t }))));
  $('consent-text').textContent = consent.checkbox;
}

renderMine();
try {
  info = await api(`/api/fan/${encodeURIComponent(eid)}/${encodeURIComponent(cid)}`);
  renderInfo();
  if (info.open) show('form');
  else showError('Submissions are closed', `Thanks for thinking of ${info.cosplayer.name}! This page isn't taking new photos or notes right now.`);
} catch (err) {
  // fetch rejects with TypeError when offline; anything else is the server saying no.
  if (err instanceof TypeError) showError("Can't reach FanWall", 'Check your connection, then reload this page.');
  else showError('This link is not valid', 'Check the QR code, or ask the organizer for a fresh link.');
}
