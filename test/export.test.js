import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const run = (out) => spawnSync(process.execPath, ['scripts/export-static.js', out], { encoding: 'utf8', env: { ...process.env, PUBLIC_URL: 'https://demo.example/repo/' } });
const files = (dir) => fs.readdirSync(dir, { recursive: true }).map((f) => path.join(dir, f)).filter((f) => fs.statSync(f).isFile());

test('the static demo publishes only what the reveal API would show, and no secrets', { timeout: 120000 }, () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'fanwall-static-'));
  try {
    const r = run(out);
    assert.equal(r.status, 0, r.stderr);
    const all = files(out);
    const json = all.filter((f) => f.endsWith('.json'));
    for (const f of json) {
      const text = fs.readFileSync(f, 'utf8');
      // (The fan page's consent *wording* is expected; a fan's stored consent record, {v, at}, is not.)
      assert.doesNotMatch(text, /codeHash|organizerToken|revealToken|deleteCode|"consent":\{"v":/, f);
      assert.doesNotMatch(text, /"\/media\//, `${f}: media links must be relative`);
    }
    const admin = JSON.parse(fs.readFileSync(path.join(out, 'api/admin/demo.json'), 'utf8'));
    const byId = new Map(admin.submissions.map((s) => [s.id, s]));
    for (const c of admin.cosplayers) {
      const reveal = JSON.parse(fs.readFileSync(path.join(out, `api/reveal/${c.id}.json`), 'utf8'));
      if (!c.released) assert.deepEqual(reveal.items, [], `${c.id}: nothing before release`);
      for (const item of reveal.items) {
        const s = byId.get(item.id);
        assert.equal(s.status, 'approved', `${c.id}: only approved items`);
        if (!s.credit) assert.equal(item.name, '', `${c.id}: names only when credited`);
      }
    }
    // Every media file a page points at was copied, and nothing else was.
    const linked = new Set(json.flatMap((f) => fs.readFileSync(f, 'utf8').match(/media\/[^"]+/g) ?? []));
    for (const m of linked) assert.ok(fs.existsSync(path.join(out, m)), m);
    assert.equal(fs.readdirSync(path.join(out, 'media')).length, linked.size);
    // Pages are marked static and work from any folder.
    const reveal = fs.readFileSync(path.join(out, 'r/yuki/index.html'), 'utf8');
    assert.match(reveal, /<html lang="en" data-static>/);
    assert.match(reveal, /<base href="\.\.\/\.\.\/">/);
    assert.doesNotMatch(reveal, /(href|src)="\//, 'no root-absolute links');
    assert.match(fs.readFileSync(path.join(out, 'api/admin/demo/qr/aki.svg'), 'utf8'), /<svg/);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('the export refuses to replace a folder it did not make', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'fanwall-static-'));
  try {
    fs.writeFileSync(path.join(out, 'keep.txt'), 'mine');
    const r = run(out);
    assert.notEqual(r.status, 0);
    assert.equal(fs.readFileSync(path.join(out, 'keep.txt'), 'utf8'), 'mine');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
