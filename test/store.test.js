import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fanwall-store-'));
process.env.DATA_DIR = dir;
const store = await import('../lib/store.js');
const { db, mediaPath, purgeExpired, removeSubmission, removeCosplayer, removeEvent, findEventByToken, HARD_CAP_DAYS } = store;

const DAY = 86400e3;
const T0 = Date.UTC(2026, 0, 1);

function reset() {
  for (const k of ['events', 'cosplayers', 'submissions']) db[k] = {};
}
function addEvent(id, extra = {}) {
  db.events[id] = { id, name: id, organizerToken: `tok-${id}`, baseImage: null, open: true, closedAt: null, retentionDays: 30, createdAt: T0, ...extra };
}
function addSub(id, eventId, { createdAt = T0, cosplayerId = 'c1', withFile = true } = {}) {
  const file = withFile ? id.padEnd(32, '0').slice(0, 32) : null;
  if (file) { fs.writeFileSync(mediaPath(`${file}.jpg`), 'x'); fs.writeFileSync(mediaPath(`${file}_t.jpg`), 'x'); }
  db.submissions[id] = { id, eventId, cosplayerId, file, message: '', name: '', credit: false, status: 'approved', hidden: false, codeHash: '', createdAt };
  return file;
}
const exists = (name) => fs.existsSync(mediaPath(name));

before(reset);
after(() => { store.flush(); fs.rmSync(dir, { recursive: true, force: true }); });

test('purgeExpired keeps open events, purges retentionDays after close', () => {
  reset();
  addEvent('open');
  addEvent('closed', { open: false, closedAt: T0 + 10 * DAY, retentionDays: 30 });
  const fOpen = addSub('aaaa', 'open');
  const fClosed = addSub('bbbb', 'closed');

  assert.equal(purgeExpired(T0 + 39 * DAY), 0);
  assert.ok(db.submissions.bbbb);
  assert.equal(purgeExpired(T0 + 40 * DAY + 1), 1);
  assert.equal(db.submissions.bbbb, undefined);
  assert.ok(!exists(`${fClosed}.jpg`) && !exists(`${fClosed}_t.jpg`));
  assert.ok(db.submissions.aaaa && exists(`${fOpen}.jpg`));
});

test('purgeExpired enforces the hard cap even while the event stays open', () => {
  reset();
  addEvent('open');
  addEvent('longretention', { open: false, closedAt: T0 + 80 * DAY, retentionDays: 90 });
  addSub('cccc', 'open');
  addSub('dddd', 'longretention');
  addSub('eeee', 'open', { createdAt: T0 + 50 * DAY });
  assert.equal(purgeExpired(T0 + HARD_CAP_DAYS * DAY), 0);
  assert.equal(purgeExpired(T0 + HARD_CAP_DAYS * DAY + 1), 2);
  assert.deepEqual(Object.keys(db.submissions), ['eeee']);
});

test('purgeExpired removes submissions whose event is gone', () => {
  reset();
  const f = addSub('ffff', 'missing');
  assert.equal(purgeExpired(T0 + DAY), 1);
  assert.ok(!exists(`${f}.jpg`));
});

test('removeSubmission deletes both files; message-only submissions are fine', () => {
  reset();
  addEvent('e');
  const f = addSub('gggg', 'e');
  addSub('hhhh', 'e', { withFile: false });
  removeSubmission('gggg');
  removeSubmission('hhhh');
  removeSubmission('nope');
  assert.ok(!exists(`${f}.jpg`) && !exists(`${f}_t.jpg`));
  assert.deepEqual(db.submissions, {});
});

test('removeCosplayer deletes only that cosplayer and their files', () => {
  reset();
  addEvent('e');
  db.cosplayers.c1 = { id: 'c1', eventId: 'e' };
  db.cosplayers.c2 = { id: 'c2', eventId: 'e' };
  const f1 = addSub('iiii', 'e', { cosplayerId: 'c1' });
  const f2 = addSub('jjjj', 'e', { cosplayerId: 'c2' });
  removeCosplayer('c1');
  assert.equal(db.cosplayers.c1, undefined);
  assert.ok(db.cosplayers.c2 && db.submissions.jjjj);
  assert.ok(!exists(`${f1}.jpg`) && exists(`${f2}.jpg`));
});

test('removeEvent deletes cosplayers, submissions, and the base image', () => {
  reset();
  const baseId = 'b'.repeat(32);
  fs.writeFileSync(mediaPath(`base_${baseId}.jpg`), 'x');
  addEvent('e', { baseImage: baseId });
  db.cosplayers.c1 = { id: 'c1', eventId: 'e' };
  const f = addSub('kkkk', 'e');
  removeEvent('e');
  assert.deepEqual([db.events, db.cosplayers, db.submissions], [{}, {}, {}]);
  assert.ok(!exists(`${f}.jpg`) && !exists(`base_${baseId}.jpg`));
});

test('a cosplayer own mosaic image is purged on the submission schedule and removed with them', () => {
  reset();
  const own = (ch) => ch.repeat(32);
  for (const ch of ['1', '2', '3', '4']) fs.writeFileSync(mediaPath(`base_${own(ch)}.jpg`), 'x');
  addEvent('closed', { open: false, closedAt: T0 + 10 * DAY });
  addEvent('open');
  db.cosplayers.a = { id: 'a', eventId: 'closed', baseImage: own('1'), baseAt: T0 };
  db.cosplayers.b = { id: 'b', eventId: 'open', baseImage: own('2'), baseAt: T0 };
  db.cosplayers.c = { id: 'c', eventId: 'open', baseImage: own('3') }; // no timestamp: fail toward deleting

  purgeExpired(T0 + 40 * DAY);
  assert.ok(exists(`base_${own('1')}.jpg`) && exists(`base_${own('2')}.jpg`));
  assert.ok(!exists(`base_${own('3')}.jpg`) && db.cosplayers.c.baseImage === null);
  purgeExpired(T0 + 40 * DAY + 1); // 30 retention days after the close
  assert.ok(!exists(`base_${own('1')}.jpg`) && db.cosplayers.a.baseImage === null);
  assert.ok(exists(`base_${own('2')}.jpg`));
  purgeExpired(T0 + HARD_CAP_DAYS * DAY + 1); // hard cap while the event stays open
  assert.ok(!exists(`base_${own('2')}.jpg`) && db.cosplayers.b.baseImage === null);
  assert.ok(db.cosplayers.a && db.cosplayers.b, 'the cosplayers themselves are kept');

  db.cosplayers.d = { id: 'd', eventId: 'open', baseImage: own('4'), baseAt: T0 };
  store.removeOrphanFiles(Date.now() + 2 * 3600e3);
  assert.ok(exists(`base_${own('4')}.jpg`), 'a live cosplayer image is not an orphan');
  removeEvent('open');
  assert.ok(!exists(`base_${own('4')}.jpg`) && !db.cosplayers.d);
});

test('removeOrphanFiles deletes unreferenced old files only', () => {
  reset();
  for (const f of fs.readdirSync(store.UPLOAD_DIR)) fs.unlinkSync(mediaPath(f)); // leftovers from earlier tests
  addEvent('e', { baseImage: 'c'.repeat(32) });
  fs.writeFileSync(mediaPath(`base_${'c'.repeat(32)}.jpg`), 'x');
  const live = addSub('llll', 'e');
  const orphan = 'd'.repeat(32);
  fs.writeFileSync(mediaPath(`${orphan}.jpg`), 'x');
  const now = Date.now();
  assert.equal(store.removeOrphanFiles(now), 0, 'fresh orphans are left for in-flight uploads');
  assert.equal(store.removeOrphanFiles(now + 2 * 3600e3), 1);
  assert.ok(!exists(`${orphan}.jpg`));
  assert.ok(exists(`${live}.jpg`) && exists(`${live}_t.jpg`) && exists(`base_${'c'.repeat(32)}.jpg`));
});

test('findEventByToken matches exactly and survives odd input', () => {
  reset();
  addEvent('e');
  assert.equal(findEventByToken('tok-e')?.id, 'e');
  assert.equal(findEventByToken('tok-x'), undefined);
  assert.equal(findEventByToken('tok-é'), undefined); // same string length, different byte length
  assert.equal(findEventByToken(undefined), undefined);
});

test('purgeExpired treats a record without a valid createdAt as expired', () => {
  reset();
  addEvent('e');
  addSub('mmmm', 'e', { createdAt: null, withFile: false }); // null, not undefined: undefined would take the default
  assert.equal(purgeExpired(T0), 1);
});

test('removeOrphanFiles never touches files it did not name', () => {
  reset();
  for (const f of fs.readdirSync(store.UPLOAD_DIR)) fs.unlinkSync(mediaPath(f));
  fs.writeFileSync(mediaPath('notes.txt'), 'x');
  assert.equal(store.removeOrphanFiles(Date.now() + 10 * 3600e3), 0);
  assert.ok(exists('notes.txt'));
});

test('getOwn ignores inherited keys', () => {
  assert.equal(store.getOwn({}, 'constructor'), undefined);
  assert.equal(store.getOwn({}, '__proto__'), undefined);
  assert.equal(store.getOwn({ a: 1 }, 'a'), 1);
  assert.equal(store.getOwn({ a: 1 }, 1), undefined);
});
