import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fanwall-api-'));
process.env.DATA_DIR = dir;
process.env.CREATE_KEY = 'letmein';
process.env.TRUST_PROXY = '1'; // lets each test act as its own client via X-Forwarded-For
const { app } = await import('../server.js');
const { db, mediaPath, flush } = await import('../lib/store.js');

let server, base;
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); flush(); fs.rmSync(dir, { recursive: true, force: true }); });

const jpeg = (w = 64, h = 48) => sharp({ create: { width: w, height: h, channels: 3, background: '#3a6' } }).jpeg().toBuffer();

async function call(p, { method = 'GET', json, form, ip } = {}) {
  const headers = {};
  if (json) headers['content-type'] = 'application/json';
  if (ip) headers['x-forwarded-for'] = ip;
  const res = await fetch(base + p, {
    method,
    headers,
    body: json ? JSON.stringify(json) : form,
  });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : await res.text() };
}

// Each submit comes from a fresh address so the 15-per-10-minutes limit doesn't leak between tests.
let ipCounter = 0;
const freshIp = () => `10.0.${Math.floor(++ipCounter / 250)}.${ipCounter % 250 + 1}`;

// The fan page always says which language the consent was shown in; pass consentLang: null to leave it out.
async function submit(eid, cid, fields = {}, photo, ip = freshIp()) {
  const form = new FormData();
  for (const [k, v] of Object.entries({ consentLang: 'en', ...fields })) if (v !== null) form.append(k, v);
  if (photo) form.append('photo', new Blob([photo], { type: 'image/jpeg' }), 'p.jpg');
  return call(`/api/fan/${eid}/${cid}/submit`, { method: 'POST', form, ip });
}

// Event creation is rate limited (10/hour), so most tests share one event and add their own cosplayer.
async function makeEvent(name = 'Con') {
  const r = await call('/api/events', { method: 'POST', json: { name, key: 'letmein' }, ip: freshIp() });
  assert.equal(r.status, 201);
  const token = r.body.adminPath.split('/')[2];
  return addCosplayer({ eid: r.body.id, token, admin: `/api/admin/${token}` });
}
async function addCosplayer(ev, name = 'Aki') {
  const c = await call(`${ev.admin}/cosplayers`, { method: 'POST', json: { name, character: 'Knight' } });
  assert.equal(c.status, 201);
  return { ...ev, cid: c.body.id };
}
let shared;
const sharedEvent = async () => addCosplayer(shared ??= await makeEvent('Shared'));

test('creating an event needs the create key and a name', async () => {
  assert.equal((await call('/api/events', { method: 'POST', json: { name: 'X' } })).status, 403);
  assert.equal((await call('/api/events', { method: 'POST', json: { name: 'X', key: 'nope' } })).status, 403);
  assert.equal((await call('/api/events', { method: 'POST', json: { name: '  ', key: 'letmein' } })).status, 400);
  assert.equal((await call('/api/events', { method: 'POST', json: { name: 'X', key: 'letmein', retentionDays: 91 } })).status, 400);
  assert.deepEqual((await call('/api/config')).body, { needsKey: true });
});

test('fan submit requires consent, and the delete code removes files', async () => {
  const { eid, cid, admin } = await sharedEvent();
  const photo = await jpeg();
  const noConsent = await submit(eid, cid, { message: 'hi' }, photo);
  assert.equal(noConsent.status, 400);
  assert.equal(Object.values(db.submissions).some((x) => x.cosplayerId === cid), false);

  const ok = await submit(eid, cid, { consent: '1', message: 'Thanks!', name: 'Mika', credit: '1' }, photo);
  assert.equal(ok.status, 201);
  const { id, deleteCode } = ok.body;
  const file = db.submissions[id].file;
  assert.match(file, /^[0-9a-f]{32}$/);
  assert.ok(fs.existsSync(mediaPath(`${file}.jpg`)) && fs.existsSync(mediaPath(`${file}_t.jpg`)));
  assert.equal(db.submissions[id].consent.v.length > 0, true);
  assert.equal(JSON.stringify(db.submissions[id]).includes(deleteCode), false, 'code stored only as a hash');

  const mine = (await call(admin)).body.submissions.find((x) => x.id === id);
  assert.equal(mine.status, 'pending');
  assert.equal(mine.codeHash, undefined);
  assert.equal((await call(mine.thumbUrl)).status, 200);

  assert.equal((await call('/api/fan/delete', { method: 'POST', json: { id, code: 'AAAA-BBBB-CCCC' } })).status, 404);
  assert.equal((await call('/api/fan/delete', { method: 'POST', json: { id, code: deleteCode.toLowerCase() } })).status, 200);
  assert.ok(!fs.existsSync(mediaPath(`${file}.jpg`)) && !fs.existsSync(mediaPath(`${file}_t.jpg`)));
  assert.equal(db.submissions[id], undefined);
});

test('fan photos keep up to 2560 px on the long edge', async () => {
  const { eid, cid } = await sharedEvent();
  const sizes = [];
  for (const [w, h] of [[4000, 3000], [1200, 900]]) {
    const ok = await submit(eid, cid, { consent: '1' }, await jpeg(w, h));
    assert.equal(ok.status, 201);
    const file = db.submissions[ok.body.id].file;
    const full = await sharp(mediaPath(`${file}.jpg`)).metadata();
    const thumb = await sharp(mediaPath(`${file}_t.jpg`)).metadata();
    sizes.push([full.width, full.height, Math.max(thumb.width, thumb.height)]);
  }
  assert.deepEqual(sizes, [[2560, 1920, 360], [1200, 900, 360]], 'big photos shrink, small ones are never enlarged');
});

test('fan delete ignores prototype keys', async () => {
  const r = await call('/api/fan/delete', { method: 'POST', json: { id: '__proto__', code: 'x' } });
  assert.equal(r.status, 404);
});

test('organizer token is required and scoped to its own event', async () => {
  const a = await makeEvent('A');
  const b = await makeEvent('B');
  const s = await submit(b.eid, b.cid, { consent: '1', message: 'for B' });
  assert.equal((await call('/api/admin/not-a-real-token')).status, 404);
  assert.equal((await call(`${a.admin}/submissions/${s.body.id}`, { method: 'PATCH', json: { status: 'approved' } })).status, 404);
  assert.equal((await call(`${a.admin}/cosplayers/${b.cid}/release`, { method: 'POST', json: { released: true } })).status, 404);
  assert.equal((await call(`${a.admin}/cosplayers/${b.cid}`, { method: 'DELETE' })).status, 404);
  const bulk = await call(`${a.admin}/submissions/bulk`, { method: 'POST', json: { ids: [s.body.id], status: 'approved' } });
  assert.deepEqual(bulk.body.updated, []);
  assert.equal(db.submissions[s.body.id].status, 'pending');
});

test('moderation: approve, reject, bulk, and bad status', async () => {
  const { eid, cid, admin } = await sharedEvent();
  const ids = [];
  for (const m of ['one', 'two', 'three']) ids.push((await submit(eid, cid, { consent: '1', message: m })).body.id);
  assert.equal((await call(`${admin}/submissions/${ids[0]}`, { method: 'PATCH', json: { status: 'rejected' } })).status, 200);
  assert.equal((await call(`${admin}/submissions/${ids[0]}`, { method: 'PATCH', json: { status: 'deleted' } })).status, 400);
  const bulk = await call(`${admin}/submissions/bulk`, { method: 'POST', json: { ids: ids.slice(1), status: 'approved' } });
  assert.deepEqual(bulk.body.updated, ids.slice(1));
  const counts = (await call(admin)).body.cosplayers.find((c) => c.id === cid).counts;
  assert.deepEqual(counts, { pending: 0, approved: 2, rejected: 1 });
});

test('closing an event stamps closedAt, blocks fans, reopening clears it', async () => {
  const { eid, cid, admin } = await makeEvent();
  const closed = await call(`${admin}/event`, { method: 'PATCH', json: { open: false, retentionDays: 7 } });
  assert.equal(closed.body.event.open, false);
  assert.ok(closed.body.event.closedAt > 0);
  assert.equal(closed.body.event.retentionDays, 7);
  assert.equal((await submit(eid, cid, { consent: '1', message: 'late' })).status, 403);
  assert.equal((await call(`/api/fan/${eid}/${cid}`)).body.open, false);
  const reopened = await call(`${admin}/event`, { method: 'PATCH', json: { open: true } });
  assert.equal(reopened.body.event.closedAt, null);
  assert.equal((await call(`${admin}/event`, { method: 'PATCH', json: { open: 'no' } })).status, 400);
  assert.equal((await call(`${admin}/event`, { method: 'PATCH', json: { name: '' } })).status, 400);
});

test('base image upload re-encodes and replaces the old file', async () => {
  const { admin, eid } = await sharedEvent();
  const up = async () => {
    const form = new FormData();
    form.append('image', new Blob([await jpeg(300, 200)], { type: 'image/jpeg' }), 'b.jpg');
    return call(`${admin}/base`, { method: 'POST', form });
  };
  const first = await up();
  assert.equal(first.status, 200);
  const firstFile = first.body.event.baseUrl.split('/').pop();
  assert.match(firstFile, /^base_[0-9a-f]{32}\.jpg$/);
  const second = await up();
  const secondFile = second.body.event.baseUrl.split('/').pop();
  assert.notEqual(firstFile, secondFile);
  assert.ok(!fs.existsSync(mediaPath(firstFile)) && fs.existsSync(mediaPath(secondFile)));
  assert.equal((await call(second.body.event.baseUrl)).status, 200);
  assert.equal(db.events[eid].baseImage, secondFile.slice(5, 37));
});

test('removing a cosplayer deletes their submissions and files', async () => {
  const { eid, cid, admin } = await sharedEvent();
  const s = await submit(eid, cid, { consent: '1' }, await jpeg());
  const file = db.submissions[s.body.id].file;
  assert.equal((await call(`${admin}/cosplayers/${cid}`, { method: 'DELETE' })).status, 200);
  assert.equal(db.cosplayers[cid], undefined);
  assert.equal(db.submissions[s.body.id], undefined);
  assert.ok(!fs.existsSync(mediaPath(`${file}.jpg`)));
});

test('release toggles and QR is an SVG', async () => {
  const { cid, admin } = await sharedEvent();
  assert.deepEqual((await call(`${admin}/cosplayers/${cid}/release`, { method: 'POST', json: { released: true } })).body, { released: true });
  assert.equal((await call(`${admin}/cosplayers/${cid}/release`, { method: 'POST', json: { released: 'yes' } })).status, 400);
  const qr = await call(`${admin}/qr/${cid}.svg`);
  assert.equal(qr.status, 200);
  assert.match(qr.headers.get('content-type'), /image\/svg\+xml/);
  assert.match(qr.body, /^<svg/);
});

test('pages: token pages are no-store with CSP; bad tokens 404', async () => {
  const { token, cid } = await sharedEvent();
  const page = await call(`/admin/${token}`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal((await call(`/admin/${token}/print/${cid}`)).status, 200);
  assert.equal((await call('/admin/wrong')).status, 404);
  assert.equal((await call('/')).status, 200);
  assert.equal((await call('/js/mosaic.js')).status, 200);
});

test('an SVG disguised as image/png is refused', async () => {
  const { eid, cid } = await sharedEvent();
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');
  const form = new FormData();
  form.append('consent', '1');
  form.append('photo', new Blob([svg], { type: 'image/png' }), 'x.png');
  const r = await call(`/api/fan/${eid}/${cid}/submit`, { method: 'POST', form });
  assert.equal(r.status, 400);
  assert.equal(Object.values(db.submissions).some((s) => s.cosplayerId === cid), false);
});

test('an opted-out cosplayer cannot be released again', async () => {
  const { cid, admin } = await sharedEvent();
  db.cosplayers[cid].optOut = true;
  assert.equal((await call(`${admin}/cosplayers/${cid}/release`, { method: 'POST', json: { released: true } })).status, 409);
  assert.equal((await call(`${admin}/cosplayers/${cid}/release`, { method: 'POST', json: { released: false } })).status, 200);
});

test('bulk rejects more than 1000 ids', async () => {
  const { admin } = await sharedEvent();
  const ids = Array.from({ length: 1001 }, (_, i) => `id${i}`);
  assert.equal((await call(`${admin}/submissions/bulk`, { method: 'POST', json: { ids, status: 'approved' } })).status, 400);
});

test('fan can delete with the code alone; malformed codes never match', async () => {
  const { eid, cid } = await sharedEvent();
  const a = await submit(eid, cid, { consent: '1', message: 'code only' });
  assert.equal((await call('/api/fan/delete', { method: 'POST', json: { code: '' } })).status, 404);
  assert.equal((await call('/api/fan/delete', { method: 'POST', json: { code: 'XXXX' } })).status, 404);
  assert.equal((await call('/api/fan/delete', { method: 'POST', json: { code: { $ne: 1 } } })).status, 404);
  const spaced = ` ${a.body.deleteCode.toLowerCase().replaceAll('-', ' ')} `;
  assert.equal((await call('/api/fan/delete', { method: 'POST', json: { code: spaced } })).status, 200);
  assert.equal(db.submissions[a.body.id], undefined);
});

test('fan page is served for any link and is no-store', async () => {
  const { eid, cid } = await sharedEvent();
  const ok = await call(`/e/${eid}/c/${cid}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  assert.match(ok.body, /fan\.js/);
  assert.equal((await call('/e/nope/c/nope')).status, 200); // the page explains bad links itself
  assert.equal((await call('/api/fan/nope/nope')).status, 404);
});

test('inherited object keys are not valid ids', async () => {
  for (const k of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    assert.equal((await call(`/api/fan/${k}/${k}`)).status, 404, k);
  }
  const { admin } = await sharedEvent();
  assert.equal((await call(`${admin}/submissions/constructor`, { method: 'PATCH', json: { status: 'approved' } })).status, 404);
  assert.equal((await call(`${admin}/cosplayers/constructor/release`, { method: 'POST', json: { released: true } })).status, 404);
  assert.equal((await call('/api/fan/delete', { method: 'POST', json: { id: 'constructor', code: 'ABCD-EFGH-JKLM' } })).status, 404);
});

test('a retried submit with the same client code is stored once', async () => {
  const { eid, cid } = await sharedEvent();
  const photo = await jpeg();
  const code = 'abcd-efgh-jkmn';
  const first = await submit(eid, cid, { consent: '1', code }, photo);
  const again = await submit(eid, cid, { consent: '1', code }, photo);
  assert.equal(first.status, 201);
  assert.equal(again.status, 201);
  assert.equal(again.body.id, first.body.id);
  assert.equal(first.body.deleteCode, 'ABCD-EFGH-JKMN');
  assert.equal(Object.values(db.submissions).filter((s) => s.cosplayerId === cid).length, 1);
  assert.equal((await submit(eid, cid, { consent: '1', message: 'x', code: 'short' })).status, 400);
  assert.equal((await submit(eid, cid, { consent: '1', message: 'x', code: 'OOOO-IIII-1111' })).status, 400);
});

test('credit is only stored when a name was given', async () => {
  const { eid, cid } = await sharedEvent();
  const r = await submit(eid, cid, { consent: '1', message: 'hi', credit: '1' });
  assert.equal(db.submissions[r.body.id].credit, false);
});

test('security headers are set on every response', async () => {
  const r = await call('/robots.txt');
  assert.equal(r.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal(r.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.match(r.headers.get('permissions-policy'), /camera=\(\)/);
  assert.equal(r.headers.get('x-powered-by'), null);
  assert.equal(r.headers.get('strict-transport-security'), null, 'no HSTS over plain HTTP');
});

test('rate limit keys group IPv6 by /64 and leave IPv4 alone', async () => {
  const { clientKey } = await import('../server.js');
  assert.equal(clientKey('203.0.113.9'), '203.0.113.9');
  assert.equal(clientKey('::ffff:203.0.113.9'), '::ffff:203.0.113.9');
  assert.equal(clientKey('2001:db8:1:2::1'), clientKey('2001:0DB8:0001:0002:ffff:eeee:dddd:cccc'));
  assert.notEqual(clientKey('2001:db8:1:2::1'), clientKey('2001:db8:1:3::1'));
  assert.equal(clientKey('::1'), '0000:0000:0000:0000::/64');
});

test('reveal: nothing before release, then approved items only, names only when credited', async () => {
  const { eid, cid, admin } = await sharedEvent();
  const token = (await call(admin)).body.cosplayers.find((c) => c.id === cid).revealPath.split('/')[2];
  const ids = {};
  for (const [k, fields] of Object.entries({
    approvedCredited: { message: 'a', name: 'Mika', credit: '1' },
    approvedAnon: { message: 'b', name: 'Secret Name' },
    pending: { message: 'c' },
    rejected: { message: 'd' },
  })) ids[k] = (await submit(eid, cid, { consent: '1', ...fields })).body.id;
  await call(`${admin}/submissions/bulk`, { method: 'POST', json: { ids: [ids.approvedCredited, ids.approvedAnon], status: 'approved' } });
  await call(`${admin}/submissions/${ids.rejected}`, { method: 'PATCH', json: { status: 'rejected' } });

  const before = await call(`/api/reveal/${token}`);
  assert.equal(before.status, 200);
  assert.equal(before.body.ready, false);
  assert.deepEqual(before.body.items, []);
  assert.equal(before.body.baseUrl, null);

  await call(`${admin}/cosplayers/${cid}/release`, { method: 'POST', json: { released: true } });
  const after = await call(`/api/reveal/${token}`);
  assert.equal(after.body.ready, true);
  assert.deepEqual(after.body.items.map((i) => i.id).sort(), [ids.approvedCredited, ids.approvedAnon].sort());
  assert.equal(after.body.items.find((i) => i.id === ids.approvedCredited).name, 'Mika');
  assert.equal(after.body.items.find((i) => i.id === ids.approvedAnon).name, '');
  assert.equal(JSON.stringify(after.body).includes('Secret Name'), false);
  for (const i of after.body.items) {
    assert.deepEqual(Object.keys(i).sort(), ['edit', 'favorite', 'fullUrl', 'hidden', 'id', 'message', 'name', 'thumbUrl']);
  }
  assert.equal(after.headers.get('cache-control'), 'no-store');

  db.cosplayers[cid].optOut = true;
  const closed = await call(`/api/reveal/${token}`);
  assert.equal(closed.body.ready, false);
  assert.equal(closed.body.optOut, true);
  assert.deepEqual(closed.body.items, []);
});

const uploadBase = async (p, w = 300, h = 200) => {
  const form = new FormData();
  form.append('image', new Blob([await jpeg(w, h)], { type: 'image/jpeg' }), 'b.jpg');
  return call(p, { method: 'POST', form });
};
const fileOf = (url) => url.split('/').pop();
const revealToken = async (admin, cid) =>
  (await call(admin)).body.cosplayers.find((c) => c.id === cid).revealPath.split('/')[2];

test('a cosplayer can have their own mosaic image, and the reveal prefers it', async () => {
  const ev = await makeEvent('Fair');
  const { admin, cid } = ev;
  const { cid: other } = await addCosplayer(ev, 'Mei');
  const eventBase = fileOf((await uploadBase(`${admin}/base`)).body.event.baseUrl);
  await call(`${admin}/release-all`, { method: 'POST', json: { released: true } });

  const own = await uploadBase(`${admin}/cosplayers/${cid}/base`, 200, 300);
  assert.equal(own.status, 200);
  const ownFile = fileOf(own.body.baseUrl);
  assert.match(ownFile, /^base_[0-9a-f]{32}\.jpg$/);
  assert.equal((await call(own.body.baseUrl)).status, 200);
  assert.equal((await call(admin)).body.cosplayers.find((c) => c.id === cid).baseUrl, own.body.baseUrl);
  assert.equal(fileOf((await call(`/api/reveal/${await revealToken(admin, cid)}`)).body.baseUrl), ownFile);
  assert.equal(fileOf((await call(`/api/reveal/${await revealToken(admin, other)}`)).body.baseUrl), eventBase);

  // Replacing removes the old file; going back to the event image removes the current one.
  const replaced = fileOf((await uploadBase(`${admin}/cosplayers/${cid}/base`)).body.baseUrl);
  assert.ok(!fs.existsSync(mediaPath(ownFile)) && fs.existsSync(mediaPath(replaced)));
  assert.deepEqual((await call(`${admin}/cosplayers/${cid}/base`, { method: 'DELETE' })).body, { baseUrl: null });
  assert.ok(!fs.existsSync(mediaPath(replaced)));
  assert.equal(fileOf((await call(`/api/reveal/${await revealToken(admin, cid)}`)).body.baseUrl), eventBase);

  // Removing the cosplayer removes their image; the event image stays.
  const last = fileOf((await uploadBase(`${admin}/cosplayers/${cid}/base`)).body.baseUrl);
  await call(`${admin}/cosplayers/${cid}`, { method: 'DELETE' });
  assert.ok(!fs.existsSync(mediaPath(last)) && fs.existsSync(mediaPath(eventBase)));
});

test('a cosplayer image upload is scoped to the organizer event', async () => {
  const { admin } = await sharedEvent();
  const fair = Object.values(db.cosplayers).find((c) => c.name === 'Mei');
  const before = fs.readdirSync(path.join(dir, 'uploads')).length;
  assert.equal((await uploadBase(`${admin}/cosplayers/${fair.id}/base`)).status, 404);
  assert.equal((await call(`${admin}/cosplayers/${fair.id}/base`, { method: 'DELETE' })).status, 404);
  assert.equal((await uploadBase(`${admin}/cosplayers/constructor/base`)).status, 404);
  assert.equal(fs.readdirSync(path.join(dir, 'uploads')).length, before, 'nothing written for a foreign cosplayer');
  assert.equal(fair.baseImage ?? null, null);
});

test('release all gives everyone their link at once, but never an opted-out cosplayer', async () => {
  const ev = await sharedEvent();
  const { cid: b } = await addCosplayer(ev, 'Rin');
  const { cid: out } = await addCosplayer(ev, 'Kai');
  db.cosplayers[out].optOut = true;
  assert.equal((await call(`${ev.admin}/release-all`, { method: 'POST', json: { released: 'yes' } })).status, 400);
  const r = await call(`${ev.admin}/release-all`, { method: 'POST', json: { released: true } });
  assert.equal(r.status, 200);
  assert.ok(r.body.updated.includes(ev.cid) && r.body.updated.includes(b) && !r.body.updated.includes(out));
  assert.equal(db.cosplayers[out].released, false);
  assert.ok(Object.values(db.cosplayers).filter((c) => c.eventId === ev.eid && !c.optOut).every((c) => c.released));
  assert.ok(Object.values(db.cosplayers).filter((c) => c.eventId !== ev.eid).some((c) => !c.released), 'other events untouched');

  const hidden = await call(`${ev.admin}/release-all`, { method: 'POST', json: { released: false } });
  assert.ok(hidden.body.updated.includes(ev.cid));
  assert.ok(Object.values(db.cosplayers).filter((c) => c.eventId === ev.eid).every((c) => !c.released));
});

test('reveal: bad tokens 404 and the page is served no-store', async () => {
  assert.equal((await call('/api/reveal/nope')).status, 404);
  assert.equal((await call('/api/reveal/constructor')).status, 404);
  const page = await call('/r/anything');
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.match(page.body, /reveal\.js/);
});

test('submit is rate limited per client address', async () => {
  const { eid, cid } = await sharedEvent();
  const statuses = [];
  for (let i = 0; i < 16; i++) statuses.push((await submit(eid, cid, { consent: '1', message: `rl ${i}` }, null, '192.0.2.77')).status);
  assert.deepEqual(statuses.slice(0, 15), Array(15).fill(201));
  assert.equal(statuses[15], 429);
  assert.equal((await submit(eid, cid, { consent: '1', message: 'other client' }, null, '192.0.2.78')).status, 201);
});

// ---------- Milestone 6: cosplayer controls ----------
// Reads a stored (uncompressed) zip from its local headers: [{ name, data }].
function readZip(buf) {
  const out = [];
  let o = 0;
  while (buf.readUInt32LE(o) === 0x04034b50) {
    const size = buf.readUInt32LE(o + 18), nameLen = buf.readUInt16LE(o + 26), extra = buf.readUInt16LE(o + 28);
    const name = buf.toString('utf8', o + 30, o + 30 + nameLen);
    const start = o + 30 + nameLen + extra;
    out.push({ name, data: buf.subarray(start, start + size) });
    o = start + size;
  }
  assert.equal(buf.readUInt32LE(buf.length - 22), 0x06054b50, 'end of central directory');
  return out;
}

// A released cosplayer with: credited photo+note, anonymous photo, a note with an uncredited name, and a pending item.
async function revealFixture() {
  const ev = await sharedEvent();
  const photo = await jpeg();
  const add = async (fields, p) => (await submit(ev.eid, ev.cid, { consent: '1', ...fields }, p)).body.id;
  const ids = {
    credited: await add({ message: 'You were amazing', name: 'Mika', credit: '1' }, photo),
    anonPhoto: await add({}, photo),
    secretNote: await add({ message: 'Loved the wig', name: 'Secret Name' }),
    pending: await add({ message: 'not yet' }, photo),
  };
  await call(`${ev.admin}/submissions/bulk`, { method: 'POST', json: { ids: [ids.credited, ids.anonPhoto, ids.secretNote], status: 'approved' } });
  const token = await revealToken(ev.admin, ev.cid);
  return { ...ev, ids, token, r: `/api/reveal/${token}` };
}

test('cosplayer controls need a released page and only touch their own approved items', async () => {
  const f = await revealFixture();
  // Not released yet: nothing can be changed or downloaded.
  assert.equal((await call(`${f.r}/items/${f.ids.credited}`, { method: 'POST', json: { hidden: true } })).status, 403);
  assert.equal((await call(`${f.r}/download.zip`)).status, 403);
  await call(`${f.admin}/cosplayers/${f.cid}/release`, { method: 'POST', json: { released: true } });

  const other = await revealFixture(); // another cosplayer's items
  for (const id of [f.ids.pending, other.ids.credited, 'constructor', 'nope']) {
    assert.equal((await call(`${f.r}/items/${id}`, { method: 'POST', json: { hidden: true } })).status, 404, id);
    assert.equal((await call(`${f.r}/items/${id}`, { method: 'DELETE' })).status, 404, id);
  }
  assert.ok(db.submissions[other.ids.credited] && db.submissions[f.ids.pending]);
  assert.equal((await call(`${f.r}/items/${f.ids.credited}`, { method: 'POST', json: { hidden: 'yes' } })).status, 400);
});

test('hide, unhide, and delete; hidden items stay out of the zip', async () => {
  const f = await revealFixture();
  await call(`${f.admin}/cosplayers/${f.cid}/release`, { method: 'POST', json: { released: true } });

  const hide = await call(`${f.r}/items/${f.ids.anonPhoto}`, { method: 'POST', json: { hidden: true } });
  assert.deepEqual({ ...hide.body, savedUntil: typeof hide.body.savedUntil }, { id: f.ids.anonPhoto, hidden: true, favorite: false, savedUntil: 'number' });
  assert.equal((await call(f.r)).body.items.find((i) => i.id === f.ids.anonPhoto).hidden, true);

  const res = await fetch(`${base}${f.r}/download.zip`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  assert.match(res.headers.get('content-disposition'), /^attachment; filename="fanwall-aki\.zip"$/);
  const files = readZip(Buffer.from(await res.arrayBuffer()));
  assert.deepEqual(files.map((x) => x.name), ['index.html', 'manifest.json', 'messages.txt', 'photos/photo-0001.jpg', 'thumbs/photo-0001.jpg'], 'hidden photo left out');
  const byName = Object.fromEntries(files.map((x) => [x.name, x.data]));
  const text = byName['messages.txt'].toString('utf8');
  assert.match(text, /\[photo-0001\.jpg\] You were amazing \(from Mika\)/);
  assert.match(text, /Loved the wig/);
  assert.ok(!text.includes('Secret Name'), 'uncredited names never appear');
  assert.ok(!text.includes('not yet'), 'pending items never appear');
  const full = db.submissions[f.ids.credited].file;
  assert.ok(byName['photos/photo-0001.jpg'].equals(fs.readFileSync(mediaPath(`${full}.jpg`))), 'the full-size photo');

  await call(`${f.r}/items/${f.ids.anonPhoto}`, { method: 'POST', json: { hidden: false } });
  assert.equal((await call(f.r)).body.items.find((i) => i.id === f.ids.anonPhoto).hidden, false);

  const file = db.submissions[f.ids.anonPhoto].file;
  assert.equal((await call(`${f.r}/items/${f.ids.anonPhoto}`, { method: 'DELETE' })).body.ok, true);
  assert.equal(db.submissions[f.ids.anonPhoto], undefined);
  assert.ok(!fs.existsSync(mediaPath(`${file}.jpg`)) && !fs.existsSync(mediaPath(`${file}_t.jpg`)));
});

test('opt-out removes everything, closes the fan page, and blocks release and a new image', async () => {
  const f = await revealFixture();
  const own = fileOf((await uploadBase(`${f.admin}/cosplayers/${f.cid}/base`)).body.baseUrl);
  const files = Object.values(db.submissions).filter((s) => s.cosplayerId === f.cid && s.file).map((s) => s.file);
  assert.ok(files.length >= 3);

  // Needs an explicit JSON confirm; works before release.
  assert.equal((await call(`${f.r}/optout`, { method: 'POST', json: {} })).status, 400);
  const form = new FormData();
  form.append('confirm', 'true');
  assert.equal((await call(`${f.r}/optout`, { method: 'POST', form })).status, 400, 'a form post is not enough');
  assert.equal(Object.values(db.submissions).filter((s) => s.cosplayerId === f.cid).length, 4);
  assert.deepEqual((await call(`${f.r}/optout`, { method: 'POST', json: { confirm: true } })).body, { ok: true });

  assert.equal(Object.values(db.submissions).filter((s) => s.cosplayerId === f.cid).length, 0, 'pending items too');
  for (const file of files) assert.ok(!fs.existsSync(mediaPath(`${file}.jpg`)));
  assert.ok(!fs.existsSync(mediaPath(own)), 'their own mosaic image');
  const view = (await call(f.r)).body;
  assert.equal(view.ready, false);
  assert.equal(view.optOut, true);
  assert.deepEqual(view.items, []);

  assert.equal((await call(`/api/fan/${f.eid}/${f.cid}`)).body.open, false);
  assert.equal((await submit(f.eid, f.cid, { consent: '1', message: 'late' })).status, 403);
  assert.equal((await call(`${f.admin}/cosplayers/${f.cid}/release`, { method: 'POST', json: { released: true } })).status, 409);
  assert.equal((await uploadBase(`${f.admin}/cosplayers/${f.cid}/base`)).status, 409);
  assert.equal((await call(`${f.r}/download.zip`)).status, 403);
  assert.equal((await call(`${f.r}/optout`, { method: 'POST', json: { confirm: true } })).status, 200, 'idempotent');
});

// ---------- photo editing ----------
// 400x200: left half red, right half blue.
async function twoTone() {
  const raw = Buffer.alloc(400 * 200 * 3);
  for (let i = 0; i < 400 * 200; i++) raw.set((i % 400) < 200 ? [220, 30, 30] : [30, 30, 220], i * 3);
  return sharp(raw, { raw: { width: 400, height: 200, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
}
const avg = async (buf) => {
  const { channels } = await sharp(buf).stats();
  return channels.slice(0, 3).map((c) => Math.round(c.mean));
};

test('edits are validated, stored as settings, scoped, and can be undone', async () => {
  const f = await revealFixture();
  const e = (id, edit, r = f.r) => call(`${r}/items/${id}/edit`, { method: 'POST', json: { edit } });
  assert.equal((await e(f.ids.credited, { rot: 90 })).status, 403, 'not before release');
  await call(`${f.admin}/cosplayers/${f.cid}/release`, { method: 'POST', json: { released: true } });

  const other = await revealFixture();
  for (const id of [f.ids.pending, other.ids.credited, 'constructor']) assert.equal((await e(id, { rot: 90 })).status, 404, id);
  assert.equal((await e(f.ids.secretNote, { rot: 90 })).status, 400, 'notes have no photo to edit');
  for (const bad of [{ rot: 45 }, 'x', { exposure: 'lots' }]) assert.equal((await e(f.ids.credited, bad)).status, 400, JSON.stringify(bad));
  assert.equal((await call(`${f.r}/items/${f.ids.credited}/edit`, { method: 'POST', json: {} })).status, 400, 'edit key required');

  const file = db.submissions[f.ids.credited].file;
  const before = fs.readFileSync(mediaPath(`${file}.jpg`));
  const ok = await e(f.ids.credited, { rot: 90, exposure: 2, junk: 1 });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.edit, { rot: 90, crop: null, auto: null, exposure: 1, contrast: 0, warmth: 0, saturation: 0 });
  assert.deepEqual((await call(f.r)).body.items.find((i) => i.id === f.ids.credited).edit, ok.body.edit);
  assert.ok(fs.readFileSync(mediaPath(`${file}.jpg`)).equals(before), 'the fan photo file is untouched');
  assert.equal((await call(f.r)).body.items.find((i) => i.id === f.ids.anonPhoto).edit, null);

  assert.deepEqual((await e(f.ids.credited, null)).body, { id: f.ids.credited, edit: null });
  assert.equal(db.submissions[f.ids.credited].edit, null);
  assert.equal((await e(f.ids.credited, { rot: 0, exposure: 0 })).body.edit, null, 'an edit that changes nothing is stored as none');
});

test('the zip has edited photos, turned the same way as the preview, plus the unedited copies', async () => {
  const f = await revealFixture();
  await call(`${f.admin}/cosplayers/${f.cid}/release`, { method: 'POST', json: { released: true } });
  const id = (await submit(f.eid, f.cid, { consent: '1' }, await twoTone())).body.id;
  await call(`${f.admin}/submissions/bulk`, { method: 'POST', json: { ids: [id], status: 'approved' } });

  // Quarter turn clockwise puts the red (left) half on top; a square crop at the top keeps only red.
  const edit = { rot: 90, crop: { ratio: 1, zoom: 1, cx: 0.5, cy: 0 } };
  assert.equal((await call(`${f.r}/items/${id}/edit`, { method: 'POST', json: { edit } })).status, 200);
  await call(`${f.r}/items/${f.ids.anonPhoto}/edit`, { method: 'POST', json: { edit: { exposure: 1 } } });

  const res = await fetch(`${base}${f.r}/download.zip`);
  assert.equal(res.status, 200);
  const files = readZip(Buffer.from(await res.arrayBuffer()));
  assert.deepEqual(files.map((x) => x.name), [
    'index.html', 'manifest.json', 'messages.txt',
    'photos/photo-0001.jpg', 'thumbs/photo-0001.jpg',
    'photos/photo-0002.jpg', 'unedited/photo-0002.jpg', 'thumbs/photo-0002.jpg',
    'photos/photo-0003.jpg', 'unedited/photo-0003.jpg', 'thumbs/photo-0003.jpg',
  ]);
  const byName = Object.fromEntries(files.map((x) => [x.name, x.data]));
  const stored = (sid) => fs.readFileSync(mediaPath(`${db.submissions[sid].file}.jpg`));
  assert.ok(byName['photos/photo-0001.jpg'].equals(stored(f.ids.credited)), 'unedited photos are the stored file');
  assert.ok(byName['unedited/photo-0002.jpg'].equals(stored(f.ids.anonPhoto)));
  assert.ok(byName['unedited/photo-0003.jpg'].equals(stored(id)));

  const brighter = await avg(byName['photos/photo-0002.jpg']), orig = await avg(stored(f.ids.anonPhoto));
  assert.ok(brighter.every((v, i) => v >= orig[i]) && brighter[1] > orig[1] + 20, `exposure: ${orig} -> ${brighter}`);

  const turned = byName['photos/photo-0003.jpg'];
  const meta = await sharp(turned).metadata();
  assert.deepEqual([meta.width, meta.height], [200, 200]);
  const [r, , b] = await avg(turned);
  assert.ok(r > 180 && b < 60, `top square should be red, got ${r},${b}`);
  // The gallery's thumbnail shows the edit too.
  const thumb = byName['thumbs/photo-0003.jpg'];
  const thumbMeta = await sharp(thumb).metadata();
  assert.deepEqual([thumbMeta.width, thumbMeta.height], [200, 200]);
  const [tr, , tb] = await avg(thumb);
  assert.ok(tr > 180 && tb < 60, `edited thumb should be red, got ${tr},${tb}`);
});

// ---------- languages (Step 0) ----------
test('errors are codes with details, never sentences', async () => {
  const { eid, cid, admin } = await sharedEvent();
  const bodies = [
    (await call('/api/fan/nope/nope')).body,
    (await submit(eid, cid, { message: 'no consent' })).body,
    (await submit(eid, cid, { consent: '1', message: 'x'.repeat(281) })).body,
    (await call('/api/nothing-here')).body,
    (await call('/api/admin/not-a-token')).body,
    (await call(`${admin}/event`, { method: 'PATCH', json: { retentionDays: 500 } })).body,
    (await call(`${admin}/cosplayers`, { method: 'POST', json: { name: '' } })).body,
    (await fetch(`${base}${admin}/event`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{oops' }).then((r) => r.json())),
  ];
  assert.deepEqual(bodies.map((b) => b.error), [
    'link_invalid', 'consent_required', 'too_long', 'not_found', 'admin_link_invalid', 'bad_retention', 'required', 'bad_request',
  ]);
  assert.deepEqual(bodies[2], { error: 'too_long', field: 'message', max: 280 });
  assert.deepEqual(bodies[6], { error: 'required', field: 'cosplayerName' });
  for (const b of bodies) for (const v of Object.values(b)) if (typeof v === 'string') assert.doesNotMatch(v, /\s/, JSON.stringify(b));
});

test('consent is offered in every language and stored with the language the fan read', async () => {
  const { eid, cid } = await sharedEvent();
  const page = (await call(`/api/fan/${eid}/${cid}`)).body;
  assert.deepEqual(Object.keys(page.consent), ['en', 'zh-Hans', 'zh-Hant']);
  for (const [lang, c] of Object.entries(page.consent)) assert.equal(c.lang, lang);
  assert.equal(page.event.lang, null);

  const ok = await submit(eid, cid, { consent: '1', consentLang: 'zh-Hant', message: '謝謝！' });
  assert.equal(ok.status, 201);
  const { consent } = db.submissions[ok.body.id];
  assert.deepEqual(Object.keys(consent).sort(), ['at', 'lang', 'v']);
  assert.equal(consent.lang, 'zh-Hant');
  assert.equal(consent.v, page.consent['zh-Hant'].version);

  for (const consentLang of [null, 'fr', 'zh']) {
    const r = await submit(eid, cid, { consent: '1', consentLang, message: 'which words?' });
    assert.equal(r.status, 400, String(consentLang));
    assert.deepEqual(r.body, { error: 'bad_request', field: 'consentLang' });
  }
});

test('the organizer sets a default language and every page gets it', async () => {
  const { eid, cid, admin } = await makeEvent('Lang');
  const patch = (json) => call(`${admin}/event`, { method: 'PATCH', json });
  assert.equal((await patch({ lang: 'zh-Hant' })).body.event.lang, 'zh-Hant');
  assert.equal((await patch({ name: 'Lang 2' })).body.event.lang, 'zh-Hant', 'left alone when not sent');
  assert.equal((await call(admin)).body.event.lang, 'zh-Hant');
  assert.equal((await call(`/api/fan/${eid}/${cid}`)).body.event.lang, 'zh-Hant');
  assert.equal((await call(`/api/reveal/${await revealToken(admin, cid)}`)).body.event.lang, 'zh-Hant', 'even before release');
  assert.equal((await patch({ lang: 'fr' })).status, 400);
  assert.equal((await patch({ lang: null })).body.event.lang, null);
  assert.equal((await patch({ lang: '' })).body.event.lang, null);
});

test('messages.txt in the ZIP follows the page language; the fans\' own words stay as written', async () => {
  const f = await revealFixture();
  await call(`${f.admin}/cosplayers/${f.cid}/release`, { method: 'POST', json: { released: true } });
  const text = async (q) => {
    const files = readZip(Buffer.from(await (await fetch(`${base}${f.r}/download.zip${q}`)).arrayBuffer()));
    return files.find((x) => x.name === 'messages.txt').data.toString('utf8');
  };
  const zh = await text('?lang=zh-Hant');
  assert.match(zh, /^Shared的粉絲送給你的照片和留言/);
  assert.match(zh, /\[photo-0001\.jpg\] You were amazing（來自Mika）/);
  assert.match(await text('?lang=zh-Hans'), /的粉丝送给你的照片和留言/);
  assert.match(await text('?lang=bogus'), /^Photos and notes from your fans at Shared/);
});

test('a bad organizer link still gets its page, with a 404, so it can explain in any language', async () => {
  const r = await call('/admin/not-a-token');
  assert.equal(r.status, 404);
  assert.match(r.body, /admin\.js/);
  assert.equal(r.headers.get('cache-control'), 'no-store');
});

// ---------- "Saved until" (Step 1) ----------
test('reveal: savedUntil is the 90-day cap of the earliest visible item while open, then close plus retention', async () => {
  const DAY = 86400e3;
  const ev = await makeEvent('Dates');
  const { admin, eid, cid } = ev;
  const token = await revealToken(admin, cid);
  const add = async (message, createdAt, status) => {
    const id = (await submit(eid, cid, { consent: '1', message })).body.id;
    db.submissions[id].createdAt = createdAt;
    if (status) await call(`${admin}/submissions/${id}`, { method: 'PATCH', json: { status } });
    return id;
  };
  const now = Date.now();
  const pendingOld = await add('pending, oldest', now - 20 * DAY); // not visible to the cosplayer, so it doesn't count
  const first = await add('first', now - 10 * DAY, 'approved');
  const second = await add('second', now - 5 * DAY, 'approved');
  assert.ok(pendingOld);

  assert.equal((await call(`/api/reveal/${token}`)).body.savedUntil, null, 'nothing before release');
  await call(`${admin}/cosplayers/${cid}/release`, { method: 'POST', json: { released: true } });
  assert.equal((await call(`/api/reveal/${token}`)).body.savedUntil, now - 10 * DAY + 90 * DAY);

  // Hiding the earliest item moves the date to the next one; showing it again moves it back.
  const hide = (id, hidden) => call(`/api/reveal/${token}/items/${id}`, { method: 'POST', json: { hidden } });
  assert.equal((await hide(first, true)).body.savedUntil, now - 5 * DAY + 90 * DAY);
  assert.equal((await hide(first, false)).body.savedUntil, now - 10 * DAY + 90 * DAY);

  // Closing with 7 days of retention comes well before the cap.
  const closed = (await call(`${admin}/event`, { method: 'PATCH', json: { open: false, retentionDays: 7 } })).body.event;
  assert.equal((await call(`/api/reveal/${token}`)).body.savedUntil, closed.closedAt + 7 * DAY);

  // Deleting everything leaves nothing to save.
  for (const id of [first, second]) await call(`/api/reveal/${token}/items/${id}`, { method: 'DELETE' });
  assert.equal((await call(`/api/reveal/${token}`)).body.savedUntil, null);
});

// ---------- "Download all" bundle (Step 2) ----------
test('the bundle holds only what the cosplayer sees: no ids, tokens, codes, hashes, hidden or pending items', async () => {
  const f = await revealFixture();
  await call(`${f.admin}/cosplayers/${f.cid}/release`, { method: 'POST', json: { released: true } });
  const hiddenId = (await submit(f.eid, f.cid, { consent: '1', message: 'hidden by the cosplayer' }, await jpeg(1200, 900))).body.id;
  await call(`${f.admin}/submissions/bulk`, { method: 'POST', json: { ids: [hiddenId], status: 'approved' } });
  await call(`${f.r}/items/${hiddenId}`, { method: 'POST', json: { hidden: true } });
  const bigId = (await submit(f.eid, f.cid, { consent: '1' }, await jpeg(1600, 1200))).body.id;
  await call(`${f.admin}/submissions/bulk`, { method: 'POST', json: { ids: [bigId], status: 'approved' } });

  const res = await fetch(`${base}${f.r}/download.zip?lang=zh-Hant&tz=-480`);
  assert.equal(res.status, 200);
  const files = readZip(Buffer.from(await res.arrayBuffer()));
  const byName = Object.fromEntries(files.map((x) => [x.name, x.data]));
  assert.equal(files[0].name, 'index.html', 'the gallery comes first');
  const manifest = JSON.parse(byName['manifest.json'].toString('utf8'));

  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.language, 'zh-Hant');
  assert.deepEqual(manifest.event, { name: 'Shared', date: manifest.event.date });
  assert.match(manifest.event.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(manifest.cosplayer, { name: 'Aki' });
  assert.equal(manifest.revealStyle, 'mosaic');
  assert.deepEqual(manifest.items.map(({ type, credit, note, edited }) => ({ type, credit, note, edited })), [
    { type: 'photo', credit: 'Mika', note: 'You were amazing', edited: false },
    { type: 'photo', credit: null, note: null, edited: false },
    { type: 'note', credit: null, note: 'Loved the wig', edited: undefined },
    { type: 'photo', credit: null, note: null, edited: false },
  ], 'approved and not hidden, in upload order; the uncredited name is left out');

  // Every file the manifest names is in the ZIP; thumbnails are grid-sized.
  for (const item of manifest.items.filter((i) => i.type === 'photo')) {
    assert.ok(byName[item.file] && byName[item.thumb], item.file);
    const meta = await sharp(byName[item.thumb]).metadata();
    assert.ok(Math.max(meta.width, meta.height) <= 600, `${item.thumb}: ${meta.width}x${meta.height}`);
  }
  assert.equal((await sharp(byName['thumbs/photo-0003.jpg']).metadata()).width, 600, 'a big photo is shrunk to 600');

  // Nothing in the text of the bundle can be used against the API, or names someone who didn't ask.
  const text = ['index.html', 'manifest.json', 'messages.txt'].map((n) => byName[n].toString('utf8')).join('\n');
  const cos = db.cosplayers[f.cid], ev = db.events[f.eid];
  const subs = Object.values(db.submissions).filter((s) => s.cosplayerId === f.cid);
  const secrets = [cos.id, cos.revealToken, ev.id, ev.organizerToken, ...subs.flatMap((s) => [s.id, s.codeHash, s.file].filter(Boolean))];
  for (const secret of secrets) assert.ok(!text.includes(secret), `leaked ${secret}`);
  for (const words of ['Secret Name', 'not yet', 'hidden by the cosplayer']) assert.ok(!text.includes(words), words);
  assert.ok(!Object.keys(byName).some((n) => /[0-9a-f]{32}/.test(n)), 'no file ids in names');

  // The gallery is in the page language and loads only files from the ZIP.
  const html = byName['index.html'].toString('utf8');
  assert.match(html, /<html lang="zh-Hant">/);
  assert.match(html, /謝謝你，Aki/);
  assert.doesNotMatch(html, /<script|https?:/);
  for (const [, ref] of html.matchAll(/(?:src|href)="([^"]*)"/g)) assert.ok(byName[ref], `${ref} is in the ZIP`);
});

test('the bundle\'s date follows the browser\'s time zone; a bad tz is ignored', async () => {
  const f = await revealFixture();
  await call(`${f.admin}/cosplayers/${f.cid}/release`, { method: 'POST', json: { released: true } });
  const first = Math.min(...Object.values(db.submissions).filter((s) => s.cosplayerId === f.cid && s.status === 'approved').map((s) => s.createdAt));
  const dateFor = async (q) => {
    const files = readZip(Buffer.from(await (await fetch(`${base}${f.r}/download.zip${q}`)).arrayBuffer()));
    return JSON.parse(files.find((x) => x.name === 'manifest.json').data.toString('utf8')).event.date;
  };
  const local = (tz) => new Date(first - tz * 60e3).toISOString().slice(0, 10);
  assert.equal(await dateFor('?tz=-840'), local(-840));
  assert.equal(await dateFor('?tz=720'), local(720));
  assert.equal(await dateFor('?tz=9999'), local(0));
  assert.equal(await dateFor('?tz=abc'), local(0));
});

// ---------- reveal styles (Step 3) ----------
test('the event sets the default reveal style; mosaic by default; the bundle records it', async () => {
  const ev = await makeEvent('Styles');
  const { admin, cid } = ev;
  const patch = (json) => call(`${admin}/event`, { method: 'PATCH', json });
  assert.equal((await call(admin)).body.event.style, 'mosaic');
  const token = await revealToken(admin, cid);
  assert.equal((await call(`/api/reveal/${token}`)).body.event.style, 'mosaic');
  assert.equal((await patch({ style: 'constellation' })).body.event.style, 'constellation');
  assert.equal((await patch({ name: 'Styles 2' })).body.event.style, 'constellation', 'left alone when not sent');
  for (const bad of ['Polaroid', 'constructor', '', null, 3]) assert.equal((await patch({ style: bad })).status, 400, String(bad));
  assert.equal((await call(`/api/reveal/${token}`)).body.event.style, 'constellation');

  await submit(ev.eid, cid, { consent: '1', message: 'hi' });
  const id = Object.values(db.submissions).find((s) => s.cosplayerId === cid).id;
  await call(`${admin}/submissions/${id}`, { method: 'PATCH', json: { status: 'approved' } });
  await call(`${admin}/cosplayers/${cid}/release`, { method: 'POST', json: { released: true } });
  const files = readZip(Buffer.from(await (await fetch(`${base}/api/reveal/${token}/download.zip`)).arrayBuffer()));
  assert.equal(JSON.parse(files.find((x) => x.name === 'manifest.json').data.toString('utf8')).revealStyle, 'constellation');

  delete db.events[ev.eid].style; // an event from before styles
  assert.equal((await call(`/api/reveal/${token}`)).body.event.style, 'mosaic');
});

test('a cosplayer can have their own reveal style; null goes back to the event default', async () => {
  const ev = await makeEvent('Own style');
  const { admin, cid } = ev;
  const { cid: other } = await addCosplayer(ev, 'Mei');
  const tokenOf = (id) => revealToken(admin, id);
  const set = (id, style) => call(`${admin}/cosplayers/${id}`, { method: 'PATCH', json: { style } });
  await call(`${admin}/event`, { method: 'PATCH', json: { style: 'polaroid' } });
  assert.deepEqual((await set(cid, 'constellation')).body, { style: 'constellation' });
  assert.equal((await call(`/api/reveal/${await tokenOf(cid)}`)).body.event.style, 'constellation');
  assert.equal((await call(`/api/reveal/${await tokenOf(other)}`)).body.event.style, 'polaroid', 'others keep the default');
  const list = (await call(admin)).body.cosplayers;
  assert.equal(list.find((c) => c.id === cid).style, 'constellation');
  assert.equal(list.find((c) => c.id === other).style, null);
  for (const bad of ['Mosaic', 'constructor', '', 7, undefined]) assert.equal((await set(cid, bad)).status, 400, String(bad));
  assert.deepEqual((await set(cid, null)).body, { style: null });
  assert.equal((await call(`/api/reveal/${await tokenOf(cid)}`)).body.event.style, 'polaroid');
  const elsewhere = await makeEvent('Elsewhere');
  assert.equal((await call(`${elsewhere.admin}/cosplayers/${cid}`, { method: 'PATCH', json: { style: 'mosaic' } })).status, 404);
});

test('the organizer previews a reveal before release: approved items only, view-only, their own seed', async () => {
  const ev = await makeEvent('Preview');
  const { admin, eid, cid, token } = ev;
  const ok = (await submit(eid, cid, { consent: '1', message: 'approved one' })).body.id;
  await submit(eid, cid, { consent: '1', message: 'still pending' });
  await call(`${admin}/submissions/${ok}`, { method: 'PATCH', json: { status: 'approved' } });
  await call(`${admin}/cosplayers/${cid}`, { method: 'PATCH', json: { style: 'constellation' } });

  const p = (await call(`${admin}/cosplayers/${cid}/preview`)).body;
  assert.equal(p.ready, true, 'shown as if released');
  assert.equal(p.preview, true);
  assert.equal(p.event.style, 'constellation');
  assert.deepEqual(p.items.map((i) => i.message), ['approved one']);
  assert.equal(p.seed, await revealToken(admin, cid), 'laid out exactly as the real page');
  assert.equal(db.cosplayers[cid].released, false, 'previewing releases nothing');
  assert.equal((await call(`/api/reveal/${p.seed}`)).body.items.length, 0, 'the real page still shows nothing');

  const other = await makeEvent('Other');
  assert.equal((await call(`${other.admin}/cosplayers/${cid}/preview`)).status, 404, 'scoped to the organizer\'s own event');
  assert.equal((await call(`/api/admin/nope/cosplayers/${cid}/preview`)).status, 404);
  const page = await call(`/admin/${token}/preview/${cid}`);
  assert.equal(page.status, 200);
  assert.match(page.body, /reveal\.js/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal((await call(`/admin/nope/preview/${cid}`)).status, 404);
});

// ---------- favorites (Step 4) ----------
test('favorites: private stars that survive hide and unhide, and a favorites-only ZIP', async () => {
  const f = await revealFixture();
  await call(`${f.admin}/cosplayers/${f.cid}/release`, { method: 'POST', json: { released: true } });
  const item = (id, json) => call(`${f.r}/items/${id}`, { method: 'POST', json });
  const view = async () => Object.fromEntries((await call(f.r)).body.items.map((i) => [i.id, i]));

  assert.equal((await item(f.ids.credited, { favorite: true })).body.favorite, true);
  assert.equal((await item(f.ids.secretNote, { favorite: true })).body.favorite, true);
  assert.equal((await view())[f.ids.anonPhoto].favorite, false);
  assert.equal((await item(f.ids.credited, { favorite: 'yes' })).status, 400);
  assert.equal((await item(f.ids.credited, {})).status, 400);

  // Hiding and showing again leaves the star alone.
  await item(f.ids.credited, { hidden: true });
  assert.equal((await view())[f.ids.credited].favorite, true);
  await item(f.ids.credited, { hidden: false });
  const v = await view();
  assert.equal(v[f.ids.credited].favorite, true);
  assert.equal(v[f.ids.credited].hidden, false);

  // The organizer never sees them.
  assert.ok(!JSON.stringify((await call(f.admin)).body).includes('favorite'));

  const zip = async (q) => {
    const files = readZip(Buffer.from(await (await fetch(`${base}${f.r}/download.zip${q}`)).arrayBuffer()));
    return { names: files.map((x) => x.name), manifest: JSON.parse(files.find((x) => x.name === 'manifest.json').data.toString('utf8')) };
  };
  const only = await zip('?only=favorites');
  assert.deepEqual(only.manifest.items.map((i) => [i.note, i.favorite]), [['You were amazing', true], ['Loved the wig', true]]);
  assert.deepEqual(only.names.filter((n) => n.startsWith('photos/')), ['photos/photo-0001.jpg'], 'the unstarred photo stays out');
  const all = await zip('');
  assert.deepEqual(all.manifest.items.map((i) => i.favorite), [true, false, true]);

  // A starred item that's hidden stays out of a favorites-only ZIP too.
  await item(f.ids.secretNote, { hidden: true });
  assert.deepEqual((await zip('?only=favorites')).manifest.items.map((i) => i.note), ['You were amazing']);
});
