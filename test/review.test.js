import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { streamZip } from '../lib/zip.js';
import { planBundle } from '../lib/bundle.js';
import { openZip, readBundle, BundleError } from '../public/js/bundle-read.js';
import { planReview, NOTES_PER_SPREAD } from '../public/js/review-plan.js';
import { makeIcs, nextDecember } from '../public/js/ics.js';

// Writes entries with the server's own ZIP writer and returns the bytes.
async function zipOf(entries) {
  const out = new PassThrough();
  const chunks = [];
  out.on('data', (c) => chunks.push(c));
  await streamZip(out, entries);
  await new Promise((r) => out.on('end', r));
  return Buffer.concat(chunks);
}
const fileOf = (buf) => ({ kind: 'file', file: new Blob([buf]) });
const rejectsWith = (p, code) => assert.rejects(p, (err) => err instanceof BundleError && err.code === code);

test('round trip: a ZIP written by lib/zip.js reads back byte for byte', async () => {
  const photo = Buffer.alloc(70000, 7); // bigger than the tail the reader scans
  const buf = await zipOf([
    { name: 'manifest.json', data: Buffer.from('{"a":1}') },
    { name: 'photos/照片-1.jpg', data: photo },
    { name: 'empty.txt', data: Buffer.alloc(0) },
  ]);
  const reads = [];
  const read = async (o, n) => { reads.push(n); return new Uint8Array(buf.subarray(o, o + n)); };
  const zip = await openZip(read, buf.length);
  assert.deepEqual(zip.names, ['manifest.json', 'photos/照片-1.jpg', 'empty.txt']);
  assert.ok(Buffer.from(await zip.bytes('photos/照片-1.jpg')).equals(photo));
  assert.equal((await zip.bytes('empty.txt')).length, 0);
  assert.ok(Math.max(...reads.slice(0, 2)) < photo.length, 'opening reads the directory, not the photos');
  await rejectsWith(zip.bytes('nope.jpg'), 'missing_file');
});

test('round trip: a real bundle reads back as its manifest and files', async () => {
  const items = [
    { message: 'You were amazing', credit: 'Mika', photo: true, edited: false, favorite: true, createdAt: Date.UTC(2026, 4, 2) },
    { message: 'Hi', credit: '', photo: false, edited: false, createdAt: Date.UTC(2026, 4, 2) },
  ];
  const { manifest, html, messages } = planBundle({ event: { name: 'Spring Con' }, cosplayer: { name: 'Aki' }, items, lang: 'en', picture: true });
  const jpeg = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
  const buf = await zipOf([
    { name: 'index.html', data: Buffer.from(html) },
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) },
    { name: 'messages.txt', data: Buffer.from(messages) },
    { name: 'photos/photo-0001.jpg', data: jpeg },
    { name: 'thumbs/photo-0001.jpg', data: jpeg },
    { name: 'picture.jpg', data: jpeg },
  ]);
  const bundle = await readBundle(fileOf(buf));
  assert.deepEqual(bundle.manifest, manifest);
  assert.ok(bundle.has('thumbs/photo-0001.jpg') && bundle.has('picture.jpg'));
  assert.equal(bundle.has('unedited/photo-0001.jpg'), false);
  const blob = await bundle.blob('picture.jpg');
  assert.equal(blob.type, 'image/jpeg');
  assert.ok(Buffer.from(await blob.arrayBuffer()).equals(jpeg));
});

test('readBundle says what is wrong with a file that is not a bundle', async () => {
  await rejectsWith(readBundle({ kind: 'url', url: 'https://example.com/a.zip' }), 'unknown_source');
  await rejectsWith(readBundle(fileOf(Buffer.from('not a zip at all'))), 'not_zip');
  await rejectsWith(readBundle(fileOf(Buffer.alloc(0))), 'not_zip');
  await rejectsWith(readBundle(fileOf(await zipOf([{ name: 'a.txt', data: Buffer.from('x') }]))), 'not_bundle');
  await rejectsWith(readBundle(fileOf(await zipOf([{ name: 'manifest.json', data: Buffer.from('{oops') }]))), 'not_bundle');
  const newer = { schemaVersion: 2, event: { name: 'E' }, items: [] };
  await rejectsWith(readBundle(fileOf(await zipOf([{ name: 'manifest.json', data: Buffer.from(JSON.stringify(newer)) }]))), 'newer_bundle');
  // A compressed (re-zipped) entry: flip the method field in both headers of a stored ZIP.
  const buf = await zipOf([{ name: 'manifest.json', data: Buffer.from('{}') }]);
  buf.writeUInt16LE(8, 8);
  buf.writeUInt16LE(8, buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 10);
  await rejectsWith(readBundle(fileOf(buf)), 'compressed');
});

const manifest = (event, date, items, cosplayer = 'Aki') => ({ schemaVersion: 1, event: { name: event, date }, cosplayer: { name: cosplayer }, revealStyle: 'mosaic', items });
const photo = (n, extra = {}) => ({ type: 'photo', file: `photos/photo-${n}.jpg`, thumb: `thumbs/photo-${n}.jpg`, note: null, credit: null, favorite: false, ...extra });
const note = (text, extra = {}) => ({ type: 'note', note: text, credit: null, favorite: false, ...extra });

test('planReview: grouped by year, in date order, the same download once', () => {
  const a = manifest('Winter Con', '2025-12-14', [photo(1)]);
  const b = manifest('Spring Con', '2026-04-02', [note('hi')]);
  const c = manifest('Summer Fest', '2026-08-20', [photo(1), photo(2)]);
  const years = planReview([c, a, b, c]);
  assert.deepEqual(years.map((y) => y.year), ['2025', '2026']);
  assert.deepEqual(years.flatMap((y) => y.spreads.map((s) => s.index)), [1, 2, 0], 'index points at the picked bundle');
  assert.deepEqual(years[1].spreads.map((s) => s.date), ['2026-04-02', '2026-08-20']);
  const odd = planReview([manifest('No date', 'soon', [])]);
  assert.equal(odd[0].year, '0000');
});

test('planReview: favorites first among the notes, then a seeded pick, and the same each time', () => {
  const items = [
    ...Array.from({ length: 10 }, (_, i) => note(`n${i}`)),
    photo(1, { note: 'with a photo', favorite: true }),
    note('the best', { favorite: true }),
    photo(2),
  ];
  const m = manifest('Con', '2026-05-01', items);
  const [s] = planReview([m])[0].spreads;
  assert.equal(s.notes.length, NOTES_PER_SPREAD);
  assert.deepEqual(new Set(s.notes.slice(0, 2).map((n) => n.note)), new Set(['with a photo', 'the best']));
  assert.deepEqual(planReview([m])[0].spreads[0], s, 'deterministic');
  assert.deepEqual(new Set(s.photos.map((p) => p.file)), new Set(['photos/photo-1.jpg', 'photos/photo-2.jpg']));
  // A different event with the same items gets its own pick, not a copy.
  const others = Array.from({ length: 8 }, (_, k) => planReview([manifest(`Con ${k}`, '2026-05-01', items.slice(0, 10))])[0].spreads[0].notes.map((n) => n.note).join());
  assert.ok(new Set(others).size > 1);
});

test('planReview carries no counts or rankings', () => {
  const big = manifest('Big Con', '2026-03-01', Array.from({ length: 200 }, (_, i) => photo(i, { note: `n${i}` })));
  const small = manifest('Small Con', '2026-06-01', [photo(1)]);
  const [year] = planReview([big, small]);
  assert.deepEqual(year.spreads.map((s) => s.index), [0, 1], 'by date, not by size');
  assert.deepEqual(Object.keys(year).sort(), ['spreads', 'year']);
  for (const s of year.spreads) assert.deepEqual(Object.keys(s).sort(), ['date', 'index', 'notes', 'photos', 'seed']);
});

test('makeIcs: all-day reminders, escaped, folded at 75 bytes, CRLF', () => {
  const ics = makeIcs([
    { uid: 'review-2026@fanwall', date: '2026-12-01', summary: 'Your year, in review; see it', description: 'Line one\nLine two, with commas', url: 'https://fan.example/review' },
    { uid: 'dl@fanwall', date: '2026-12-31', summary: '下载你在冬季同人展的 FanWall 照片，在页面删除之前把它们全部保存好' },
  ], { now: new Date(Date.UTC(2026, 10, 3, 4, 5, 6)) });
  assert.ok(ics.endsWith('\r\n'));
  assert.doesNotMatch(ics.replace(/\r\n/g, ''), /[\r\n]/, 'every line ends in CRLF');
  const lines = ics.split('\r\n');
  for (const l of lines) assert.ok(new TextEncoder().encode(l).length <= 75, `${l} is folded`);
  const unfolded = ics.replace(/\r\n /g, '');
  assert.match(unfolded, /DTSTAMP:20261103T040506Z/);
  assert.match(unfolded, /DTSTART;VALUE=DATE:20261201\r\nDTEND;VALUE=DATE:20261202/);
  assert.match(unfolded, /DTSTART;VALUE=DATE:20261231\r\nDTEND;VALUE=DATE:20270101/, 'ends the next day, across the year');
  assert.match(unfolded, /SUMMARY:Your year\\, in review\\; see it/);
  assert.match(unfolded, /DESCRIPTION:Line one\\nLine two\\, with commas/);
  assert.match(unfolded, /SUMMARY:下载你在冬季同人展的 FanWall 照片，在页面删除之前把它们全部保存好/, 'folds on whole characters');
  assert.equal(unfolded.match(/BEGIN:VEVENT/g).length, 2);
  assert.equal(unfolded.match(/TRIGGER:PT9H/g).length, 2);
  assert.throws(() => makeIcs([{ uid: 'x', date: '1 Dec', summary: 's' }]));
});

test('nextDecember: this year until the 1st, then next year', () => {
  assert.equal(nextDecember('2026-11-03'), '2026-12-01');
  assert.equal(nextDecember('2026-12-01'), '2026-12-01');
  assert.equal(nextDecember('2026-12-02'), '2027-12-01');
  assert.equal(nextDecember('2027-01-15'), '2027-12-01');
});
