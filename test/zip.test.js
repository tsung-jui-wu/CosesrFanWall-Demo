import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import zlib from 'node:zlib';
import { streamZip } from '../lib/zip.js';

// Minimal stand-in for an HTTP response: collects bytes, can simulate backpressure or a hang-up.
function fakeRes({ full = false } = {}) {
  const res = new EventEmitter();
  res.chunks = [];
  res.destroyed = false;
  res.write = (b) => { res.chunks.push(Buffer.from(b)); return !full; };
  res.end = (b) => { if (b) res.chunks.push(Buffer.from(b)); res.ended = true; };
  return res;
}

test('streamZip writes a readable store-only archive', async () => {
  const res = fakeRes();
  const a = Buffer.from('hello'), b = Buffer.from('ありがとう');
  await streamZip(res, [{ name: 'a.txt', data: a }, { name: 'メッセージ.txt', data: b }]);
  const zip = Buffer.concat(res.chunks);
  assert.ok(res.ended);
  const eocd = zip.length - 22;
  assert.equal(zip.readUInt32LE(eocd), 0x06054b50);
  assert.equal(zip.readUInt16LE(eocd + 10), 2);
  // First local header: name, then the stored bytes, with a matching CRC.
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.equal(zip.readUInt32LE(14), zlib.crc32(a));
  const nameLen = zip.readUInt16LE(26);
  assert.equal(zip.subarray(30, 30 + nameLen).toString(), 'a.txt');
  assert.deepEqual(zip.subarray(30 + nameLen, 30 + nameLen + a.length), a);
  // Central directory starts where the EOCD says it does.
  assert.equal(zip.readUInt32LE(zip.readUInt32LE(eocd + 16)), 0x02014b50);
});

test('streamZip rejects instead of hanging when the client disconnects', async () => {
  const res = fakeRes({ full: true });
  const p = streamZip(res, [{ name: 'a', data: Buffer.alloc(10) }, { name: 'b', data: Buffer.alloc(10) }]);
  setImmediate(() => { res.destroyed = true; res.emit('close'); });
  await assert.rejects(p, /disconnected/);
  assert.equal(res.listenerCount('drain'), 0);
  assert.equal(res.listenerCount('close'), 0);
});
