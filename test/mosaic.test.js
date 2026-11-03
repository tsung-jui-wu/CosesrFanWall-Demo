import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rgbToLab, tileFeature, targetCells, chooseGrid, planMosaic, mulberry32, featureDistance,
} from '../public/js/mosaic.js';

const RED = [220, 30, 40], BLUE = [30, 60, 200];

// Red disc on a blue background, drawn at (2*cols) x (2*rows) as the browser would.
function discTarget(cols, rows, radiusFrac = 0.3) {
  const W = cols * 2, H = rows * 2;
  const rgba = new Uint8ClampedArray(W * H * 4);
  const r = radiusFrac * Math.min(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const inside = (x + 0.5 - W / 2) ** 2 + (y + 0.5 - H / 2) ** 2 <= r * r;
      rgba.set([...(inside ? RED : BLUE), 255], (y * W + x) * 4);
    }
  }
  return { ...targetCells(rgba, cols, rows), isDisc: (col, row) => {
    // A cell counts as disc only if all 4 quadrant centers are inside.
    for (let q = 0; q < 4; q++) {
      const x = col * 2 + (q & 1) + 0.5, y = row * 2 + (q >> 1) + 0.5;
      if ((x - W / 2) ** 2 + (y - H / 2) ** 2 > r * r) return false;
    }
    return true;
  } };
}

function randomTiles(n, seed = 7) {
  const rng = mulberry32(seed);
  return Array.from({ length: n }, (_, i) => {
    const base = [rng() * 255, rng() * 255, rng() * 255];
    const px = new Uint8ClampedArray(16);
    for (let q = 0; q < 4; q++) px.set([...base.map((v) => v + (rng() - 0.5) * 30), 255], q * 4);
    return { id: `t${i}`, feature: tileFeature(px) };
  });
}

function setup(n, { aspect = 1.5, seed = 42, opts, reuse } = {}) {
  const { cols, rows } = chooseGrid(n, aspect, reuse ? { reuse } : {});
  const target = discTarget(cols, rows);
  const tiles = randomTiles(n);
  const plan = planMosaic({ cols, rows, cellFeatures: target.features, meanRGB: target.meanRGB, tiles, seed, opts });
  return { cols, rows, target, tiles, plan };
}

const filledCells = (plan) => plan.cells.filter((c) => c.tileId !== null);

test('rgbToLab matches reference values', () => {
  const close = (got, want) => got.forEach((v, i) => assert.ok(Math.abs(v - want[i]) < 0.05, `${got} vs ${want}`));
  close(rgbToLab(255, 255, 255), [100, 0, 0]);
  close(rgbToLab(0, 0, 0), [0, 0, 0]);
  close(rgbToLab(255, 0, 0), [53.24, 80.09, 67.2]);
  close(rgbToLab(0, 0, 255), [32.3, 79.19, -107.86]);
});

test('targetCells lays out 12 features and a mean color per cell', () => {
  const rgba = new Uint8ClampedArray(4 * 2 * 4); // 2 cols x 1 row -> 4x2 pixels
  for (let i = 0; i < 8; i++) rgba.set(i % 4 < 2 ? [255, 255, 255, 255] : [0, 0, 0, 255], i * 4);
  const { features, meanRGB } = targetCells(rgba, 2, 1);
  assert.equal(features.length, 24);
  assert.ok(Math.abs(features[0] - 100) < 0.01); // cell 0 is white
  assert.ok(Math.abs(features[12]) < 0.01); // cell 1 is black
  assert.deepEqual([...meanRGB], [255, 255, 255, 0, 0, 0]);
});

test('chooseGrid follows reuse rules, clamps, and keeps the aspect', () => {
  const near = (n, want) => {
    const g = chooseGrid(n, 1.5);
    assert.ok(Math.abs(g.cols * g.rows - want) <= g.cols, `n=${n}: ${g.cols}x${g.rows}, want ~${want}`);
    return g;
  };
  const g = near(100, 600); // few photos: up to 6 uses each
  assert.ok(Math.abs(g.cols / g.rows - 1.5) < 0.15);
  near(150, 900); // ...to reach about 900 cells
  near(300, 900);
  near(600, 1200); // many photos: at least 2 uses each, as before
  near(1000, 1500);
  const small = chooseGrid(5, 1);
  assert.ok(Math.abs(small.cols * small.rows - 60) <= small.cols);
  const big = chooseGrid(5000, 16 / 9);
  assert.ok(big.cols * big.rows <= 2400);
  assert.ok(big.cols * big.rows > 2300);
});

test('plan is deterministic for the same seed', () => {
  const a = setup(300, { seed: 'reveal-token-abc' }).plan;
  const b = setup(300, { seed: 'reveal-token-abc' }).plan;
  assert.deepEqual(a, b);
  const c = setup(300, { seed: 'other-seed' }).plan;
  assert.notDeepEqual(a.order, c.order);
});

function planVsRandom({ target, tiles, plan }) {
  const idx = new Map(tiles.map((t, i) => [t.id, i]));
  const filled = filledCells(plan);
  const meanDE = (pick) => filled.reduce((s, c) =>
    s + featureDistance(target.features, (c.row * plan.cols + c.col) * 12, tiles[pick(c)].feature, 0), 0) / filled.length;
  const rng = mulberry32(99);
  return { planned: meanDE((c) => idx.get(c.tileId)), random: meanDE(() => Math.floor(rng() * tiles.length)) };
}

test('plan matches colors far better than random assignment', () => {
  // Defaults: 300 tiles on a ~900-cell grid gives maxReuse 3, so nearly every random-colored tile must
  // be used three times in a red/blue image. Greedy lands within ~1 ΔE of a swap-optimized assignment here,
  // so the gap to random is capped by the tile palette, not the algorithm.
  const tight = setup(300);
  const a = planVsRandom(tight);
  assert.ok(a.planned < a.random * 0.9, `tight: planned ${a.planned.toFixed(1)} vs random ${a.random.toFixed(1)}`);

  // With room to choose (600 cells, up to 4 uses each), the plan should be dramatically better.
  const roomy = planVsRandom(setup(300, { reuse: 2, opts: { maxReuse: 4 } }));
  assert.ok(roomy.planned < roomy.random * 0.6, `roomy: planned ${roomy.planned.toFixed(1)} vs random ${roomy.random.toFixed(1)}`);

  // Disc cells should get redder tiles than background cells.
  const { tiles, plan, target } = tight;
  const idx = new Map(tiles.map((t, i) => [t.id, i]));
  const filled = filledCells(plan);
  const aStar = (cells) => cells.reduce((s, c) => s + tiles[idx.get(c.tileId)].feature[1], 0) / cells.length;
  const disc = filled.filter((c) => target.isDisc(c.col, c.row));
  const back = filled.filter((c) => !target.isDisc(c.col, c.row));
  assert.ok(aStar(disc) > aStar(back) + 20);
});

test('reuse limit and same-tile spacing hold when there are enough tiles', () => {
  const { plan } = setup(300);
  const spots = new Map();
  for (const c of filledCells(plan)) spots.set(c.tileId, [...(spots.get(c.tileId) ?? []), c]);
  for (const [id, list] of spots) {
    assert.ok(list.length <= plan.maxReuse, `${id} used ${list.length}x`);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const d = Math.max(Math.abs(list[i].col - list[j].col), Math.abs(list[i].row - list[j].row));
        assert.ok(d > 4, `${id} placed ${d} cells apart`);
      }
    }
  }
});

test('reuse grows when tiles are scarce, and every filled cell still gets a tile', () => {
  const { plan, tiles } = setup(12);
  const filled = filledCells(plan);
  assert.ok(plan.maxReuse * tiles.length >= filled.length);
  const counts = {};
  for (const c of filled) counts[c.tileId] = (counts[c.tileId] ?? 0) + 1;
  assert.ok(Object.values(counts).every((k) => k <= plan.maxReuse));
});

test('fewer than 12 tiles gives float mode', () => {
  const { plan, tiles } = setup(5);
  assert.equal(plan.mode, 'float');
  assert.deepEqual(plan.cells, []);
  assert.deepEqual(plan.leftover, tiles.map((t) => t.id));
});

test('partial coverage fills the subject first', () => {
  const { plan, target } = setup(30);
  assert.equal(plan.mode, 'mosaic');
  assert.ok(plan.coverage < 1);
  const N = plan.cols * plan.rows;
  const filled = filledCells(plan);
  assert.equal(filled.length, Math.round(plan.coverage * N));
  const discCells = plan.cells.filter((c) => target.isDisc(c.col, c.row));
  assert.ok(discCells.length > 0);
  assert.ok(discCells.every((c) => c.tileId !== null), 'every disc cell is filled');
  assert.ok(plan.cells.some((c) => c.tileId === null), 'some background stays ghost');
});

test('leftover plus used ids equals all tile ids', () => {
  for (const n of [12, 30, 300, 1000]) {
    const { plan, tiles } = setup(n);
    const used = new Set(filledCells(plan).map((c) => c.tileId));
    for (const id of plan.leftover) assert.ok(!used.has(id), `${id} is both used and leftover`);
    assert.deepEqual([...used, ...plan.leftover].sort(), tiles.map((t) => t.id).sort());
  }
});

test('order covers filled cells with delays from 0 to 1 and a tint per cell', () => {
  const { plan } = setup(300);
  const filled = filledCells(plan);
  assert.equal(plan.order.length, filled.length);
  assert.equal(new Set(plan.order).size, plan.order.length);
  assert.equal(plan.cells[plan.order[0]].delay, 0);
  assert.equal(plan.cells[plan.order.at(-1)].delay, 1);
  for (const c of filled) assert.ok(c.tint.alpha >= 0.08 && c.tint.alpha <= 0.5);
});

test('partial coverage finds the subject on a gradient background', () => {
  // Black-to-white vertical gradient with a muted green disc. The disc is only moderately far from
  // the *average* border color (mid gray), while the dark top and light bottom rows are far from it;
  // the subject must still fill first.
  const { cols, rows } = chooseGrid(30, 1.5);
  const W = cols * 2, H = rows * 2, r = 0.3 * Math.min(W, H);
  const rgba = new Uint8ClampedArray(W * H * 4);
  const inDisc = (x, y) => (x - W / 2) ** 2 + (y - H / 2) ** 2 <= r * r;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = Math.round((y / (H - 1)) * 255);
      rgba.set([...(inDisc(x + 0.5, y + 0.5) ? [112, 132, 112] : [v, v, v]), 255], (y * W + x) * 4);
    }
  }
  const { features, meanRGB } = targetCells(rgba, cols, rows);
  const plan = planMosaic({ cols, rows, cellFeatures: features, meanRGB, tiles: randomTiles(30), seed: 3 });
  const discCells = plan.cells.filter((c) => [0, 1, 2, 3].every((q) => inDisc(c.col * 2 + (q & 1) + 0.5, c.row * 2 + (q >> 1) + 0.5)));
  assert.ok(discCells.length > 0);
  assert.ok(discCells.every((c) => c.tileId !== null), 'every disc cell is filled before plain background');
});
