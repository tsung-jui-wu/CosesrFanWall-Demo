// Demo data: one event, six cosplayers, a synthetic booth image, and `count` synthetic fan photos.
// Usage: npm run seed [-- count]   (stop the server first: it keeps the db in memory and would overwrite this)
import { db, flush, newId, sha256 } from '../lib/store.js';
import { savePhoto, saveBase } from '../lib/images.js';
import { CONSENT_VERSION } from '../lib/consent.js';
import { mulberry32 } from '../public/js/mosaic.js';

const arg = Number.parseInt(process.argv[2] ?? '', 10);
const count = Number.isFinite(arg) ? Math.max(0, Math.min(1500, arg)) : 150;
const base = (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
const rng = mulberry32(2026);
const pick = (arr) => arr[Math.floor(rng() * arr.length)];
const hsl = (h, s, l) => `hsl(${Math.round(h)},${s}%,${l}%)`;

const MESSAGES = [
  'Your costume made my whole day!', 'The detail on the armor is unreal.', 'Thank you for posing with my kid!',
  'Best cosplay of the con, hands down.', 'You were so kind to everyone in line.', 'That prop work!! How?!',
  'I cried a little, it was perfect.', 'Thanks for the photo, you are a legend.', 'See you next year!',
  'The wig styling is incredible.', 'You inspired me to start cosplaying.', 'Such a fun pose, thank you!',
];
const NAMES = ['Mika', 'Jun', 'Sam', 'Rae', 'Toby', 'Ines', 'Kai', 'Lou', 'Noor', 'Ash'];

// Booth: warm gradient, dark stage, a big pink heart as the subject so the mosaic reads clearly.
function boothSvg() {
  const stars = Array.from({ length: 40 }, () =>
    `<circle cx="${(rng() * 1600).toFixed(0)}" cy="${(rng() * 420).toFixed(0)}" r="${(2 + rng() * 5).toFixed(1)}" fill="#fff8d6" opacity="${(0.4 + rng() * 0.6).toFixed(2)}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000">
    <defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1b1446"/><stop offset="0.6" stop-color="#5b2a86"/><stop offset="1" stop-color="#f08a4b"/>
    </linearGradient></defs>
    <rect width="1600" height="1000" fill="url(#sky)"/>${stars}
    <rect y="820" width="1600" height="180" fill="#2a1a12"/>
    <path d="M800 860 C 380 600 420 250 640 250 C 730 250 780 310 800 360 C 820 310 870 250 960 250 C 1180 250 1220 600 800 860 Z"
      fill="#ff3d7f" stroke="#ffd1e1" stroke-width="14"/>
  </svg>`;
}

// A "photo": random hue gradient with a few blobs, and sometimes a person-ish silhouette.
function photoSvg() {
  const h = rng() * 360;
  const blobs = Array.from({ length: 4 }, () =>
    `<circle cx="${(rng() * 600).toFixed(0)}" cy="${(rng() * 800).toFixed(0)}" r="${(60 + rng() * 180).toFixed(0)}" fill="${hsl(h + rng() * 90 - 45, 60 + rng() * 35, 35 + rng() * 40)}" opacity="0.8"/>`).join('');
  const person = rng() < 0.6
    ? `<circle cx="300" cy="300" r="90" fill="${hsl(h + 180, 40, 25)}"/><rect x="190" y="400" width="220" height="400" rx="80" fill="${hsl(h + 180, 40, 25)}"/>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${hsl(h, 70, 55)}"/><stop offset="1" stop-color="${hsl(h + 40, 70, 30)}"/>
    </linearGradient></defs>
    <rect width="600" height="800" fill="url(#g)"/>${blobs}${person}
  </svg>`;
}

// The same costume in every photo (crimson coat, black hair), like a real day at a con: only the
// framing and the hall behind change. Used to check the mosaic when the fan photos share one palette.
const HALL = ['#8d8a86', '#b9b2a6', '#6f6a66', '#c9c3b8', '#4a4a52', '#a59a88', '#7b8794', '#d8d2c4', '#3b3a40', '#5d6b4f', '#86a6c8'];
const figure = (x, y, scale) => `<g transform="translate(${x} ${y}) scale(${scale})">
    <path d="M-70 160 L-55 -10 Q0 -40 55 -10 L70 160 Z" fill="#b3122b"/>
    <path d="M-10 -10 L10 -10 L6 160 L-6 160 Z" fill="#1a1416"/>
    <circle cx="0" cy="-50" r="34" fill="#f1c7a8"/>
    <path d="M-38 -55 Q0 -110 38 -55 L44 10 L30 -40 Q0 -70 -30 -40 L-44 10 Z" fill="#141014"/>
  </g>`;
const hall = (w, h, top, bottom) => `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient></defs>
  <rect width="${w}" height="${h}" fill="url(#g)"/>`;
function outfitSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600">${hall(800, 600, pick(HALL), pick(HALL))}
    ${figure(270 + rng() * 260, 330 + rng() * 130, 1.3 + rng() * 2.4)}</svg>`;
}
// The cosplayer's own mosaic image: the organizer's booth photo of them.
const portraitSvg = () => `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900">${hall(1200, 900, '#9b958c', '#5a5650')}
  ${figure(600, 430, 2.6)}</svg>`;

async function addSubmissions(ev, cos, n, statusOf, photoRate = 0.85, makePhoto = photoSvg) {
  for (let i = 0; i < n; i++) {
    const hasPhoto = rng() < photoRate;
    const hasMessage = !hasPhoto || rng() < 0.4;
    const name = rng() < 0.6 ? pick(NAMES) : '';
    const createdAt = Date.now() - Math.floor(rng() * 6 * 3600e3);
    const id = newId();
    db.submissions[id] = {
      id, eventId: ev.id, cosplayerId: cos.id,
      file: hasPhoto ? await savePhoto(Buffer.from(makePhoto()), { allowSvg: true }) : null,
      message: hasMessage ? pick(MESSAGES) : '',
      name, credit: Boolean(name) && rng() < 0.7,
      consent: { v: CONSENT_VERSION, lang: 'en', at: createdAt },
      status: statusOf(i), hidden: false,
      codeHash: sha256(newId()), // seeded items have no usable delete code
      createdAt,
    };
  }
}

// A running server holds the db in memory and would overwrite what we write, orphaning the new files.
const running = await fetch(`http://localhost:${process.env.PORT || 3000}/robots.txt`, { signal: AbortSignal.timeout(1500) })
  .then(() => true, () => false);
if (running) {
  console.error(`A server is answering on port ${process.env.PORT || 3000}. Stop it, seed, then start it again.`);
  process.exit(1);
}

const now = Date.now();
const ev = {
  id: newId(), name: 'FanWall Demo Con', organizerToken: newId(24), baseImage: await saveBase(Buffer.from(boothSvg()), { allowSvg: true }),
  open: true, closedAt: null, retentionDays: 30, lang: null, createdAt: now,
};
db.events[ev.id] = ev;
const mkCos = (name, character, released) => {
  const c = {
    id: newId(), eventId: ev.id, name, character, revealToken: newId(24), released, optOut: false,
    baseImage: null, baseAt: null, createdAt: now,
  };
  db.cosplayers[c.id] = c;
  return c;
};
// One cosplayer per reveal case: lots of photos, a few dozen, a handful, just three, and the
// release gate (not released yet). Yuki's fans all photographed one costume, and Yuki has their own image.
const star = mkCos('Aki', 'Starlight Knight', true);
const partial = mkCos('Mei', 'Sky Pirate', true);
const small = mkCos('Rin', 'Forest Witch', true);
const gated = mkCos('Kai', 'Clockwork Mage', false);
const outfit = mkCos('Yuki', 'Crimson Duelist', true);
outfit.baseImage = await saveBase(Buffer.from(portraitSvg()), { allowSvg: true });
outfit.baseAt = now;
const few = mkCos('Sora', 'Moon Archer', true); // just three photos: every style must still look complete

// Mostly approved with some pending and rejected, so moderation has something to do.
await addSubmissions(ev, star, count, () => { const r = rng(); return r < 0.75 ? 'approved' : r < 0.9 ? 'pending' : 'rejected'; });
await addSubmissions(ev, partial, 30, () => 'approved', 1);
await addSubmissions(ev, small, 8, () => 'approved', 1);
await addSubmissions(ev, gated, 12, () => 'pending');
await addSubmissions(ev, outfit, 150, () => 'approved', 0.85, outfitSvg);
await addSubmissions(ev, few, 3, () => 'approved', 1); // last, so the others' random data stays the same
flush();

const total = Object.values(db.submissions).filter((s) => s.eventId === ev.id).length;
console.log(`Seeded "${ev.name}" with ${total} submissions.\n`);
console.log(`Organizer: ${base}/admin/${ev.organizerToken}`);
for (const c of [star, partial, small, gated, outfit, few]) {
  console.log(`\n${c.name} (${c.released ? 'released' : 'not released'})`);
  console.log(`  Fan page: ${base}/e/${ev.id}/c/${c.id}`);
  console.log(`  Reveal:   ${base}/r/${c.revealToken}`);
}
