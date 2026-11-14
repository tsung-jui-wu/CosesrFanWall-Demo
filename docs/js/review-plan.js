// The year in review's running order, from the manifests of the bundles the person picked. Pure and
// DOM-free (tested under node --test). No counts anywhere: nothing here says which event was bigger.
import { mulberry32, hashSeed } from './mosaic.js';

export const NOTES_PER_SPREAD = 3;
export const PHOTOS_PER_SPREAD = 60; // enough for any style's picture; the rest stay in the ZIP

function shuffled(arr, seed) {
  const out = arr.slice();
  const rng = mulberry32(hashSeed(seed));
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// A seed from what the bundle says about itself (it carries no ids): the same bundle always gets the
// same spread.
export const spreadSeed = (m) => `${m.event.name}\u0000${m.cosplayer?.name ?? ''}\u0000${m.event.date ?? ''}`;

// manifests: in any order, possibly the same bundle twice.
// Returns [{ year, spreads: [{ index, seed, notes: [items], photos: [items] }] }]: years oldest first
// and events in date order, so the review reads as the year went. index points into `manifests`.
export function planReview(manifests) {
  const seen = new Set();
  const spreads = [];
  manifests.forEach((m, index) => {
    const seed = spreadSeed(m);
    if (seen.has(seed)) return; // the same download picked twice
    seen.add(seed);
    const items = m.items ?? [];
    // Notes: the cosplayer's favorites first, then a seeded pick of the rest.
    const notes = items.filter((i) => typeof i.note === 'string' && i.note);
    const fav = shuffled(notes.filter((i) => i.favorite === true), `${seed}:notes`);
    const rest = shuffled(notes.filter((i) => i.favorite !== true), `${seed}:notes`);
    const photos = items.filter((i) => i.type === 'photo' && (i.thumb || i.file));
    spreads.push({
      index, seed, date: /^\d{4}-\d{2}-\d{2}$/.test(m.event.date ?? '') ? m.event.date : '0000-00-00',
      notes: [...fav, ...rest].slice(0, NOTES_PER_SPREAD),
      photos: shuffled(photos, `${seed}:photos`).slice(0, PHOTOS_PER_SPREAD),
    });
  });
  spreads.sort((a, b) => a.date.localeCompare(b.date) || a.seed.localeCompare(b.seed));
  const years = [];
  for (const s of spreads) {
    const year = s.date.slice(0, 4);
    if (years.at(-1)?.year !== year) years.push({ year, spreads: [] });
    years.at(-1).spreads.push(s);
  }
  return years;
}
