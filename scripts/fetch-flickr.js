// Live-data test helper: download photos for one Flickr tag through the official API, skipping
// duplicates (same photo id, or a near-identical image by perceptual hash). For local testing only:
// the photos belong to their owners, so do not commit them or put them in the docs/ demo.
// Usage: FLICKR_API_KEY=... node scripts/fetch-flickr.js <tag> <out folder> [--count 300] [--cc-only]
//   Writes credits.tsv (file, owner, license, page URL) next to the images.
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import sharp from 'sharp';

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    count: { type: 'string', default: '300' },
    'cc-only': { type: 'boolean', default: false },
  },
});
const fail = (msg) => { console.error(msg); process.exit(1); };
const key = process.env.FLICKR_API_KEY ?? fail('Set FLICKR_API_KEY (get one at https://www.flickr.com/services/apps/create/).');
if (positionals.length !== 2) fail('Usage: node scripts/fetch-flickr.js <tag> <out folder> [--count 300] [--cc-only]');
const [tag, outDir] = positionals;
const want = Number(opts.count);
const MAX_DIST = 6; // dHash bits that may differ before two images count as the same

async function api(method, params) {
  const qs = new URLSearchParams({ method, api_key: key, format: 'json', nojsoncallback: '1', ...params });
  const res = await fetch(`https://api.flickr.com/services/rest/?${qs}`);
  const body = await res.json();
  if (body.stat !== 'ok') fail(`Flickr API error: ${body.message ?? res.status}`);
  return body;
}

// 64-bit difference hash: 9x8 grayscale, compare each pixel with its right neighbour.
async function dhash(buf) {
  const px = await sharp(buf).grayscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer();
  let h = 0n;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) h = (h << 1n) | (px[y * 9 + x] > px[y * 9 + x + 1] ? 1n : 0n);
  return h;
}
const dist = (a, b) => { let v = a ^ b, n = 0; while (v) { n += Number(v & 1n); v >>= 1n; } return n; };

await fs.mkdir(outDir, { recursive: true });
const seenIds = new Set();
const hashes = [];
const credits = ['file\towner\tlicense\tpage'];
let saved = 0, dupes = 0;

for (let page = 1; saved < want; page++) {
  const { photos } = await api('flickr.photos.search', {
    tags: tag, sort: 'relevance', media: 'photos', content_type: '1', safe_search: '1',
    per_page: '100', page: String(page), extras: 'url_l,url_c,url_z,owner_name,license',
    ...(opts['cc-only'] ? { license: '1,2,3,4,5,6,9,10' } : {}),
  });
  if (!photos.photo.length || page > photos.pages) break;
  for (const p of photos.photo) {
    if (saved >= want) break;
    if (seenIds.has(p.id)) continue;
    seenIds.add(p.id);
    const url = p.url_l ?? p.url_c ?? p.url_z;
    if (!url) continue;
    const res = await fetch(url);
    if (!res.ok) continue;
    const buf = Buffer.from(await res.arrayBuffer());
    let h;
    try { h = await dhash(buf); } catch { continue; }
    if (hashes.some((o) => dist(o, h) <= MAX_DIST)) { dupes++; continue; }
    hashes.push(h);
    const file = `${String(saved + 1).padStart(3, '0')}_${p.id}.jpg`;
    await fs.writeFile(path.join(outDir, file), buf);
    credits.push([file, p.ownername, p.license, `https://www.flickr.com/photos/${p.owner}/${p.id}`].join('\t'));
    saved++;
    if (saved % 25 === 0) console.log(`${saved}/${want} saved (${dupes} near-duplicates skipped)`);
  }
}

await fs.writeFile(path.join(outDir, 'credits.tsv'), credits.join('\n') + '\n');
console.log(`Done: ${saved} images in ${path.resolve(outDir)}, ${dupes} near-duplicates skipped.`);
if (saved < want) console.log(`Only ${saved} unique photos were available for this tag.`);
