import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import multer from 'multer';
import QRCode from 'qrcode';
import {
  db, save, newId, sha256, UPLOAD_DIR, MEDIA_NAME, mediaPath, getOwn, safeEqual, removeSubmission, removeCosplayer, optOutCosplayer,
  purgeExpired, removeOrphanFiles, removeEvent, findEventByToken, findCosplayerByToken, HARD_CAP_DAYS, savedUntil,
} from './lib/store.js';
import { consentCopies, CONSENT_VERSION } from './lib/consent.js';
import { planBundle } from './lib/bundle.js';
import { streamZip } from './lib/zip.js';
import { savePhoto, saveBase, removePhoto, removeBase, renderEdited, renderThumb, ImageDecodeError } from './lib/images.js';
import { normalizeEdit, EditError } from './public/js/edit.js';
import { isLang } from './public/js/i18n-core.js';
import { isStyle, styleOf, styleFor, DEFAULT_STYLE } from './public/js/styles.js';

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const CREATE_KEY = process.env.CREATE_KEY || '';
// The site owner's key: opens /owner (every event, invite codes). When it is set, making an event
// needs an invite code from the owner (or the owner key itself, or the older shared CREATE_KEY).
const OWNER_KEY = process.env.OWNER_KEY || '';
const MAX_INVITES = 500;
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
const MAX_PER_COSPLAYER = 1500;
const MAX_COSPLAYERS = 200;
const MAX_MESSAGE = 280;
const MAX_NAME = 40;
const MAX_TITLE = 80;
const BULK_MAX = 1000; // keeps a bulk body well under the JSON limit; the dashboard sends batches
const STATUSES = new Set(['pending', 'approved', 'rejected']);
const IMAGE_MIME = /^image\/(jpeg|png|webp|avif|heic|heif|gif)$/;
const CSP = [
  "default-src 'self'", "img-src 'self' blob: data:", "object-src 'none'", "base-uri 'none'",
  "frame-ancestors 'none'", "form-action 'self'",
].join('; ');

export const app = express();
app.disable('x-powered-by');
// Only a hop count is accepted. "true" would trust any X-Forwarded-For, letting anyone dodge the rate limits.
if (process.env.TRUST_PROXY) {
  const hops = Number(process.env.TRUST_PROXY);
  if (Number.isInteger(hops) && hops > 0) app.set('trust proxy', hops);
  else console.warn('[config] TRUST_PROXY must be a number of proxy hops (e.g. 1); ignoring it.');
}

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': CSP,
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin', // other sites can't embed fan photos
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  });
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000');
  next();
});

app.get('/robots.txt', (req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /\n'));

// ---------- rate limits ----------
// In memory only. Keys are an HMAC of the client address under a per-process secret,
// so raw IPs are never kept, even in memory.
const RL_SECRET = crypto.randomBytes(32);

// One person on IPv6 usually controls a whole /64, so count that prefix as one client.
export function clientKey(ip = '') {
  if (!net.isIPv6(ip) || ip.startsWith('::ffff:')) return ip;
  const [head, tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [], t = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  return groups.slice(0, 4).map((g) => g.toLowerCase().padStart(4, '0')).join(':') + '::/64';
}

function rateLimit({ max, windowMs }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, h] of hits) if (h.reset <= now) hits.delete(k);
  }, windowMs).unref();
  return (req, res, next) => {
    const key = crypto.createHmac('sha256', RL_SECRET).update(clientKey(req.ip)).digest('base64url');
    const now = Date.now();
    let h = hits.get(key);
    if (!h || h.reset <= now) hits.set(key, (h = { count: 0, reset: now + windowMs }));
    if (++h.count > max) {
      res.set('Retry-After', String(Math.ceil((h.reset - now) / 1000)));
      return res.status(429).json({ error: 'rate_limited' });
    }
    next();
  };
}
const submitLimit = rateLimit({ max: 15, windowMs: 10 * 60e3 });
const deleteLimit = rateLimit({ max: 30, windowMs: 10 * 60e3 });
const createLimit = rateLimit({ max: 10, windowMs: 60 * 60e3 });
const downloadLimit = rateLimit({ max: 20, windowMs: 10 * 60e3 });
const ownerLimit = rateLimit({ max: 60, windowMs: 10 * 60e3 });

// ---------- helpers ----------
// Delete codes: 12 chars from an unambiguous alphabet (~60 bits), shown as XXXX-XXXX-XXXX.
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_RE = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12}$/;
const formatCode = (s) => `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
function newDeleteCode() {
  let s = '';
  for (const b of crypto.randomBytes(12)) s += CODE_ALPHABET[b & 31];
  return formatCode(s);
}
const normalizeCode = (code) => (typeof code === 'string' ? code.toUpperCase().replace(/[^0-9A-Z]/g, '') : '');

const isOn = (v) => v === true || v === '1' || v === 'true' || v === 'on';
const chars = (s) => [...s].length;

// Errors go out as a code plus details ({ error: 'too_long', field: 'message', max: 280 }), never as
// a sentence: the pages put them into words in the visitor's language (public/locales).
class HttpError extends Error {
  constructor(status, code, vars = {}) { super(code); this.status = status; this.code = code; this.vars = vars; }
}

// Optional trimmed string field with a length cap. Returns undefined when absent.
// field names the input for the error (field.<name> in the catalogs).
function textField(value, field, { max, required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new HttpError(400, 'required', { field });
    return undefined;
  }
  if (typeof value !== 'string') throw new HttpError(400, 'not_text', { field });
  const s = value.trim();
  if (required && !s) throw new HttpError(400, 'required', { field });
  if (chars(s) > max) throw new HttpError(400, 'too_long', { field, max });
  return s;
}

function retentionField(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > HARD_CAP_DAYS) throw new HttpError(400, 'bad_retention', { max: HARD_CAP_DAYS });
  return n;
}

// Mistakes only a hand-made request makes share one code; field says which part was wrong.
function boolField(value, field) {
  if (typeof value !== 'boolean') throw new HttpError(400, 'bad_request', { field });
  return value;
}

// The event's default language for its pages; null leaves it to each visitor's browser.
function langField(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (!isLang(value)) throw new HttpError(400, 'bad_request', { field: 'lang' });
  return value;
}

// The event's reveal style (public/js/styles.js). One per event, never per cosplayer.
function styleField(value) {
  if (value === undefined) return undefined;
  if (!isStyle(value)) throw new HttpError(400, 'bad_request', { field: 'style' });
  return value;
}

const fanPath = (c) => `/e/${c.eventId}/c/${c.id}`;
const mediaUrl = (name) => `/media/${name}`;
const publicBase = (req) => PUBLIC_URL || `${req.protocol}://${req.get('host')}`;

function loadFanTarget(eid, cid) {
  const ev = getOwn(db.events, eid);
  const cos = getOwn(db.cosplayers, cid);
  if (!ev || !cos || cos.eventId !== ev.id) return null;
  return { ev, cos, open: Boolean(ev.open) && !cos.optOut };
}

// ---------- uploads ----------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 10, fieldSize: 4096, parts: 12 },
  fileFilter: (req, file, cb) =>
    IMAGE_MIME.test(file.mimetype) ? cb(null, true) : cb(new HttpError(415, 'not_image')),
});
const imageUpload = (field) => (req, res, next) =>
  upload.single(field)(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') return next(new HttpError(413, 'image_too_large', { maxMb: MAX_UPLOAD_BYTES / 1024 / 1024 }));
      return next(new HttpError(400, 'bad_upload'));
    }
    next(err);
  });

async function encodeOr400(fn, buffer) {
  try {
    return await fn(buffer);
  } catch (err) {
    if (err instanceof ImageDecodeError) throw new HttpError(400, 'image_unreadable');
    throw err;
  }
}

// ---------- API: common ----------
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.use('/api', express.json({ limit: '64kb' }));

app.get('/api/config', (req, res) => res.json({ needsKey: Boolean(CREATE_KEY || OWNER_KEY) }));

// Invite codes look like delete codes (XXXX-XXXX-XXXX) and are kept only as a SHA-256 hash.
const findInvite = (key) => {
  const code = normalizeCode(key);
  if (!CODE_RE.test(code)) return undefined;
  const hash = sha256(code);
  return Object.values(db.invites).find((i) => !i.revoked && safeEqual(i.codeHash, hash));
};

// Which key let this event be made: { inviteId } for an invite code, {} for the owner or shared key.
// Throws when a key is needed and this one isn't right.
function createGrant(key) {
  if (!CREATE_KEY && !OWNER_KEY) return {};
  if (safeEqual(key, OWNER_KEY) || safeEqual(key, CREATE_KEY)) return {};
  const invite = OWNER_KEY ? findInvite(key) : undefined;
  if (!invite) throw new HttpError(403, 'bad_create_key');
  return { inviteId: invite.id };
}

app.post('/api/events', createLimit, (req, res) => {
  const body = req.body ?? {};
  const grant = createGrant(body.key);
  const name = textField(body.name, 'eventName', { max: MAX_TITLE, required: true });
  const retentionDays = retentionField(body.retentionDays) ?? 30;
  const id = newId();
  const organizerToken = newId(24);
  db.events[id] = {
    id, name, organizerToken, baseImage: null, open: true, closedAt: null, retentionDays, lang: null, style: DEFAULT_STYLE,
    createdAt: Date.now(), inviteId: grant.inviteId ?? null,
  };
  save();
  res.status(201).json({ id, adminPath: `/admin/${organizerToken}` });
});

// ---------- API: fans ----------
app.get('/api/fan/:eid/:cid', (req, res) => {
  const t = loadFanTarget(req.params.eid, req.params.cid);
  if (!t) throw new HttpError(404, 'link_invalid');
  res.json({
    event: { name: t.ev.name, lang: t.ev.lang ?? null },
    cosplayer: { name: t.cos.name, character: t.cos.character ?? '' },
    open: t.open,
    consent: consentCopies({ cosplayerName: t.cos.name, retentionDays: t.ev.retentionDays ?? 30 }), // by language
  });
});

const inFlight = new Set(); // code hashes of submissions currently being encoded

app.post(
  '/api/fan/:eid/:cid/submit',
  submitLimit,
  // Check the target before buffering the upload, so closed links don't cost us 12 MB.
  (req, res, next) => {
    const t = loadFanTarget(req.params.eid, req.params.cid);
    if (!t) throw new HttpError(404, 'link_invalid');
    if (!t.open) throw new HttpError(403, 'closed');
    let count = 0;
    for (const s of Object.values(db.submissions)) if (s.cosplayerId === t.cos.id) count++;
    if (count >= MAX_PER_COSPLAYER) throw new HttpError(409, 'inbox_full');
    res.locals.target = t;
    next();
  },
  imageUpload('photo'),
  async (req, res) => {
    const body = req.body ?? {};
    if (body.consent !== '1') throw new HttpError(400, 'consent_required');
    // The language of the consent text the fan agreed to, kept with the consent version.
    if (!isLang(body.consentLang)) throw new HttpError(400, 'bad_request', { field: 'consentLang' });
    const message = textField(body.message, 'message', { max: MAX_MESSAGE }) ?? '';
    const name = textField(body.name, 'name', { max: MAX_NAME }) ?? '';
    if (!req.file && !message) throw new HttpError(400, 'empty_submission');

    // The fan page sends its own delete code, so a retry after a lost response carries the same
    // code and we can answer it without storing a duplicate. Only the hash is ever kept.
    let deleteCode = newDeleteCode();
    if (body.code !== undefined) {
      const c = normalizeCode(body.code);
      if (!CODE_RE.test(c)) throw new HttpError(400, 'bad_request', { field: 'code' });
      deleteCode = formatCode(c);
    }
    const codeHash = sha256(normalizeCode(deleteCode));
    const cosId = res.locals.target.cos.id;
    const dup = Object.values(db.submissions).find((s) => s.cosplayerId === cosId && s.codeHash === codeHash);
    if (dup) return res.status(201).json({ id: dup.id, deleteCode });
    if (inFlight.has(codeHash)) {
      res.set('Retry-After', '5');
      throw new HttpError(503, 'still_sending');
    }

    inFlight.add(codeHash);
    try {
      const file = req.file ? await encodeOr400(savePhoto, req.file.buffer) : null;

      // Re-check after the async encode: the event may have closed or the cosplayer opted out meanwhile.
      const t = loadFanTarget(req.params.eid, req.params.cid);
      if (!t?.open) {
        await removePhoto(file);
        throw new HttpError(403, 'closed');
      }

      const now = Date.now();
      const id = newId();
      db.submissions[id] = {
        id,
        eventId: t.ev.id,
        cosplayerId: t.cos.id,
        file,
        message,
        name,
        credit: Boolean(name) && isOn(body.credit),
        consent: { v: CONSENT_VERSION, lang: body.consentLang, at: now },
        status: 'pending',
        hidden: false,
        codeHash,
        createdAt: now,
      };
      save();
      res.status(201).json({ id, deleteCode });
    } finally {
      inFlight.delete(codeHash);
    }
  },
);

// `{id, code}` or just `{code}`: a fan on another device only has the code they wrote down.
// Codes carry ~60 bits and this route is rate limited, so a code-only lookup can't be brute forced.
app.post('/api/fan/delete', deleteLimit, (req, res) => {
  const { id, code } = req.body ?? {};
  const norm = normalizeCode(code);
  const hash = sha256(norm);
  let s;
  if (CODE_RE.test(norm)) {
    if (id === undefined) s = Object.values(db.submissions).find((x) => safeEqual(x.codeHash, hash));
    else if (safeEqual(getOwn(db.submissions, id)?.codeHash, hash)) s = db.submissions[id];
  }
  // Same answer for unknown id and wrong code, so ids can't be probed.
  if (!s) throw new HttpError(404, 'code_not_found');
  removeSubmission(s.id);
  save();
  res.json({ ok: true });
});

// ---------- API: cosplayer reveal ----------
// Nothing but the names is visible until the organizer releases the link, and only approved items
// ever are. A fan's name is included only if they ticked "credit me".
function revealTarget(token) {
  const c = findCosplayerByToken(token);
  const ev = c && getOwn(db.events, c.eventId);
  if (!c || !ev) throw new HttpError(404, 'link_invalid');
  return { c, ev, ready: Boolean(c.released) && !c.optOut };
}
// The cosplayer can only act on what they can see: their own approved items, after release.
function revealReady(token) {
  const t = revealTarget(token);
  if (!t.ready) throw new HttpError(403, t.c.optOut ? 'page_closed' : 'page_not_open');
  return t;
}
function revealItem(token, id) {
  const t = revealReady(token);
  const s = getOwn(db.submissions, id);
  if (!s || s.cosplayerId !== t.c.id || s.status !== 'approved') throw new HttpError(404, 'item_not_found');
  return { ...t, s };
}
const approvedFor = (c) => Object.values(db.submissions)
  .filter((s) => s.cosplayerId === c.id && s.status === 'approved')
  .sort((a, b) => a.createdAt - b.createdAt);
// When the first item the cosplayer hasn't hidden will be deleted (see savedUntil in lib/store.js).
const savedUntilFor = (c, ev) => savedUntil(ev, approvedFor(c).filter((s) => !s.hidden));

app.get('/api/reveal/:token', (req, res) => {
  const { c, ev, ready } = revealTarget(req.params.token);
  res.json(revealView(c, ev, ready));
});

// What a reveal page gets. event.style is this cosplayer's style (their own, or the event's default).
// The organizer's preview gets the same view, as if released.
function revealView(c, ev, ready) {
  const out = {
    ready, optOut: Boolean(c.optOut), event: { name: ev.name, lang: ev.lang ?? null, style: styleFor(ev, c) },
    cosplayer: { name: c.name, character: c.character ?? '' },
  };
  if (!ready) return { ...out, baseUrl: null, items: [], savedUntil: null };
  const items = approvedFor(c).map((s) => ({
      id: s.id,
      thumbUrl: s.file ? mediaUrl(`${s.file}_t.jpg`) : null,
      fullUrl: s.file ? mediaUrl(`${s.file}.jpg`) : null,
      message: s.message,
      name: s.credit ? s.name : '',
      hidden: Boolean(s.hidden),
      favorite: Boolean(s.favorite),
      edit: s.edit ?? null,
    }));
  // The cosplayer's own image when the organizer set one, so no two reveals have to show the same picture.
  const baseImage = c.baseImage || ev.baseImage;
  return { ...out, baseUrl: baseImage ? mediaUrl(`base_${baseImage}.jpg`) : null, items, savedUntil: savedUntilFor(c, ev) };
}

// { hidden } and/or { favorite }. Hidden items stay saved but leave the animation, the export, and
// the ZIP. Favorites are the cosplayer's own stars: private to them (the organizer never sees them),
// independent of hiding, and deleted with the item. Hiding can move "Saved until", so the new date
// comes back too.
app.post('/api/reveal/:token/items/:id', (req, res) => {
  const { s, c, ev } = revealItem(req.params.token, req.params.id);
  const body = req.body ?? {};
  if (body.hidden === undefined && body.favorite === undefined) throw new HttpError(400, 'bad_request', { field: 'hidden' });
  const hidden = body.hidden === undefined ? undefined : boolField(body.hidden, 'hidden');
  const favorite = body.favorite === undefined ? undefined : boolField(body.favorite, 'favorite');
  if (hidden !== undefined) s.hidden = hidden;
  if (favorite !== undefined) s.favorite = favorite;
  save();
  res.json({ id: s.id, hidden: Boolean(s.hidden), favorite: Boolean(s.favorite), savedUntil: savedUntilFor(c, ev) });
});

// Non-destructive: only the edit's description is stored; the fan's file stays as it was.
// { edit: null } goes back to the original.
app.post('/api/reveal/:token/items/:id/edit', (req, res) => {
  const { s } = revealItem(req.params.token, req.params.id);
  if (!s.file) throw new HttpError(400, 'not_a_photo');
  if (req.body?.edit === undefined) throw new HttpError(400, 'bad_request', { field: 'edit' }); // {"edit": null} undoes
  try {
    s.edit = normalizeEdit(req.body.edit);
  } catch (err) {
    if (err instanceof EditError) throw new HttpError(400, 'bad_request', { field: 'edit' });
    throw err;
  }
  save();
  res.json({ id: s.id, edit: s.edit });
});

app.delete('/api/reveal/:token/items/:id', (req, res) => {
  const { s, c, ev } = revealItem(req.params.token, req.params.id);
  removeSubmission(s.id);
  save();
  res.json({ ok: true, savedUntil: savedUntilFor(c, ev) });
});

// Allowed before release too: a cosplayer may want the page closed without seeing anything.
// `confirm: true` must arrive as JSON, which a cross-site form can't send.
app.post('/api/reveal/:token/optout', (req, res) => {
  const { c } = revealTarget(req.params.token);
  if (req.body?.confirm !== true) throw new HttpError(400, 'bad_request', { field: 'confirm' }); // {"confirm": true}
  optOutCosplayer(c.id);
  save();
  res.json({ ok: true });
});

const asciiSlug = (s) => s.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

// "Download all" (see lib/bundle.js and BUNDLE-FORMAT.md): a gallery page that works offline,
// manifest.json, messages.txt, every visible photo at full size, and grid-sized thumbnails.
// Names appear only when the fan asked for credit. Edited photos come out edited, with the
// unedited copy under unedited/ for editing elsewhere. The mosaic image isn't included: it's drawn
// in the browser, and "Save image" on the reveal page saves it.
// ?lang= is the page's language for the bundle's own words (the fans' notes stay as written);
// ?tz= is the browser's getTimezoneOffset(), so the event's date is the cosplayer's calendar day.
// ?only=favorites keeps just the items the cosplayer starred.
app.get('/api/reveal/:token/download.zip', downloadLimit, async (req, res) => {
  const { c, ev } = revealReady(req.params.token);
  const lang = isLang(req.query.lang) ? req.query.lang : ev.lang ?? 'en';
  const tz = Number(req.query.tz);
  const favoritesOnly = req.query.only === 'favorites';
  const kept = [];
  for (const s of approvedFor(c)) {
    if (s.hidden || (favoritesOnly && !s.favorite)) continue;
    const photo = Boolean(s.file) && fs.existsSync(mediaPath(`${s.file}.jpg`));
    if (photo || s.message) kept.push({ s, photo });
  }
  // The mosaic's picture (theirs, else the event's), so the year in review can draw the mosaic again.
  const baseImage = c.baseImage || ev.baseImage;
  const picture = baseImage && fs.existsSync(mediaPath(`base_${baseImage}.jpg`)) ? mediaPath(`base_${baseImage}.jpg`) : null;
  const plan = planBundle({
    event: ev, cosplayer: c, lang, tz: Number.isInteger(tz) && Math.abs(tz) <= 840 ? tz : 0, revealStyle: styleFor(ev, c),
    fallbackDate: ev.closedAt ?? ev.createdAt, picture: Boolean(picture),
    items: kept.map(({ s, photo }) => ({
      message: s.message, credit: s.credit && s.name ? s.name : '', photo, edited: photo && Boolean(s.edit),
      favorite: Boolean(s.favorite), createdAt: s.createdAt,
    })),
  });
  const entries = [
    { name: 'index.html', data: Buffer.from(plan.html, 'utf8') },
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(plan.manifest, null, 2), 'utf8') },
    { name: 'messages.txt', data: Buffer.from(plan.messages, 'utf8') },
  ];
  kept.forEach(({ s }, i) => {
    const photo = plan.photos[i];
    if (!photo) return;
    const { file, edit } = s; // rendered when written, so only one generated image is in memory at a time
    if (edit) {
      entries.push({ name: `photos/${photo}`, data: () => renderEdited(file, edit) });
      entries.push({ name: `unedited/${photo}`, path: mediaPath(`${file}.jpg`) });
    } else {
      entries.push({ name: `photos/${photo}`, path: mediaPath(`${file}.jpg`) });
    }
    entries.push({ name: `thumbs/${photo}`, data: () => renderThumb(file, edit) });
  });
  if (picture) entries.push({ name: 'picture.jpg', path: picture });
  res.set({
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="fanwall-${asciiSlug(c.name) || 'photos'}.zip"`,
  });
  try {
    await streamZip(res, entries);
  } catch (err) {
    if (!res.headersSent) throw err;
    res.destroy(); // client hung up, or a file vanished mid-stream: a truncated zip is better than a hang
  }
});

// ---------- API: organizer ----------
const admin = express.Router();
app.use('/api/admin/:token', (req, res, next) => {
  const ev = findEventByToken(req.params.token);
  if (!ev) throw new HttpError(404, 'admin_link_invalid');
  res.locals.ev = ev;
  next();
}, admin);

function ownCosplayer(res, cid) {
  const c = getOwn(db.cosplayers, cid);
  if (!c || c.eventId !== res.locals.ev.id) throw new HttpError(404, 'cosplayer_not_found');
  return c;
}

function eventView(ev) {
  return {
    id: ev.id, name: ev.name, open: ev.open, closedAt: ev.closedAt, retentionDays: ev.retentionDays,
    lang: ev.lang ?? null, style: styleOf(ev), createdAt: ev.createdAt,
    baseUrl: ev.baseImage ? mediaUrl(`base_${ev.baseImage}.jpg`) : null,
  };
}

admin.get('/', (req, res) => {
  const ev = res.locals.ev;
  const cosplayers = Object.values(db.cosplayers).filter((c) => c.eventId === ev.id);
  const counts = new Map(cosplayers.map((c) => [c.id, { pending: 0, approved: 0, rejected: 0 }]));
  const submissions = [];
  for (const s of Object.values(db.submissions)) {
    if (s.eventId !== ev.id) continue;
    const k = counts.get(s.cosplayerId);
    if (k) k[s.status]++;
    submissions.push({
      id: s.id, cosplayerId: s.cosplayerId, status: s.status, hidden: s.hidden, message: s.message,
      name: s.name, credit: s.credit, createdAt: s.createdAt,
      thumbUrl: s.file ? mediaUrl(`${s.file}_t.jpg`) : null, fullUrl: s.file ? mediaUrl(`${s.file}.jpg`) : null,
    });
  }
  submissions.sort((a, b) => a.createdAt - b.createdAt);
  cosplayers.sort((a, b) => a.createdAt - b.createdAt);
  res.json({
    event: eventView(ev),
    cosplayers: cosplayers.map((c) => ({
      id: c.id, name: c.name, character: c.character, released: c.released, optOut: c.optOut,
      fanPath: fanPath(c), revealPath: `/r/${c.revealToken}`, counts: counts.get(c.id),
      baseUrl: c.baseImage ? mediaUrl(`base_${c.baseImage}.jpg`) : null,
      style: isStyle(c.style) ? c.style : null, // their own; null means the event's default
    })),
    submissions,
  });
});

admin.patch('/event', (req, res) => {
  const ev = res.locals.ev;
  const body = req.body ?? {};
  const name = textField(body.name, 'eventName', { max: MAX_TITLE, required: body.name !== undefined });
  const retentionDays = retentionField(body.retentionDays);
  const open = body.open === undefined ? undefined : boolField(body.open, 'open');
  const lang = langField(body.lang);
  const style = styleField(body.style);
  if (name !== undefined) ev.name = name;
  if (retentionDays !== undefined) ev.retentionDays = retentionDays;
  if (lang !== undefined) ev.lang = lang;
  if (style !== undefined) ev.style = style;
  if (open === false && ev.open) { ev.open = false; ev.closedAt = Date.now(); }
  if (open === true && !ev.open) { ev.open = true; ev.closedAt = null; }
  save();
  res.json({ event: eventView(ev) });
});

admin.post('/base', imageUpload('image'), async (req, res) => {
  if (!req.file) throw new HttpError(400, 'image_missing');
  const ev = res.locals.ev;
  const id = await encodeOr400(saveBase, req.file.buffer);
  const old = ev.baseImage;
  ev.baseImage = id;
  save();
  await removeBase(old);
  res.json({ event: eventView(ev) });
});

admin.post('/cosplayers', (req, res) => {
  const ev = res.locals.ev;
  const body = req.body ?? {};
  const name = textField(body.name, 'cosplayerName', { max: 60, required: true });
  const character = textField(body.character, 'character', { max: 60 }) ?? '';
  let count = 0;
  for (const c of Object.values(db.cosplayers)) if (c.eventId === ev.id) count++;
  if (count >= MAX_COSPLAYERS) throw new HttpError(409, 'too_many_cosplayers', { max: MAX_COSPLAYERS });
  const id = newId();
  db.cosplayers[id] = {
    id, eventId: ev.id, name, character, revealToken: newId(24), released: false, optOut: false,
    baseImage: null, baseAt: null, style: null, createdAt: Date.now(),
  };
  save();
  res.status(201).json({ id });
});

// A cosplayer's own reveal style; { style: null } goes back to the event's default.
admin.patch('/cosplayers/:cid', (req, res) => {
  const c = ownCosplayer(res, req.params.cid);
  const style = req.body?.style === null ? null : styleField(req.body?.style);
  if (style === undefined) throw new HttpError(400, 'bad_request', { field: 'style' });
  c.style = style;
  save();
  res.json({ style: c.style });
});

// The organizer's preview of a cosplayer's reveal page: exactly what they'd see if released now,
// approved items only. View-only: every change still needs the cosplayer's own link, after release.
admin.get('/cosplayers/:cid/preview', (req, res) => {
  const c = ownCosplayer(res, req.params.cid);
  res.json({ ...revealView(c, res.locals.ev, !c.optOut), preview: true, seed: c.revealToken });
});

admin.delete('/cosplayers/:cid', (req, res) => {
  const c = ownCosplayer(res, req.params.cid);
  removeCosplayer(c.id);
  save();
  res.json({ ok: true });
});

// A cosplayer's own mosaic image (e.g. a photo of them in costume). Checked before the upload is read.
admin.post('/cosplayers/:cid/base', (req, res, next) => {
  const c = ownCosplayer(res, req.params.cid);
  if (c.optOut) throw new HttpError(409, 'cosplayer_closed', { name: c.name });
  next();
},
  imageUpload('image'), async (req, res) => {
    if (!req.file) throw new HttpError(400, 'image_missing');
    const id = await encodeOr400(saveBase, req.file.buffer);
    const c = getOwn(db.cosplayers, req.params.cid);
    if (!c || c.eventId !== res.locals.ev.id || c.optOut) { // removed or opted out while the image was encoding
      await removeBase(id);
      throw c?.optOut ? new HttpError(409, 'cosplayer_closed', { name: c.name }) : new HttpError(404, 'cosplayer_not_found');
    }
    const old = c.baseImage;
    c.baseImage = id;
    c.baseAt = Date.now();
    save();
    await removeBase(old);
    res.json({ baseUrl: mediaUrl(`base_${id}.jpg`) });
  });

admin.delete('/cosplayers/:cid/base', async (req, res) => {
  const c = ownCosplayer(res, req.params.cid);
  const old = c.baseImage;
  c.baseImage = null;
  c.baseAt = null;
  save();
  await removeBase(old);
  res.json({ baseUrl: null });
});

// Everyone gets their link at the same moment. Opted-out cosplayers are skipped.
admin.post('/release-all', (req, res) => {
  const released = boolField(req.body?.released, 'released');
  const updated = [];
  for (const c of Object.values(db.cosplayers)) {
    if (c.eventId !== res.locals.ev.id || (released && c.optOut) || c.released === released) continue;
    c.released = released;
    updated.push(c.id);
  }
  save();
  res.json({ updated });
});

admin.post('/cosplayers/:cid/release', (req, res) => {
  const c = ownCosplayer(res, req.params.cid);
  const released = boolField(req.body?.released, 'released');
  if (released && c.optOut) throw new HttpError(409, 'cosplayer_opted_out', { name: c.name });
  c.released = released;
  save();
  res.json({ released: c.released });
});

admin.get('/qr/:cid.svg', async (req, res) => {
  const c = ownCosplayer(res, req.params.cid);
  const svg = await QRCode.toString(publicBase(req) + fanPath(c), { type: 'svg', margin: 2, errorCorrectionLevel: 'M' });
  res.type('image/svg+xml').send(svg);
});

function statusField(value) {
  if (!STATUSES.has(value)) throw new HttpError(400, 'bad_request', { field: 'status' }); // pending, approved, or rejected
  return value;
}

admin.patch('/submissions/:id', (req, res) => {
  const status = statusField(req.body?.status);
  const id = req.params.id;
  const s = getOwn(db.submissions, id);
  if (!s || s.eventId !== res.locals.ev.id) throw new HttpError(404, 'item_not_found');
  s.status = status;
  save();
  res.json({ id, status });
});

admin.post('/submissions/bulk', (req, res) => {
  const status = statusField(req.body?.status);
  const ids = req.body?.ids;
  if (!Array.isArray(ids) || ids.length > BULK_MAX) throw new HttpError(400, 'bad_request', { field: 'ids', max: BULK_MAX });
  const updated = [];
  for (const id of ids) {
    const s = getOwn(db.submissions, id);
    if (s && s.eventId === res.locals.ev.id) { s.status = status; updated.push(id); }
  }
  save();
  res.json({ updated });
});

// ---------- API: site owner ----------
// The key comes in a header, never the address, so it stays out of history and server logs.
// Organizers only ever hold their own event's link; the owner can open any of them from here.
const owner = express.Router();
app.use('/api/owner', ownerLimit, (req, res, next) => {
  if (!OWNER_KEY) throw new HttpError(404, 'owner_off');
  if (!safeEqual(req.get('x-owner-key'), OWNER_KEY)) throw new HttpError(403, 'bad_owner_key');
  next();
}, owner);

const inviteView = (i) => ({
  id: i.id, label: i.label, createdAt: i.createdAt, revoked: Boolean(i.revoked),
  events: Object.values(db.events).filter((e) => e.inviteId === i.id).length,
});

owner.get('/', (req, res) => {
  const cosplayers = {}, pending = {};
  for (const c of Object.values(db.cosplayers)) cosplayers[c.eventId] = (cosplayers[c.eventId] ?? 0) + 1;
  for (const s of Object.values(db.submissions)) if (s.status === 'pending') pending[s.eventId] = (pending[s.eventId] ?? 0) + 1;
  const events = Object.values(db.events)
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
    .map((e) => ({
      id: e.id, name: e.name, open: e.open, createdAt: e.createdAt, closedAt: e.closedAt,
      cosplayers: cosplayers[e.id] ?? 0, pending: pending[e.id] ?? 0,
      invite: getOwn(db.invites, e.inviteId)?.label ?? null,
      adminPath: `/admin/${e.organizerToken}`,
    }));
  const invites = Object.values(db.invites).sort((a, b) => b.createdAt - a.createdAt).map(inviteView);
  res.json({ events, invites });
});

// The code is shown once, in this answer; only its hash is stored. The label is for the owner
// (an organizer or event name). Don't put emails in it.
owner.post('/invites', (req, res) => {
  const label = textField(req.body?.label, 'inviteLabel', { max: MAX_TITLE, required: true });
  if (Object.keys(db.invites).length >= MAX_INVITES) throw new HttpError(400, 'too_many_invites', { max: MAX_INVITES });
  const code = newDeleteCode();
  const id = newId();
  db.invites[id] = { id, label, codeHash: sha256(normalizeCode(code)), createdAt: Date.now(), revoked: false };
  save();
  res.status(201).json({ ...inviteView(db.invites[id]), code });
});

// Revoking stops new events with that code. Events already made keep working.
owner.delete('/invites/:id', (req, res) => {
  const i = getOwn(db.invites, req.params.id);
  if (!i) throw new HttpError(404, 'invite_not_found');
  i.revoked = true;
  save();
  res.json(inviteView(i));
});

owner.delete('/events/:id', (req, res) => {
  if (!getOwn(db.events, req.params.id)) throw new HttpError(404, 'event_not_found');
  removeEvent(req.params.id);
  save();
  res.json({ ok: true });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));

// ---------- media ----------
app.get('/media/:file', (req, res) => {
  const name = req.params.file;
  if (!MEDIA_NAME.test(name)) return res.status(404).end();
  res.sendFile(name, {
    root: UPLOAD_DIR,
    dotfiles: 'deny',
    headers: {
      'Content-Type': 'image/jpeg',
      'X-Robots-Tag': 'noindex',
      'Cache-Control': 'private, max-age=3600',
    },
  }, (err) => {
    // Missing file -> 404. After headers are out, the only failure is the client hanging up; nothing to do.
    if (err && !res.headersSent) res.status(404).end();
  });
});

// ---------- pages ----------
const page = (file) => (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(file, { root: PUBLIC_DIR });
};
// A bad organizer link still gets its page, with a 404, so the page can say so in the visitor's language.
const requireOrganizer = (req, res, next) => {
  if (!findEventByToken(req.params.token)) res.status(404);
  next();
};

app.get('/', page('index.html'));
app.get('/review', page('review.html')); // the year in review: reads ZIPs on the device, holds no data
app.get('/e/:eid/c/:cid', page('fan.html')); // the page itself explains bad or closed links
app.get('/r/:token', page('reveal.html')); // the page shows "not ready" / "not valid" itself
app.get('/owner', page('owner.html')); // asks for the owner key itself; holds no data
app.get('/admin/:token', requireOrganizer, page('admin.html'));
app.get('/admin/:token/print/:cid', requireOrganizer, page('print.html'));
app.get('/admin/:token/preview/:cid', requireOrganizer, page('reveal.html')); // reveal.js sees the path
app.use(express.static(PUBLIC_DIR, { index: false }));

// ---------- errors ----------
// Never log request bodies, headers, or addresses here.
app.use((err, req, res, next) => {
  const status = err.status ?? err.statusCode ?? 500;
  if (status >= 500) console.error('[error]', err.message);
  if (res.headersSent) return next(err);
  // Anything else (a malformed JSON body, say) gets a generic code; parser messages never go out.
  if (err instanceof HttpError) return res.status(status).json({ error: err.code, ...err.vars });
  res.status(status).json({ error: status >= 500 ? 'server_error' : 'bad_request' });
});

// ---------- retention ----------
function runPurge() {
  try {
    const n = purgeExpired();
    if (n) console.log(`[purge] removed ${n} expired submission(s)`);
    const orphans = removeOrphanFiles();
    if (orphans) console.log(`[purge] removed ${orphans} orphaned file(s)`);
  } catch (err) {
    console.error('[purge] failed:', err.message);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runPurge();
  setInterval(runPurge, 60 * 60e3).unref();
  app.listen(PORT, () => console.log(`FanWall listening on http://localhost:${PORT}`));
}
