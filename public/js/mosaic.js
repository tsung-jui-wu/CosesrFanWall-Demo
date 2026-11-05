// Photo-mosaic planner. Pure and DOM-free: the browser prepares tiny pixel buffers, this decides
// which tile goes in which cell, and canvas drawing lives elsewhere. Also runs under `node --test`.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Numbers pass through; strings (e.g. a reveal token) are hashed with FNV-1a.
export function hashSeed(seed) {
  if (typeof seed === 'number') return seed >>> 0;
  let h = 0x811c9dc5;
  for (const ch of String(seed ?? '')) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// ---------- color ----------
const toLinear = (c) => {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const EPS = (6 / 29) ** 3;
const KAPPA = 3 * (6 / 29) ** 2;
const f = (t) => (t > EPS ? Math.cbrt(t) : t / KAPPA + 4 / 29);

// sRGB (0..255) to CIE Lab, D65 white.
export function rgbToLab(r, g, b) {
  const R = toLinear(r), G = toLinear(g), B = toLinear(b);
  const fx = f((0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047);
  const fy = f(0.2126729 * R + 0.7151522 * G + 0.072175 * B);
  const fz = f((0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

// Mean ΔE76 over the 4 quadrants of two 12-float features.
export function featureDistance(fa, ia, fb, ib) {
  let s = 0;
  for (let q = 0; q < 12; q += 3) {
    const dl = fa[ia + q] - fb[ib + q], da = fa[ia + q + 1] - fb[ib + q + 1], db = fa[ia + q + 2] - fb[ib + q + 2];
    s += Math.sqrt(dl * dl + da * da + db * db);
  }
  return s / 4;
}

// ---------- features ----------
// rgba2x2: RGBA bytes of a 2x2 image (TL, TR, BL, BR). Returns 12 floats: L,a,b per quadrant.
export function tileFeature(rgba2x2) {
  const out = new Float32Array(12);
  for (let q = 0; q < 4; q++) out.set(rgbToLab(rgba2x2[q * 4], rgba2x2[q * 4 + 1], rgba2x2[q * 4 + 2]), q * 3);
  return out;
}

// rgba: RGBA bytes of the target drawn at (2*cols) x (2*rows); each pixel is one cell quadrant.
export function targetCells(rgba, cols, rows) {
  const W = cols * 2;
  if (rgba.length < W * rows * 2 * 4) throw new Error('targetCells: rgba is smaller than (2*cols) x (2*rows)');
  const features = new Float32Array(cols * rows * 12);
  const meanRGB = new Uint8Array(cols * rows * 3);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const c = row * cols + col;
      let r = 0, g = 0, b = 0;
      for (let q = 0; q < 4; q++) {
        const p = ((row * 2 + (q >> 1)) * W + col * 2 + (q & 1)) * 4;
        features.set(rgbToLab(rgba[p], rgba[p + 1], rgba[p + 2]), c * 12 + q * 3);
        r += rgba[p]; g += rgba[p + 1]; b += rgba[p + 2];
      }
      meanRGB[c * 3] = Math.round(r / 4);
      meanRGB[c * 3 + 1] = Math.round(g / 4);
      meanRGB[c * 3 + 2] = Math.round(b / 4);
    }
  }
  return { features, meanRGB };
}

// ---------- grid ----------
// aspect = width / height of the target image.
// Smaller sets reuse each photo more (up to 6x) to reach about `targetCells`, so 150 photos don't
// give a chunky 450-cell grid. Beyond ~1000 cells a phone screen shows little more detail anyway.
// A handful of photos gets the coarsest grid (minCells), every cell filled by reusing them.
// At least `minSide` cells each way, so no tile is more than a sixth of the picture's width or height,
// however tall or wide it is: a saved mosaic only ever shows fans' photos as small tiles.
export function chooseGrid(n, aspect, opts = {}) {
  const minCells = opts.minCells ?? 60, maxCells = opts.maxCells ?? 2400, minSide = opts.minSide ?? 6;
  const reuse = opts.reuse ?? Math.max(n < 800 ? 2 : 1.5, Math.min(6, (opts.targetCells ?? 900) / Math.max(n, 1)));
  const cells = clamp(Math.round(n * reuse), minCells, maxCells);
  const cols = Math.max(minSide, Math.round(Math.sqrt(cells * aspect)));
  let rows = Math.max(minSide, Math.round(cells / cols));
  if (cols * rows > maxCells) rows = Math.max(minSide, Math.floor(maxCells / cols));
  return { cols, rows };
}

// Mixed cell sizes (decided 2026-11-04): big cells of 2x2 grid units where the picture is flat, single
// units where it has detail, so the same number of photos draws a sharper subject. Returns the fine
// grid { cols, rows } (both even) and `cells`, about as many cells as chooseGrid's uniform grid, so
// photos are reused as much as before. The big cells alone use `bigShare` of that budget, which keeps
// them near the uniform cell size: a first try let them reach 1/8 of the width, and the plain areas at
// the sides looked chunky. At least `minSide` big cells each way, so no tile is over a sixth.
export function chooseLayout(n, aspect, opts = {}) {
  const { cols: uc, rows: ur } = chooseGrid(n, aspect, opts);
  const minSide = opts.minSide ?? 6;
  const big = uc * ur * (opts.bigShare ?? 0.6);
  let bc, br;
  if (aspect >= 1) { br = Math.max(minSide, Math.floor(Math.sqrt(big / aspect))); bc = Math.max(minSide, Math.round(br * aspect)); }
  else { bc = Math.max(minSide, Math.floor(Math.sqrt(big * aspect))); br = Math.max(minSide, Math.round(bc / aspect)); }
  return { cols: bc * 2, rows: br * 2, cells: clamp(uc * ur, bc * br, bc * br * 4) };
}

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const quadDE = (fa, ia, fb, ib) => Math.hypot(fa[ia] - fb[ib], fa[ia + 1] - fb[ib + 1], fa[ia + 2] - fb[ib + 2]);

// The cells of the picture: each grid unit on its own, or (given `target` cells, fewer than
// cols*rows) 2x2 blocks as one big cell wherever the picture is flattest, splitting the blocks with
// the most detail until there are about `target` cells. A big cell's quadrant is the mean of one of
// its four units, and its detail is how far the units' own quadrants stray from that.
function layoutCells(cols, rows, unitFeatures, unitRGB, target) {
  const cells = []; // { col, row, size, feature (12), rgb (3) }
  const unit = (col, row) => {
    const u = row * cols + col;
    return { col, row, size: 1, feature: unitFeatures.subarray(u * 12, u * 12 + 12), rgb: Array.from(unitRGB.subarray(u * 3, u * 3 + 3)) };
  };
  if (!target || target >= cols * rows) {
    for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) cells.push(unit(col, row));
    return cells;
  }
  if (cols % 2 || rows % 2) throw new Error('planMosaic: mixed cells need an even number of cols and rows');
  const bc = cols / 2, br = rows / 2, blocks = [];
  for (let by = 0; by < br; by++) {
    for (let bx = 0; bx < bc; bx++) {
      const feature = new Float32Array(12), rgb = [0, 0, 0];
      const us = [0, 1, 2, 3].map((q) => (by * 2 + (q >> 1)) * cols + bx * 2 + (q & 1));
      us.forEach((u, q) => {
        for (let k = 0; k < 3; k++) {
          feature[q * 3 + k] = (unitFeatures[u * 12 + k] + unitFeatures[u * 12 + 3 + k] + unitFeatures[u * 12 + 6 + k] + unitFeatures[u * 12 + 9 + k]) / 4;
          rgb[k] += unitRGB[u * 3 + k] / 4;
        }
      });
      let err = 0;
      us.forEach((u, q) => { for (let p = 0; p < 12; p += 3) err += quadDE(unitFeatures, u * 12 + p, feature, q * 3); });
      blocks.push({ bx, by, feature, rgb: rgb.map(Math.round), err });
    }
  }
  const splits = clamp(Math.floor((target - blocks.length) / 3), 0, blocks.length);
  const split = new Set(blocks.map((_, i) => i).sort((a, b) => blocks[b].err - blocks[a].err || a - b).slice(0, splits));
  blocks.forEach((b, i) => {
    if (!split.has(i)) cells.push({ col: b.bx * 2, row: b.by * 2, size: 2, feature: b.feature, rgb: b.rgb });
    else for (let q = 0; q < 4; q++) cells.push(unit(b.bx * 2 + (q & 1), b.by * 2 + (q >> 1)));
  });
  return cells;
}

// ---------- plan ----------
// cols x rows is the grid; cellFeatures and meanRGB come from targetCells on it.
// tiles: [{ id, feature }] where feature is tileFeature() output; at least one.
// opts.cells (from chooseLayout): about that many cells, big and small (see layoutCells). Without it,
// every grid unit is one cell, in row-major order.
// Returns { mode: 'mosaic', cols, rows, maxReuse, cells, grid, order, leftover }.
// cells[i] = { col, row, size, tileId, deltaE, tint: { rgb, alpha }, delay }: the cell covers grid
// units col..col+size-1 and row..row+size-1. grid[row * cols + col] is the cell over that unit.
// Every cell gets a tile, however few photos there are: a small set is reused across the grid rather
// than leaving faded "ghost" cells, which would show at a glance how few photos arrived.
export function planMosaic({ cols, rows, cellFeatures, meanRGB, tiles, opts = {}, seed = 1 }) {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) {
    throw new Error('planMosaic: cols and rows must be positive integers');
  }
  const U = cols * rows;
  if (cellFeatures.length !== U * 12) throw new Error('planMosaic: cellFeatures must have cols*rows*12 values');
  if (meanRGB.length !== U * 3) throw new Error('planMosaic: meanRGB must have cols*rows*3 values');
  const n = tiles.length;
  if (n < 1) throw new Error('planMosaic: needs at least one tile');
  const ids = tiles.map((t) => t.id);

  const rng = mulberry32(hashSeed(seed));
  const minSpacing = opts.minSpacing ?? 4;
  const usagePenalty = opts.usagePenalty ?? 6;
  const spacingPenalty = opts.spacingPenalty ?? 40;

  const lay = layoutCells(cols, rows, cellFeatures, meanRGB, opts.cells);
  const N = lay.length;
  const grid = new Int32Array(U);
  lay.forEach((c, i) => {
    for (let y = 0; y < c.size; y++) for (let x = 0; x < c.size; x++) grid[(c.row + y) * cols + c.col + x] = i;
  });
  // A cell's middle in grid units (a single unit's is its own col and row).
  const mx = (c) => c.col + (c.size - 1) / 2, my = (c) => c.row + (c.size - 1) / 2;

  // Saliency = ΔE from each cell's mean Lab to the *nearest* border cell color: high on the subject.
  // The fly-in starts there, so the subject appears first. (The first version used the average border
  // color, which fails on gradient backgrounds: a sky that runs from navy to purple averages to a
  // middle tone, so plain bands at either end looked "salient".)
  const mean = new Float32Array(N * 3);
  lay.forEach((c, i) => {
    for (let k = 0; k < 3; k++) mean[i * 3 + k] = (c.feature[k] + c.feature[k + 3] + c.feature[k + 6] + c.feature[k + 9]) / 4;
  });
  const border = [];
  lay.forEach((c, i) => {
    if (c.row === 0 || c.col === 0 || c.row + c.size === rows || c.col + c.size === cols) border.push(i);
  });
  const saliency = new Float32Array(N);
  let sx = 0, sy = 0, sw = 0;
  for (let i = 0; i < N; i++) {
    let best = Infinity;
    for (const b of border) {
      const dl = mean[i * 3] - mean[b * 3], da = mean[i * 3 + 1] - mean[b * 3 + 1], db = mean[i * 3 + 2] - mean[b * 3 + 2];
      const d = dl * dl + da * da + db * db;
      if (d < best) best = d;
    }
    const s = (saliency[i] = Math.sqrt(best)), w = s * lay[i].size * lay[i].size; // by area
    sx += w * mx(lay[i]); sy += w * my(lay[i]); sw += w;
  }

  // The subject's centroid, weighted by saliency.
  const scx = sw ? sx / sw : (cols - 1) / 2, scy = sw ? sy / sw : (rows - 1) / 2;
  const filled = Array.from({ length: N }, (_, i) => i);
  const maxReuse = Math.max(opts.maxReuse ?? 2, Math.ceil(N / n));

  const tf = new Float32Array(n * 12);
  tiles.forEach((t, i) => {
    if (t.feature?.length !== 12) throw new Error(`planMosaic: tile ${t.id} needs a 12-value feature`);
    tf.set(t.feature, i * 12);
  });
  const usage = new Uint32Array(n);
  const placed = Array.from({ length: n }, () => []);

  const cells = lay.map((c) => ({
    col: c.col, row: c.row, size: c.size, tileId: null, deltaE: null, tint: { rgb: c.rgb, alpha: 0 }, delay: null,
  }));

  for (const i of shuffle(filled.slice(), rng)) {
    const c = lay[i], x = mx(c), y = my(c), cf = c.feature;
    let best = -1, bestCost = Infinity, bestDE = 0;
    for (let t = 0; t < n; t++) {
      if (usage[t] >= maxReuse) continue;
      let cost = usagePenalty * usage[t];
      if (usage[t] && minSpacing > 0) {
        // Distance in cell sizes, so a big cell keeps its repeats further away.
        let d = Infinity;
        for (const [px, py, ps] of placed[t]) d = Math.min(d, Math.max(Math.abs(px - x), Math.abs(py - y)) / Math.max(ps, c.size));
        if (d <= minSpacing) cost += spacingPenalty * (1 + (minSpacing - d) / minSpacing);
      }
      if (cost >= bestCost) continue;
      // Inline quadrant ΔE with early exit once this tile can no longer win.
      let s = 0;
      const to = t * 12;
      for (let q = 0; q < 12; q += 3) {
        const dl = cf[q] - tf[to + q];
        const da = cf[q + 1] - tf[to + q + 1];
        const db = cf[q + 2] - tf[to + q + 2];
        s += Math.sqrt(dl * dl + da * da + db * db);
        if (cost + s / 4 >= bestCost) break;
      }
      if (cost + s / 4 < bestCost) { best = t; bestCost = cost + s / 4; bestDE = s / 4; }
    }
    usage[best]++;
    placed[best].push([x, y, c.size]);
    const cell = cells[i];
    cell.tileId = ids[best];
    cell.deltaE = bestDE;
    cell.tint.alpha = clamp(bestDE / 50, 0.08, 0.5);
  }

  // Fly-in order: the most salient cells first (the subject), then outward from its centroid, with
  // seeded jitter so the edge of the growing picture isn't a hard line.
  let maxS = 0;
  for (let i = 0; i < N; i++) maxS = Math.max(maxS, saliency[i]);
  const dist = (i) => Math.hypot(mx(lay[i]) - scx, my(lay[i]) - scy);
  let maxDist = 0;
  for (const i of filled) maxDist = Math.max(maxDist, dist(i));
  const jitter = (opts.orderJitter ?? 0.15) * maxDist;
  const key = new Map(filled.map((i) => [i, dist(i) * (1 - 0.5 * (maxS ? saliency[i] / maxS : 0)) + rng() * jitter]));
  const order = filled.slice().sort((a, b) => key.get(a) - key.get(b) || a - b);
  order.forEach((i, k) => { cells[i].delay = order.length > 1 ? k / (order.length - 1) : 0; });

  const leftover = ids.filter((_, t) => usage[t] === 0);
  return { mode: 'mosaic', cols, rows, maxReuse, cells, grid, order, leftover };
}
