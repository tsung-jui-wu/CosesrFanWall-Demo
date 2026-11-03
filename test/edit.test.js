import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEdit, isIdentity, EditError, EMPTY_EDIT, rotatedSize, cropRect, colorOps, applyColor, analyze } from '../public/js/edit.js';
import { mulberry32 } from '../public/js/mosaic.js';

// RGBA pixels from a per-pixel color function.
function image(n, color) {
  const px = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) px.set([...color(i), 255], i * 4);
  return px;
}
const mean = (px, ch) => { let s = 0; for (let p = ch; p < px.length; p += 4) s += px[p]; return s / (px.length / 4); };
const luma = (px) => 0.2126 * mean(px, 0) + 0.7152 * mean(px, 1) + 0.0722 * mean(px, 2);
const autoEdit = (px, s = 1) => normalizeEdit({ auto: { s, ...analyze(px) } });
const applied = (px, edit) => applyColor(Uint8Array.from(px), 4, colorOps(edit));

test('normalizeEdit: nothing to do is null, and the result always has every field', () => {
  assert.equal(normalizeEdit(null), null);
  assert.equal(normalizeEdit({}), null);
  assert.equal(normalizeEdit({ ...EMPTY_EDIT }), null);
  assert.equal(normalizeEdit({ crop: { ratio: null, zoom: 1, cx: 0.2, cy: 0.9 } }), null, 'a full-photo crop is no crop');
  assert.equal(normalizeEdit({ auto: { s: 0, wb: [1, 1, 1], lo: 0, hi: 1, gamma: 1, vib: 0 } }), null, 'Auto at 0%');
  const e = normalizeEdit({ rot: 90, exposure: 0.3 });
  assert.deepEqual(e, { ...EMPTY_EDIT, rot: 90, exposure: 0.3 });
  assert.equal(isIdentity(e), false);
});

test('normalizeEdit rejects bad shapes and clamps out-of-range numbers', () => {
  for (const bad of [[], 'x', 5, { rot: 45 }, { rot: '90' }, { exposure: '1' }, { exposure: NaN }, { crop: 'square' },
    { crop: { zoom: Infinity } }, { auto: { s: 1 } }, { auto: { s: 1, wb: [1, 1], lo: 0, hi: 1, gamma: 1, vib: 0 } }]) {
    assert.throws(() => normalizeEdit(bad), EditError, JSON.stringify(bad));
  }
  const e = normalizeEdit({ exposure: 9, contrast: -9, crop: { ratio: 99, zoom: 0.1, cx: -3, cy: 7 }, junk: 'dropped' });
  assert.equal(e.exposure, 1);
  assert.equal(e.contrast, -1);
  assert.deepEqual(e.crop, { ratio: 4, zoom: 1, cx: 0, cy: 1 });
  assert.equal('junk' in e, false);
  assert.equal(normalizeEdit({ saturation: 0.123456 }).saturation, 0.123, 'stored numbers are rounded');
});

test('rotatedSize swaps sides for quarter turns', () => {
  assert.deepEqual(rotatedSize(400, 300, 0), [400, 300]);
  assert.deepEqual(rotatedSize(400, 300, 90), [300, 400]);
  assert.deepEqual(rotatedSize(400, 300, 180), [400, 300]);
  assert.deepEqual(rotatedSize(400, 300, 270), [300, 400]);
});

test('cropRect: shapes, zoom, and centers that hug the edges', () => {
  const crop = (c) => ({ crop: { ratio: null, zoom: 1, cx: 0.5, cy: 0.5, ...c } });
  assert.deepEqual(cropRect(400, 300, null), { left: 0, top: 0, width: 400, height: 300 });
  assert.deepEqual(cropRect(400, 300, crop({ ratio: 1 })), { left: 50, top: 0, width: 300, height: 300 });
  assert.deepEqual(cropRect(400, 300, crop({ ratio: 1, cx: 1 })), { left: 100, top: 0, width: 300, height: 300 });
  assert.deepEqual(cropRect(400, 300, crop({ zoom: 2, cx: 0, cy: 1 })), { left: 0, top: 150, width: 200, height: 150 });
  assert.deepEqual(cropRect(300, 400, crop({ ratio: 16 / 9 })), { left: 0, top: 116, width: 300, height: 169 });
  // Fuzz: always whole pixels, inside the photo, at least 1x1.
  const rng = mulberry32(7);
  for (let i = 0; i < 2000; i++) {
    const W = 1 + Math.floor(rng() * 3000), H = 1 + Math.floor(rng() * 3000);
    const r = cropRect(W, H, crop({ ratio: 0.25 + rng() * 3.75, zoom: 1 + rng() * 3, cx: rng(), cy: rng() }));
    assert.ok(Object.values(r).every(Number.isInteger));
    assert.ok(r.left >= 0 && r.top >= 0 && r.width >= 1 && r.height >= 1 && r.left + r.width <= W && r.top + r.height <= H, JSON.stringify({ W, H, r }));
  }
});

test('color: no color change means no work, and the sliders move the right way', () => {
  assert.equal(colorOps(null), null);
  assert.equal(colorOps(normalizeEdit({ rot: 90 })), null, 'rotate alone touches no pixels');
  const rng = mulberry32(3);
  const px = image(4000, () => [rng() * 256, rng() * 256, rng() * 256].map(Math.floor));

  const brighter = applied(px, normalizeEdit({ exposure: 0.5 }));
  const darker = applied(px, normalizeEdit({ exposure: -0.5 }));
  assert.ok(luma(brighter) > luma(px) + 10 && luma(darker) < luma(px) - 10);
  const { lut } = colorOps(normalizeEdit({ exposure: 1, contrast: 1 }));
  for (let i = 1; i < 256; i++) assert.ok(lut[i] >= lut[i - 1], 'tone curves never reverse');
  assert.equal(lut[0], 0);
  assert.equal(lut[255], 255, 'exposure and contrast keep pure black and white');

  const warm = applied(px, normalizeEdit({ warmth: 1 }));
  assert.ok(mean(warm, 0) > mean(px, 0) && mean(warm, 2) < mean(px, 2));

  const gray = applied(px, normalizeEdit({ saturation: -1 }));
  for (let p = 0; p < gray.length; p += 4) assert.ok(Math.abs(gray[p] - gray[p + 1]) <= 1 && Math.abs(gray[p + 1] - gray[p + 2]) <= 1);
  for (const v of applied(px, normalizeEdit({ saturation: 1, exposure: 1 }))) assert.ok(v >= 0 && v <= 255);
});

test('auto: brightens a dark, flat, tinted photo and removes most of the tint', () => {
  // A dim scene with a blue cast: gray walls plus a few colored things.
  const rng = mulberry32(11);
  const px = image(6000, (i) => {
    const v = 40 + rng() * 50;
    return i % 5 === 0 ? [v * 1.6, v * 0.5, v * 0.6] : [v * 0.85, v * 0.95, v * 1.2];
  });
  const out = applied(px, autoEdit(px));
  assert.ok(luma(out) > luma(px) * 1.5, `brighter: ${luma(px).toFixed(0)} -> ${luma(out).toFixed(0)}`);
  const cast = (img) => { // blue over red on the gray pixels
    let r = 0, b = 0;
    for (let i = 0; i < img.length / 4; i++) if (i % 5) { r += img[i * 4]; b += img[i * 4 + 2]; }
    return b / r;
  };
  assert.ok(cast(out) < cast(px) - 0.15 && cast(out) > 1, `tint reduced but not overcorrected: ${cast(px).toFixed(2)} -> ${cast(out).toFixed(2)}`);
});

test('auto: leaves a well-exposed photo mostly alone, and a red costume red', () => {
  const rng = mulberry32(5);
  const fine = image(6000, () => { const v = rng() * 255; return [v, v, v]; });
  const out = applied(fine, autoEdit(fine));
  let worst = 0;
  for (let i = 0; i < fine.length; i++) worst = Math.max(worst, Math.abs(out[i] - fine[i]));
  assert.ok(worst <= 16, `largest change ${worst}`);

  // Mostly a saturated red costume: white balance must not read that as a cast.
  const costume = image(6000, (i) => (i % 10 ? [200 + rng() * 40, 30, 40] : [128, 128, 128]));
  const { wb } = analyze(costume);
  assert.ok(wb.every((g) => Math.abs(g - 1) < 0.02), `wb ${wb}`);
});

test('auto strength blends from the original to the full correction', () => {
  const rng = mulberry32(9);
  const px = image(3000, () => { const v = 30 + rng() * 60; return [v, v * 0.9, v * 1.1]; });
  const a = analyze(px);
  const at = (s) => luma(applied(px, normalizeEdit({ auto: { s, ...a } })));
  assert.ok(at(0.25) < at(0.5) && at(0.5) < at(1));
  assert.equal(normalizeEdit({ auto: { s: 0, ...a } }), null);
});
