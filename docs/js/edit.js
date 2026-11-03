// Photo edits, pure and DOM-free: shared by the reveal page (preview, Save photo, mosaic tiles),
// the server (ZIP), and the tests, so every copy of an edited photo comes out the same.
//
// An edit is a small JSON description; the fan's photo file is never changed.
//   rot         0 | 90 | 180 | 270, clockwise, applied first
//   crop        { ratio, zoom, cx, cy } or null. ratio is width / height (null keeps the photo's
//               shape); zoom >= 1 shrinks the crop; cx, cy are its center as 0..1 of the rotated photo
//   auto        { s, wb, lo, hi, gamma, vib } or null. s is the strength (0..1); the rest are measured
//               once by analyze() and stored, so the server never has to re-measure
//   exposure, contrast, warmth, saturation   -1..1, 0 = unchanged

export class EditError extends Error {}

const ROTATIONS = new Set([0, 90, 180, 270]);
const SLIDERS = ['exposure', 'contrast', 'warmth', 'saturation'];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round3 = (v) => Math.round(v * 1000) / 1000;

function num(value, label, lo, hi) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new EditError(`${label} must be a number.`);
  return round3(clamp(value, lo, hi));
}
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

export const EMPTY_EDIT = Object.freeze({ rot: 0, crop: null, auto: null, exposure: 0, contrast: 0, warmth: 0, saturation: 0 });

// Validates untrusted input (it arrives from the browser) and returns a clean copy with every
// field present, or null when the edit changes nothing. Out-of-range numbers are clamped.
export function normalizeEdit(input) {
  if (input === null || input === undefined) return null;
  if (!isObject(input)) throw new EditError('An edit must be an object.');
  const rot = input.rot ?? 0;
  if (!ROTATIONS.has(rot)) throw new EditError('Rotation must be 0, 90, 180, or 270.');
  const out = { ...EMPTY_EDIT, rot };

  if (input.crop != null) {
    const c = input.crop;
    if (!isObject(c)) throw new EditError('Crop must be an object.');
    const ratio = c.ratio == null ? null : num(c.ratio, 'Crop ratio', 0.25, 4);
    const zoom = num(c.zoom ?? 1, 'Crop zoom', 1, 4);
    if (ratio !== null || zoom > 1) out.crop = { ratio, zoom, cx: num(c.cx ?? 0.5, 'Crop center', 0, 1), cy: num(c.cy ?? 0.5, 'Crop center', 0, 1) };
  }

  if (input.auto != null) {
    const a = input.auto;
    if (!isObject(a)) throw new EditError('Auto must be an object.');
    if (!Array.isArray(a.wb) || a.wb.length !== 3) throw new EditError('Auto white balance must be three numbers.');
    const auto = {
      s: num(a.s, 'Auto strength', 0, 1),
      wb: a.wb.map((g) => num(g, 'Auto white balance', 0.8, 1.25)),
      lo: num(a.lo, 'Auto black point', 0, 0.2),
      hi: num(a.hi, 'Auto white point', 0.5, 1),
      gamma: num(a.gamma, 'Auto gamma', 0.5, 2),
      vib: num(a.vib, 'Auto vibrance', 0, 0.5),
    };
    if (auto.s > 0) out.auto = auto;
  }

  for (const k of SLIDERS) out[k] = num(input[k] ?? 0, k[0].toUpperCase() + k.slice(1), -1, 1);
  return isIdentity(out) ? null : out;
}

export function isIdentity(e) {
  return !e || (e.rot === 0 && !e.crop && !e.auto && SLIDERS.every((k) => !e[k]));
}

// ---------- geometry ----------
export const rotatedSize = (w, h, rot) => (rot === 90 || rot === 270 ? [h, w] : [w, h]);

// The crop in whole pixels of the rotated (W x H) photo; always inside it and at least 1x1.
// The largest rectangle of the chosen shape, shrunk by zoom, centered on (cx, cy) as far as it fits.
export function cropRect(W, H, edit) {
  const c = edit?.crop;
  if (!c) return { left: 0, top: 0, width: W, height: H };
  const aspect = c.ratio ?? W / H;
  let w = W, h = H;
  if (W / H > aspect) w = H * aspect; else h = W / aspect;
  const width = clamp(Math.round(w / c.zoom), 1, W), height = clamp(Math.round(h / c.zoom), 1, H);
  const left = clamp(Math.round(c.cx * W - width / 2), 0, W - width);
  const top = clamp(Math.round(c.cy * H - height / 2), 0, H - height);
  return { left, top, width, height };
}

// ---------- color ----------
// Every step except saturation works on one channel at a time, so they fold into a lookup table
// per channel. Saturation mixes channels and runs per pixel after the tables.
export function colorOps(edit) {
  if (!edit || (!edit.auto && SLIDERS.every((k) => !edit[k]))) return null;
  const a = edit.auto, s = a?.s ?? 0;
  const lo = a ? a.lo * s : 0, hi = a ? 1 - (1 - a.hi) * s : 1;
  const gamma = a ? 1 + (a.gamma - 1) * s : 1;
  const expo = 2 ** -edit.exposure; // a power curve: brightens or darkens without clipping black or white
  const warm = [1 + 0.12 * edit.warmth, 1, 1 - 0.12 * edit.warmth];
  const lut = new Uint8Array(768);
  for (let ch = 0; ch < 3; ch++) {
    const wb = a ? 1 + (a.wb[ch] - 1) * s : 1;
    for (let i = 0; i < 256; i++) {
      let v = (i / 255) * wb;
      v = clamp((v - lo) / (hi - lo), 0, 1) ** gamma;
      v **= expo;
      v += edit.contrast * (v * v * (3 - 2 * v) - v); // toward (or away from) a smoothstep S-curve
      lut[ch * 256 + i] = Math.round(clamp(v * warm[ch], 0, 1) * 255);
    }
  }
  return { lut, sat: edit.saturation, vib: a ? a.vib * s : 0 };
}

// In place, on RGB or RGBA bytes (channels = 3 or 4). Works on a plain Uint8Array (sharp's raw
// output), so values are clamped by hand rather than relying on Uint8ClampedArray.
export function applyColor(px, channels, ops) {
  if (!ops) return px;
  const { lut, sat, vib } = ops;
  const mix = sat !== 0 || vib !== 0;
  for (let p = 0; p < px.length; p += channels) {
    let r = lut[px[p]], g = lut[256 + px[p + 1]], b = lut[512 + px[p + 2]];
    if (mix) {
      const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      // Vibrance lifts dull colors more than strong ones, and skin tones (red > green > blue,
      // hue about 10-45 degrees) only a little, so faces don't turn orange.
      const skin = r > g && g > b && g - b >= (r - b) * 0.17 && g - b <= (r - b) * 0.75;
      const k = 1 + sat + vib * (1 - (mx - mn) / 255) * (skin ? 0.35 : 1);
      r = y + (r - y) * k; g = y + (g - y) * k; b = y + (b - y) * k;
    }
    px[p] = r < 0 ? 0 : r > 255 ? 255 : Math.round(r);
    px[p + 1] = g < 0 ? 0 : g > 255 ? 255 : Math.round(g);
    px[p + 2] = b < 0 ? 0 : b > 255 ? 255 : Math.round(b);
  }
  return px;
}

// ---------- auto ----------
// Measures a small copy of the photo (about 256 px is plenty) and returns the auto settings,
// without the strength. Every correction is deliberately partial and capped: event lighting and
// costume colors are often on purpose, and a full correction would make a red costume look wrong.
export function analyze(px, channels = 4) {
  const n = px.length / channels;
  // White balance from near-gray pixels only (skin and costumes are more colorful than the cutoff),
  // so a big saturated costume doesn't count as a cast.
  let gn = 0, gr = 0, gg = 0, gb = 0;
  for (let p = 0; p < px.length; p += channels) {
    const r = px[p], g = px[p + 1], b = px[p + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (y > 15 && y < 240 && mx - mn < 0.3 * mx) { gn++; gr += r; gg += g; gb += b; }
  }
  let wb = [1, 1, 1];
  if (gn >= n * 0.05 && gr && gg && gb) {
    const gray = (gr + gg + gb) / 3;
    wb = [gr, gg, gb].map((sum) => clamp(1 + (gray / sum - 1) * 0.5, 0.88, 1.15));
  }

  // Brightness after white balance: histogram for levels and the median, plus mean colorfulness.
  const hist = new Uint32Array(256);
  let satSum = 0, satN = 0;
  for (let p = 0; p < px.length; p += channels) {
    const r = Math.min(255, px[p] * wb[0]), g = Math.min(255, px[p + 1] * wb[1]), b = Math.min(255, px[p + 2] * wb[2]);
    hist[Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b)]++;
    const mx = Math.max(r, g, b);
    if (mx > 20) { satSum += (mx - Math.min(r, g, b)) / mx; satN++; }
  }
  const pct = (q) => {
    let acc = 0;
    for (let i = 0; i < 256; i++) if ((acc += hist[i]) >= q * n) return i / 255;
    return 1;
  };
  // Stretch at most about 1.7x: more than that mostly amplifies noise in a genuinely dark scene.
  const lo = Math.min(pct(0.005), 0.12), hi = Math.max(pct(0.995), 0.6);
  const mid = clamp((pct(0.5) - lo) / (hi - lo), 0.02, 0.98);
  const gamma = clamp(Math.log(0.47) / Math.log(mid), 0.55, 1.5);
  const vib = clamp((0.4 - (satN ? satSum / satN : 0.4)) * 0.8, 0, 0.3);
  return { wb: wb.map(round3), lo: round3(lo), hi: round3(hi), gamma: round3(gamma), vib: round3(vib) };
}
