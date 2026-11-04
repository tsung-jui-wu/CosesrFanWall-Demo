# FanWall: project notes for Claude Code

Read `PLAN.md` first. It holds the spec, route list, privacy checklist, mosaic algorithm, and milestones. Work one milestone at a time and verify before moving on.

## Commands

- `npm start`: run the server (`node server.js`)
- `npm run dev`: run with `node --watch`
- `npm test`: `node --test`
- `npm run seed`: create demo data
- `npm run export`: build the view-only static demo into `docs/` (for GitHub Pages)

## Conventions

- ES modules everywhere (`"type": "module"`). Node 22+.
- No front-end build step. Plain HTML, CSS, and ES modules under `public/`.
- No inline `style="…"` attributes: the CSP blocks them (they silently do nothing). Use a class in `public/css/app.css`, where the design tokens live.
- `public/js/mosaic.js` and `public/js/edit.js` must stay **DOM-free and pure** so they can be tested in Node (and `edit.js` runs on the server too). The same goes for `bundle-read.js`, `review-plan.js`, and `ics.js`. Canvas code lives elsewhere (`reveal.js`, `editor.js`, `render.js`, `review.js`).
- Keep the consent wording in `lib/consent.js` only, in all three languages. Bump `CONSENT_VERSION` whenever any of the wording changes.
- No hardcoded user-facing words in pages or scripts: add keys to all three catalogs in `public/locales/` and use `t()` or `data-i18n`. The server sends error codes (`{error: 'code', ...details}`), never sentences. See "Languages" in PLAN.md.
- All storage goes through `lib/store.js`. Do not write `db.json` from anywhere else.

## Privacy rules (do not break these)

- Never store or log IP addresses or emails.
- Fan delete codes are stored only as a SHA-256 hash; never log them.
- Always re-encode uploads with sharp; never keep or serve an original upload.
- Media file names are 128-bit random hex and served only via the regex-checked `/media/:file` route.
- Nothing is visible to a cosplayer until the submission is approved **and** the cosplayer is released.
- Retention purge must keep working: deleted `retentionDays` after the event closes, hard cap 90 days.
- Do not add analytics, trackers, or third-party scripts or fonts to any page. Fonts are self-hosted in `public/fonts/`.
- No counts, rankings, or comparisons between cosplayers on fan-facing or cosplayer-facing pages. Counts belong on the organizer dashboard only.
- A cosplayer's own mosaic image follows the same retention purge as submissions and is deleted with the cosplayer (and on opt-out).

## Testing expectations

- Mosaic: determinism, quality versus random, reuse and spacing limits, float and partial-coverage modes.
- Edit: `normalizeEdit` validation, crops always inside the photo, tone curves monotonic, Auto fixes a dark tinted photo but leaves a good one (and a red costume) alone.
- Store: `purgeExpired` with a fake clock; removal helpers delete files.
- API: consent required, delete code works, unapproved items never appear in `/api/reveal/*`, edits never change the stored photo file.
- Bundle ("Download all"): no ids, tokens, delete codes, or hashes, and no hidden, unapproved, or uncredited-name content in `index.html`, `manifest.json`, or `messages.txt`; the gallery loads nothing from the network. Keep `BUNDLE-FORMAT.md` in step with `lib/bundle.js`.
- Year in review: a ZIP written by `lib/zip.js` reads back with `bundle-read.js`; `planReview` carries no counts.
