import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planWall, PRINT_RATIO, PRINT_PHOTO } from '../public/js/polaroid.js';
import { planSky } from '../public/js/constellation.js';
import { STYLES, STYLE_IDS, DEFAULT_STYLE, isStyle, styleOf, EXPORT, EXPORT_MAX_PHOTO, pickPool, cycleItem } from '../public/js/styles.js';

const COUNTS = [1, 3, 8, 30, 150, 1500];

test('the registry: three styles, mosaic by default, each with a planner', () => {
  assert.deepEqual(STYLE_IDS, ['mosaic', 'polaroid', 'constellation']);
  for (const id of STYLE_IDS) assert.equal(typeof STYLES[id].plan, 'function', id);
  assert.equal(DEFAULT_STYLE, 'mosaic');
  assert.ok(isStyle('polaroid') && !isStyle('Polaroid') && !isStyle('constructor') && !isStyle(undefined));
  assert.equal(styleOf({ style: 'constellation' }), 'constellation');
  assert.equal(styleOf({}), 'mosaic', 'events from before styles keep the mosaic');
  assert.equal(styleOf({ style: 'nope' }), 'mosaic');
});

// ---------- polaroid wall ----------
const wall = (photos, extra = {}) => planWall({ aspect: 0.6, cols: 4, photos, seed: 'token-1', noteSpots: 3, ...extra });

test('wall: the same seed gives the same wall; another seed a different one', () => {
  assert.deepEqual(wall(30), wall(30));
  assert.notDeepEqual(wall(30).prints, wall(30, { seed: 'token-2' }).prints);
});

test('wall: always full, with the same number of prints however many photos there are', () => {
  const sizes = new Set(COUNTS.map((n) => wall(n).prints.length));
  assert.equal(sizes.size, 1, 'the print count never depends on the photo count');
  const { prints, height } = wall(3);
  // Sample the wall: nearly every spot is under a print (rotation ignored: it only adds overlap).
  let covered = 0, total = 0;
  for (let gx = 0.02; gx < 1; gx += 0.04) {
    for (let gy = 0.02; gy < height; gy += 0.04) {
      total++;
      if (prints.some((p) => Math.abs(gx - p.x) <= p.w / 2 && Math.abs(gy - p.y) <= (p.w * PRINT_RATIO) / 2)) covered++;
    }
  }
  assert.ok(covered / total > 0.85, `covered ${Math.round((100 * covered) / total)}%`);
});

test('wall: photos are all different when there are enough, and spread evenly and apart when not', () => {
  const big = wall(1500);
  assert.equal(new Set(big.prints.map((p) => p.photo)).size, big.prints.length);
  for (const n of [1, 3, 8]) {
    const { prints } = wall(n);
    const usage = Array(n).fill(0);
    for (const p of prints) usage[p.photo]++;
    assert.ok(usage.every((u) => u > 0), `n=${n}: every photo hangs`);
    assert.ok(Math.max(...usage) - Math.min(...usage) <= 2, `n=${n}: even use ${usage}`);
    if (n >= 8) {
      const cw = 1 / 4;
      for (const a of prints) for (const b of prints) {
        if (a !== b && a.photo === b.photo) assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= cw * 1.6, `n=${n}: copies kept apart`);
      }
    }
  }
});

test('wall: intro delays run 0..1 and notes are pinned inside the wall', () => {
  const { prints, notes, height } = wall(30);
  const delays = prints.map((p) => p.delay).sort((a, b) => a - b);
  assert.equal(delays[0], 0);
  assert.equal(delays.at(-1), 1);
  assert.equal(notes.length, 3);
  for (const n of notes) assert.ok(n.x > 0 && n.x < 1 && n.y > 0 && n.y < height);
  assert.throws(() => planWall({ aspect: 1, cols: 4, photos: 0 }));
});

// ---------- constellation ----------
const sky = (photos, extra = {}) => planSky({ aspect: 0.6, stars: 9, radius: 0.06, photos, seed: 'token-1', noteSpots: 3, ...extra });

test('sky: the same seed gives the same sky; another seed a different one', () => {
  assert.deepEqual(sky(30), sky(30));
  assert.notDeepEqual(sky(30).stars, sky(30, { seed: 'token-2' }).stars);
});

test('sky: the same stars and background however many photos there are', () => {
  for (const n of COUNTS) {
    const s = sky(n);
    assert.equal(s.stars.length, 9, `n=${n}`);
    assert.equal(s.dust.length, 140, `n=${n}`);
  }
  // Positions don't move with the count either: only which photo each star shows.
  assert.deepEqual(sky(1).stars.map(({ x, y }) => [x, y]), sky(1500).stars.map(({ x, y }) => [x, y]));
});

test('sky: stars stay inside and apart, and the lines join them all as one tree', () => {
  const { stars, links, height } = sky(30);
  for (const s of stars) assert.ok(s.x - s.r > 0 && s.x + s.r < 1 && s.y - s.r > 0 && s.y + s.r < height);
  for (const a of stars) for (const b of stars) {
    if (a !== b) assert.ok(Math.hypot(a.x - b.x, a.y - b.y) > a.r + b.r, 'stars never overlap');
  }
  assert.equal(links.length, stars.length - 1);
  const parent = stars.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (const [a, b] of links) parent[find(a)] = find(b);
  assert.equal(new Set(stars.map((_, i) => find(i))).size, 1, 'one connected constellation');
});

test('sky: photos spread evenly, never on two joined stars when avoidable; notes sit by different stars', () => {
  for (const n of [1, 3, 8]) {
    const { stars, links } = sky(n);
    const usage = Array(n).fill(0);
    for (const s of stars) usage[s.photo]++;
    assert.ok(usage.every((u) => u > 0) && Math.max(...usage) - Math.min(...usage) <= 2, `n=${n}: ${usage}`);
    if (n >= 3) for (const [a, b] of links) assert.notEqual(stars[a].photo, stars[b].photo, `n=${n}: joined stars differ`);
  }
  const { notes } = sky(30);
  assert.equal(new Set(notes.map((n) => n.star)).size, notes.length);
  for (const n of notes) assert.ok(Math.abs(Math.hypot(n.dx, n.dy) - 1) < 1e-9);
});

// ---------- Save image: small photos only ----------
test('saved walls and skies only ever show photos as small tiles, at any count', () => {
  const aspect = EXPORT.width / EXPORT.height;
  for (const n of COUNTS) {
    const w = planWall({ aspect, photos: n, seed: 's', ...EXPORT.polaroid });
    for (const p of w.prints) assert.ok(p.w * PRINT_PHOTO <= EXPORT_MAX_PHOTO, `wall, n=${n}: photo ${p.w * PRINT_PHOTO}`);
    const s = planSky({ aspect, photos: n, seed: 's', ...EXPORT.constellation });
    for (const st of s.stars) assert.ok(2 * st.r <= EXPORT_MAX_PHOTO, `sky, n=${n}: star ${2 * st.r}`);
  }
});

// ---------- shared helpers ----------
test('pickPool is a fixed seeded pick; cycleItem shows K different items and gives every item a turn', () => {
  assert.deepEqual(pickPool(500, 120, 'a'), pickPool(500, 120, 'a'));
  assert.equal(new Set(pickPool(500, 120, 'a')).size, 120);
  assert.deepEqual(pickPool(5, 120, 'a').sort(), [0, 1, 2, 3, 4]);

  const K = 4, len = 11, seen = new Set();
  for (let step = 0; step < 40; step++) {
    const shown = Array.from({ length: K }, (_, k) => cycleItem(k, step, K, len));
    assert.equal(new Set(shown).size, K, `step ${step}: ${shown}`);
    shown.forEach((i) => seen.add(i));
    if (step > 0) {
      const before = Array.from({ length: K }, (_, k) => cycleItem(k, step - 1, K, len));
      assert.equal(shown.filter((v, k) => v !== before[k]).length, 1, 'one slot changes at a time');
    }
  }
  assert.equal(seen.size, len);
  assert.deepEqual([0, 1, 2].map((k) => cycleItem(k, 99, 3, 3)), [0, 1, 2], 'nothing cycles when everything fits');
});
