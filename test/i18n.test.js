import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { LANGS, matchLang, format, placeholders } from '../public/js/i18n-core.js';
import { consentCopy, consentCopies, CONSENT_VERSION } from '../lib/consent.js';

const read = (f) => fs.readFileSync(f, 'utf8');
const catalogs = Object.fromEntries(LANGS.map((l) => [l, JSON.parse(read(`public/locales/${l}.json`))]));
const en = catalogs.en;
const has = (key) => key in en || `${key}.other` in en; // a plural key is used without its .one/.other

test('all three catalogs have the same keys, no empty values, and the same placeholders', () => {
  const keys = Object.keys(en).sort();
  for (const l of LANGS) {
    const cat = catalogs[l];
    assert.deepEqual(Object.keys(cat).sort(), keys, `${l}: same keys as en`);
    for (const [k, v] of Object.entries(cat)) {
      assert.equal(typeof v, 'string', `${l} ${k}`);
      assert.ok(v.trim(), `${l} ${k} is empty`);
      assert.deepEqual(placeholders(v), placeholders(en[k]), `${l} ${k}: placeholders`);
    }
  }
  // Plural keys come in pairs.
  for (const k of keys) if (k.endsWith('.one')) assert.ok(`${k.slice(0, -4)}.other` in en, k);
});

test('every key the pages and scripts use exists', () => {
  const files = [
    ...fs.readdirSync('public').filter((f) => f.endsWith('.html')).map((f) => path.join('public', f)),
    ...fs.readdirSync('public/js').filter((f) => f.endsWith('.js')).map((f) => path.join('public/js', f)),
    'scripts/export-static.js',
    'lib/bundle.js',
  ];
  const NS = 'common|lang|offline|copy|status|field|error|landing|fan|reveal|editor|admin|print|demo|zip';
  const re = new RegExp(`(?:data-i18n(?:-[a-z-]+)?="|data-lang-label="|['"])((?:${NS})\\.[A-Za-z0-9_.]+)["']`, 'g');
  let found = 0;
  for (const f of files) {
    for (const [, key] of read(f).matchAll(re)) {
      if (/\.(html|js)$/.test(key)) continue; // a file name like 'fan.html', not a key
      found++;
      assert.ok(has(key), `${f}: missing key ${key}`);
    }
  }
  assert.ok(found > 200, `found only ${found} keys; is the pattern still right?`);

  // Keys the code builds from a value.
  const families = {
    status: ['pending', 'approved', 'rejected'],
    'admin.grid.empty': ['pending', 'approved', 'rejected', 'all'],
    'reveal.caption': ['both', 'photos', 'notes'],
    'reveal.intro': ['both', 'photos', 'notes'],
    'reveal.sr': ['both', 'photos', 'notes'],
    'copy.link': ['done', 'prompt'],
    'copy.code': ['done', 'prompt'],
    'demo.case': ['yuki', 'aki', 'mei', 'rin', 'kai'],
  };
  for (const [prefix, names] of Object.entries(families)) for (const n of names) assert.ok(has(`${prefix}.${n}`), `${prefix}.${n}`);
});

test('every error code the server sends has words, and field names do too', () => {
  const server = read('server.js');
  const codes = new Set([...server.matchAll(/HttpError\(\d+, '([a-z_]+)'/g), ...server.matchAll(/\{ error: '([a-z_]+)' \}/g)].map((m) => m[1]));
  for (const m of server.matchAll(/'(page_closed|page_not_open|server_error|bad_request)'/g)) codes.add(m[1]);
  assert.ok(codes.size > 25, `found ${codes.size} codes`);
  for (const code of codes) assert.ok(has(`error.${code}`), `error.${code}`);
  for (const [, field] of server.matchAll(/textField\([^,]+, '(\w+)'/g)) assert.ok(has(`field.${field}`), `field.${field}`);
});

test('browser languages map to ours', () => {
  const cases = {
    'zh-TW': 'zh-Hant', 'zh-HK': 'zh-Hant', 'zh-MO': 'zh-Hant', 'zh-Hant': 'zh-Hant', 'zh-Hant-TW': 'zh-Hant',
    'zh-CN': 'zh-Hans', 'zh-SG': 'zh-Hans', 'zh-Hans': 'zh-Hans', zh: 'zh-Hans', 'zh-Hans-HK': 'zh-Hans',
    en: 'en', 'en-US': 'en', 'en-GB': 'en', ja: null, 'ja-JP': null, fr: null, '': null, enx: null,
  };
  for (const [tag, want] of Object.entries(cases)) assert.equal(matchLang(tag), want, tag);
  assert.equal(matchLang(undefined), null);
});

test('format fills placeholders and picks plural forms per language', () => {
  const cat = { hi: 'Hi {name}, {name}!', 'n.one': '{count} item', 'n.other': '{count} items' };
  assert.equal(format(cat, 'en', 'hi', { name: 'Aki' }), 'Hi Aki, Aki!');
  assert.equal(format(cat, 'en', 'hi'), 'Hi {name}, {name}!', 'a missing var stays visible');
  assert.equal(format(cat, 'en', 'n', { count: 1 }), '1 item');
  assert.equal(format(cat, 'en', 'n', { count: 0 }), '0 items');
  assert.equal(format(cat, 'zh-Hant', 'n', { count: 1 }), '1 items', 'Chinese has no singular form');
  assert.equal(format(cat, 'en', 'missing'), 'missing');
  assert.equal(format(en, 'en', 'admin.bulk.confirm', { count: 3 }), 'Approve 3 items?');
});

test('consent comes in all three languages with the name and days filled in', () => {
  const all = consentCopies({ cosplayerName: 'Aki', retentionDays: 14 });
  assert.deepEqual(Object.keys(all), LANGS);
  for (const l of LANGS) {
    const c = all[l];
    assert.equal(c.version, CONSENT_VERSION);
    assert.equal(c.lang, l);
    assert.equal(c.points.length, all.en.points.length, `${l}: same points as English`);
    const text = JSON.stringify(c);
    assert.ok(text.includes('Aki') && text.includes('14') && text.includes('90'), l);
    assert.ok(c.checkbox.includes('13'), `${l}: the age line`);
    assert.doesNotMatch(text, /\$\{|undefined/, l);
  }
  // The translations are a new version: v1 had English only.
  assert.notEqual(CONSENT_VERSION, '2026-11-v1');
  assert.equal(consentCopy({ cosplayerName: '', retentionDays: 30, lang: 'xx' }).lang, 'en');
  assert.ok(consentCopy({ cosplayerName: '', retentionDays: 30, lang: 'zh-Hant' }).points[1].t.includes('這位 Coser'));
  // "Mosaic" must not be 马赛克 / 馬賽克, which usually means a censor blur in Chinese.
  for (const l of ['zh-Hans', 'zh-Hant']) {
    assert.doesNotMatch(JSON.stringify(all[l]) + JSON.stringify(catalogs[l]), /马赛克|馬賽克/, l);
  }
});
