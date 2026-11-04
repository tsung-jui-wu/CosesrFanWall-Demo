import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planBundle, BUNDLE_SCHEMA } from '../lib/bundle.js';

const T0 = Date.UTC(2026, 10, 3, 2, 0); // 2026-11-03 02:00 UTC
const items = [
  { message: '', credit: 'Mika', photo: true, edited: false, createdAt: T0 + 1000 },
  { message: 'Best cosplay! <script>alert(1)</script>', credit: '', photo: true, edited: true, favorite: true, createdAt: T0 + 2000 },
  { message: 'See you "next" year & more', credit: 'Rin <b>', photo: false, edited: false, createdAt: T0 },
];
const plan = (extra = {}) => planBundle({ event: { name: 'Con <x>' }, cosplayer: { name: 'Aki' }, items, lang: 'en', ...extra });

test('manifest: one entry per item, credits only when given, paths for each file', () => {
  const { manifest, photos } = plan();
  assert.deepEqual(photos, ['photo-0001.jpg', 'photo-0002.jpg', null]);
  assert.deepEqual(manifest, {
    schemaVersion: BUNDLE_SCHEMA,
    language: 'en',
    event: { name: 'Con <x>', date: '2026-11-03' },
    cosplayer: { name: 'Aki' },
    revealStyle: 'mosaic',
    picture: null,
    items: [
      { type: 'photo', file: 'photos/photo-0001.jpg', thumb: 'thumbs/photo-0001.jpg', edited: false, credit: 'Mika', note: null, favorite: false },
      {
        type: 'photo', file: 'photos/photo-0002.jpg', thumb: 'thumbs/photo-0002.jpg', unedited: 'unedited/photo-0002.jpg',
        edited: true, credit: null, note: 'Best cosplay! <script>alert(1)</script>', favorite: true,
      },
      { type: 'note', credit: 'Rin <b>', note: 'See you "next" year & more', favorite: false },
    ],
  });
  assert.equal(BUNDLE_SCHEMA, 1);
});

test('the event date is the first item\'s day on the cosplayer\'s clock', () => {
  assert.equal(plan({ tz: 0 }).manifest.event.date, '2026-11-03');
  assert.equal(plan({ tz: 300 }).manifest.event.date, '2026-11-02', 'UTC-5: still the evening before');
  assert.equal(plan({ tz: -480 }).manifest.event.date, '2026-11-03', 'UTC+8: mid-morning');
  assert.match(plan({ tz: 300 }).html, /November 2, 2026/);
  const empty = planBundle({ event: { name: 'E' }, cosplayer: { name: 'C' }, items: [], lang: 'en', fallbackDate: Date.UTC(2025, 11, 31, 12) });
  assert.equal(empty.manifest.event.date, '2025-12-31');
  assert.deepEqual(empty.manifest.items, []);
});

test('the gallery escapes what fans wrote, loads nothing, and points only at files in the bundle', () => {
  const { html, manifest } = plan();
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /Best cosplay! &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /See you &quot;next&quot; year &amp; more/);
  assert.match(html, /— Rin &lt;b&gt;/);
  assert.match(html, /Con &lt;x&gt;/);
  assert.match(html, /script-src 'none'; connect-src 'none'/);
  const refs = [...html.matchAll(/(?:src|href)="([^"]*)"/g)].map((m) => m[1]);
  const files = new Set(manifest.items.flatMap((i) => [i.file, i.thumb]).filter(Boolean));
  assert.ok(refs.length >= 4);
  for (const ref of refs) assert.ok(files.has(ref), `${ref} is a file in the bundle`);
  assert.doesNotMatch(html, /https?:|url\(|@import|\/\//, 'no network, no remote fonts');
});

test('the gallery and messages.txt follow the page language; fans\' words stay as written', () => {
  const zh = plan({ lang: 'zh-Hant' });
  assert.match(zh.html, /<html lang="zh-Hant">/);
  assert.match(zh.html, /<title>謝謝你，Aki<\/title>/);
  assert.match(zh.html, /點一下照片即可看大圖/);
  assert.match(zh.html, /PingFang TC/);
  assert.equal(zh.manifest.language, 'zh-Hant');
  assert.deepEqual(zh.messages.split('\r\n'), [
    'Con <x>的粉絲送給你的照片和留言', '',
    '[photo-0001.jpg] （照片）（來自Mika）', '',
    '[photo-0002.jpg] Best cosplay! <script>alert(1)</script>', '',
    'See you "next" year & more（來自Rin <b>）', '',
  ]);
  assert.match(plan({ lang: 'zh-Hans' }).html, /PingFang SC/);
});

test('a bundle of notes only says so and has no photo hint', () => {
  const { html } = planBundle({
    event: { name: 'E' }, cosplayer: { name: 'C' }, lang: 'en',
    items: [{ message: 'Hi', credit: '', photo: false, edited: false, createdAt: T0 }],
  });
  assert.match(html, /Notes from your fans at E/);
  assert.doesNotMatch(html, /Tap a photo/);
});

test('the picture is listed only when the bundle carries one', () => {
  assert.equal(plan().manifest.picture, null);
  assert.equal(plan({ picture: true }).manifest.picture, 'picture.jpg');
});
