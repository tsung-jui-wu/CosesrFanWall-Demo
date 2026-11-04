// "Download all": the cosplayer's keepsake. A store-only ZIP (lib/zip.js) holding a gallery page that
// works offline (index.html), manifest.json for programs to read (the year in review), messages.txt,
// and the photos. The format is documented in BUNDLE-FORMAT.md; bump BUNDLE_SCHEMA for a change that
// would break a reader. Nothing goes in that the cosplayer can't already see on their page: no ids,
// tokens, delete codes, or hashes, no hidden or unapproved items, and a fan's name only if credited.
import { translate } from './i18n.js';
import { INTL } from '../public/js/i18n-core.js';

export const BUNDLE_SCHEMA = 1;

const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

// The calendar day of `ts` on the cosplayer's own clock. tz is Date#getTimezoneOffset() from their
// browser (minutes behind UTC); the result is read with UTC getters.
const localDay = (ts, tz) => new Date(ts - tz * 60e3);

// System fonts only: the page must not load anything. Simplified and Traditional get their own glyphs.
const CJK = {
  'zh-Hant': '"PingFang TC", "Microsoft JhengHei", "Noto Sans CJK TC", "Noto Sans TC"',
  other: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Noto Sans SC"',
};
const style = (lang) => `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: #090909; color: #fff;
  font: 15px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, ${CJK[lang] ?? CJK.other}, sans-serif; }
main { max-width: 1100px; margin: 0 auto; padding: 24px 15px 48px; }
header { border-radius: 26px; padding: 26px 22px; margin-bottom: 18px; background: linear-gradient(135deg, #6a4cf5, #b23ad4); }
header p { margin: 0; }
.eyebrow { margin-bottom: 10px; font-size: 13px; font-weight: 600; overflow-wrap: anywhere; }
h1 { margin: 0; font-size: clamp(32px, 9vw, 52px); line-height: 1.1; font-weight: 600; overflow-wrap: anywhere; }
.sub { margin-top: 12px; font-size: 16px; }
.hint { margin-top: 8px; font-size: 13px; opacity: 0.85; }
.grid { display: grid; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(min(160px, 45%), 1fr)); }
.item { margin: 0; background: #141414; border-radius: 16px; overflow: hidden; display: flex; flex-direction: column; }
.item a { display: block; }
.item img { display: block; width: 100%; aspect-ratio: 3 / 4; object-fit: cover; background: #1c1c1c; }
.item figcaption { padding: 10px 12px 12px; font-size: 14px; overflow-wrap: anywhere; white-space: pre-wrap; }
.item figcaption p { margin: 0; }
.note { justify-content: center; padding: 18px 14px; min-height: 160px; }
.note blockquote { margin: 0; font-size: 17px; line-height: 1.35; overflow-wrap: anywhere; white-space: pre-wrap; }
.who { color: #999; font-size: 13px; margin-top: 6px !important; }
footer { color: #999; font-size: 13px; text-align: center; margin-top: 28px; }
`;

// items: what the cosplayer can see, in upload order:
//   { message, credit (the fan's name if they asked for credit, else ''), photo, edited, favorite, createdAt }
// Returns each item's photo file name (or null), the manifest, the gallery page, and messages.txt.
export function planBundle({ event, cosplayer, items, lang, tz = 0, revealStyle = 'mosaic', fallbackDate = Date.now() }) {
  const t = (key, vars) => translate(lang, key, vars);
  let n = 0;
  const photos = items.map((it) => (it.photo ? `photo-${String(++n).padStart(4, '0')}.jpg` : null));

  // The event's date is the day its first item arrived, on the cosplayer's clock.
  const first = items.length ? Math.min(...items.map((it) => it.createdAt)) : fallbackDate;
  const day = localDay(first, tz);
  const date = day.toISOString().slice(0, 10);
  const dateText = new Intl.DateTimeFormat(INTL[lang] ?? 'en', { dateStyle: 'long', timeZone: 'UTC' }).format(day);

  const manifest = {
    schemaVersion: BUNDLE_SCHEMA,
    language: lang,
    event: { name: event.name, date },
    cosplayer: { name: cosplayer.name },
    revealStyle,
    items: items.map((it, i) => {
      const photo = photos[i];
      const files = photo
        ? { file: `photos/${photo}`, thumb: `thumbs/${photo}`, ...(it.edited ? { unedited: `unedited/${photo}` } : {}), edited: Boolean(it.edited) }
        : {};
      return { type: photo ? 'photo' : 'note', ...files, credit: it.credit || null, note: it.message || null, favorite: Boolean(it.favorite) };
    }),
  };

  // messages.txt: the notes and credits, with the photo each one came with. CRLF for Notepad.
  const lines = [t('zip.header', { event: event.name }), ''];
  items.forEach((it, i) => {
    if (!it.message && !it.credit) return;
    const text = it.message || t('zip.photo');
    lines.push(`${photos[i] ? `[${photos[i]}] ` : ''}${it.credit ? t('zip.credited', { text, name: it.credit }) : text}`, '');
  });

  // index.html: plain HTML and CSS, no scripts, nothing from the network, so it opens from a phone's
  // Files app with the network off. Every bit of text is escaped; fans wrote some of it.
  const hasPhotos = photos.some(Boolean), hasNotes = items.some((it) => it.message);
  const kind = hasPhotos && hasNotes ? 'both' : hasPhotos ? 'photos' : 'notes';
  const cards = items.map((it, i) => {
    const who = it.credit ? `<p class="who">${esc(t('reveal.from', { name: it.credit }))}</p>` : '';
    const photo = photos[i];
    if (!photo) return `<figure class="item note"><blockquote>${esc(it.message)}</blockquote>${who}</figure>`;
    const alt = t(it.message ? 'reveal.lb.photoAlt' : 'reveal.lb.photoAltNoMessage');
    const caption = it.message || it.credit ? `<figcaption>${it.message ? `<p>${esc(it.message)}</p>` : ''}${who}</figcaption>` : '';
    return `<figure class="item"><a href="photos/${photo}"><img src="thumbs/${photo}" alt="${esc(alt)}" loading="lazy"></a>${caption}</figure>`;
  });
  const title = t('reveal.thankYou', { name: cosplayer.name });
  const html = `<!doctype html>
<html lang="${esc(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta http-equiv="Content-Security-Policy" content="script-src 'none'; connect-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'">
<title>${esc(title)}</title>
<style>${style(lang)}</style>
</head>
<body>
<main>
<header>
<p class="eyebrow">${esc(event.name)} · ${esc(dateText)}</p>
<h1>${esc(title)}</h1>
<p class="sub">${esc(t(`reveal.caption.${kind}`, { event: event.name }))}</p>
${hasPhotos ? `<p class="hint">${esc(t('zip.gallery.hint'))}</p>` : ''}
</header>
<section class="grid">
${cards.join('\n')}
</section>
<footer>${esc(t('zip.gallery.footer'))}</footer>
</main>
</body>
</html>
`;
  return { photos, manifest, html, messages: lines.join('\r\n') };
}
