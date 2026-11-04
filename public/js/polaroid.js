// Polaroid wall planner. Pure and DOM-free, like mosaic.js: it decides where each print hangs, how it
// tilts, and which photo it shows; reveal.js and art.js draw them. Also runs under `node --test`.
//
// The wall always looks full. How many prints hang depends only on the wall's shape and the print
// size, never on how many photos there are: with fewer photos than prints each photo hangs more than
// once, kept apart from its copies; with more, the reveal cycles through them a print at a time.
import { mulberry32, hashSeed } from './mosaic.js';

export const PRINT_RATIO = 1.2; // a print's height / width: a square photo with a deeper bottom border
export const PRINT_PHOTO = 0.86; // the photo's side, as a share of the print's width

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// aspect: width / height of the wall; cols: prints across; photos: how many photos to hang (at least 1);
// noteSpots: how many places to pin notes. Everything is in wall-width units: x runs 0..1 across and
// y 0..height down, where height = 1 / aspect.
// Returns { height, prints: [{ x, y, w, rot, photo, delay }] in drawing order (later ones on top),
// notes: [{ x, y, rot }] }. (x, y) is a print's center and w its width; delay (0..1) orders the intro.
export function planWall({ aspect, cols, photos, seed = 1, noteSpots = 0 }) {
  if (!(aspect > 0) || !Number.isInteger(cols) || cols < 1) throw new Error('planWall: needs aspect > 0 and whole cols >= 1');
  if (!Number.isInteger(photos) || photos < 1) throw new Error('planWall: needs at least one photo');
  const rng = mulberry32(hashSeed(seed) ^ 0x5eed1e);
  const height = 1 / aspect;
  const cw = 1 / cols, w = cw * 0.94;
  const rowH = w * PRINT_RATIO * 0.84; // rows overlap a little, like prints pinned close together
  // Enough rows to run past the top and bottom edges, so the wall never shows a bare strip.
  const rows = Math.ceil(height / rowH) + 1;
  const y0 = (height - (rows - 1) * rowH) / 2;

  const prints = [];
  for (let r = 0; r < rows; r++) {
    const odd = r % 2 === 1;
    // Odd rows sit half a print over, with one more print so both edges stay covered.
    for (let c = 0; c < (odd ? cols + 1 : cols); c++) {
      prints.push({
        x: (odd ? c : c + 0.5) * cw + (rng() - 0.5) * 0.16 * cw,
        y: y0 + r * rowH + (rng() - 0.5) * 0.14 * rowH,
        w: w * (0.96 + rng() * 0.08),
        rot: (rng() - 0.5) * 0.24, // about ±7 degrees
        photo: 0,
        delay: 0,
      });
    }
  }
  shuffle(prints, rng); // drawing order decides which print overlaps which
  assignPhotos(prints, photos, cw, rng);
  const order = shuffle(prints.map((_, i) => i), rng);
  order.forEach((p, i) => { prints[p].delay = order.length > 1 ? i / (order.length - 1) : 0; });

  // Notes are pinned over the prints, spread out: two across at most, a short last row centered.
  const notes = [];
  const across = Math.min(noteSpots, 2), down = Math.ceil(noteSpots / Math.max(across, 1));
  for (let i = 0; i < noteSpots; i++) {
    const c = i % across, r = Math.floor(i / across);
    const inRow = Math.min(across, noteSpots - r * across);
    notes.push({
      x: (c + 0.5 + (across - inRow) / 2) / across + (rng() - 0.5) * 0.08,
      y: ((r + 0.5) / down) * height + (rng() - 0.5) * 0.06 * height,
      rot: (rng() - 0.5) * 0.12,
    });
  }
  return { height, prints, notes };
}

// With at least as many photos as prints, every print shows a different photo. With fewer, each photo
// is used about equally often, and never on two neighboring prints when that can be avoided.
function assignPhotos(prints, photos, cw, rng) {
  if (photos >= prints.length) {
    prints.forEach((p, i) => { p.photo = i; });
    return;
  }
  const usage = new Uint32Array(photos);
  const near = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) < cw * 1.6;
  const done = [];
  for (const i of shuffle(prints.map((_, k) => k), rng)) {
    const p = prints[i];
    const nextTo = new Set(done.filter((q) => near(p, q)).map((q) => q.photo));
    let best = 0, bestKey = Infinity;
    for (let f = 0; f < photos; f++) {
      const key = (nextTo.has(f) ? 1000 : 0) + usage[f] + rng() * 0.5;
      if (key < bestKey) { best = f; bestKey = key; }
    }
    p.photo = best;
    usage[best]++;
    done.push(p);
  }
}
