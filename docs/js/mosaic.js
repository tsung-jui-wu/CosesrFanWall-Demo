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
export function chooseGrid(n, aspect, opts = {}) {
  const minCells = opts.minCells ?? 60, maxCells = opts.maxCells ?? 2400;
  const reuse = opts.reuse ?? Math.max(n < 800 ? 2 : 1.5, Math.min(6, (opts.targetCells ?? 900) / Math.max(n, 1)));
  const cells = clamp(Math.round(n * reuse), minCells, maxCells);
  const cols = Math.max(1, Math.round(Math.sqrt(cells * aspect)));
  let rows = Math.max(1, Math.round(cells / cols));
  if (cols * rows > maxCells) rows = Math.max(1, Math.floor(maxCells / cols));
  return { cols, rows };
}

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---------- plan ----------
// tiles: [{ id, feature }] where feature is tileFeature() output.
// Returns { mode: 'float'|'mosaic', cols, rows, coverage, maxReuse, cells, order, leftover }.
// cells[i] (row-major) = { col, row, tileId|null, deltaE|null, tint: { rgb, alpha }, delay|null };
// tileId null means a "ghost" cell where the faded base image shows through.
export function planMosaic({ cols, rows, cellFeatures, meanRGB, tiles, opts = {}, seed = 1 }) {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) {
    throw new Error('planMosaic: cols and rows must be positive integers');
  }
  const N = cols * rows;
  if (cellFeatures.length !== N * 12) throw new Error('planMosaic: cellFeatures must have cols*rows*12 values');
  if (meanRGB.length !== N * 3) throw new Error('planMosaic: meanRGB must have cols*rows*3 values');
  const n = tiles.length;
  const ids = tiles.map((t) => t.id);

  if (n < (opts.minTiles ?? 12)) {
    return { mode: 'float', cols, rows, coverage: 0, maxReuse: 0, cells: [], order: [], leftover: ids };
  }

  const rng = mulberry32(hashSeed(seed));
  const minSpacing = opts.minSpacing ?? 4;
  const usagePenalty = opts.usagePenalty ?? 6;
  const spacingPenalty = opts.spacingPenalty ?? 40;
  const coverage = clamp(n / 60, 0.3, 1);

  // Saliency = ΔE from each cell's mean Lab to the *nearest* border cell color. (The plan's first
  // version used the average border color, which fails on gradient backgrounds: a sky that runs from
  // navy to purple averages to a middle tone, so plain bands at either end looked "salient".)
  const mean = new Float32Array(N * 3);
  for (let c = 0; c < N; c++) {
    for (let k = 0; k < 3; k++) {
      const o = c * 12 + k;
      mean[c * 3 + k] = (cellFeatures[o] + cellFeatures[o + 3] + cellFeatures[o + 6] + cellFeatures[o + 9]) / 4;
    }
  }
  const border = [];
  for (let c = 0; c < N; c++) {
    const col = c % cols, row = (c / cols) | 0;
    if (row === 0 || row === rows - 1 || col === 0 || col === cols - 1) border.push(c);
  }
  const saliency = new Float32Array(N);
  let sx = 0, sy = 0, sw = 0;
  for (let c = 0; c < N; c++) {
    let best = Infinity;
    for (const b of border) {
      const dl = mean[c * 3] - mean[b * 3], da = mean[c * 3 + 1] - mean[b * 3 + 1], db = mean[c * 3 + 2] - mean[b * 3 + 2];
      const d = dl * dl + da * da + db * db;
      if (d < best) best = d;
    }
    const s = (saliency[c] = Math.sqrt(best));
    sx += s * (c % cols); sy += s * ((c / cols) | 0); sw += s;
  }

  // Fill the most salient cells first. Ties (flat areas) grow outward from the subject's centroid.
  const scx = sw ? sx / sw : (cols - 1) / 2, scy = sw ? sy / sw : (rows - 1) / 2;
  const centerDist = (c) => ((c % cols) - scx) ** 2 + (((c / cols) | 0) - scy) ** 2;
  const byPriority = Array.from({ length: N }, (_, c) => c)
    .sort((a, b) => saliency[b] - saliency[a] || centerDist(a) - centerDist(b) || a - b);
  const filledCount = clamp(Math.round(coverage * N), 1, N);
  const filled = byPriority.slice(0, filledCount);
  const maxReuse = Math.max(opts.maxReuse ?? 2, Math.ceil(filledCount / n));

  const tf = new Float32Array(n * 12);
  tiles.forEach((t, i) => {
    if (t.feature?.length !== 12) throw new Error(`planMosaic: tile ${t.id} needs a 12-value feature`);
    tf.set(t.feature, i * 12);
  });
  const usage = new Uint32Array(n);
  const placed = Array.from({ length: n }, () => []);

  const cells = new Array(N);
  for (let c = 0; c < N; c++) {
    cells[c] = {
      col: c % cols, row: (c / cols) | 0, tileId: null, deltaE: null,
      tint: { rgb: [meanRGB[c * 3], meanRGB[c * 3 + 1], meanRGB[c * 3 + 2]], alpha: 0 }, delay: null,
    };
  }

  for (const c of shuffle(filled.slice(), rng)) {
    const col = c % cols, row = (c / cols) | 0, co = c * 12;
    let best = -1, bestCost = Infinity, bestDE = 0;
    for (let t = 0; t < n; t++) {
      if (usage[t] >= maxReuse) continue;
      let cost = usagePenalty * usage[t];
      if (usage[t] && minSpacing > 0) {
        let d = Infinity;
        for (const [pc, pr] of placed[t]) d = Math.min(d, Math.max(Math.abs(pc - col), Math.abs(pr - row)));
        if (d <= minSpacing) cost += spacingPenalty * (1 + (minSpacing - d) / minSpacing);
      }
      if (cost >= bestCost) continue;
      // Inline quadrant ΔE with early exit once this tile can no longer win.
      let s = 0;
      const to = t * 12;
      for (let q = 0; q < 12; q += 3) {
        const dl = cellFeatures[co + q] - tf[to + q];
        const da = cellFeatures[co + q + 1] - tf[to + q + 1];
        const db = cellFeatures[co + q + 2] - tf[to + q + 2];
        s += Math.sqrt(dl * dl + da * da + db * db);
        if (cost + s / 4 >= bestCost) break;
      }
      if (cost + s / 4 < bestCost) { best = t; bestCost = cost + s / 4; bestDE = s / 4; }
    }
    usage[best]++;
    placed[best].push([col, row]);
    const cell = cells[c];
    cell.tileId = ids[best];
    cell.deltaE = bestDE;
    cell.tint.alpha = clamp(bestDE / 50, 0.08, 0.5);
  }

  // Fly-in order: outward from the centroid of filled cells, with seeded jitter.
  let cx = 0, cy = 0;
  for (const c of filled) { cx += c % cols; cy += (c / cols) | 0; }
  cx /= filledCount; cy /= filledCount;
  const dist = (c) => Math.hypot((c % cols) - cx, ((c / cols) | 0) - cy);
  let maxDist = 0;
  for (const c of filled) maxDist = Math.max(maxDist, dist(c));
  const jitter = (opts.orderJitter ?? 0.15) * maxDist;
  const key = new Map(filled.map((c) => [c, dist(c) + rng() * jitter]));
  const order = filled.slice().sort((a, b) => key.get(a) - key.get(b) || a - b);
  order.forEach((c, i) => { cells[c].delay = order.length > 1 ? i / (order.length - 1) : 0; });

  const leftover = ids.filter((_, t) => usage[t] === 0);
  return { mode: 'mosaic', cols, rows, coverage, maxReuse, cells, order, leftover };
}
