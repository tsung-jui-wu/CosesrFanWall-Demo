// The landing page's demo carousel: each reveal style plays on a dark card, then the carousel moves
// on, and a last "More to come" card closes the loop. The photos are made up here, on canvases (no
// real fan photo is ever shown on the landing page, and nothing is fetched). The wall and the sky are
// the same scenes Save GIF plays (render.js animatePicture); the mosaic follows the reveal's fly-in.
// Respects prefers-reduced-motion: the cards show their finished pictures and nothing moves until
// the person presses play.
import { t, onLangChange } from './i18n.js';
import { tileFeature, targetCells, chooseLayout, planMosaic, mulberry32 } from './mosaic.js';
import { animatePicture } from './render.js';
import { makeCanvas, shrinkInto, coverCrop, easeOut } from './art.js';

const track = document.getElementById('demo-track');
const dotsBox = document.getElementById('demo-dots');
const playButton = document.getElementById('demo-play');
const slides = [...track.querySelectorAll('.demo-card')];

const HOLD_MS = 2800; // the finished picture stays this long before the carousel moves on
const MORE_MS = 4500; // how long the "More to come" card stays
const PHOTOS = 150; // small ones, for the mosaic's tiles
const BIG_PHOTOS = 28; // sharp ones for the wall's prints and the sky's stars (each shows a couple dozen at most)
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const reduced = matchMedia('(prefers-reduced-motion: reduce)');

// ---------- made-up photos ----------
// A "photo", drawn on a 3:4 plan 300 wide and scaled to w x h: a gradient in some hue with soft
// out-of-focus lights, and usually a person (head, hair, shoulders) lit from one side. Light and dark
// ones both, so the mosaic has tiles for every part of its picture. The wall and the sky get big ones
// (their photos are cut at 256 px), the mosaic small ones.
function fakePhoto(rng, w, h) {
  const c = makeCanvas(w, h);
  const g = c.getContext('2d');
  g.scale(w / 300, h / 400);
  const hue = rng() * 360, l = 24 + rng() * 54, s = 40 + rng() * 45;
  const col = (dh, ds, dl, a = 1) => `hsl(${(hue + dh + 360) % 360} ${clamp(s + ds, 0, 100)}% ${clamp(l + dl, 4, 96)}% / ${a})`;
  const bg = g.createLinearGradient(0, 0, 300, 400);
  bg.addColorStop(0, col(0, 0, 14));
  bg.addColorStop(1, col(40, 0, -20));
  g.fillStyle = bg;
  g.fillRect(0, 0, 300, 400);
  // Bokeh: soft round lights behind the subject.
  for (let i = 0; i < 9; i++) {
    const x = rng() * 300, y = rng() * 300, r = 14 + rng() * 46;
    const b = g.createRadialGradient(x, y, 0, x, y, r);
    b.addColorStop(0, col(rng() * 80 - 40, 10, 30, 0.55));
    b.addColorStop(0.7, col(rng() * 80 - 40, 10, 25, 0.25));
    b.addColorStop(1, col(0, 0, 0, 0));
    g.fillStyle = b;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  if (rng() < 0.75) {
    const x = 110 + rng() * 80, y = 150 + rng() * 40, k = 0.85 + rng() * 0.35;
    const oh = (hue + 150 + rng() * 60) % 360, os = 30 + rng() * 50, ol = 14 + rng() * 26;
    const outfit = g.createLinearGradient(-110, 0, 110, 0); // lit from the left (in the figure's own units)
    outfit.addColorStop(0, `hsl(${oh} ${os}% ${ol + 14}%)`);
    outfit.addColorStop(1, `hsl(${oh} ${os}% ${Math.max(6, ol - 8)}%)`);
    const hair = `hsl(${rng() * 360} ${rng() < 0.5 ? 60 : 15}% ${10 + rng() * 50}%)`;
    g.save();
    g.translate(x, y);
    g.scale(k, k);
    g.fillStyle = outfit; // shoulders
    g.beginPath();
    g.moveTo(-110, 260);
    g.bezierCurveTo(-105, 150, -70, 115, 0, 112);
    g.bezierCurveTo(70, 115, 105, 150, 110, 260);
    g.closePath();
    g.fill();
    g.fillStyle = '#e9c3a6'; // neck and face
    g.fillRect(-16, 70, 32, 46);
    g.beginPath();
    g.ellipse(0, 40, 40, 48, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = hair;
    g.beginPath();
    g.ellipse(0, 22, 46, 40, 0, Math.PI, Math.PI * 2);
    g.lineTo(46, 70);
    g.quadraticCurveTo(38, 40, 30, 18);
    g.lineTo(-30, 18);
    g.quadraticCurveTo(-38, 40, -46, 70);
    g.closePath();
    g.fill();
    g.restore();
  }
  const v = g.createRadialGradient(150, 200, 120, 150, 200, 280); // a soft vignette
  v.addColorStop(0, 'rgba(0, 0, 0, 0)');
  v.addColorStop(1, 'rgba(0, 0, 0, 0.32)');
  g.fillStyle = v;
  g.fillRect(0, 0, 300, 400);
  return c;
}

// The mosaic's picture: a pink heart on a dusk sky over a stage, like the demo seed's booth image.
function fakePicture() {
  const c = makeCanvas(480, 300);
  const g = c.getContext('2d');
  g.scale(0.3, 0.3); // drawn on a 1600 x 1000 plan
  const sky = g.createLinearGradient(0, 0, 0, 1000);
  sky.addColorStop(0, '#1b1446');
  sky.addColorStop(0.6, '#5b2a86');
  sky.addColorStop(1, '#f08a4b');
  g.fillStyle = sky;
  g.fillRect(0, 0, 1600, 1000);
  const rng = mulberry32(7);
  g.fillStyle = '#fff8d6';
  for (let i = 0; i < 40; i++) {
    g.globalAlpha = 0.4 + rng() * 0.6;
    g.beginPath();
    g.arc(rng() * 1600, rng() * 420, 3 + rng() * 6, 0, Math.PI * 2);
    g.fill();
  }
  g.globalAlpha = 1;
  g.fillStyle = '#2a1a12';
  g.fillRect(0, 820, 1600, 180);
  const heart = new Path2D('M800 860 C 380 600 420 250 640 250 C 730 250 780 310 800 360 C 820 310 870 250 960 250 C 1180 250 1220 600 800 860 Z');
  g.fillStyle = '#ff3d7f';
  g.fill(heart);
  g.lineWidth = 14;
  g.strokeStyle = '#ffd1e1';
  g.stroke(heart);
  return c;
}

// ---------- the mosaic, as on the reveal stage ----------
const GHOST_ALPHA = 0.3, FLIGHT_MS = 1000, TINT_MS = 500, MOSAIC_T0 = 1200, MOSAIC_SPREAD = 4200;

function planDemoMosaic(photos, picture) {
  const aspect = picture.width / picture.height;
  const { cols, rows, cells } = chooseLayout(photos.length, aspect);
  const target = makeCanvas(cols * 2, rows * 2);
  shrinkInto(target, picture, 0, 0, picture.width, picture.height, cols * 2, rows * 2);
  const { features, meanRGB } = targetCells(target.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, cols * 2, rows * 2).data, cols, rows);
  const th = 48, tw = clamp(Math.round(th * (picture.width / cols) / (picture.height / rows)), 8, 128);
  const px2 = makeCanvas(2, 2);
  const px2g = px2.getContext('2d', { willReadFrequently: true });
  const tiles = photos.map((img, i) => {
    const tile = makeCanvas(tw, th);
    shrinkInto(tile, img, ...coverCrop(img.width, img.height, tw / th), tw, th);
    shrinkInto(px2, tile, 0, 0, tw, th, 2, 2);
    return { id: String(i), feature: tileFeature(px2g.getImageData(0, 0, 2, 2).data), img: tile };
  });
  const plan = planMosaic({ cols, rows, cellFeatures: features, meanRGB, tiles, seed: 'landing', opts: { cells } });
  const rng = mulberry32(11);
  const fly = plan.cells.map(() => [rng() * 1.2 - 0.1, rng() * 1.2 - 0.1, (rng() - 0.5) * 1.2, 1.8 + rng() * 1.4]);
  return { plan, cols, rows, aspect, picture, fly, imgs: new Map(tiles.map((x) => [x.id, x.img])) };
}

// The mosaic on a W x H card, below `top` px of caption: { end, draw(g, t) }.
function mosaicScene(m, W, H, top) {
  const pad = Math.round(Math.min(W, H) * 0.06);
  const aw = W - 2 * pad, ah = Math.max(10, H - top - pad);
  const rw = Math.min(aw, ah * m.aspect), rh = rw / m.aspect;
  const rect = { x: (W - rw) / 2, y: top + (ah - rh) / 2, w: rw, h: rh };
  const box = (c) => {
    const x0 = Math.round(rect.x + (c.col * rw) / m.cols), x1 = Math.round(rect.x + ((c.col + c.size) * rw) / m.cols);
    const y0 = Math.round(rect.y + (c.row * rh) / m.rows), y1 = Math.round(rect.y + ((c.row + c.size) * rh) / m.rows);
    return [x0, y0, x1 - x0, y1 - y0];
  };
  const start = (c) => MOSAIC_T0 + c.delay * MOSAIC_SPREAD;
  const radius = Math.max(6, Math.round(W * 0.014));
  const landed = (g, c, tint) => {
    const [x, y, w, h] = box(c);
    g.globalAlpha = 1;
    g.drawImage(m.imgs.get(c.tileId), x, y, w, h);
    const a = c.tint.alpha * tint;
    if (a > 0) { g.globalAlpha = a; g.fillStyle = `rgb(${c.tint.rgb.join(',')})`; g.fillRect(x, y, w, h); }
  };
  return {
    end: MOSAIC_T0 + MOSAIC_SPREAD + FLIGHT_MS + TINT_MS,
    draw(g, t) {
      g.fillStyle = '#000';
      g.fillRect(0, 0, W, H);
      const ghost = t < 600 ? (t / 600) * 0.85 : t < 1600 ? 0.85 + (GHOST_ALPHA - 0.85) * ((t - 600) / 1000) : GHOST_ALPHA;
      g.save();
      g.beginPath();
      if (g.roundRect) g.roundRect(rect.x, rect.y, rect.w, rect.h, radius); else g.rect(rect.x, rect.y, rect.w, rect.h);
      g.clip();
      g.globalAlpha = ghost;
      g.drawImage(m.picture, rect.x, rect.y, rect.w, rect.h);
      const flying = [];
      for (const i of m.plan.order) {
        const c = m.plan.cells[i], s = start(c);
        if (t < s) break; // order is sorted by delay
        const p = (t - s) / FLIGHT_MS;
        if (p >= 1) landed(g, c, clamp((t - s - FLIGHT_MS) / TINT_MS, 0, 1));
        else flying.push(i, p);
      }
      g.restore();
      for (let k = 0; k < flying.length; k += 2) {
        const i = flying[k], p = flying[k + 1], e = easeOut(p), c = m.plan.cells[i];
        const [x, y, w, h] = box(c);
        const [sx, sy, rot, scale] = m.fly[i];
        const px = sx * W + (x + w / 2 - sx * W) * e, py = sy * H + (y + h / 2 - sy * H) * e;
        const s = scale + (1 - scale) * e, r = rot * (1 - e);
        g.globalAlpha = clamp(p * 4, 0, 1);
        g.setTransform(Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), px, py);
        g.drawImage(m.imgs.get(c.tileId), (-w * s) / 2, (-h * s) / 2, w * s, h * s);
      }
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalAlpha = 1;
    },
  };
}

// ---------- the carousel ----------
let bigPhotos = null, mosaic = null;
const cards = slides.map((el) => ({ el, style: el.dataset.style || null, canvas: el.querySelector('canvas'), copy: el.querySelector('.demo-copy'), scene: null, W: 0, H: 0, top: 0 }));

function build(card) {
  if (!card.canvas || !mosaic) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = Math.round(card.canvas.clientWidth * dpr), H = Math.round(card.canvas.clientHeight * dpr);
  if (!W || !H) return;
  // The mosaic sits below the card's words, so it moves when they wrap differently (a language
  // switch, the font arriving).
  const top = card.style === 'mosaic' ? Math.round((card.copy.offsetTop + card.copy.offsetHeight) * dpr) : 0;
  if (card.scene && W === card.W && H === card.H && top === card.top) return;
  card.canvas.width = W;
  card.canvas.height = H;
  card.W = W;
  card.H = H;
  card.top = top;
  if (card.style === 'mosaic') {
    card.scene = mosaicScene(mosaic, W, H, top);
  } else {
    card.scene = animatePicture(card.style, { photos: bigPhotos, seed: `landing-${card.style}` }, W, H);
  }
  paint(card, card === cards[active] && playing ? elapsed : Infinity);
}

function paint(card, t) {
  if (!card.scene) return;
  const g = card.canvas.getContext('2d');
  g.imageSmoothingQuality = 'high';
  card.scene.draw(g, t);
}

let active = 0, elapsed = 0, last = null, raf = 0, visible = false, pending = null, pendingTimer = 0;
let playing = !reduced.matches;

const durationOf = (card) => (card.scene ? card.scene.end + HOLD_MS : MORE_MS);

function frame(now) {
  raf = 0;
  if (!playing || !visible || document.hidden) { last = null; return; }
  if (last !== null) elapsed += Math.min(100, now - last); // no leap after a stall
  last = now;
  const card = cards[active];
  paint(card, elapsed);
  if (elapsed >= durationOf(card)) goTo((active + 1) % cards.length);
  raf = requestAnimationFrame(frame);
}
const kick = () => { if (!raf && playing && visible && !document.hidden) raf = requestAnimationFrame(frame); };

function setActive(i) {
  if (i === active) return;
  paint(cards[active], Infinity); // the card leaving keeps its finished picture
  active = i;
  elapsed = 0;
  last = null;
  if (playing) paint(cards[active], 0);
  updateDots();
}

function goTo(i, smooth = true) {
  const el = slides[i];
  pending = i;
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => { pending = null; }, 1500);
  setActive(i);
  track.scrollTo({ left: el.offsetLeft - (track.clientWidth - el.offsetWidth) / 2, behavior: smooth && !reduced.matches ? 'smooth' : 'auto' });
}

// The slide whose middle is nearest the track's middle.
function nearest() {
  const mid = track.scrollLeft + track.clientWidth / 2;
  let best = 0, bestD = Infinity;
  slides.forEach((el, i) => {
    const d = Math.abs(el.offsetLeft + el.offsetWidth / 2 - mid);
    if (d < bestD) { bestD = d; best = i; }
  });
  return best;
}
let scrollRaf = 0;
track.addEventListener('scroll', () => {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    const i = nearest();
    if (pending !== null) { if (i === pending) pending = null; return; } // our own scroll, on its way
    setActive(i);
  });
}, { passive: true });
// The person takes over mid-glide: follow their scroll, not ours.
for (const type of ['pointerdown', 'wheel', 'touchstart', 'keydown']) track.addEventListener(type, () => { pending = null; }, { passive: true });

// Dots, and the play / pause button.
const dots = slides.map((el, i) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'carousel-dot';
  b.addEventListener('click', () => { goTo(i); kick(); });
  dotsBox.append(b);
  return b;
});
function updateDots() {
  dots.forEach((b, i) => {
    b.setAttribute('aria-label', t('landing.demo.goto', { name: t(slides[i].dataset.name) }));
    if (i === active) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
  });
}
function updatePlay() {
  const key = playing ? 'landing.demo.pause' : 'landing.demo.play';
  playButton.dataset.i18nAriaLabel = key;
  playButton.setAttribute('aria-label', t(key));
  playButton.classList.toggle('is-paused', !playing);
}
playButton.addEventListener('click', () => {
  playing = !playing;
  last = null;
  updatePlay();
  kick();
});
onLangChange(() => { updateDots(); updatePlay(); });

// Only run while the carousel is on screen and the tab is showing.
new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; kick(); }, { threshold: 0.25 }).observe(track);
document.addEventListener('visibilitychange', kick);
const resized = new ResizeObserver(() => cards.forEach(build));
resized.observe(track);
for (const card of cards) if (card.style === 'mosaic') resized.observe(card.copy);

updateDots();
updatePlay();

// Make the photos once the page has settled (a few milliseconds of drawing), then draw every card.
setTimeout(() => {
  const rng = mulberry32(2026);
  const small = Array.from({ length: PHOTOS }, () => fakePhoto(rng, 72, 96)); // only needed to plan the mosaic
  bigPhotos = Array.from({ length: BIG_PHOTOS }, () => fakePhoto(rng, 300, 400));
  mosaic = planDemoMosaic(small, fakePicture());
  cards.forEach(build);
  if (playing) paint(cards[active], 0);
  kick();
}, 60);
