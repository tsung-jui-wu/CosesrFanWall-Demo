import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { GifEncoder, buildPalette } from '../public/js/gif.js';

const W = 97, H = 61;
// A gradient, with a red square moving across it from the second frame on.
function frame(f) {
  const px = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const sq = f > 0 && x >= 10 * f && x < 10 * f + 20 && y >= 10 && y < 30;
      px.set(sq ? [255, 0, 0, 255] : [Math.floor((x * 255) / W), Math.floor((y * 255) / H), 128, 255], i);
    }
  }
  return px;
}
const maxError = (a, aStride, b) => {
  let m = 0;
  for (let p = 0; p < W * H; p++) for (let c = 0; c < 3; c++) m = Math.max(m, Math.abs(a[p * aStride + c] - b[p * 4 + c]));
  return m;
};

test('a palette has at most 255 colors, keeps the colors it is given, and has a gray in between', () => {
  assert.equal(buildPalette([frame(1)]).length / 3, 255);
  // (16 and 214 are levels the 5-bit histogram keeps exactly.)
  const two = new Uint8Array(400).map((_, i) => (i % 4 === 3 ? 255 : i < 200 ? 16 : 214));
  const pal = Array.from(buildPalette([two]));
  const colors = Array.from({ length: pal.length / 3 }, (_, i) => pal.slice(i * 3, i * 3 + 3).join());
  assert.ok(colors.length < 255);
  for (const c of ['16,16,16', '214,214,214', '128,128,128']) assert.ok(colors.includes(c), c);
});

test('frames read back with another decoder, looping, with repeats merged into one longer frame', async () => {
  const frames = [0, 1, 2, 3].map(frame);
  const gif = new GifEncoder(W, H, buildPalette(frames));
  for (const f of frames) gif.addFrame(f, 10);
  gif.addFrame(frames[3], 10); // nothing changed: the last frame shows for longer instead
  const bytes = gif.finish();
  assert.equal(Buffer.from(bytes.subarray(0, 6)).toString(), 'GIF89a');
  assert.equal(bytes.at(-1), 0x3b);

  const meta = await sharp(bytes, { animated: true }).metadata();
  assert.equal(meta.pages, 4);
  assert.deepEqual(meta.delay, [100, 100, 100, 200]);
  assert.equal(meta.loop, 0);

  // Later frames store only what changed; the decoded frames still match the whole picture.
  const { data, info } = await sharp(bytes, { animated: true }).raw().toBuffer({ resolveWithObject: true });
  const page = W * H * info.channels;
  frames.forEach((f, i) => assert.ok(maxError(data.subarray(i * page), info.channels, f) <= 24, `frame ${i}`));
});

test('a frame with many colors survives the 4096-code table resets', async () => {
  const N = 300;
  let s = 7;
  const noise = new Uint8Array(N * N * 4).map((_, i) => (i % 4 === 3 ? 255 : (s = (s * 1103515245 + 12345) >>> 0) >>> 24));
  const gif = new GifEncoder(N, N, buildPalette([noise]));
  gif.addFrame(noise, 5);
  const { data, info } = await sharp(gif.finish()).raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, N);
  // Random colors land on the nearest of 255; what matters is that every pixel decoded in place.
  let total = 0;
  for (let p = 0; p < N * N; p++) for (let c = 0; c < 3; c++) total += Math.abs(data[p * info.channels + c] - noise[p * 4 + c]);
  assert.ok(total / (N * N * 3) < 24, `mean error ${total / (N * N * 3)}`);
});
