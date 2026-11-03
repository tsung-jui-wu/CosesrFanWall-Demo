// Tiny JSON-file store. Fine for a demo / a few events; swap for SQLite or Postgres when it grows.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const FILE = path.join(DATA_DIR, 'db.json');

export const db = { events: {}, cosplayers: {}, submissions: {} };
if (fs.existsSync(FILE)) Object.assign(db, JSON.parse(fs.readFileSync(FILE, 'utf8')));

let timer = null;
export function flush() {
  clearTimeout(timer);
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, FILE);
}
// Debounced. A failed write must not throw inside the timer (that would crash the process);
// on Windows, antivirus or indexing can briefly lock the file, so log and try again shortly.
export function save(delay = 150) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      flush();
    } catch (err) {
      console.error('[store] save failed, retrying:', err.message);
      save(2000);
    }
  }, delay);
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { flush(); process.exit(0); });
process.on('exit', () => { try { flush(); } catch {} });

export const newId = (bytes = 9) => crypto.randomBytes(bytes).toString('base64url');
export const newFileId = () => crypto.randomBytes(16).toString('hex');
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export const mediaPath = (name) => path.join(UPLOAD_DIR, name);
export const MEDIA_NAME = /^(?:[0-9a-f]{32}(?:_t)?|base_[0-9a-f]{32})\.jpg$/;

// Lookups by an id that came from a request. Plain `map[id]` would also "find" inherited keys
// like `constructor` or `__proto__`.
export const getOwn = (map, id) => (typeof id === 'string' && Object.hasOwn(map, id) ? map[id] : undefined);

function unlinkQuiet(name) {
  try { fs.unlinkSync(mediaPath(name)); } catch {}
}

export function removeSubmission(id) {
  const s = getOwn(db.submissions, id);
  if (!s) return;
  if (s.file) { unlinkQuiet(`${s.file}.jpg`); unlinkQuiet(`${s.file}_t.jpg`); }
  delete db.submissions[id];
}

export function removeCosplayerContent(cosplayerId) {
  for (const s of Object.values(db.submissions)) if (s.cosplayerId === cosplayerId) removeSubmission(s.id);
}

export function removeCosplayer(cosplayerId) {
  removeCosplayerContent(cosplayerId);
  const c = getOwn(db.cosplayers, cosplayerId);
  if (c?.baseImage) unlinkQuiet(`base_${c.baseImage}.jpg`);
  delete db.cosplayers[cosplayerId];
}

// The cosplayer's "remove everything": every submission (any status), their own mosaic image, and
// the page closes for good. The record stays so the fan link and reveal link answer "closed".
export function optOutCosplayer(cosplayerId) {
  const c = getOwn(db.cosplayers, cosplayerId);
  if (!c) return;
  removeCosplayerContent(cosplayerId);
  if (c.baseImage) unlinkQuiet(`base_${c.baseImage}.jpg`);
  Object.assign(c, { optOut: true, released: false, baseImage: null, baseAt: null });
}

export function removeEvent(eventId) {
  for (const s of Object.values(db.submissions)) if (s.eventId === eventId) removeSubmission(s.id);
  for (const c of Object.values(db.cosplayers)) if (c.eventId === eventId) removeCosplayer(c.id);
  const ev = db.events[eventId];
  if (ev?.baseImage) unlinkQuiet(`base_${ev.baseImage}.jpg`);
  delete db.events[eventId];
}

export const findEventByToken = (token) =>
  Object.values(db.events).find((e) => safeEqual(e.organizerToken, token));
export const findCosplayerByToken = (token) =>
  Object.values(db.cosplayers).find((c) => safeEqual(c.revealToken, token));

// Constant-time string compare. Non-strings and empty strings never match.
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a) return false;
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// Retention: submissions are deleted `retentionDays` after the event closes,
// and never kept longer than HARD_CAP_DAYS after they were uploaded. A cosplayer's own mosaic
// image is usually a photo of them, so it follows the same rule.
export const HARD_CAP_DAYS = 90;
const DAY = 86400e3;
export function purgeExpired(now = Date.now()) {
  let removed = 0;
  for (const s of Object.values(db.submissions)) {
    const ev = db.events[s.eventId];
    const afterClose = ev?.closedAt ? ev.closedAt + (ev.retentionDays ?? 30) * DAY : Infinity;
    // A record without a usable timestamp counts as expired: fail toward deleting, not keeping.
    const cap = Number.isFinite(s.createdAt) ? s.createdAt + HARD_CAP_DAYS * DAY : -Infinity;
    if (!ev || now > Math.min(afterClose, cap)) { removeSubmission(s.id); removed++; }
  }
  let changed = removed > 0;
  for (const c of Object.values(db.cosplayers)) {
    if (!c.baseImage) continue;
    const ev = db.events[c.eventId];
    const afterClose = ev?.closedAt ? ev.closedAt + (ev.retentionDays ?? 30) * DAY : Infinity;
    const cap = Number.isFinite(c.baseAt) ? c.baseAt + HARD_CAP_DAYS * DAY : -Infinity;
    if (now > Math.min(afterClose, cap)) {
      unlinkQuiet(`base_${c.baseImage}.jpg`);
      c.baseImage = null;
      c.baseAt = null;
      changed = true;
    }
  }
  if (changed) save();
  return removed;
}

// Media files no record points to (e.g. a crash between writing an upload and saving the db).
// They would otherwise escape retention forever. minAgeMs leaves in-flight uploads alone.
export function removeOrphanFiles(now = Date.now(), minAgeMs = 3600e3) {
  const live = new Set();
  for (const s of Object.values(db.submissions)) if (s.file) { live.add(`${s.file}.jpg`); live.add(`${s.file}_t.jpg`); }
  for (const e of Object.values(db.events)) if (e.baseImage) live.add(`base_${e.baseImage}.jpg`);
  for (const c of Object.values(db.cosplayers)) if (c.baseImage) live.add(`base_${c.baseImage}.jpg`);
  let removed = 0;
  for (const name of fs.readdirSync(UPLOAD_DIR)) {
    if (live.has(name) || !MEDIA_NAME.test(name)) continue; // only ever touch files we name
    try {
      if (now - fs.statSync(mediaPath(name)).mtimeMs < minAgeMs) continue;
      fs.unlinkSync(mediaPath(name));
      removed++;
    } catch {}
  }
  return removed;
}
