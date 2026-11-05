// Live-data test: import a folder of real photos as fan submissions, through the same savePhoto
// re-encode as an upload (EXIF and GPS stripped, random file names; the originals are not copied).
// Usage: npm run import -- <folder> [--cosplayer <id> | --event <id>] [--name <cosplayer name>] [--status pending|approved]
//   With no --cosplayer or --event, creates a new test event. With --event, adds a new cosplayer to it.
//   (Stop the server first: it keeps the db in memory and would overwrite this.)
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { db, flush, newId, sha256, getOwn } from '../lib/store.js';
import { savePhoto, ImageDecodeError } from '../lib/images.js';
import { CONSENT_VERSION } from '../lib/consent.js';
import { DEFAULT_STYLE } from '../public/js/styles.js';

const MAX_PER_COSPLAYER = 1500; // same cap as the submit route in server.js
const EXT = /\.(jpe?g|png|webp|gif|heic|heif|avif)$/i;

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    event: { type: 'string' },
    cosplayer: { type: 'string' },
    name: { type: 'string', default: 'Test Cosplayer' },
    status: { type: 'string', default: 'pending' },
  },
});
const fail = (msg) => { console.error(msg); process.exit(1); };
if (positionals.length !== 1) fail('Usage: npm run import -- <folder> [--cosplayer <id> | --event <id>] [--name <name>] [--status pending|approved]');
if (!['pending', 'approved'].includes(opts.status)) fail(`--status must be pending or approved, not "${opts.status}".`);

const port = process.env.PORT || 3000;
const base = (process.env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/+$/, '');
const running = await fetch(`http://localhost:${port}/robots.txt`, { signal: AbortSignal.timeout(1500) })
  .then(() => true, () => false);
if (running) fail(`A server is answering on port ${port}. Stop it, import, then start it again.`);

const dir = path.resolve(positionals[0]);
const names = await fs.readdir(dir, { withFileTypes: true })
  .then((ents) => ents.filter((e) => e.isFile() && EXT.test(e.name)).map((e) => e.name).sort(), () => fail(`Cannot read folder ${dir}`));
if (!names.length) fail(`No images (jpg, png, webp, gif, heic, avif) in ${dir}`);

const now = Date.now();
let ev, cos;
if (opts.cosplayer) {
  cos = getOwn(db.cosplayers, opts.cosplayer) ?? fail(`No cosplayer with id ${opts.cosplayer}.`);
  ev = db.events[cos.eventId];
  if (opts.event && opts.event !== ev.id) fail('That cosplayer belongs to another event.');
} else {
  if (opts.event) ev = getOwn(db.events, opts.event) ?? fail(`No event with id ${opts.event}.`);
  else {
    ev = {
      id: newId(), name: 'Import Test', organizerToken: newId(24), baseImage: null, open: true, closedAt: null,
      retentionDays: 30, lang: null, style: DEFAULT_STYLE, createdAt: now,
    };
    db.events[ev.id] = ev;
  }
  cos = {
    id: newId(), eventId: ev.id, name: opts.name, character: '', revealToken: newId(24), released: false, optOut: false,
    baseImage: null, baseAt: null, style: null, createdAt: now,
  };
  db.cosplayers[cos.id] = cos;
}

let room = MAX_PER_COSPLAYER - Object.values(db.submissions).filter((s) => s.cosplayerId === cos.id).length;
let added = 0, skipped = 0;
for (const [i, name] of names.entries()) {
  if (room <= 0) {
    console.warn(`Stopped: ${cos.name} has reached ${MAX_PER_COSPLAYER} submissions; ${names.length - i} files not imported.`);
    break;
  }
  let file;
  try {
    file = await savePhoto(await fs.readFile(path.join(dir, name)));
  } catch (err) {
    if (!(err instanceof ImageDecodeError)) throw err;
    console.warn(`Skipped ${name}: ${err.message}`);
    skipped++;
    continue;
  }
  const id = newId();
  db.submissions[id] = {
    id, eventId: ev.id, cosplayerId: cos.id, file, message: '', name: '', credit: false,
    consent: { v: CONSENT_VERSION, lang: 'en', at: now },
    status: opts.status, hidden: false,
    codeHash: sha256(newId()), // imported items have no usable delete code
    createdAt: now,
  };
  added++;
  room--;
  process.stdout.write(`\r${added + skipped}/${names.length}`);
}
flush();

console.log(`\nImported ${added} photos (${opts.status}) for ${cos.name} at "${ev.name}"${skipped ? `; skipped ${skipped}` : ''}.\n`);
console.log(`Organizer: ${base}/admin/${ev.organizerToken}`);
console.log(`Fan page:  ${base}/e/${ev.id}/c/${cos.id}`);
console.log(`Reveal:    ${base}/r/${cos.revealToken}${cos.released ? '' : '   (not released yet: release it from the organizer page)'}`);
