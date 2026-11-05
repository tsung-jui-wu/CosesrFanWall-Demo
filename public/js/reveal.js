// Cosplayer reveal, in the event's style (styles.js): photos fly in and assemble into a mosaic of the
// organizer's image, get pinned up on a wall as prints, or light up as a constellation; notes settle
// around them. Everything is drawn on one canvas. The timeline is a pure function of elapsed time, so
// skip, replay, and resize need no extra state.
import { api, el, toast, loadBitmap, STATIC, segmentAfter, downloadBlob, saveOrShare } from './api.js';
import { makeIcs, nextDecember } from './ics.js';
import { tileFeature, targetCells, chooseGrid, planMosaic, mulberry32, hashSeed } from './mosaic.js';
import { planWall, PRINT_RATIO } from './polaroid.js';
import { planSky } from './constellation.js';
import { styleOf, pickPool, cycleItem, EXPORT, EXPORT_MAX_PHOTO } from './styles.js';
import { makeCanvas, shrinkInto, coverCrop, drawPiece, paintWall, printPiece, paintSky, paintDust, paintLink, starPiece, ARRIVE, easeOut } from './art.js';
import { renderPicture, animatePicture } from './render.js';
import { GifEncoder, buildPalette } from './gif.js';
import { renderEdited, photoBlob, openEditor } from './editor.js';
import { t, lang, setText, setTitle, formatDate, onLangChange, useEventLang } from './i18n.js';

const token = segmentAfter('r');
// The organizer's preview (/admin/<token>/preview/<cosplayer>): the same page, view-only, reading
// the organizer API. It's laid out with the cosplayer's own seed, so it matches what they'll see.
const PREVIEW = Boolean(segmentAfter('preview'));
const dataPath = PREVIEW
  ? `/api/admin/${encodeURIComponent(segmentAfter('admin'))}/cosplayers/${encodeURIComponent(segmentAfter('preview'))}/preview`
  : `/api/reveal/${encodeURIComponent(token)}`;
let seed = token; // layouts and animations; set from the data once it loads
const $ = (id) => document.getElementById(id);
const canvas = $('stage');
const ctx = canvas.getContext('2d');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

const BG = '#090909'; // matches --canvas in app.css
const CARD_BG = '#141414'; // --surface-1
const TILE_PX = 64; // tiles are pre-cut at this height; cells are almost always smaller
const PHOTO_PX = 256; // the wall's and the sky's photos are cut square at this size
const POOL_MAX = 120; // the most photos a wall or sky takes turns through (a seeded pick of them)
const GHOST_ALPHA = 0.3;
const FLIGHT_MS = 1000;
const TINT_MS = 500;
const ENTER_MS = 1600;
const CYCLE_MS = 4500; // a note slot moves on to the next note
const PIECE_MS = ARRIVE.piece; // a print or a star arriving
const PIECE_CYCLE_MS = 2600; // a print or a star moves on to the next photo

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

let data = null;
let scene = null; // built once by prepare()
let L = null; // layout for the current canvas size
let startTime = 0;
let pausedAt = null;
let running = false;
let finalCache = null;
const cardCache = new Map();

// ---------- image prep ----------
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

// The scene's mode: 'mosaic', 'wall' (polaroid), 'sky' (constellation), or 'float' when there are only
// notes. A mosaic needs a picture to assemble into; without one, its photos go up on a wall instead.
async function prepare(onProgress) {
  await document.fonts?.ready; // note cards are drawn with Inter; don't cache them in a fallback font
  const style = styleOf(data.event);
  const visible = data.items.filter(shown);
  const photos = visible.filter((i) => i.thumbUrl);
  const notes = visible.filter((i) => i.message).map((item) => ({ kind: 'note', item }));
  const steps = photos.length + 2;
  let done = 0;
  const tick = (n = 1) => onProgress((done += n) / steps);

  const base = style === 'mosaic' && data.baseUrl ? await loadBitmap(data.baseUrl).catch(() => null) : null;
  tick();
  const look = style === 'polaroid' ? 'wall' : style === 'constellation' ? 'sky' : 'plain';
  const float = () => {
    onProgress(1);
    return buildScene({ mode: 'float', look, base, floaters: notes });
  };
  if (!photos.length) return float(); // only notes: nothing to assemble or pin up, and nothing to save
  if (style !== 'mosaic' || !base) return prepareArt(style === 'constellation' ? 'sky' : 'wall', photos, notes, tick, onProgress);

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
  if (!tiles.length) return float(); // none of the photos would load

  const plan = planMosaic({ cols, rows, cellFeatures: features, meanRGB, tiles, seed });
  // Photos the plan didn't use float with the notes.
  const leftover = new Set(plan.leftover);
  const extras = await floatPhotos(tiles.filter((t) => leftover.has(t.id)).map((t) => t.item));
  onProgress(1);
  return buildScene({
    mode: 'mosaic', base, plan, cols, rows, aspect,
    imgs: new Map(tiles.map((t) => [t.id, t.img])),
    floaters: interleave(extras, notes),
  });
}

// The wall and the sky: a seeded pick of up to POOL_MAX photos, each cut square at PHOTO_PX. The layout
// itself is planned per screen size (computeLayout), since it depends on the screen's shape.
async function prepareArt(mode, photos, notes, tick, onProgress) {
  const picks = pickPool(photos.length, POOL_MAX, seed).map((i) => photos[i]);
  tick(photos.length - picks.length);
  const pics = (await pool(picks, 6, async (item) => {
    let bmp;
    try {
      bmp = await thumbOf(item);
      const img = makeCanvas(PHOTO_PX, PHOTO_PX);
      shrinkInto(img, bmp, ...coverCrop(bmp.width, bmp.height, 1), PHOTO_PX, PHOTO_PX);
      return { item, img };
    } catch {
      return null;
    } finally {
      bmp?.close?.();
      tick();
    }
  })).filter(Boolean);
  onProgress(1);
  if (!pics.length) return buildScene({ mode: 'float', look: mode, base: null, floaters: notes });
  return buildScene({ mode, pics, floaters: notes });
}

// Per-cell flight paths and the timeline, all derived from the seed.
function buildScene(s) {
  const rng = mulberry32(hashSeed(seed) ^ 0x9e3779b9);
  s.floaterRot = s.floaters.map(() => (rng() - 0.5) * 0.16);
  if (s.mode === 'wall' || s.mode === 'sky') {
    // Prints are pinned up, or stars light up, over `spread` ms; then the notes arrive.
    s.t0 = ARRIVE.t0;
    s.spread = s.mode === 'wall' ? ARRIVE.wall : ARRIVE.sky;
    s.tilesEnd = s.t0 + s.spread + PIECE_MS;
    s.floatStart = s.tilesEnd - 600;
    s.floatSpan = null;
  } else if (s.mode === 'mosaic') {
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
// A full-canvas background painted once per layout instead of every frame.
function backdropOf(paint, W, H) {
  const c = makeCanvas(W, H);
  paint(c.getContext('2d'), W, H);
  return c;
}

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
  } else if (scene.mode === 'wall') {
    // The wall fills the band from edge to edge; notes are pinned over it. How many prints and note
    // spots there are depends only on the screen, never on how many photos or notes arrived.
    const cols = clamp(Math.round(W / (132 * dpr)), 3, 8);
    const spots = Math.min(n, clamp(Math.round((W * UH) / (330 * dpr) ** 2), 1, 4));
    const plan = planWall({ aspect: W / UH, cols, photos: scene.pics.length, seed, noteSpots: spots });
    const cardW = Math.round(clamp((W / cols) * 1.5, 130 * dpr, 280 * dpr));
    for (const s of plan.notes) {
      lay.slots.push({
        x: clamp(s.x * W, cardW / 2 + gap, W - cardW / 2 - gap),
        y: clamp(top + s.y * W, top + cardW * 0.45, top + UH - cardW * 0.45),
        rot: s.rot, pinned: true,
      });
    }
    Object.assign(lay, {
      cardW, cardH: Math.round(cardW * 0.75), plan, top, bandH: UH, bg: backdropOf(paintWall, W, H),
      pieceW: (W / cols) * 0.94, pieces: new Map(), pieceCap: plan.prints.length + 12,
    });
  } else if (scene.mode === 'sky') {
    // The sky fills the screen; the stars sit in the band, notes drift beside some of them.
    const stars = clamp(Math.round((W * UH) / (155 * dpr) ** 2 / 2), 5, 12);
    const radius = clamp(Math.min(W, UH) * 0.075, 26 * dpr, 52 * dpr) / W;
    const plan = planSky({ aspect: W / UH, stars, radius, photos: scene.pics.length, seed, dust: 170, noteSpots: Math.min(n, 3) });
    const cardW = Math.round(clamp(Math.min(W, H) * 0.32, 120 * dpr, 230 * dpr));
    for (const s of plan.notes) {
      const star = plan.stars[s.star];
      const reach = star.r * W + cardW * 0.62;
      lay.slots.push({
        x: clamp(star.x * W + s.dx * reach, cardW / 2 + gap, W - cardW / 2 - gap),
        y: clamp(top + star.y * W + s.dy * reach * 0.8, top + cardW * 0.4, top + UH - cardW * 0.4),
      });
    }
    Object.assign(lay, {
      cardW, cardH: Math.round(cardW * 0.75), plan, top, bg: backdropOf(paintSky, W, H),
      starR: radius * 1.18 * W, pieces: new Map(), pieceCap: plan.stars.length + 12,
    });
  } else {
    // Float mode: a jittered grid over the usable band.
    const maxK = clamp(Math.floor((W * UH) / (190 * dpr) ** 2), 4, 12);
    const K = Math.min(n, maxK);
    const gc = Math.max(1, Math.ceil(Math.sqrt((K * W) / UH))), gr = Math.max(1, Math.ceil(K / gc));
    const cw = W / gc, ch = UH / gr;
    const cardW = Math.round(clamp(Math.min(cw, ch * 1.2) * 0.78, 90 * dpr, 300 * dpr));
    const rng = mulberry32(hashSeed(seed) + K);
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
    // Only notes, at a polaroid or constellation event: they still hang on the wall or in the sky.
    const bg = scene.look === 'wall' ? backdropOf(paintWall, W, H) : scene.look === 'sky' ? backdropOf(paintSky, W, H) : null;
    Object.assign(lay, { cardW, cardH: Math.round(cardW * 0.75), backdrop, bg });
  }
  // Each slot enters from the nearest outside direction; a pinned note drops in from just above.
  const cx = W / 2, cy = H / 2, reach = 0.45 * Math.max(W, H);
  for (const s of lay.slots) {
    const dx = s.x - cx, dy = s.y - cy, d = Math.hypot(dx, dy) || 1;
    s.fromX = s.pinned ? s.x : s.x + (dx / d) * reach;
    s.fromY = s.pinned ? s.y - 40 * dpr : s.y + (dy / d) * reach;
  }
  const K = lay.slots.length;
  lay.floatGap = K ? (scene.floatSpan ?? K * 300) / K : 0;
  lay.end = Math.max(scene.tilesEnd, scene.floatStart + K * lay.floatGap + ENTER_MS);
  L = lay;
  finalCache = null;
  cardCache.clear();
}

// ---------- cards (notes and floating photos) ----------
// Chinese closing punctuation never starts a line; it hangs at the end of the one before instead.
const NO_LINE_START = /[，。、！？：；」』）》〉】…]/;
function wrapText(c, text, maxW, maxLines) {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim());
  const lines = [];
  let line = '';
  let i = 0;
  for (; i < chars.length && lines.length < maxLines; i++) {
    const test = line + chars[i];
    if (!line || c.measureText(test).width <= maxW || NO_LINE_START.test(chars[i])) { line = test; continue; }
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

// The page's own font stack (--font-body in app.css), so a note in Chinese draws with the same CJK
// fonts, in the right Simplified or Traditional shapes, as the page around it.
const fontStack = () => getComputedStyle(document.documentElement).getPropertyValue('--font-body').trim() || 'sans-serif';

// Card looks: charcoal (mosaic), paper with tape pinned on the wall, dark glass in the sky.
const CARD_LOOK = {
  plain: { bg: CARD_BG, ink: '#ffffff', sub: '#999999', edge: 'rgba(255,255,255,0.08)', round: 0.1 },
  wall: { bg: '#f6f0e1', ink: '#2b2620', sub: '#7a6f62', edge: 'rgba(0,0,0,0.06)', round: 0.02, tape: true },
  sky: { bg: 'rgba(14, 18, 42, 0.92)', ink: '#ffffff', sub: '#aab4d8', edge: 'rgba(170, 190, 255, 0.28)', round: 0.12 },
};
const cardLook = () => CARD_LOOK[scene.look ?? scene.mode] ?? CARD_LOOK.plain;

// Rounded cards: a photo fills its card; a note is its text with the name below, in the card's look.
function renderCard(f) {
  const FONT = fontStack();
  const look = cardLook();
  const { cardW: w, cardH: h, dpr } = L;
  const m = Math.round(16 * dpr); // room for the shadow and the tape
  const r = Math.round(Math.min(w, h) * look.round);
  const c = makeCanvas(w + 2 * m, h + 2 * m);
  const g = c.getContext('2d');
  const box = () => { g.beginPath(); if (g.roundRect) g.roundRect(m, m, w, h, r); else g.rect(m, m, w, h); };
  g.shadowColor = 'rgba(0,0,0,0.5)'; g.shadowBlur = 16 * dpr; g.shadowOffsetY = 6 * dpr;
  g.fillStyle = look.bg;
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
    g.fillStyle = look.ink;
    g.font = `400 ${fs}px ${FONT}`;
    g.textBaseline = 'top';
    const lines = wrapText(g, f.item.message, w - 2 * pad, maxLines);
    const block = lines.length * lh + (hasName ? lh * 1.2 : 0);
    let y = m + Math.max(pad, (h - block) / 2);
    for (const line of lines) { g.fillText(line, m + pad, y); y += lh; }
    if (hasName) {
      g.fillStyle = look.sub;
      g.font = `500 ${Math.round(fs * 0.85)}px ${FONT}`;
      g.fillText(f.item.name, m + pad, y + lh * 0.2);
    }
  }
  g.strokeStyle = look.edge; // the faint edge of a floating card
  g.lineWidth = Math.max(1, dpr * 0.75);
  box(); g.stroke();
  if (look.tape) {
    g.translate(m + w / 2, m);
    g.rotate(0.04);
    g.fillStyle = 'rgba(232, 222, 190, 0.8)';
    g.fillRect(-w * 0.14, -h * 0.07, w * 0.28, h * 0.14);
  }
  return c;
}

function card(idx) {
  let c = cardCache.get(idx);
  if (!c) { c = renderCard(scene.floaters[idx]); cardCache.set(idx, c); }
  return c;
}

// When len items take turns in K slots, one slot moving on every `period` ms from `ms` = 0 (styles.js
// cycleItem): what slot k shows, what it showed before, and how far through the change it is (f, 0..1).
function turn(k, ms, K, len, period, fadeMs) {
  if (len <= K || ms < 0) return { item: k % len, prev: k % len, f: 1 };
  const c = Math.floor(ms / period), local = ms - c * period;
  const item = cycleItem(k, c + 1, K, len);
  if (c % K !== k || local >= fadeMs) return { item, prev: item, f: 1 };
  return { item, prev: cycleItem(k, c, K, len), f: local / fadeMs };
}

// Which floater slot k shows at time t, and its opacity. After the reveal settles, one slot at a
// time fades to the next unseen item, so every note gets its turn.
function slotContent(k, t) {
  const r = turn(k, t - (L.end + 2500), L.slots.length, scene.floaters.length, CYCLE_MS, 1200);
  return r.f < 0.5 ? [r.prev, 1 - 2 * r.f] : [r.item, 2 * r.f - 1];
}

// The wall's prints and the sky's stars take turns through the photos the same way, crossfading.
const pieceTurn = (k, t, K) => turn(k, t - (L.end + 1500), K, scene.pics.length, PIECE_CYCLE_MS, 900);

// ---------- drawing ----------
function cellBox(i, rect = L.rect) {
  const col = i % scene.cols, row = Math.floor(i / scene.cols);
  const cw = rect.w / scene.cols, ch = rect.h / scene.rows;
  // Round edges, not sizes, so neighboring cells meet without seams.
  const x0 = Math.round(rect.x + col * cw), x1 = Math.round(rect.x + (col + 1) * cw);
  const y0 = Math.round(rect.y + row * ch), y1 = Math.round(rect.y + (row + 1) * ch);
  return [x0, y0, x1 - x0, y1 - y0];
}

function drawLandedCell(g, i, tintAlpha, rect = L.rect) {
  const [x, y, w, h] = cellBox(i, rect);
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
  paintAssembly(ctx, t, L.rect, L.W, L.H, L.baseScaled, clipMosaic);
}

// The mosaic at time t, assembling in `rect` on a W x H canvas: the stage, or a Save GIF frame. In a
// GIF, a tile in flight is never drawn bigger than a saved image allows (maxTile, as a share of W).
function paintAssembly(g, t, rect, W, H, base, clip = null, maxTile = Infinity) {
  // Show the whole picture first, then fade it back to a ghost as the photos arrive.
  const ghost = t < 600 ? (t / 600) * 0.85 : t < 1600 ? 0.85 + (GHOST_ALPHA - 0.85) * ((t - 600) / 1000) : GHOST_ALPHA;
  g.save();
  clip?.(g);
  g.globalAlpha = ghost;
  g.drawImage(base, rect.x, rect.y, rect.w, rect.h);

  const flying = [];
  for (const i of scene.plan.order) {
    const s = scene.start[i];
    if (t < s) break; // order is sorted by delay, so nothing later has started either
    const p = (t - s) / FLIGHT_MS;
    if (p >= 1) drawLandedCell(g, i, clamp((t - s - FLIGHT_MS) / TINT_MS, 0, 1), rect);
    else flying.push(i, p);
  }
  g.restore(); // tiles in flight aren't clipped
  for (let k = 0; k < flying.length; k += 2) {
    const i = flying[k], p = flying[k + 1], e = easeOut(p);
    const [x, y, w, h] = cellBox(i, rect);
    const [sx, sy, rot, scale] = scene.fly.subarray(i * 4, i * 4 + 4);
    const px = sx * W + (x + w / 2 - sx * W) * e, py = sy * H + (y + h / 2 - sy * H) * e;
    const s = Math.min(scale + (1 - scale) * e, (maxTile * W) / Math.max(w, h)), r = rot * (1 - e);
    g.globalAlpha = clamp(p * 4, 0, 1);
    g.setTransform(Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), px, py);
    g.drawImage(scene.imgs.get(scene.plan.cells[i].tileId), (-w * s) / 2, (-h * s) / 2, w * s, h * s);
  }
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1;
}

function drawBackdrop(t) {
  if (L.bg) { ctx.drawImage(L.bg, 0, 0); return; } // only notes, on the wall or in the sky
  if (!L.backdrop) return;
  ctx.globalAlpha = 0.35 * clamp(t / 800, 0, 1);
  ctx.drawImage(L.backdrop, 0, 0);
  ctx.globalAlpha = 1;
}

// ---------- the wall and the sky ----------
// Prints and stars are drawn once per photo and kept; the cache holds about what's on screen, so a
// big set doesn't fill a phone's canvas memory while the pieces take turns.
function piece(key, make) {
  let c = L.pieces.get(key);
  if (c) { L.pieces.delete(key); L.pieces.set(key, c); return c; } // most recently used goes last
  c = make();
  L.pieces.set(key, c);
  if (L.pieces.size > L.pieceCap) L.pieces.delete(L.pieces.keys().next().value);
  return c;
}
const printOf = (photo) => piece(`p${photo}`, () => printPiece(scene.pics[photo].img, L.pieceW));
const starOf = (photo) => piece(`s${photo}`, () => starPiece(scene.pics[photo].img, L.starR));

// Which photo print or star i shows at time t: its planned one, or, when there are more photos than
// pieces, its turn in the cycle (crossfading from the one before).
const pieceShows = (i, own, K, t) => (scene.pics.length <= K ? { item: own, prev: own, f: 1 } : pieceTurn(i, t, K));

// Draws piece i (arriving `a`, 0..1) with its photo crossfading: the old one, then the new one over it.
function drawTurning(make, s, x, y, rot, scale, a) {
  if (s.f < 1) drawPiece(ctx, make(s.prev), x, y, rot, scale, a);
  drawPiece(ctx, make(s.item), x, y, rot, scale, a * s.f);
}

function drawWall(t) {
  const { W, plan, top, dpr } = L;
  ctx.drawImage(L.bg, 0, 0);
  // The wall runs past its band's edges; keep it clear of the caption above and the buttons below.
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, top, W, L.bandH);
  ctx.clip();
  const P = plan.prints.length;
  plan.prints.forEach((p, i) => {
    const a = clamp((t - (scene.t0 + p.delay * scene.spread)) / PIECE_MS, 0, 1);
    if (a === 0) return;
    const e = easeOut(a); // each print drops onto the wall and settles
    const scale = ((p.w * W) / L.pieceW) * (1 + (1 - e) * 0.18);
    drawTurning(printOf, pieceShows(i, p.photo, P, t), p.x * W, top + p.y * W - (1 - e) * 30 * dpr, p.rot + (1 - e) * 0.25, scale, a);
  });
  ctx.restore();
}

function drawSky(t) {
  const { W, H, plan, top, dpr } = L;
  const still = reduceMotion.matches;
  ctx.drawImage(L.bg, 0, 0);
  paintDust(ctx, plan.dust, plan.height, W, H, t, still, clamp(t / 1200, 0, 1));
  const lit = (s) => clamp((t - (scene.t0 + s.delay * scene.spread)) / PIECE_MS, 0, 1);
  for (const [a, b] of plan.links) {
    // Each line draws itself toward the later of its two stars as that star lights up.
    const [from, to] = plan.stars[a].delay <= plan.stars[b].delay ? [plan.stars[a], plan.stars[b]] : [plan.stars[b], plan.stars[a]];
    paintLink(ctx, from.x * W, top + from.y * W, to.x * W, top + to.y * W, lit(to), Math.max(1, dpr));
  }
  const K = plan.stars.length;
  plan.stars.forEach((s, i) => {
    const a = lit(s);
    if (a === 0) return;
    const pulse = still ? 1 : 1 + 0.03 * Math.sin(t / 1300 + i * 1.7);
    const scale = ((s.r * W) / L.starR) * (0.6 + 0.4 * easeOut(a)) * pulse;
    drawTurning(starOf, pieceShows(i, s.photo, K, t), s.x * W, top + s.y * W, 0, scale, a);
  });
}

function drawFloaters(t) {
  const still = reduceMotion.matches;
  const bob = (scene.mode === 'float' ? 10 : scene.mode === 'sky' ? 8 : 3) * L.dpr;
  const sway = scene.mode === 'float' ? 0.04 : scene.mode === 'sky' ? 0.03 : 0.015;
  for (let k = 0; k < L.slots.length; k++) {
    const slot = L.slots[k];
    const p = clamp((t - (scene.floatStart + k * L.floatGap)) / ENTER_MS, 0, 1);
    if (p === 0) continue;
    const [idx, alpha] = slotContent(k, t);
    const c = card(idx);
    const e = easeOut(p);
    const moving = !still && !slot.pinned; // pinned notes stay put
    const x = slot.fromX + (slot.x - slot.fromX) * e;
    const y = slot.fromY + (slot.y - slot.fromY) * e + (moving ? Math.sin(t / 1700 + k * 1.3) * bob : 0);
    const r = (slot.rot ?? scene.floaterRot[idx]) + (moving ? Math.sin(t / 2300 + k) * sway : 0);
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
  if (scene.mode === 'wall') {
    // The topmost print under the point, in the print's own turned frame.
    const { W, plan, top } = L, t = elapsed();
    if (py < top || py > top + L.bandH) return null; // that part of the wall is clipped away
    for (let i = plan.prints.length - 1; i >= 0; i--) {
      const p = plan.prints[i], w = p.w * W;
      const dx = px - p.x * W, dy = py - (top + p.y * W);
      const lx = dx * Math.cos(p.rot) + dy * Math.sin(p.rot), ly = -dx * Math.sin(p.rot) + dy * Math.cos(p.rot);
      if (Math.abs(lx) <= w / 2 && Math.abs(ly) <= (w * PRINT_RATIO) / 2) {
        return scene.pics[pieceShows(i, p.photo, plan.prints.length, t).item].item;
      }
    }
    return null;
  }
  if (scene.mode === 'sky') {
    const { W, plan, top } = L, t = elapsed();
    const i = plan.stars.findIndex((s) => Math.hypot(px - s.x * W, py - (top + s.y * W)) <= s.r * W * 1.25);
    return i < 0 ? null : scene.pics[pieceShows(i, plan.stars[i].photo, plan.stars.length, t).item].item;
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
    img.alt = t(item.message ? 'reveal.lb.photoAlt' : 'reveal.lb.photoAltNoMessage');
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
  $('lb-name').textContent = item.name ? t('reveal.from', { name: item.name }) : '';
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
    await saveOrShare(blob, `fanwall-${fileSlug(data.cosplayer.name)}-${entry.item.id.slice(0, 6)}.jpg`, t('reveal.share.photo', { event: data.event.name }));
  } catch (err) {
    console.error(err);
    toast(t('reveal.toast.savePhotoFailed'), { error: true });
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
    else if (scene.mode === 'wall') drawWall(t);
    else if (scene.mode === 'sky') drawSky(t);
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
      setText($('zoom-hint'), scene.mode === 'mosaic' ? 'reveal.hint.zoom' : 'reveal.hint.tap');
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
// ready when the button is pressed. Whatever the style, a saved image holds the picture only: fans'
// photos as small tiles (no bigger than EXPORT_MAX_PHOTO of the image's width, see styles.js), and
// never their notes or names, which their consent doesn't cover. So there's nothing to save when the
// page has notes only.
const EXPORT_PX = 2160;
let exportBlob = null, exportPromise = null, exportScene = null; // tied to one scene
const canSave = () => Boolean(scene) && scene.mode !== 'float';
const toJpeg = (c) => new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/jpeg', 0.92));

// The wall or the sky, from the style's still renderer (render.js), at the saved size.
function renderArtExport() {
  const style = scene.mode === 'sky' ? 'constellation' : 'polaroid';
  return toJpeg(renderPicture(style, { photos: scene.pics.map((p) => p.img), picture: null, seed }));
}

function renderExport() {
  const s = scene;
  if (s.mode !== 'mosaic') return renderArtExport();
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
  return toJpeg(c);
}

// A rebuild (after hiding or deleting) makes a new scene, so an image for the old one is never reused.
function makeExport() {
  if (exportScene !== scene) { exportScene = scene; exportBlob = null; exportPromise = null; }
  const s = scene;
  exportPromise ??= renderExport().then((b) => { if (exportScene === s) exportBlob = b; return b; });
  return exportPromise;
}
function queueExport() {
  if (!canSave() || (exportScene === scene && exportPromise)) return;
  const s = scene;
  setTimeout(() => {
    if (scene === s) makeExport().catch(() => { if (exportScene === s) exportPromise = null; });
  }, 1500);
}
const resetExport = () => { exportBlob = null; exportPromise = null; exportScene = null; gifBlob = null; gifScene = null; };

const fileSlug = (s) => s.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'mosaic';

$('export').addEventListener('click', async () => {
  const button = $('export');
  closeSaveMenu();
  button.disabled = true;
  try {
    const blob = (exportScene === scene && exportBlob) || (await makeExport());
    await saveOrShare(blob, `fanwall-${fileSlug(data.cosplayer.name)}.jpg`, t('reveal.thankYou', { name: data.cosplayer.name }));
  } catch (err) {
    console.error(err);
    toast(t('reveal.toast.exportFailed'), { error: true });
  } finally {
    button.disabled = false;
  }
});

// Save GIF: the picture coming together, then holding. The same rule as the image: the picture only,
// never notes or names, and no photo bigger than EXPORT_MAX_PHOTO of the width (tiles in flight are
// held to it; prints and stars only grow into place). The timeline is squeezed into GIF_MAX_MS so the
// loop stays short enough to post. Made on request, not ahead: it takes a few seconds and a lot more
// work than the image.
const GIF_PX = 640; // the long side
const GIF_FRAME_CS = 8; // hundredths of a second per frame (12.5 fps)
const GIF_HOLD_CS = 300; // the finished picture, before the loop starts again
const GIF_MAX_MS = 6000;
let gifBlob = null, gifScene = null, gifBusy = false;

function gifAnimation() {
  const s = scene;
  if (s.mode === 'mosaic') {
    const w = s.aspect >= 1 ? GIF_PX : Math.round(GIF_PX * s.aspect);
    const h = s.aspect >= 1 ? Math.round(GIF_PX / s.aspect) : GIF_PX;
    const base = makeCanvas(w, h);
    shrinkInto(base, s.base, 0, 0, s.base.width, s.base.height, w, h);
    const rect = { x: 0, y: 0, w, h };
    return {
      w, h, from: 600, end: s.tilesEnd, // from the picture showing, so the first frame isn't blank
      draw(g, t) {
        g.fillStyle = BG;
        g.fillRect(0, 0, w, h);
        paintAssembly(g, t, rect, w, h, base, null, EXPORT_MAX_PHOTO);
      },
    };
  }
  const h = GIF_PX, w = Math.round((GIF_PX * EXPORT.width) / EXPORT.height); // 4:5, as the image
  const art = animatePicture(s.mode === 'sky' ? 'constellation' : 'polaroid', { photos: s.pics.map((p) => p.img), seed }, w, h);
  return { w, h, from: ARRIVE.t0 + ARRIVE.piece, end: art.end, draw: art.draw }; // from the first piece in place
}

async function renderGif(onProgress) {
  const s = scene;
  const a = gifAnimation();
  const c = makeCanvas(a.w, a.h);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  const span = a.end - a.from;
  const n = Math.max(2, Math.round(Math.min(span, GIF_MAX_MS) / (GIF_FRAME_CS * 10)) + 1);
  const pixels = (k) => { a.draw(g, a.from + (span * k) / (n - 1)); return g.getImageData(0, 0, a.w, a.h).data; };
  // One palette for the whole loop, from frames across it (so pieces fading in get their in-between
  // colors too, not only the finished picture's).
  const samples = Array.from({ length: 8 }, (_, i) => pixels(Math.round((i * (n - 1)) / 7)));
  const gif = new GifEncoder(a.w, a.h, buildPalette(samples));
  for (let k = 0; k < n; k++) {
    if (scene !== s) throw new Error('the scene was rebuilt');
    gif.addFrame(pixels(k), k === n - 1 ? GIF_HOLD_CS : GIF_FRAME_CS);
    onProgress((k + 1) / n);
    await new Promise((r) => setTimeout(r)); // let the page breathe between frames
  }
  return new Blob([gif.finish()], { type: 'image/gif' });
}

$('export-gif').addEventListener('click', async () => {
  if (gifBusy) return;
  const button = $('export-gif');
  const name = `fanwall-${fileSlug(data.cosplayer.name)}.gif`, title = t('reveal.thankYou', { name: data.cosplayer.name });
  if (gifScene === scene && gifBlob) {
    closeSaveMenu();
    await saveOrShare(gifBlob, name, title);
    return;
  }
  gifBusy = true;
  button.disabled = true;
  const s = scene;
  try {
    const blob = await renderGif((p) => setText(button, 'reveal.save.gifMaking', { pct: Math.round(p * 100) }));
    gifBlob = blob; gifScene = s;
    // Phones only open the share sheet right after a tap. When that moment has passed, keep the file
    // and ask for one more tap.
    if (navigator.userActivation && !navigator.userActivation.isActive && matchMedia('(pointer: coarse)').matches) {
      toast(t('reveal.toast.gifReady'));
    } else {
      closeSaveMenu();
      await saveOrShare(blob, name, title);
    }
  } catch (err) {
    console.error(err);
    toast(t('reveal.toast.gifFailed'), { error: true });
  } finally {
    gifBusy = false;
    button.disabled = false;
    setText(button, 'reveal.save.gif');
  }
});

// Save: a small menu above the button, with the image and the GIF.
function closeSaveMenu() {
  $('save-options').hidden = true;
  $('save-toggle').setAttribute('aria-expanded', 'false');
}
$('save-toggle').addEventListener('click', () => {
  const open = $('save-options').hidden;
  $('save-options').hidden = !open;
  $('save-toggle').setAttribute('aria-expanded', String(open));
  if (open) $('export').focus();
});
document.addEventListener('click', (e) => { if (!e.target.closest('#save-menu')) closeSaveMenu(); });
$('save-menu').addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || $('save-options').hidden) return;
  e.stopPropagation();
  closeSaveMenu();
  $('save-toggle').focus();
});

// ---------- manage ----------
let dirty = false;
// "Only my favorites": the picture, Save image, and the download show just the starred items. A
// convenience remembered on this device only; it has no effect while nothing visible is starred.
const FAV_KEY = `fanwall:favorites-only:${token}`;
let favoritesOnly = (() => { try { return localStorage.getItem(FAV_KEY) === '1'; } catch { return false; } })();
const favOn = () => favoritesOnly && Boolean(data?.items.some((i) => i.favorite && !i.hidden));
const shown = (i) => !i.hidden && (!favOn() || i.favorite);
const describe = (item) => (item.message
  ? t('reveal.what.note', { text: `${Array.from(item.message).slice(0, 40).join('')}${Array.from(item.message).length > 40 ? '…' : ''}` })
  : t('reveal.what.photo'));

function itemRow(item) {
  const what = describe(item);
  return el('li', { class: item.hidden ? 'is-hidden' : '', 'data-id': item.id },
    item.thumbUrl
      ? el('button', { type: 'button', class: 'thumb', 'aria-label': t('reveal.row.openLabel', { what }), onclick: () => openItem(item) },
        el('img', { src: item.thumbUrl, alt: '', loading: 'lazy' }))
      : null,
    el('div', { class: 'text' },
      el('div', { text: item.message || t('reveal.row.photo') }),
      item.name ? el('div', { class: 'who', text: t('reveal.from', { name: item.name }) }) : null,
      item.hidden || item.edit || item.favorite
        ? el('div', {
          class: 'who',
          text: [item.favorite && t('reveal.row.favorite'), item.hidden && t('reveal.row.hidden'), item.edit && t('reveal.row.edited')].filter(Boolean).join(' · '),
        })
        : null),
    el('div', { class: 'acts' },
      item.fullUrl
        ? el('button', { type: 'button', 'data-act': 'edit', text: t('reveal.row.edit'), 'aria-label': t('reveal.row.editLabel', { what }), onclick: () => editPhoto(item) })
        : null,
      el('button', {
        type: 'button', class: 'star', 'data-act': 'fav', text: item.favorite ? '★' : '☆', 'aria-pressed': String(Boolean(item.favorite)),
        'aria-label': t('reveal.row.favLabel', { what }), onclick: () => setFavorite(item, !item.favorite),
      }),
      el('button', {
        type: 'button', 'data-act': 'hide', text: t(item.hidden ? 'reveal.row.show' : 'reveal.row.hide'),
        'aria-label': t(item.hidden ? 'reveal.row.showLabel' : 'reveal.row.hideLabel', { what }), onclick: () => setHidden(item, !item.hidden),
      }),
      el('button', { type: 'button', class: 'danger', text: t('common.delete'), 'aria-label': t('reveal.row.deleteLabel', { what }), onclick: () => deleteItem(item) })));
}

// The ZIP's own words (gallery page, messages.txt) are in the page language, and its date is on this
// device's calendar. With "only my favorites" on, it holds just the starred items.
const zipUrl = () => `/api/reveal/${encodeURIComponent(token)}/download.zip?lang=${encodeURIComponent(lang)}&tz=${new Date().getTimezoneOffset()}${favOn() ? '&only=favorites' : ''}`;
const canDownload = () => !STATIC && !PREVIEW && data?.ready && data.items.some(shown); // the ZIP is built by the server

function renderManage(focusId = null, focusAct = 'hide') {
  const items = data.items ?? [];
  $('items').replaceChildren(...(items.length ? items.map(itemRow) : [el('li', { class: 'muted', text: t('reveal.manage.empty') })]));
  $('fav-row').hidden = !items.some((i) => i.favorite && !i.hidden);
  $('fav-only').checked = favOn();
  $('download-row').hidden = !canDownload();
  $('download').href = zipUrl();
  $('optout-confirm').hidden = true;
  $('optout-start').hidden = false;
  renderSaved();
  if (focusId) $('items').querySelector(`li[data-id="${CSS.escape(focusId)}"] [data-act="${focusAct}"]`)?.focus();
}

// "Saved until", on the intro card and at the top of Manage. The server sends when the first item
// that isn't hidden will be deleted; the date shown is the day before, so it names the last whole
// day that is still safe. No countdown: in the final week the line only stands out more, with a
// download next to it.
const DAY = 86400e3;
const SOON_MS = 7 * DAY;
function renderSaved() {
  const until = data?.ready ? data.savedUntil ?? null : null;
  const soon = until !== null && until - Date.now() <= SOON_MS;
  for (const line of [$('intro-saved'), $('manage-saved')]) {
    line.hidden = until === null;
    if (until === null) continue;
    line.classList.toggle('soon', soon);
    line.querySelector('.saved-text').textContent = t('reveal.saved.until', { date: formatDate(Math.max(until - DAY, Date.now())) });
    const dl = line.querySelector('.saved-dl');
    dl.hidden = !soon || !canDownload();
    dl.href = zipUrl();
  }
}
const takeSavedUntil = (res) => { if (res && 'savedUntil' in res) data.savedUntil = res.savedUntil; };

// Calendar reminders, made on this device in the page language (no email asked, nothing sent): the
// year in review in early December, and, when there's a deletion date, a nudge to download a few
// days before it. The page's own link never goes in: it's private, and calendars sync to clouds.
const localDay = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
$('remind').addEventListener('click', () => {
  const today = localDay(Date.now());
  const reviewUrl = new URL(STATIC ? 'review/' : '/review', document.baseURI).href;
  const events = [{
    uid: `fanwall-review-${nextDecember(today)}@fanwall`, date: nextDecember(today),
    summary: t('reveal.remind.reviewTitle'), description: t('reveal.remind.reviewText', { url: reviewUrl }), url: reviewUrl,
  }];
  if (data?.savedUntil) {
    const before = localDay(Math.max(Date.now(), data.savedUntil - 4 * DAY));
    events.push({
      uid: `fanwall-download-${hashSeed(`${data.event.name}\u0000${data.cosplayer.name}`)}@fanwall`, date: before,
      summary: t('reveal.remind.downloadTitle', { event: data.event.name }),
      description: t('reveal.remind.downloadText', { date: formatDate(Math.max(data.savedUntil - DAY, Date.now())) }),
    });
  }
  downloadBlob(new Blob([makeIcs(events)], { type: 'text/calendar' }), 'fanwall-reminders.ics');
});

// From the lightbox (reopen: back to it afterwards) or from a Manage row.
function editPhoto(item, { reopen = false } = {}) {
  openEditor({ load: () => loadBitmap(item.fullUrl), edit: item.edit }, {
    save: async (edit) => (await api(`/api/reveal/${encodeURIComponent(token)}/items/${encodeURIComponent(item.id)}/edit`, { method: 'POST', json: { edit } })).edit,
    onClose: (saved, edit) => {
      if (saved) { item.edit = edit; itemsChanged(); toast(t('reveal.toast.editSaved')); }
      if (reopen) openItem(item);
      else if ($('manage').open) renderManage(item.id, 'edit');
    },
  });
}

// Stars: private to the cosplayer. With "only my favorites" on, a star changes what's shown.
async function setFavorite(item, favorite) {
  try {
    const res = await api(`/api/reveal/${encodeURIComponent(token)}/items/${encodeURIComponent(item.id)}`, { method: 'POST', json: { favorite } });
    item.favorite = res.favorite ?? favorite;
    if (favoritesOnly) dirty = true;
    renderManage(item.id, 'fav');
  } catch (err) {
    toast(err.message, { error: true });
  }
}

$('fav-only').addEventListener('change', (e) => {
  favoritesOnly = e.target.checked;
  try { localStorage.setItem(FAV_KEY, favoritesOnly ? '1' : ''); } catch {}
  dirty = true;
  renderManage();
});

async function setHidden(item, hidden) {
  try {
    const res = await api(`/api/reveal/${encodeURIComponent(token)}/items/${encodeURIComponent(item.id)}`, { method: 'POST', json: { hidden } });
    item.hidden = hidden;
    takeSavedUntil(res);
    dirty = true;
    renderManage(item.id);
  } catch (err) {
    toast(err.message, { error: true });
  }
}

async function deleteItem(item) {
  if (!confirm(t(item.message ? 'reveal.confirmDelete.note' : 'reveal.confirmDelete.photo'))) return;
  const i = data.items.indexOf(item);
  try {
    const res = await api(`/api/reveal/${encodeURIComponent(token)}/items/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
    data.items.splice(i, 1);
    takeSavedUntil(res);
    dirty = true;
    renderManage(data.items[Math.min(i, data.items.length - 1)]?.id);
    toast(t('common.deleted'));
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
    data = { ...data, ready: false, optOut: true, items: [], baseUrl: null, savedUntil: null };
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
// title and text are [key, vars] pairs for the catalogs.
function intro([titleKey, titleVars], [textKey, textVars], eventName = '') {
  $('intro-event').textContent = eventName;
  setText($('intro-title'), titleKey, titleVars);
  setText($('intro-text'), textKey, textVars);
  renderSaved();
}

function fillSummary(visible, what) {
  const notes = visible.filter((i) => i.message);
  setText($('sr-summary'), visible.length ? `reveal.sr.${what}` : '');
  $('sr-list').replaceChildren(...notes.map((n) => el('li', { text: n.name ? `${n.message} (${n.name})` : n.message })));
}

// Never show a count: cosplayers at the same event compare screenshots, and a number turns the
// reveal into a scoreboard. Say what kind of things arrived, not how many.
const kinds = (photos, notes) => (photos && notes ? 'both' : photos ? 'photos' : 'notes');

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
  intro(['reveal.closed.title'], ['reveal.closed.text'], data.event.name);
}

// Builds (or rebuilds, after Manage changes) the scene from the items that aren't hidden.
async function showReady() {
  const name = data.cosplayer.name;
  const visible = data.items.filter(shown);
  const what = kinds(visible.some((i) => i.thumbUrl), visible.some((i) => i.message));
  fillSummary(visible, what);
  setText($('caption-sub'), `reveal.caption.${what}`, { event: data.event.name });
  setText($('intro-manage'), 'reveal.manage.open');
  $('intro-manage').hidden = false;
  resetExport();

  if (!visible.length) {
    stopPlayback();
    freeScene(scene);
    scene = null;
    $('play').hidden = true;
    intro(['reveal.for', { name }], [data.items.length ? 'reveal.allHidden' : 'reveal.nothingYet'], data.event.name);
    return;
  }

  const wasRunning = running;
  const button = $('play');
  if (!wasRunning) {
    intro(['reveal.for', { name }], [`reveal.intro.${what}`, { event: data.event.name }], data.event.name);
    button.hidden = false;
    button.disabled = true;
  } else {
    toast(t('reveal.toast.updating'));
  }
  try {
    const next = await prepare(wasRunning ? () => {} : (p) => setText(button, 'reveal.preparingPct', { pct: Math.round(clamp(p, 0, 1) * 100) }));
    const old = scene;
    scene = next;
    computeLayout();
    freeScene(old);
    $('save-menu').hidden = !canSave();
    closeSaveMenu();
    canvas.setAttribute('data-i18n-aria-label', `reveal.stage.${styleOf(data.event)}`);
    canvas.setAttribute('aria-label', t(`reveal.stage.${styleOf(data.event)}`));
    if (running) { play({ fromEnd: true }); toast(t('reveal.toast.updated')); }
    else {
      setText(button, reduceMotion.matches ? 'reveal.show' : 'reveal.play');
      button.disabled = false;
      button.focus();
    }
  } catch (err) {
    console.error(err);
    if (wasRunning) toast(t('reveal.toast.updateFailed'), { error: true });
    else setText(button, 'reveal.prepareFailed');
  }
}

// A language switch: notes are drawn on the canvas with the page's font stack, which follows the
// language, so redraw them. Everything set with setText follows by itself.
onLangChange(() => {
  if (scene) computeLayout();
  if ($('manage').open) renderManage();
  else renderSaved();
});

try {
  data = await api(dataPath);
  seed = data.seed ?? token;
  await useEventLang(data.event.lang);
  if (PREVIEW) {
    // Nothing on this page may change the cosplayer's page: their controls stay hidden here.
    document.body.classList.add('previewing');
    setText($('preview-chip'), 'reveal.preview.chip', { name: data.cosplayer.name });
    $('preview-chip').hidden = false;
  }
} catch (err) {
  if (err instanceof TypeError) intro(['offline.title'], ['offline.text']);
  else intro(['reveal.invalid.title'], ['reveal.invalid.text']);
}

if (data?.optOut) {
  showClosed();
} else if (data && !data.ready) {
  intro(['reveal.notReady.title'], ['reveal.notReady.text'], data.event.name);
  // Closing the page is allowed before release: someone may not want fan photos at all.
  setText($('intro-manage'), 'reveal.manage.closeOnly');
  $('intro-manage').hidden = false;
} else if (data) {
  setTitle('reveal.docTitleFor', { name: data.cosplayer.name });
  setText($('caption-title'), 'reveal.thankYou', { name: data.cosplayer.name });
  await showReady();
}
