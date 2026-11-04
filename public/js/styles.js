// Reveal styles. The organizer sets a default for the event and may give any cosplayer their own
// (decided 2026-11-03, replacing "per event only"). Each style has a pure, DOM-free layout planner
// (tested under node --test); reveal.js and art.js draw them. Shared with the server, which checks
// settings against STYLE_IDS.
import { planMosaic, mulberry32, hashSeed } from './mosaic.js';
import { planWall } from './polaroid.js';
import { planSky } from './constellation.js';

export const STYLES = {
  mosaic: { plan: planMosaic }, // the photos assemble into the event's picture (or the cosplayer's own)
  polaroid: { plan: planWall }, // the photos pinned on a wall as prints; notes as paper cards
  constellation: { plan: planSky }, // the photos as stars joined by faint lines; notes drifting nearby
};
export const STYLE_IDS = Object.keys(STYLES);
export const DEFAULT_STYLE = 'mosaic';
export const isStyle = (v) => typeof v === 'string' && Object.hasOwn(STYLES, v);
export const styleOf = (event) => (isStyle(event?.style) ? event.style : DEFAULT_STYLE);
// A cosplayer's reveal style: their own when the organizer set one, else the event's default.
export const styleFor = (event, cosplayer) => (isStyle(cosplayer?.style) ? cosplayer.style : styleOf(event));

// Save image. Fans agree that their photo may appear as a small tile in an image the cosplayer posts,
// and to nothing more: no photo in a saved image is wider or taller than this share of the image's
// width, and no notes or names are drawn into it at all.
export const EXPORT_MAX_PHOTO = 1 / 6;
// The wall and the sky are saved at 4:5, a portrait post. (The mosaic keeps its picture's shape.)
export const EXPORT = {
  width: 1728, height: 2160,
  polaroid: { cols: 6 },
  constellation: { stars: 12, radius: 0.055 },
};

// The photos a wall or a sky works with when there are more than it can hold: a fixed, seeded pick of
// `max` indices out of `n`, in a seeded order, so the same reveal always shows the same set.
export function pickPool(n, max, seed) {
  const idx = Array.from({ length: n }, (_, i) => i);
  const rng = mulberry32(hashSeed(seed) ^ 0x9001);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx.slice(0, Math.min(n, max));
}

// When `len` items take turns in K slots: which item slot k shows after `step` changes. Each change
// moves slot (step % K) on to the next item, so (when len >= K) the K on show are always different,
// and every item gets its turn.
export function cycleItem(k, step, K, len) {
  if (len <= K || step <= k) return k % len;
  const last = k + K * Math.floor((step - 1 - k) / K); // the last step at which slot k changed
  return (K + last) % len;
}
