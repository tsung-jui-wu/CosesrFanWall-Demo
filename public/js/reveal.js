// Cosplayer reveal: photos fly in and assemble into a mosaic of the organizer's image; notes settle
// around it. Everything is drawn on one canvas. The timeline is a pure function of elapsed time, so
// skip, replay, and resize need no extra state.
import { api, el, toast, loadBitmap, STATIC, segmentAfter } from './api.js';
import { tileFeature, targetCells, chooseGrid, planMosaic, mulberry32, hashSeed } from './mosaic.js';
import { renderEdited, photoBlob, openEditor } from './editor.js';

const token = segmentAfter('r');
const $ = (id) => document.getElementById(id);
const canvas = $('stage');
const ctx = canvas.getContext('2d');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

const BG = '#090909'; // matches --canvas in app.css
const CARD_BG = '#141414'; // --surface-1
const TILE_PX = 64; // tiles are pre-cut at this height; cells are almost always smaller
const MIN_MOSAIC_TILES = 12; // matches planMosaic's default minTiles
const GHOST_ALPHA = 0.3;
const FLIGHT_MS = 1000;
const TINT_MS = 500;
const ENTER_MS = 1600;
const CYCLE_MS = 4500;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const easeOut = (p) => 1 - (1 - p) ** 3;
const makeCanvas = (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h });

let data = null;
let scene = null; // built once by prepare()
let L = null; // layout for the current canvas size
let startTime = 0;
let pausedAt = null;
let running = false;
let finalCache = null;
const cardCache = new Map();

// ---------- image prep ----------
// Step-down halving through two reusable scratch canvases, so big reductions average pixels
// instead of aliasing (and we don't allocate a canvas per step per tile).
const scratch = [makeCanvas(1, 1), makeCanvas(1, 1)];
function shrinkInto(dest, src, sx, sy, sw, sh, tw, th) {
  let cur = src, cx = sx, cy = sy, cw = sw, ch = sh, flip = 0;
  while (cw / 2 >= tw && ch / 2 >= th) {
    const w = Math.round(cw / 2), h = Math.round(ch / 2);
    const s = scratch[(flip ^= 1)];
    if (s.width < w) s.width = w;
    if (s.height < h) s.height = h;
    const sctx = s.getContext('2d');
    sctx.clearRect(0, 0, w, h);
    sctx.drawImage(cur, cx, cy, cw, ch, 0, 0, w, h);
    cur = s; cx = 0; cy = 0; cw = w; ch = h;
  }
  const dctx = dest.getContext('2d');
  dctx.imageSmoothingQuality = 'high';
  dctx.clearRect(0, 0, tw, th);
  dctx.drawImage(cur, cx, cy, cw, ch, 0, 0, tw, th);
}

// Centered crop of a (w x h) image to the given aspect (width / height).
function coverCrop(w, h, aspect) {
  if (w / h > aspect) { const cw = h * aspect; return [(w - cw) / 2, 0, cw, h]; }
  const ch = w / aspect;
  return [0, (h - ch) / 2, w, ch];
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

const interleave = (a, b) => {
  const out = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) { if (i < a.length) out.push(a[i]); if (i < b.length) out.push(b[i]); }
  return out;
};

// Full thumbnails for floating photo cards. Decoded bitmaps are big (~0.7 MB each), so cap how many
// we hold; the cards cycle through these. Repeat fetches come from the browser cache.
const MAX_FLOAT_PHOTOS = 60;
async function floatPhotos(items) {
  return (await pool(items.slice(0, MAX_FLOAT_PHOTOS), 6, async (item) => {
    try { return { kind: 'photo', item, img: await thumbOf(item) }; } catch { return null; }
  })).filter(Boolean);
}

// The thumbnail with the cosplayer's edit applied, so tiles and cards match the photo they open.
async function thumbOf(item) {
  const bmp = await loadBitmap(item.thumbUrl);
  if (!item.edit) return bmp;
  try { return renderEdited(bmp, item.edit); } finally { bmp.close(); }
}

async function prepare(onProgress) {
  await document.fonts?.ready; // note cards are drawn with Inter; don't cache them in a fallback font
  const visible = data.items.filter((i) => !i.hidden);
  const photos = visible.filter((i) => i.thumbUrl);
  const notes = visible.filter((i) => i.message).map((item) => ({ kind: 'note', item }));
  const steps = photos.length + 2;
  let done = 0;
  const tick = (n = 1) => onProgress((done += n) / steps);

  const base = data.baseUrl ? await loadBitmap(data.baseUrl).catch(() => null) : null;
  tick();
  const float = async (pics) => {
    onProgress(1);
    return buildScene({ mode: 'float', base, floaters: interleave(pics, notes), photoCount: photos.length, noteCount: notes.length });
  };
  if (!base || photos.length < MIN_MOSAIC_TILES) return float(await floatPhotos(photos));

  // Target: the base image at (2*cols) x (2*rows), one pixel per cell quadrant.
  const aspect = base.width / base.height;
  const { cols, rows } = chooseGrid(photos.length, aspect);
  const target = makeCanvas(cols * 2, rows * 2);
  const tctx = target.getContext('2d', { willReadFrequently: true });
  shrinkInto(target, base, 0, 0, base.width, base.height, cols * 2, rows * 2);
  const { features, meanRGB } = targetCells(tctx.getImageData(0, 0, cols * 2, rows * 2).data, cols, rows);

  // Tiles: center-cropped to the cell aspect, cut at TILE_PX, reduced to 2x2 for matching. Each
  // thumbnail is released as soon as its tile is cut, so memory stays at the small tiles only.
  const cellAspect = (base.width / cols) / (base.height / rows);
  const th = TILE_PX, tw = clamp(Math.round(TILE_PX * cellAspect), 8, 256);
  const px2 = makeCanvas(2, 2);
  const px2ctx = px2.getContext('2d', { willReadFrequently: true });
  const tiles = (await pool(photos, 6, async (item) => {
    let bmp;
    try {
      bmp = await thumbOf(item);
      // No awaits from here on: the shared scratch canvases are used synchronously.
      const img = makeCanvas(tw, th);
      shrinkInto(img, bmp, ...coverCrop(bmp.width, bmp.height, tw / th), tw, th);
      shrinkInto(px2, img, 0, 0, tw, th, 2, 2);
      return { id: item.id, feature: tileFeature(px2ctx.getImageData(0, 0, 2, 2).data), img, item };
    } catch {
      return null;
    } finally {
      bmp?.close?.(); // a bitmap, or a canvas when the photo is edited
      tick();
    }
  })).filter(Boolean);
  if (tiles.length < MIN_MOSAIC_TILES) return float(await floatPhotos(photos)); // too many failed to load

  const plan = planMosaic({ cols, rows, cellFeatures: features, meanRGB, tiles, seed: token });
  // Photos the plan didn't use float with the notes.
  const leftover = new Set(plan.leftover);
  const extras = await floatPhotos(tiles.filter((t) => leftover.has(t.id)).map((t) => t.item));
  onProgress(1);
  return buildScene({
    mode: 'mosaic', base, plan, cols, rows, aspect,
    imgs: new Map(tiles.map((t) => [t.id, t.img])),
    floaters: interleave(extras, notes), photoCount: tiles.length, noteCount: notes.length,
  });
}

// Per-cell flight paths and the timeline, all derived from the seed.
function buildScene(s) {
  const rng = mulberry32(hashSeed(token) ^ 0x9e3779b9);
  s.floaterRot = s.floaters.map(() => (rng() - 0.5) * 0.16);
  if (s.mode === 'mosaic') {
    const N = s.cols * s.rows;
    s.start = new Float64Array(N);
    s.fly = new Float32Array(N * 4); // start x, start y (0..1 of stage), rotation, scale
    s.tint = new Array(N);
    const spread = clamp(1500 + s.plan.order.length * 3, 2500, 7000);
    s.t0 = 1400;
    for (const i of s.plan.order) {
      const c = s.plan.cells[i];
      s.start[i] = s.t0 + c.delay * spread;
      s.fly.set([rng() * 1.2 - 0.1, rng() * 1.2 - 0.1, (rng() - 0.5) * 1.2, 1.8 + rng() * 1.4], i * 4);
      s.tint[i] = `rgb(${c.tint.rgb.join(',')})`;
    }
    s.tilesEnd = s.t0 + spread + FLIGHT_MS + TINT_MS;
    s.floatStart = s.t0 + 500;
    s.floatSpan = spread;
  } else {
    s.tilesEnd = 0;
    s.floatStart = 500;
    s.floatSpan = null; // set per layout: depends on how many slots fit
  }
  return s;
}

// ---------- layout ----------
function computeLayout() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = Math.round(canvas.clientWidth * dpr), H = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  // Usable band: clear of the caption at the top and the button bar at the bottom.
  const top = Math.round(($('caption').offsetHeight + 12) * dpr), UH = H - top - 84 * dpr;
  const gap = 10 * dpr;
  const n = scene.floaters.length;
  const lay = { W, H, dpr, slots: [] };

  if (scene.mode === 'mosaic' && W / UH <= scene.aspect) {
    // Portrait (phones): the mosaic full width under the caption, notes in a grid below it.
    const pad = 15 * dpr;
    let w = W - 2 * pad, h = w / scene.aspect;
    const minNotes = n ? 110 * dpr : 0;
    if (h > UH - minNotes) { h = Math.max(1, UH - minNotes); w = h * scene.aspect; }
    const rect = { x: (W - w) / 2, y: n ? top : top + (UH - h) / 2, w, h };
    let cardW = 0, cardH = 0;
    if (n) {
      const areaTop = rect.y + h + gap, areaH = top + UH - areaTop;
      const cols = clamp(Math.floor(W / (190 * dpr)), 2, 4);
      cardW = (W - 2 * pad - (cols - 1) * gap) / cols;
      cardH = cardW * 0.75;
      let rows = Math.floor((areaH + gap) / (cardH + gap));
      if (rows < 1) { rows = 1; cardH = Math.max(40 * dpr, areaH); cardW = cardH / 0.75; }
      cardW = Math.round(cardW); cardH = Math.round(cardH);
      const x0 = (W - (cols * cardW + (cols - 1) * gap)) / 2;
      const y0 = areaTop + (areaH - (rows * cardH + (rows - 1) * gap)) / 2;
      for (let k = 0; k < Math.min(n, rows * cols); k++) {
        const col = k % cols, row = Math.floor(k / cols);
        lay.slots.push({ x: x0 + col * (cardW + gap) + cardW / 2, y: y0 + row * (cardH + gap) + cardH / 2 });
      }
    }
    const baseScaled = makeCanvas(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
    shrinkInto(baseScaled, scene.base, 0, 0, scene.base.width, scene.base.height, baseScaled.width, baseScaled.height);
    Object.assign(lay, { rect, cardW, cardH, baseScaled });
  } else if (scene.mode === 'mosaic') {
    // Landscape: the mosaic centered, notes in a column on each side.
    const cardW = n ? Math.round(clamp(Math.min(W, H) * 0.2, 96 * dpr, 190 * dpr)) : 0;
    const cardH = Math.round(cardW * 0.75);
    let w = Math.max(1, W - 2 * gap - (n ? 2 * (cardW + 2 * gap) : 0)), h = w / scene.aspect;
    if (h > UH - 2 * gap) { h = Math.max(1, UH - 2 * gap); w = h * scene.aspect; }
    const rect = { x: (W - w) / 2, y: top + (UH - h) / 2, w, h };
    if (n) {
      const sides = [rect.x - gap - cardW / 2, rect.x + rect.w + gap + cardW / 2];
      const per = Math.max(1, Math.floor(UH / (cardH * 1.12)));
      const total = Math.min(n, per * 2);
      for (let k = 0; k < total; k++) {
        const count = k % 2 ? Math.floor(total / 2) : Math.ceil(total / 2);
        lay.slots.push({ x: sides[k % 2], y: top + ((Math.floor(k / 2) + 0.5) / count) * UH });
      }
    }
    // Scale the base once per layout instead of every frame.
    const baseScaled = makeCanvas(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
    shrinkInto(baseScaled, scene.base, 0, 0, scene.base.width, scene.base.height, baseScaled.width, baseScaled.height);
    Object.assign(lay, { rect, cardW, cardH, baseScaled });
  } else {
    // Float mode: a jittered grid over the usable band.
    const maxK = clamp(Math.floor((W * UH) / (190 * dpr) ** 2), 4, 12);
    const K = Math.min(n, maxK);
    const gc = Math.max(1, Math.ceil(Math.sqrt((K * W) / UH))), gr = Math.max(1, Math.ceil(K / gc));
    const cw = W / gc, ch = UH / gr;
    const cardW = Math.round(clamp(Math.min(cw, ch * 1.2) * 0.78, 90 * dpr, 300 * dpr));
    const rng = mulberry32(hashSeed(token) + K);
    for (let k = 0; k < K; k++) {
      const col = k % gc, row = Math.floor(k / gc);
      lay.slots.push({
        x: clamp((col + 0.5 + (rng() - 0.5) * 0.3) * cw, cardW / 2 + gap, W - cardW / 2 - gap),
        y: clamp(top + (row + 0.5 + (rng() - 0.5) * 0.3) * ch, top + cardW * 0.4, top + UH - cardW * 0.4),
      });
    }
    let backdrop = null;
    if (scene.base) {
      backdrop = makeCanvas(W, H);
      shrinkInto(backdrop, scene.base, ...coverCrop(scene.base.width, scene.base.height, W / H), W, H);
    }
    Object.assign(lay, { cardW, cardH: Math.round(cardW * 0.75), backdrop });
  }
  // Each slot enters from the nearest outside direction.
  const cx = W / 2, cy = H / 2, reach = 0.45 * Math.max(W, H);
  for (const s of lay.slots) {
    const dx = s.x - cx, dy = s.y - cy, d = Math.hypot(dx, dy) || 1;
    s.fromX = s.x + (dx / d) * reach;
    s.fromY = s.y + (dy / d) * reach;
  }
  const K = lay.slots.length;
  lay.floatGap = K ? (scene.floatSpan ?? K * 300) / K : 0;
  lay.end = Math.max(scene.tilesEnd, scene.floatStart + K * lay.floatGap + ENTER_MS);
  L = lay;
  finalCache = null;
  cardCache.clear();
}

// ---------- cards (notes and floating photos) ----------
function wrapText(c, text, maxW, maxLines) {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim());
  const lines = [];
  let line = '';
  let i = 0;
  for (; i < chars.length && lines.length < maxLines; i++) {
    const test = line + chars[i];
    if (!line || c.measureText(test).width <= maxW) { line = test; continue; }
    const cut = chars[i] === ' ' ? -1 : line.lastIndexOf(' ');
    if (cut > 0) { lines.push(line.slice(0, cut)); line = line.slice(cut + 1) + chars[i]; }
    else { lines.push(line.trimEnd()); line = chars[i] === ' ' ? '' : chars[i]; }
  }
  const truncated = i < chars.length || (lines.length === maxLines && line.trim());
  if (lines.length < maxLines && line.trim()) lines.push(line.trim());
  if (truncated && lines.length) {
    let last = Array.from(lines[lines.length - 1]);
    while (last.length && c.measureText(last.join('') + '…').width > maxW) last.pop();
    lines[lines.length - 1] = last.join('').trimEnd() + '…';
  }
  return lines;
}

const FONT = 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif';

// Charcoal cards with rounded corners: a photo fills its card; a note is white text, name in gray.
function renderCard(f) {
  const { cardW: w, cardH: h, dpr } = L;
  const m = Math.round(16 * dpr); // room for the shadow
  const r = Math.round(Math.min(w, h) * 0.1);
  const c = makeCanvas(w + 2 * m, h + 2 * m);
  const g = c.getContext('2d');
  const box = () => { g.beginPath(); if (g.roundRect) g.roundRect(m, m, w, h, r); else g.rect(m, m, w, h); };
  g.shadowColor = 'rgba(0,0,0,0.5)'; g.shadowBlur = 16 * dpr; g.shadowOffsetY = 6 * dpr;
  g.fillStyle = CARD_BG;
  box(); g.fill();
  g.shadowColor = 'transparent';
  if (f.kind === 'photo') {
    g.save(); box(); g.clip();
    g.imageSmoothingQuality = 'high';
    g.drawImage(f.img, ...coverCrop(f.img.width, f.img.height, w / h), m, m, w, h);
    g.restore();
  } else {
    const pad = Math.round(w * 0.09);
    const fs = Math.max(12 * dpr, Math.round(w / 12));
    const lh = Math.round(fs * 1.3);
    const hasName = Boolean(f.item.name);
    const maxLines = Math.max(1, Math.floor((h - 2 * pad - (hasName ? lh * 1.2 : 0)) / lh));
    g.fillStyle = '#ffffff';
    g.font = `400 ${fs}px ${FONT}`;
    g.textBaseline = 'top';
    const lines = wrapText(g, f.item.message, w - 2 * pad, maxLines);
    const block = lines.length * lh + (hasName ? lh * 1.2 : 0);
    let y = m + Math.max(pad, (h - block) / 2);
    for (const line of lines) { g.fillText(line, m + pad, y); y += lh; }
    if (hasName) {
      g.fillStyle = '#999999';
      g.font = `500 ${Math.round(fs * 0.85)}px ${FONT}`;
      g.fillText(f.item.name, m + pad, y + lh * 0.2);
    }
  }
  g.strokeStyle = 'rgba(255,255,255,0.08)'; // the faint light edge of a floating card
  g.lineWidth = Math.max(1, dpr * 0.75);
  box(); g.stroke();
  return c;
}

function card(idx) {
  let c = cardCache.get(idx);
  if (!c) { c = renderCard(scene.floaters[idx]); cardCache.set(idx, c); }
  return c;
}

// Which floater slot k shows at time t, and its opacity. After the reveal settles, one slot at a
// time crossfades to the next unseen item, so every note gets its turn.
function slotContent(k, t) {
  const K = L.slots.length, len = scene.floaters.length;
  const cycle0 = L.end + 2500;
  if (len <= K || t < cycle0) return [k, 1];
  const elapsed = t - cycle0;
  const c = Math.floor(elapsed / CYCLE_MS), local = elapsed - c * CYCLE_MS;
  const latest = (upto) => (upto < k ? k : (K + k + K * Math.floor((upto - k) / K)) % len);
  if (c % K !== k) return [latest(c), 1];
  if (local < 600) return [latest(c - 1), 1 - local / 600];
  if (local < 1200) return [latest(c), (local - 600) / 600];
  return [latest(c), 1];
}

// ---------- drawing ----------
function cellBox(i) {
  const { rect } = L;
  const col = i % scene.cols, row = Math.floor(i / scene.cols);
  const cw = rect.w / scene.cols, ch = rect.h / scene.rows;
  // Round edges, not sizes, so neighboring cells meet without seams.
  const x0 = Math.round(rect.x + col * cw), x1 = Math.round(rect.x + (col + 1) * cw);
  const y0 = Math.round(rect.y + row * ch), y1 = Math.round(rect.y + (row + 1) * ch);
  return [x0, y0, x1 - x0, y1 - y0];
}

function drawLandedCell(g, i, tintAlpha) {
  const [x, y, w, h] = cellBox(i);
  g.globalAlpha = 1;
  g.drawImage(scene.imgs.get(scene.plan.cells[i].tileId), x, y, w, h);
  const a = scene.plan.cells[i].tint.alpha * tintAlpha;
  if (a > 0) { g.globalAlpha = a; g.fillStyle = scene.tint[i]; g.fillRect(x, y, w, h); }
}

// Rounded corners for the mosaic (not while zoomed, and not in the saved image).
function clipMosaic(g) {
  const { rect } = L, r = 14 * L.dpr;
  g.beginPath();
  if (g.roundRect) g.roundRect(rect.x, rect.y, rect.w, rect.h, r); else g.rect(rect.x, rect.y, rect.w, rect.h);
  g.clip();
}

function renderFinal() {
  const c = makeCanvas(L.W, L.H);
  const g = c.getContext('2d');
  const { rect } = L;
  clipMosaic(g);
  g.globalAlpha = GHOST_ALPHA;
  g.drawImage(L.baseScaled, rect.x, rect.y, rect.w, rect.h);
  for (const i of scene.plan.order) drawLandedCell(g, i, 1);
  g.globalAlpha = 1;
  return c;
}

function drawMosaic(t) {
  if (t >= scene.tilesEnd) {
    finalCache ??= renderFinal();
    ctx.drawImage(finalCache, 0, 0);
    return;
  }
  const { rect, W, H } = L;
  // Show the whole picture first, then fade it back to a ghost as the photos arrive.
  const ghost = t < 600 ? (t / 600) * 0.85 : t < 1600 ? 0.85 + (GHOST_ALPHA - 0.85) * ((t - 600) / 1000) : GHOST_ALPHA;
  ctx.save();
  clipMosaic(ctx);
  ctx.globalAlpha = ghost;
  ctx.drawImage(L.baseScaled, rect.x, rect.y, rect.w, rect.h);

  const flying = [];
  for (const i of scene.plan.order) {
    const s = scene.start[i];
    if (t < s) break; // order is sorted by delay, so nothing later has started either
    const p = (t - s) / FLIGHT_MS;
    if (p >= 1) drawLandedCell(ctx, i, clamp((t - s - FLIGHT_MS) / TINT_MS, 0, 1));
    else flying.push(i, p);
  }
  ctx.restore(); // tiles in flight aren't clipped
  for (let k = 0; k < flying.length; k += 2) {
    const i = flying[k], p = flying[k + 1], e = easeOut(p);
    const [x, y, w, h] = cellBox(i);
    const [sx, sy, rot, scale] = scene.fly.subarray(i * 4, i * 4 + 4);
    const px = sx * W + (x + w / 2 - sx * W) * e, py = sy * H + (y + h / 2 - sy * H) * e;
    const s = scale + (1 - scale) * e, r = rot * (1 - e);
    ctx.globalAlpha = clamp(p * 4, 0, 1);
    ctx.setTransform(Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), px, py);
    ctx.drawImage(scene.imgs.get(scene.plan.cells[i].tileId), (-w * s) / 2, (-h * s) / 2, w * s, h * s);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
}

function drawBackdrop(t) {
  if (!L.backdrop) return;
  ctx.globalAlpha = 0.35 * clamp(t / 800, 0, 1);
  ctx.drawImage(L.backdrop, 0, 0);
  ctx.globalAlpha = 1;
}

function drawFloaters(t) {
  const still = reduceMotion.matches;
  const bob = (scene.mode === 'float' ? 10 : 3) * L.dpr;
  const sway = scene.mode === 'float' ? 0.04 : 0.015;
  for (let k = 0; k < L.slots.length; k++) {
    const slot = L.slots[k];
    const p = clamp((t - (scene.floatStart + k * L.floatGap)) / ENTER_MS, 0, 1);
    if (p === 0) continue;
    const [idx, alpha] = slotContent(k, t);
    const c = card(idx);
    const e = easeOut(p);
    const x = slot.fromX + (slot.x - slot.fromX) * e;
    const y = slot.fromY + (slot.y - slot.fromY) * e + (still ? 0 : Math.sin(t / 1700 + k * 1.3) * bob);
    const r = scene.floaterRot[idx] + (still ? 0 : Math.sin(t / 2300 + k) * sway);
    ctx.globalAlpha = alpha * Math.min(1, p * 2);
    ctx.setTransform(Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), x, y);
    ctx.drawImage(c, -c.width / 2, -c.height / 2);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
}

// ---------- zoom (finished mosaic only) ----------
// view maps unzoomed canvas coords to the screen: screen = view.x + x * view.s.
const view = { s: 1, x: 0, y: 0 };
const elapsed = () => (pausedAt ?? performance.now()) - startTime;
const finished = () => running && scene && L && elapsed() >= L.end;
const zoomable = () => finished() && scene.mode === 'mosaic';
const maxZoom = () => clamp((TILE_PX * 1.5 * L.dpr) / (L.rect.h / scene.rows), 2, 16);

function clampView() {
  if (view.s <= 1.001) Object.assign(view, { s: 1, x: 0, y: 0 });
  else {
    // Keep part of the mosaic under the middle of the screen.
    const { rect, W, H } = L;
    view.x = clamp(view.x, W / 2 - (rect.x + rect.w) * view.s, W / 2 - rect.x * view.s);
    view.y = clamp(view.y, H / 2 - (rect.y + rect.h) * view.s, H / 2 - rect.y * view.s);
  }
  $('reset-zoom').hidden = view.s === 1;
}
function zoomAt(px, py, f) {
  if (!zoomable()) return;
  const s = clamp(view.s * f, 1, maxZoom());
  view.x = px - (px - view.x) * (s / view.s);
  view.y = py - (py - view.y) * (s / view.s);
  view.s = s;
  clampView();
}
function resetView() { view.s = 0; clampView(); }

function drawZoomed() {
  const { rect, W, H } = L;
  ctx.setTransform(view.s, 0, 0, view.s, view.x, view.y);
  ctx.globalAlpha = GHOST_ALPHA;
  ctx.drawImage(scene.base, rect.x, rect.y, rect.w, rect.h); // full resolution, not the screen-sized copy
  // Only the cells on screen.
  const cw = rect.w / scene.cols, ch = rect.h / scene.rows;
  const c0 = clamp(Math.floor((-view.x / view.s - rect.x) / cw), 0, scene.cols - 1);
  const c1 = clamp(Math.floor(((W - view.x) / view.s - rect.x) / cw), 0, scene.cols - 1);
  const r0 = clamp(Math.floor((-view.y / view.s - rect.y) / ch), 0, scene.rows - 1);
  const r1 = clamp(Math.floor(((H - view.y) / view.s - rect.y) / ch), 0, scene.rows - 1);
  for (let row = r0; row <= r1; row++) {
    for (let col = c0; col <= c1; col++) {
      const i = row * scene.cols + col;
      if (scene.plan.cells[i].tileId !== null) drawLandedCell(ctx, i, 1);
    }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
}

// What's under a canvas point: a floating card (drawn on top) or a mosaic cell.
function itemAt(px, py) {
  if (view.s === 1) {
    for (let k = L.slots.length - 1; k >= 0; k--) {
      const slot = L.slots[k];
      const [idx] = slotContent(k, elapsed());
      const c = card(idx), m = 12 * L.dpr;
      if (Math.abs(px - slot.x) <= c.width / 2 - m && Math.abs(py - slot.y) <= c.height / 2 - m) return scene.floaters[idx].item;
    }
  }
  if (scene.mode !== 'mosaic') return null;
  const { rect } = L;
  const x = (px - view.x) / view.s, y = (py - view.y) / view.s;
  if (x < rect.x || y < rect.y || x >= rect.x + rect.w || y >= rect.y + rect.h) return null;
  const col = Math.floor(((x - rect.x) / rect.w) * scene.cols), row = Math.floor(((y - rect.y) / rect.h) * scene.rows);
  const id = scene.plan.cells[row * scene.cols + col]?.tileId;
  return id ? data.items.find((i) => i.id === id) : null;
}

// The photo open in the lightbox: { item, promise, blob, url }. Its JPEG (edited if need be) is
// prepared as soon as it opens, because phones only allow the share sheet right after a tap.
let lb = null;
function openItem(item) {
  closeLightboxPhoto();
  const img = $('lb-img');
  img.hidden = !item.fullUrl;
  $('lb-actions').hidden = !item.fullUrl;
  img.removeAttribute('src');
  if (item.fullUrl) {
    img.alt = item.message ? 'Photo from a fan' : 'Photo from a fan, no message';
    const entry = (lb = { item, blob: null, url: null });
    entry.promise = photoBlob(item).then((b) => { entry.blob = b; return b; });
    entry.promise.catch(() => {}); // reported when Save photo is pressed
    if (!item.edit) img.src = item.fullUrl;
    else {
      entry.promise.then((b) => {
        if (lb !== entry) return;
        entry.url = URL.createObjectURL(b);
        img.src = entry.url;
      }, () => { if (lb === entry) img.src = item.fullUrl; });
    }
  }
  $('lb-message').textContent = item.message;
  $('lb-name').textContent = item.name ? `— ${item.name}` : '';
  $('lightbox').showModal();
}
function closeLightboxPhoto() {
  if (lb?.url) URL.revokeObjectURL(lb.url);
  lb = null;
}
$('lightbox').addEventListener('close', () => { if (!$('lightbox').open) closeLightboxPhoto(); });

$('lb-save').addEventListener('click', async () => {
  const entry = lb;
  if (!entry) return;
  const button = $('lb-save');
  button.disabled = true;
  try {
    const blob = entry.blob ?? (await entry.promise);
    await saveOrShare(blob, `fanwall-${fileSlug(data.cosplayer.name)}-${entry.item.id.slice(0, 6)}.jpg`, `From your fans at ${data.event.name}`);
  } catch (err) {
    console.error(err);
    toast("Couldn't save the photo. Try again.", { error: true });
  } finally {
    button.disabled = false;
  }
});
$('lb-edit').addEventListener('click', () => {
  const item = lb?.item;
  if (!item) return;
  $('lightbox').close();
  editPhoto(item, { reopen: true });
});

const pointers = new Map();
let gesture = null; // { tap, start, last, at } for one finger; { dist, mid } for two
const pointOf = (e) => {
  const r = canvas.getBoundingClientRect();
  return [(e.clientX - r.left) * L.dpr, (e.clientY - r.top) * L.dpr];
};
const midDist = () => {
  const [[ax, ay], [bx, by]] = [...pointers.values()];
  return { mid: [(ax + bx) / 2, (ay + by) / 2], dist: Math.hypot(ax - bx, ay - by) || 1 };
};

canvas.addEventListener('pointerdown', (e) => {
  if (!finished()) return;
  $('zoom-hint').hidden = true;
  canvas.setPointerCapture(e.pointerId);
  const p = pointOf(e);
  pointers.set(e.pointerId, p);
  gesture = pointers.size === 1 ? { tap: true, start: p, last: p, at: performance.now() } : pointers.size === 2 ? midDist() : null;
});
canvas.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId) || !gesture) return;
  const p = pointOf(e);
  pointers.set(e.pointerId, p);
  if (pointers.size === 2 && gesture.dist) {
    const g = midDist();
    zoomAt(g.mid[0], g.mid[1], g.dist / gesture.dist);
    view.x += g.mid[0] - gesture.mid[0];
    view.y += g.mid[1] - gesture.mid[1];
    clampView();
    gesture = g;
  } else if (pointers.size === 1 && gesture.last) {
    if (Math.hypot(p[0] - gesture.start[0], p[1] - gesture.start[1]) > 8 * L.dpr) gesture.tap = false;
    if (!gesture.tap && view.s > 1) {
      view.x += p[0] - gesture.last[0];
      view.y += p[1] - gesture.last[1];
      clampView();
    }
    gesture.last = p;
  }
});
function endPointer(e) {
  if (!pointers.delete(e.pointerId)) return;
  if (e.type === 'pointerup' && gesture?.tap && performance.now() - gesture.at < 600) {
    const item = itemAt(...pointOf(e));
    if (item) openItem(item);
  }
  // After a pinch, the remaining finger pans without counting as a tap.
  const rest = [...pointers.values()][0];
  gesture = rest ? { tap: false, start: rest, last: rest, at: 0 } : null;
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
// After a finger lifts, the browser also sends a click. By then a tap may have opened the lightbox,
// so that click would land on its backdrop and close it again at once. The tap is already handled.
canvas.addEventListener('touchend', (e) => { if (finished()) e.preventDefault(); }, { passive: false });
canvas.addEventListener('wheel', (e) => {
  if (!zoomable()) return;
  e.preventDefault();
  zoomAt(...pointOf(e), Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.002)));
}, { passive: false });

document.addEventListener('keydown', (e) => {
  if (!zoomable() || document.querySelector('dialog[open]') || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.closest?.('button, a, input')) { if (!['+', '=', '-', '0'].includes(e.key)) return; }
  const step = 60 * L.dpr;
  const act = {
    '+': () => zoomAt(L.W / 2, L.H / 2, 1.4), '=': () => zoomAt(L.W / 2, L.H / 2, 1.4),
    '-': () => zoomAt(L.W / 2, L.H / 2, 1 / 1.4), 0: resetView,
    ArrowLeft: () => { view.x += step; clampView(); }, ArrowRight: () => { view.x -= step; clampView(); },
    ArrowUp: () => { view.y += step; clampView(); }, ArrowDown: () => { view.y -= step; clampView(); },
  }[e.key];
  if (act && (view.s > 1 || !e.key.startsWith('Arrow'))) { e.preventDefault(); act(); }
});

// ---------- frame ----------
let captionShown = false, doneShown = false, hintShown = false;
function frame(now) {
  if (!running) return;
  const t = now - startTime;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, L.W, L.H);
  if (scene.mode === 'mosaic' && view.s > 1) drawZoomed();
  else {
    if (scene.mode === 'mosaic') drawMosaic(t);
    else drawBackdrop(t);
    drawFloaters(t);
  }
  const done = t >= L.end;
  if (done !== doneShown) {
    doneShown = done;
    $('skip').hidden = done;
    canvas.classList.toggle('zoomable', done && scene.mode === 'mosaic');
    if (done && !hintShown) {
      hintShown = true;
      $('zoom-hint').textContent = scene.mode === 'mosaic'
        ? 'Pinch or scroll to zoom. Tap a photo or note to open it.'
        : 'Tap a photo or note to open it.';
      $('zoom-hint').hidden = false;
      setTimeout(() => { $('zoom-hint').hidden = true; }, 6000);
    }
  }
  const cap = done && view.s === 1;
  if (cap !== captionShown) { captionShown = cap; $('caption').classList.toggle('show', cap); }
  requestAnimationFrame(frame);
}

// ---------- controls ----------
function play({ fromEnd = false } = {}) {
  const now = performance.now();
  startTime = fromEnd ? now - L.end : now;
  pausedAt = null;
  doneShown = null; // re-evaluate the finished state for this (possibly rebuilt) scene
  resetView();
  if (!running) { running = true; requestAnimationFrame(frame); }
  queueExport();
}

function stopPlayback() {
  running = false;
  doneShown = captionShown = false;
  $('caption').classList.remove('show');
  canvas.classList.remove('zoomable');
  $('controls').hidden = true;
  $('zoom-hint').hidden = true;
  $('intro').hidden = false;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

$('play').addEventListener('click', () => {
  $('intro').hidden = true;
  $('controls').hidden = false;
  play({ fromEnd: reduceMotion.matches });
  $('replay').focus();
});
$('skip').addEventListener('click', () => { startTime = performance.now() - L.end; $('replay').focus(); });
$('replay').addEventListener('click', () => play({ fromEnd: reduceMotion.matches }));
$('reset-zoom').addEventListener('click', () => { resetView(); $('replay').focus(); });

// Hold the clock while the tab is hidden, so nobody misses the reveal by switching apps.
document.addEventListener('visibilitychange', () => {
  if (!running) return;
  if (document.hidden) pausedAt = performance.now();
  else if (pausedAt !== null) { startTime += performance.now() - pausedAt; pausedAt = null; }
});

new ResizeObserver(() => { if (scene) { computeLayout(); resetView(); } }).observe(canvas);

// ✕ closes; so does a click on the backdrop. (A click on the dialog's own padding also targets the
// dialog element, so check it landed outside the box.)
// (The photo editor is built later by editor.js and handles its own closing.)
for (const d of document.querySelectorAll('dialog')) {
  d.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) return d.close();
    if (e.target !== d) return;
    const r = d.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close();
  });
}

// ---------- export ----------
// Rendered ahead of time: phones only allow the share sheet right after a tap, so the file must be
// ready when the button is pressed. Contains the small tiles only, never full-size photos.
const EXPORT_PX = 2160;
let exportBlob = null, exportPromise = null, exportScene = null; // tied to one scene

function renderExport() {
  const s = scene;
  const w = s.aspect >= 1 ? EXPORT_PX : Math.round(EXPORT_PX * s.aspect);
  const h = s.aspect >= 1 ? Math.round(EXPORT_PX / s.aspect) : EXPORT_PX;
  const c = makeCanvas(w, h);
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.fillStyle = BG;
  g.fillRect(0, 0, w, h);
  g.globalAlpha = GHOST_ALPHA;
  g.drawImage(s.base, 0, 0, w, h);
  for (const i of s.plan.order) {
    const cell = s.plan.cells[i];
    const x0 = Math.round((cell.col * w) / s.cols), x1 = Math.round(((cell.col + 1) * w) / s.cols);
    const y0 = Math.round((cell.row * h) / s.rows), y1 = Math.round(((cell.row + 1) * h) / s.rows);
    g.globalAlpha = 1;
    g.drawImage(s.imgs.get(cell.tileId), x0, y0, x1 - x0, y1 - y0);
    g.globalAlpha = cell.tint.alpha;
    g.fillStyle = s.tint[i];
    g.fillRect(x0, y0, x1 - x0, y1 - y0);
  }
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/jpeg', 0.92));
}

// A rebuild (after hiding or deleting) makes a new scene, so an image for the old one is never reused.
function makeExport() {
  if (exportScene !== scene) { exportScene = scene; exportBlob = null; exportPromise = null; }
  const s = scene;
  exportPromise ??= renderExport().then((b) => { if (exportScene === s) exportBlob = b; return b; });
  return exportPromise;
}
function queueExport() {
  if (scene?.mode !== 'mosaic' || (exportScene === scene && exportPromise)) return;
  const s = scene;
  setTimeout(() => {
    if (scene === s) makeExport().catch(() => { if (exportScene === s) exportPromise = null; });
  }, 1500);
}
const resetExport = () => { exportBlob = null; exportPromise = null; exportScene = null; };

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

const fileSlug = (s) => s.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'mosaic';

// Share sheet on phones (save to photos, post); a plain download on desktop.
async function saveOrShare(blob, name, title) {
  const file = new File([blob], name, { type: 'image/jpeg' });
  if (matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title });
      return;
    } catch (err) {
      if (err.name === 'AbortError') return; // closed the share sheet
    }
  }
  downloadBlob(blob, name);
}

$('export').addEventListener('click', async () => {
  const button = $('export');
  button.disabled = true;
  try {
    const blob = (exportScene === scene && exportBlob) || (await makeExport());
    await saveOrShare(blob, `fanwall-${fileSlug(data.cosplayer.name)}.jpg`, `Thank you, ${data.cosplayer.name}`);
  } catch (err) {
    console.error(err);
    toast("Couldn't make the image. Try again.", { error: true });
  } finally {
    button.disabled = false;
  }
});

// ---------- manage ----------
let dirty = false;
const describe = (item) => (item.message ? `note “${Array.from(item.message).slice(0, 40).join('')}${Array.from(item.message).length > 40 ? '…' : ''}”` : 'photo');

function itemRow(item) {
  const what = describe(item);
  return el('li', { class: item.hidden ? 'is-hidden' : '', 'data-id': item.id },
    item.thumbUrl
      ? el('button', { type: 'button', class: 'thumb', 'aria-label': `Open ${what}`, onclick: () => openItem(item) },
        el('img', { src: item.thumbUrl, alt: '', loading: 'lazy' }))
      : null,
    el('div', { class: 'text' },
      el('div', { text: item.message || 'Photo' }),
      item.name ? el('div', { class: 'who', text: `— ${item.name}` }) : null,
      item.hidden || item.edit ? el('div', { class: 'who', text: [item.hidden && 'Hidden', item.edit && 'Edited'].filter(Boolean).join(' · ') }) : null),
    el('div', { class: 'acts' },
      item.fullUrl
        ? el('button', { type: 'button', 'data-act': 'edit', text: 'Edit', 'aria-label': `Edit ${what}`, onclick: () => editPhoto(item) })
        : null,
      el('button', {
        type: 'button', 'data-act': 'hide', text: item.hidden ? 'Show' : 'Hide',
        'aria-label': `${item.hidden ? 'Show' : 'Hide'} ${what}`, onclick: () => setHidden(item, !item.hidden),
      }),
      el('button', { type: 'button', class: 'danger', text: 'Delete', 'aria-label': `Delete ${what}`, onclick: () => deleteItem(item) })));
}

function renderManage(focusId = null, focusAct = 'hide') {
  const items = data.items ?? [];
  $('items').replaceChildren(...(items.length ? items.map(itemRow) : [el('li', { class: 'muted', text: 'Nothing here yet.' })]));
  $('download-row').hidden = STATIC || !data.ready || !items.some((i) => !i.hidden); // the ZIP is built by the server
  $('download').href = `/api/reveal/${encodeURIComponent(token)}/download.zip`;
  $('optout-confirm').hidden = true;
  $('optout-start').hidden = false;
  if (focusId) $('items').querySelector(`li[data-id="${CSS.escape(focusId)}"] [data-act="${focusAct}"]`)?.focus();
}

// From the lightbox (reopen: back to it afterwards) or from a Manage row.
function editPhoto(item, { reopen = false } = {}) {
  openEditor({ load: () => loadBitmap(item.fullUrl), edit: item.edit }, {
    save: async (edit) => (await api(`/api/reveal/${encodeURIComponent(token)}/items/${encodeURIComponent(item.id)}/edit`, { method: 'POST', json: { edit } })).edit,
    onClose: (saved, edit) => {
      if (saved) { item.edit = edit; itemsChanged(); toast('Edit saved.'); }
      if (reopen) openItem(item);
      else if ($('manage').open) renderManage(item.id, 'edit');
    },
  });
}

async function setHidden(item, hidden) {
  try {
    await api(`/api/reveal/${encodeURIComponent(token)}/items/${encodeURIComponent(item.id)}`, { method: 'POST', json: { hidden } });
    item.hidden = hidden;
    dirty = true;
    renderManage(item.id);
  } catch (err) {
    toast(err.message, { error: true });
  }
}

async function deleteItem(item) {
  if (!confirm(`Delete this ${item.message ? 'note' : 'photo'} for good? This can't be undone.`)) return;
  const i = data.items.indexOf(item);
  try {
    await api(`/api/reveal/${encodeURIComponent(token)}/items/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
    data.items.splice(i, 1);
    dirty = true;
    renderManage(data.items[Math.min(i, data.items.length - 1)]?.id);
    toast('Deleted.');
  } catch (err) {
    toast(err.message, { error: true });
  }
}

const openManage = () => { renderManage(); $('manage').showModal(); };
$('manage-open').addEventListener('click', openManage);
$('intro-manage').addEventListener('click', openManage);
$('optout-start').addEventListener('click', () => {
  $('optout-start').hidden = true;
  $('optout-confirm').hidden = false;
  $('optout-cancel').focus();
});
$('optout-cancel').addEventListener('click', () => {
  $('optout-confirm').hidden = true;
  $('optout-start').hidden = false;
  $('optout-start').focus();
});
$('optout-go').addEventListener('click', async () => {
  $('optout-go').disabled = true;
  try {
    await api(`/api/reveal/${encodeURIComponent(token)}/optout`, { method: 'POST', json: { confirm: true } });
    dirty = false;
    data = { ...data, ready: false, optOut: true, items: [], baseUrl: null };
    $('manage').close();
    showClosed();
  } catch (err) {
    toast(err.message, { error: true });
  } finally {
    $('optout-go').disabled = false;
  }
});

// Changes made in the drawer apply when it closes: one rebuild instead of one per click.
// An edit saved from the lightbox rebuilds right away.
let rebuilding = Promise.resolve();
const rebuild = () => { rebuilding = rebuilding.then(showReady).catch((err) => console.error(err)); };
function itemsChanged() {
  if ($('manage').open) dirty = true;
  else rebuild();
}
$('manage').addEventListener('close', () => {
  if (!dirty) return;
  dirty = false;
  rebuild();
});

// ---------- start ----------
function intro(title, text, eventName = '') {
  $('intro-event').textContent = eventName;
  $('intro-title').textContent = title;
  $('intro-text').textContent = text;
}

function fillSummary(visible, what) {
  const notes = visible.filter((i) => i.message);
  $('sr-summary').textContent = visible.length ? `${what} from your fans.` : '';
  $('sr-list').replaceChildren(...notes.map((n) => el('li', { text: n.name ? `${n.message} (${n.name})` : n.message })));
}

// Never show a count: cosplayers at the same event compare screenshots, and a number turns the
// reveal into a scoreboard. Say what kind of things arrived, not how many.
const kinds = (photos, notes) => (photos && notes ? 'Photos and notes' : photos ? 'Photos' : 'Notes');

function freeScene(s) {
  if (!s) return;
  s.base?.close?.();
  for (const f of s.floaters) f.img?.close?.();
}

function showClosed() {
  stopPlayback();
  freeScene(scene);
  scene = null;
  resetExport();
  fillSummary([], '');
  $('play').hidden = true;
  $('intro-manage').hidden = true;
  intro('This page has been closed', 'Everything here was deleted at your request.', data.event.name);
}

// Builds (or rebuilds, after Manage changes) the scene from the items that aren't hidden.
async function showReady() {
  const name = data.cosplayer.name;
  const visible = data.items.filter((i) => !i.hidden);
  const what = kinds(visible.some((i) => i.thumbUrl), visible.some((i) => i.message));
  fillSummary(visible, what);
  $('caption-sub').textContent = `${what} from your fans at ${data.event.name}`;
  $('intro-manage').textContent = 'Manage your page';
  $('intro-manage').hidden = false;
  resetExport();

  if (!visible.length) {
    stopPlayback();
    freeScene(scene);
    scene = null;
    $('play').hidden = true;
    intro(`For ${name}`, data.items.length
      ? 'Everything is hidden right now. Open Manage to show items again.'
      : 'Nothing to show yet. Check back soon!', data.event.name);
    return;
  }

  const wasRunning = running;
  const button = $('play');
  if (!wasRunning) {
    intro(`For ${name}`, `${what} from your fans at ${data.event.name}.`, data.event.name);
    button.hidden = false;
    button.disabled = true;
  } else {
    toast('Updating your mosaic…');
  }
  try {
    const next = await prepare(wasRunning ? () => {} : (p) => { button.textContent = `Preparing… ${Math.round(clamp(p, 0, 1) * 100)}%`; });
    const old = scene;
    scene = next;
    computeLayout();
    freeScene(old);
    $('export').hidden = scene.mode !== 'mosaic';
    if (running) { play({ fromEnd: true }); toast('Updated.'); }
    else {
      button.textContent = reduceMotion.matches ? 'Show' : 'Play';
      button.disabled = false;
      button.focus();
    }
  } catch (err) {
    console.error(err);
    if (wasRunning) toast("Couldn't update the mosaic. Try reloading.", { error: true });
    else button.textContent = "Couldn't prepare the mosaic. Try reloading.";
  }
}

try {
  data = await api(`/api/reveal/${encodeURIComponent(token)}`);
} catch (err) {
  if (err instanceof TypeError) intro("Can't reach FanWall", 'Check your connection, then reload this page.');
  else intro('This link is not valid', 'Ask the organizer for a fresh link.');
}

if (data?.optOut) {
  showClosed();
} else if (data && !data.ready) {
  intro('Not quite ready yet', 'The organizer is still gathering photos and notes from your fans. Check back soon!', data.event.name);
  // Closing the page is allowed before release: someone may not want fan photos at all.
  $('intro-manage').textContent = "Don't want this? Close your page";
  $('intro-manage').hidden = false;
} else if (data) {
  document.title = `For ${data.cosplayer.name} · FanWall`;
  $('caption-title').textContent = `Thank you, ${data.cosplayer.name}`;
  await showReady();
}
