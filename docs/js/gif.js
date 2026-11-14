// Animated GIF encoding for Save GIF on the reveal page. Pure and DOM-free (tested under node --test):
// frames come in as RGBA pixels, the file comes out as bytes. One shared palette of up to 255 colors
// (median cut) with index 255 kept for "unchanged": each frame after the first stores only the box of
// pixels that changed, and inside it the unchanged ones are transparent, so the still parts of an
// animation cost almost nothing. Colors are mapped with a 4x4 ordered dither, which depends only on a
// pixel's position, so a pixel that doesn't change on screen doesn't flicker between frames either.

const TRANSPARENT = 255;
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const DITHER = 10; // the dither's reach, in 0..255 levels

const key15 = (r, g, b) => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);

// Up to `max` colors (r, g, b triplets) for the given RGBA buffers: a coarse 3x3x3 cube, so a rare
// color (a piece half faded in) always has a near neighbor instead of snapping to some photo's color,
// and the rest by median cut over a 15-bit histogram. Fully transparent pixels are skipped.
const CUBE = [0, 128, 255].flatMap((r) => [0, 128, 255].flatMap((g) => [0, 128, 255].map((b) => [r, g, b]))).flat();
export function buildPalette(buffers, max = 255) {
  const cut = medianCut(buffers, max - CUBE.length / 3);
  const pal = new Uint8Array(cut.length + CUBE.length);
  pal.set(cut);
  pal.set(CUBE, cut.length);
  return pal;
}

function medianCut(buffers, max) {
  const hist = new Uint32Array(32768);
  for (const px of buffers) {
    for (let i = 0; i < px.length; i += 4) if (px[i + 3]) hist[key15(px[i], px[i + 1], px[i + 2])]++;
  }
  const colors = [];
  for (let k = 0; k < hist.length; k++) if (hist[k]) colors.push(k);
  if (!colors.length) colors.push(0);
  const ch = (k, c) => (k >> (10 - 5 * c)) & 31; // channel c (0 r, 1 g, 2 b) of a 15-bit key
  const boxOf = (list) => {
    const lo = [31, 31, 31], hi = [0, 0, 0];
    let count = 0;
    for (const k of list) {
      for (let c = 0; c < 3; c++) { const v = ch(k, c); if (v < lo[c]) lo[c] = v; if (v > hi[c]) hi[c] = v; }
      count += hist[k];
    }
    const span = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
    const axis = span.indexOf(Math.max(...span));
    return { list, count, axis, span: span[axis] };
  };
  const boxes = [boxOf(colors)];
  while (boxes.length < max) {
    // Split the box with the widest side, weighted gently by how many pixels it covers (so a big
    // plain background doesn't take the colors a photo needs), at its weighted median.
    let best = -1, score = 0;
    boxes.forEach((b, i) => { const s = b.span * Math.sqrt(b.count); if (b.list.length > 1 && s > score) { score = s; best = i; } });
    if (best < 0) break;
    const { list, axis, count } = boxes[best];
    list.sort((a, b) => ch(a, axis) - ch(b, axis));
    let seen = 0, cut = 1;
    for (; cut < list.length; cut++) { seen += hist[list[cut - 1]]; if (seen >= count / 2) break; }
    boxes.splice(best, 1, boxOf(list.slice(0, cut)), boxOf(list.slice(cut)));
  }
  const pal = new Uint8Array(boxes.length * 3);
  boxes.forEach((b, i) => {
    let r = 0, g = 0, bl = 0;
    for (const k of b.list) { const n = hist[k] || 1; r += ch(k, 0) * n; g += ch(k, 1) * n; bl += ch(k, 2) * n; }
    const n = b.list.reduce((s, k) => s + (hist[k] || 1), 0);
    pal.set([r, g, bl].map((v) => Math.round(((v / n) * 255) / 31)), i * 3);
  });
  return pal;
}

class Bytes {
  constructor() { this.chunks = []; this.buf = new Uint8Array(1 << 16); this.n = 0; }
  byte(b) { if (this.n === this.buf.length) this.flush(); this.buf[this.n++] = b; }
  word(w) { this.byte(w & 255); this.byte((w >> 8) & 255); }
  bytes(arr, len = arr.length) { for (let i = 0; i < len; i++) this.byte(arr[i]); }
  flush() { if (this.n) this.chunks.push(this.buf.slice(0, this.n)); this.n = 0; }
  result() {
    this.flush();
    const out = new Uint8Array(this.chunks.reduce((s, c) => s + c.length, 0));
    let o = 0;
    for (const c of this.chunks) { out.set(c, o); o += c.length; }
    return out;
  }
}

// GIF's LZW with 8-bit symbols, packed into 255-byte sub-blocks.
function lzw(out, idx) {
  const MIN = 8, CLEAR = 256, EOI = 257, HSIZE = 5003;
  const htab = new Int32Array(HSIZE).fill(-1), ctab = new Int32Array(HSIZE);
  const block = new Uint8Array(255);
  let size = MIN + 1, next = EOI + 1, acc = 0, bits = 0, bl = 0;
  const emit = (code) => {
    acc |= code << bits;
    bits += size;
    while (bits >= 8) {
      block[bl++] = acc & 255; acc >>>= 8; bits -= 8;
      if (bl === 255) { out.byte(255); out.bytes(block); bl = 0; }
    }
  };
  out.byte(MIN);
  emit(CLEAR);
  let prefix = idx[0];
  for (let i = 1; i < idx.length; i++) {
    const c = idx[i];
    const key = (c << 12) | prefix;
    let h = key % HSIZE;
    while (htab[h] !== -1 && htab[h] !== key) h = h + 1 === HSIZE ? 0 : h + 1;
    if (htab[h] === key) { prefix = ctab[h]; continue; }
    emit(prefix);
    if (next === 4096) { emit(CLEAR); htab.fill(-1); size = MIN + 1; next = EOI + 1; }
    else { if (next >= 1 << size) size++; htab[h] = key; ctab[h] = next++; }
    prefix = c;
  }
  emit(prefix);
  emit(EOI);
  if (bits > 0) block[bl++] = acc & 255;
  if (bl) { out.byte(bl); out.bytes(block, bl); }
  out.byte(0);
}

export class GifEncoder {
  // palette: r, g, b triplets, at most 255 colors (index 255 is "unchanged").
  constructor(width, height, palette) {
    if (palette.length > 255 * 3) throw new Error('GifEncoder: at most 255 colors');
    Object.assign(this, { width, height, palette });
    this.cache = new Int16Array(32768).fill(-1); // 15-bit color -> nearest palette index
    this.shown = null; // palette indices of what's on screen after the frames so far
    this.pending = null; // the last frame, held back in case the next one is the same and extends it
    this.out = new Bytes();
    const out = this.out;
    out.bytes([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]); // GIF89a
    out.word(width); out.word(height);
    out.byte(0xf7); out.byte(0); out.byte(0); // a 256-entry global table
    const table = new Uint8Array(768);
    table.set(palette);
    out.bytes(table);
    out.bytes([0x21, 0xff, 11, ...Array.from('NETSCAPE2.0', (ch) => ch.charCodeAt(0)), 3, 1, 0, 0, 0]); // loop forever
  }

  nearest(r, g, b) {
    const k = key15(r, g, b);
    let i = this.cache[k];
    if (i >= 0) return i;
    const R = ((k >> 10) << 3) + 4, G = (((k >> 5) & 31) << 3) + 4, B = ((k & 31) << 3) + 4;
    const p = this.palette;
    let best = Infinity;
    for (let j = 0; j < p.length; j += 3) {
      const dr = p[j] - R, dg = p[j + 1] - G, db = p[j + 2] - B;
      const d = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
      if (d < best) { best = d; i = j / 3; }
    }
    this.cache[k] = i;
    return i;
  }

  // rgba: width * height * 4 bytes. delay in hundredths of a second.
  addFrame(rgba, delay) {
    const { width: w, height: h } = this;
    const idx = new Uint8Array(w * h);
    const clamp8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
    for (let y = 0, p = 0; y < h; y++) {
      for (let x = 0; x < w; x++, p++) {
        const d = (BAYER[((y & 3) << 2) | (x & 3)] / 16 - 0.47) * DITHER;
        const q = p * 4;
        idx[p] = this.nearest(clamp8(rgba[q] + d), clamp8(rgba[q + 1] + d), clamp8(rgba[q + 2] + d));
      }
    }
    if (!this.shown) {
      this.shown = idx;
      this.hold({ x: 0, y: 0, w, h, idx, delay });
      return;
    }
    // The box that changed.
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0, p = 0; y < h; y++) {
      for (let x = 0; x < w; x++, p++) {
        if (idx[p] !== this.shown[p]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; y1 = y; }
      }
    }
    if (x1 < 0) { this.pending.delay += delay; return; }
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    const part = new Uint8Array(bw * bh);
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const p = (y0 + y) * w + x0 + x;
        part[y * bw + x] = idx[p] === this.shown[p] ? TRANSPARENT : idx[p];
      }
    }
    this.shown = idx;
    this.hold({ x: x0, y: y0, w: bw, h: bh, idx: part, delay });
  }

  hold(frame) {
    if (this.pending) this.write(this.pending);
    this.pending = frame;
  }

  write({ x, y, w, h, idx, delay }) {
    const out = this.out;
    // Graphic control: leave the frame in place, index 255 transparent.
    out.bytes([0x21, 0xf9, 4, 0b00000101]);
    out.word(Math.min(65535, Math.max(2, Math.round(delay))));
    out.byte(TRANSPARENT); out.byte(0);
    out.byte(0x2c);
    out.word(x); out.word(y); out.word(w); out.word(h);
    out.byte(0);
    lzw(out, idx);
  }

  // The finished file.
  finish() {
    if (this.pending) this.write(this.pending);
    this.pending = null;
    this.out.byte(0x3b);
    return this.out.result();
  }
}
