// View-only demo as a static site (for GitHub Pages): seeds fresh demo data, reads every page's data
// through the real API (so only what the server would show goes out), and writes plain files.
// Usage: npm run export [-- outDir]   (default: docs)
// Set PUBLIC_URL to the site's address (e.g. https://you.github.io/repo/) so the QR codes point there.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { STYLE_IDS, DEFAULT_STYLE } from '../public/js/styles.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const OUT = path.resolve(ROOT, process.argv[2] || 'docs');
const MARKER = '.fanwall-export'; // only a folder we made ourselves is ever emptied
const SITE = (process.env.PUBLIC_URL || '').replace(/\/*$/, '/');

if (fs.existsSync(OUT)) {
  if (fs.readdirSync(OUT).length && !fs.existsSync(path.join(OUT, MARKER))) {
    console.error(`${OUT} exists and wasn't made by this script; refusing to replace it.`);
    process.exit(1);
  }
  fs.rmSync(OUT, { recursive: true, force: true });
}

// 1. Fresh demo data in a throwaway folder. PORT=9 only aims the seed's "is a server running?"
//    check at a closed port.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fanwall-export-'));
const seed = spawnSync(process.execPath, [path.join(ROOT, 'scripts/seed-demo.js')], {
  env: { ...process.env, DATA_DIR: dataDir, PORT: '9' }, encoding: 'utf8',
});
if (seed.status !== 0) {
  console.error(seed.stdout, seed.stderr);
  process.exit(1);
}

// 2. Ask the real server for each page's data.
process.env.DATA_DIR = dataDir;
const { app } = await import('../server.js');
const { db, mediaPath } = await import('../lib/store.js');
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const get = async (p) => {
  const res = await fetch(`http://127.0.0.1:${server.address().port}${p}`);
  if (!res.ok) throw new Error(`${p}: HTTP ${res.status}`);
  return res.json();
};

const ev = Object.values(db.events)[0];
const cosplayers = Object.values(db.cosplayers).sort((a, b) => a.createdAt - b.createdAt);
const slugOf = new Map(cosplayers.map((c) => [c.id, c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')]));
const media = new Set();

// Media URLs become relative to the site root (pages set <base>), and get collected for copying.
function relink(value) {
  if (typeof value === 'string' && value.startsWith('/media/')) { media.add(value.slice(7)); return value.slice(1); }
  if (Array.isArray(value)) return value.map(relink);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, relink(v)]));
  return value;
}
const write = (rel, data) => {
  const file = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data));
};

// A real event uses the one style its organizer picks; the demo shows every released cosplayer in
// each style too (r/<slug>-polaroid/, r/<slug>-constellation/), with the same items.
const VARIANTS = STYLE_IDS.filter((s) => s !== DEFAULT_STYLE);
for (const c of cosplayers) {
  const slug = slugOf.get(c.id);
  const reveal = relink(await get(`/api/reveal/${c.revealToken}`));
  write(`api/reveal/${slug}.json`, reveal);
  if (reveal.ready) for (const style of VARIANTS) write(`api/reveal/${slug}-${style}.json`, { ...reveal, event: { ...reveal.event, style } });
  write(`api/fan/demo/${slug}.json`, relink(await get(`/api/fan/${ev.id}/${c.id}`)));
}
const admin = relink(await get(`/api/admin/${ev.organizerToken}`));
admin.event.id = 'demo';
admin.cosplayers = admin.cosplayers.map((c) => {
  const slug = slugOf.get(c.id);
  return { ...c, id: slug, fanPath: `/e/demo/c/${slug}/`, revealPath: `/r/${slug}/` };
});
admin.submissions = admin.submissions.map((s) => ({ ...s, cosplayerId: slugOf.get(s.cosplayerId) }));
write('api/admin/demo.json', admin);
for (const [, slug] of slugOf) {
  const target = SITE === '/' ? `e/demo/c/${slug}/` : new URL(`e/demo/c/${slug}/`, SITE).href;
  write(`api/admin/demo/qr/${slug}.svg`, await QRCode.toString(target, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' }));
}
server.close();

// 3. Pages: the app's own HTML, marked static, with a relative <base> so any folder works.
function page(template, rel, { banner = false } = {}) {
  const depth = rel.split('/').length - 1;
  let html = fs.readFileSync(path.join(PUBLIC, template), 'utf8')
    .replace('<html ', '<html data-static ')
    .replace('<meta charset="utf-8">', `<meta charset="utf-8">\n  <base href="${'../'.repeat(depth) || './'}">`)
    .replace(/(href|src)="\//g, '$1="');
  if (banner) {
    html = html.replace(/<body([^>]*)>/, '<body$1>\n  <p class="demo-banner"><span data-i18n="demo.banner"></span> · <a href="" data-i18n="demo.allPages"></a></p>');
  }
  write(rel, html);
}
const released = new Set(cosplayers.filter((c) => c.released).map((c) => slugOf.get(c.id)));
for (const [, slug] of slugOf) {
  page('reveal.html', `r/${slug}/index.html`);
  if (released.has(slug)) for (const style of VARIANTS) page('reveal.html', `r/${slug}-${style}/index.html`);
  page('fan.html', `e/demo/c/${slug}/index.html`, { banner: true });
  page('print.html', `admin/demo/print/${slug}/index.html`, { banner: true });
}
page('admin.html', 'admin/demo/index.html', { banner: true });

const name = (slug) => cosplayers.find((c) => slugOf.get(c.id) === slug)?.name ?? slug;
const revealCases = ['yuki', 'aki', 'mei', 'rin', 'sora', 'kai'].filter((slug) => [...slugOf.values()].includes(slug));
const styleLinks = (slug) => !released.has(slug) ? '' : `<span class="demo-styles">${STYLE_IDS.map((s) =>
  `<a href="r/${s === DEFAULT_STYLE ? slug : `${slug}-${s}`}/" data-i18n="style.${s}.name"></a>`).join(' · ')}</span>`;
// The hub's words are in the catalogs too (demo.*), so its switcher works like every other page's.
const attr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const vars = (v) => `data-i18n-vars="${attr(JSON.stringify(v))}"`;
write('index.html', `<!doctype html>
<html data-static lang="en" class="i18n-pending">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title data-i18n="demo.hub.title"></title>
  <link rel="icon" href="favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="css/app.css">
</head>
<body class="landing">
  <main>
    <header class="topbar">
      <span class="wordmark">FanWall</span>
      <div class="topbar-end">
        <span class="chip" data-i18n="demo.banner"></span>
        <div class="lang-switch" data-lang-switch></div>
      </div>
    </header>
    <section class="spotlight" aria-labelledby="hero-h">
      <h1 id="hero-h">FanWall</h1>
      <p class="lead" data-i18n="demo.hub.lead"></p>
    </section>
    <section class="panel" aria-labelledby="rev-h">
      <h2 id="rev-h" data-i18n="demo.hub.revealHeading"></h2>
      <p class="muted" data-i18n="demo.hub.revealText"></p>
      <ul class="demo-links">
${revealCases.map((slug) => `        <li><a href="r/${slug}/">${attr(name(slug))}</a><span data-i18n="demo.case.${slug}"></span>${styleLinks(slug)}</li>`).join('\n')}
      </ul>
    </section>
    <section class="panel" aria-labelledby="fan-h">
      <h2 id="fan-h" data-i18n="demo.hub.fanHeading"></h2>
      <p class="muted" data-i18n="demo.hub.fanText"></p>
      <ul class="demo-links"><li><a href="e/demo/c/${slugOf.get(cosplayers[0].id)}/" data-i18n="fan.titleFor" ${vars({ name: cosplayers[0].name })}></a></li></ul>
    </section>
    <section class="panel" aria-labelledby="org-h">
      <h2 id="org-h" data-i18n="demo.hub.orgHeading"></h2>
      <p class="muted" data-i18n="demo.hub.orgText"></p>
      <ul class="demo-links"><li><a href="admin/demo/" data-i18n="admin.heading"></a></li></ul>
    </section>
  </main>
  <script type="module" src="js/i18n.js"></script>
</body>
</html>
`);

// 4. Assets. Fonts in app.css are absolute (/fonts/...); here they're relative to the stylesheet.
for (const dir of ['css', 'js', 'fonts', 'locales']) fs.cpSync(path.join(PUBLIC, dir), path.join(OUT, dir), { recursive: true });
fs.copyFileSync(path.join(PUBLIC, 'favicon.svg'), path.join(OUT, 'favicon.svg'));
const css = path.join(OUT, 'css/app.css');
fs.writeFileSync(css, fs.readFileSync(css, 'utf8').replaceAll('url("/fonts/', 'url("../fonts/'));
for (const file of media) {
  const src = mediaPath(file);
  if (fs.existsSync(src)) write(`media/${file}`, fs.readFileSync(src));
}
write('.nojekyll', ''); // serve files as they are, no Jekyll processing
write(MARKER, 'Made by scripts/export-static.js. Safe to delete and re-create.\n');
fs.rmSync(dataDir, { recursive: true, force: true });

console.log(`Static demo written to ${path.relative(ROOT, OUT) || '.'}/ (${media.size} media files).`);
if (SITE === '/') console.log('Tip: set PUBLIC_URL to the site address before exporting so the QR codes on the signs work.');
process.exit(0);
