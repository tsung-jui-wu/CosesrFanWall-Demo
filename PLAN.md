# FanWall: build plan

A fan-made tool that lets an event **organizer** collect photos and messages from fans for each guest cosplayer, then hand the cosplayer one link that plays a "thank you" reveal: photos and notes fly in and assemble into a mosaic of the organizer's event/booth photo. The cosplayer can then export the mosaic for their own social accounts.

Why it exists: tagging a cosplayer on Instagram floods their notifications and most fan photos never reach them. This gives them one calm inbox, moderated by the organizer, with a moment worth having at the end.

## Decisions already made

- **Organizer-run.** Organizers create the event, print QR signs, moderate, and release the link. Fans never need an account.
- **Mosaic target = organizer's image** (event photo, booth shot, key art the organizer has rights to). Not the cosplayer's face, not licensed character art by default.
- **Fewer photos than a full mosaic needs:** blend smoothly into a "ghost image + floating items" look instead of a hard switch (see Mosaic algorithm).
- **Messages** are never mosaic tiles. They always float as small paper notes.
- **Privacy and consent are first-class**: consent text is visible on the fan page, organizer approves before the cosplayer sees anything, cosplayer can hide, remove, or wipe everything, fans can delete their own submission.
- **After the reveal**, the cosplayer can download everything (ZIP) and export the mosaic image (and use the share sheet on mobile).
- Demo first: single Node server, JSON file storage, deployable to one small host with a persistent volume.

## Stack

- Node 22+, Express, multer (uploads), sharp (re-encode, resize, strip EXIF), qrcode (SVG QR codes).
- Front end: plain HTML, CSS, ES modules. No build step.
- Storage: `data/db.json` plus `data/uploads/`. Behind a small `lib/store.js` so it can be swapped later.
- Tests: `node --test`.

## Status of the repo

Milestones 1 to 7 are done: server, mosaic module, organizer dashboard, print sign, fan page, reveal page and
animation, cosplayer controls (hide, delete, opt-out, ZIP, image export, zoom), photo editing, demo seed, and tests (`npm test`). Also done before Milestone 6: the fairness changes listed under
"Fairness between cosplayers" below.

Not started: Milestone 8 (README, accessibility pass, deploy).

## Data model (`lib/store.js` shape)

```
events[id]       { id, name, organizerToken, baseImage|null (file id), open, closedAt|null,
                   retentionDays (default 30), createdAt }
cosplayers[id]   { id, eventId, name, character, revealToken, released, optOut,
                   baseImage|null (own mosaic image; falls back to the event's), baseAt|null, createdAt }
submissions[id]  { id, eventId, cosplayerId, file|null (hex id; files are <id>.jpg and <id>_t.jpg),
                   message, name, credit (bool), consent {v, at}, status 'pending'|'approved'|'rejected',
                   hidden (cosplayer hid it), edit|null (cosplayer's photo edit, see "Photo editing"),
                   codeHash (sha256 of fan delete code), createdAt }
```

Rules: never store IP addresses or emails. Delete codes are stored only as a hash. File ids are 128-bit random so URLs are unguessable.

## Routes

Pages (static HTML, `Cache-Control: no-store` for token pages):

| Route | Page |
|---|---|
| `/` | landing, "create demo event" form |
| `/e/:eventId/c/:cosplayerId` | fan upload page (QR target) |
| `/admin/:token` | organizer dashboard |
| `/admin/:token/print/:cosplayerId` | printable QR sign |
| `/r/:revealToken` | cosplayer reveal and controls |

API:

| Method and path | Purpose |
|---|---|
| `POST /api/events` | create event `{name, retentionDays?, key?}` (optional `CREATE_KEY` env gate); returns admin path |
| `GET /api/fan/:eid/:cid` | event name, cosplayer name, consent copy, open state |
| `POST /api/fan/:eid/:cid/submit` | multipart: `photo?`, `message?` (max 280), `name?` (max 40), `credit`, `consent=1`; needs photo or message; returns `{id, deleteCode}` |
| `POST /api/fan/delete` | `{id, code}` fan self-delete |
| `GET /api/admin/:token` | event, cosplayers (with counts and reveal links), submissions |
| `PATCH /api/admin/:token/event` | `{name?, open?, retentionDays?}`; setting `open:false` stamps `closedAt` |
| `POST /api/admin/:token/base` | upload mosaic base image (multipart `image`) |
| `POST /api/admin/:token/cosplayers` | add cosplayer `{name, character?}` |
| `DELETE /api/admin/:token/cosplayers/:cid` | remove cosplayer and their content |
| `PATCH /api/admin/:token/submissions/:id` | `{status}` approve or reject |
| `POST /api/admin/:token/submissions/bulk` | `{ids, status}` |
| `POST /api/admin/:token/cosplayers/:cid/release` | `{released}` gate the reveal link |
| `POST /api/admin/:token/release-all` | `{released}` for every cosplayer in the event; opted-out ones are never released |
| `POST /api/admin/:token/cosplayers/:cid/base` | upload this cosplayer's own mosaic image (multipart `image`) |
| `DELETE /api/admin/:token/cosplayers/:cid/base` | go back to the event image |
| `GET /api/admin/:token/qr/:cid.svg` | QR code for the fan URL (uses `PUBLIC_URL` or request host) |
| `GET /api/reveal/:token` | `{ready, event, cosplayer, items[]}`; items are approved only, each with `hidden` flag and `edit` |
| `POST /api/reveal/:token/items/:id` | `{hidden}` |
| `POST /api/reveal/:token/items/:id/edit` | `{edit}` (or `{edit: null}` to undo); photos only; validated by `normalizeEdit` |
| `DELETE /api/reveal/:token/items/:id` | remove permanently |
| `POST /api/reveal/:token/optout` | delete all content for this cosplayer (including their own mosaic image), set `optOut`, fan page closes |
| `GET /api/reveal/:token/download.zip` | all visible photos plus `messages.txt` (with credits), streamed via `lib/zip.js`; edited photos are rendered with the edit, with the unedited copy under `unedited/` |
| `GET /media/:file` | serve `<hex32>.jpg`, `<hex32>_t.jpg`, `base_<hex32>.jpg` only (regex-checked) |

Server behavior: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `robots.txt` disallowing all, `X-Robots-Tag: noindex` on media, per-IP in-memory rate limits (submit about 15 per 10 min; create event about 10 per hour), `trust proxy` via env, cap of about 1500 submissions per cosplayer, multer limit 12 MB and image mimetypes only, sharp `limitInputPixels`, hourly `purgeExpired()` plus one run at boot.

Image pipeline (sharp): auto-rotate, resize to max 2560 px (room for cosplayers to crop and edit), JPEG q82 (full); max 360 px, q75 (thumb). Re-encoding strips EXIF and GPS. Never keep the original upload.

## Privacy and consent checklist (acceptance criteria)

1. The fan page shows the full consent text from `lib/consent.js` before the submit button, plus a required checkbox. Submit is rejected server-side without `consent=1`.
2. Each submission stores `consent.v` and timestamp.
3. Nothing reaches the cosplayer until the organizer approves it and clicks Release.
4. Cosplayer can hide or unhide each item, delete each item, and wipe everything and close the page.
5. Fan gets a delete code after submitting (also kept in their `localStorage`), and delete works without any account.
6. Retention: deleted `retentionDays` after the event closes, never kept longer than 90 days after upload. Covered by a test that calls `purgeExpired(fakeNow)`.
7. Name is optional; it is shown to the cosplayer only if the fan ticked "credit me".
8. No IPs or emails stored or logged.
9. Under-13 note and "bystanders" note are in the consent copy.
10. Exported mosaic contains only small tiles. The README states plainly that the cosplayer may post it.

## Mosaic algorithm (`public/js/mosaic.js`)

Must be **pure and DOM-free** so it runs in the browser and in `node --test`. The browser only does canvas drawing around it.

Inputs the browser prepares:

- Target image drawn to a canvas of size `(2*cols) x (2*rows)`; each pixel is a "quadrant" of a cell. Tiles are drawn to a `2x2` canvas (center-cropped to the cell aspect). Use step-down halving for large reductions so averaging is real, not aliased.

Functions:

1. `rgbToLab(r,g,b)`: sRGB to Lab (D65).
2. `tileFeature(rgba2x2)`: 12 floats (4 quadrants x L,a,b).
3. `targetCells(rgba, cols, rows)`: returns `{features: Float32Array(cols*rows*12), meanRGB: Uint8Array(cols*rows*3)}`.
4. `chooseGrid(n, aspect, opts)`: `reuse = max(n<800 ? 2 : 1.5, min(6, 900/n))`; `cells = clamp(n*reuse, 60, 2400)`; derive `cols,rows` from aspect; returns `{cols, rows}`. (The first rule, `3 if n<200`, gave 150 photos a chunky ~450-cell grid. Smaller sets now reuse photos up to 6x to reach ~900 cells; past ~1000 cells a phone shows little more detail.)
5. `planMosaic({cols, rows, cellFeatures, meanRGB, tiles:[{id, feature}], opts, seed})`, deterministic via seeded RNG (mulberry32):
   - `n < minTiles (12)`: return `{mode:'float', cells:[], leftover: all ids}`. The renderer shows the base image dimmed with items drifting around it.
   - Otherwise `coverage = clamp(n / 60, 0.3, 1)`.
   - Saliency per cell = ΔE between the cell mean and the *nearest* border cell's mean. (The first version used the average border color, which fails on gradient backgrounds: the average is a mid tone, so plain bands at either end looked salient.) Fill the top `coverage` fraction of cells; the rest remain "ghost" (the base image, faded). This is the smooth blend: with few photos, the subject fills first.
   - `maxReuse = max(opts.maxReuse ?? 2, ceil(filledCells / n))`.
   - Visit filled cells in seeded-shuffled order. Cost for tile t at cell c = mean over quadrants of ΔE76(cellQuad, tileQuad) + `usagePenalty * usage[t]` + a proximity penalty that grows when the same tile already sits within `minSpacing` (default 4) cells. Pick the lowest cost among tiles with `usage < maxReuse`.
   - Per cell output: `{col, row, tileId|null, tint: {rgb, alpha}}` where `alpha = clamp(cost/50, 0.08, 0.5)`. The renderer overlays the target mean color at that alpha so the likeness sharpens without hiding the photo.
   - `order`: cell indices sorted by distance from the centroid of filled cells plus seeded jitter, with a normalized `delay` 0..1 per cell for the fly-in stagger.
   - `leftover`: tile ids not used; the renderer floats these around the edges.

Tests (`test/mosaic.test.js`) with synthetic data (red disc on blue background; 300 random-color tiles):

- Deterministic for the same seed.
- Mean ΔE of the plan is clearly lower than random assignment.
- No tile exceeds `maxReuse`; same-tile spacing respected when enough tiles exist.
- `n=5` gives `mode:'float'`; `n=30` gives coverage below 1 with the disc area filled first.
- `leftover` plus used ids equals all tile ids.

## Pages

**Fan page** (mobile-first, 30-second flow): cosplayer name and event; choose or take photo (`<input type=file accept=image/* capture>` optional); client-side resize to 2560 px before upload (also helps bad venue Wi-Fi); optional "Edit photo" (rotate, crop, Auto, sliders; see Photo editing); optional message with counter; optional name plus "credit me" toggle; consent text visible, required checkbox; upload with retry queue (IndexedDB or in-memory with retry on `online`); success screen with the delete code (copy button) and "send another".

**Organizer dashboard**: event settings (name, retention, open/closed); upload base image with preview; add cosplayers; per cosplayer: counts (pending, approved), QR SVG download, "Print sign" page, Release toggle, copy reveal link; moderation grid with large thumbnails, keyboard shortcuts (A approve, R reject, arrows), bulk approve, filter by cosplayer and status; message items shown as cards.

**Print sign**: big QR, cosplayer name, one line of copy, event name; print stylesheet.

**Reveal page** (cosplayer): if not released, a friendly "not ready yet" screen. Otherwise a full-screen dark stage: intro card with event and cosplayer name, a "Play" button (also satisfies autoplay rules), then the animation: tiles fly from scattered/floating start positions into their cells following `order` and `delay`, tint overlays fade in, notes drift in and settle in the margins, final hold shows the finished mosaic. Float mode loops gently. Controls: replay, skip, "Manage" drawer (list approved items with hide/unhide/delete), "Download all (ZIP)", "Export mosaic" (render at 2160 px on the long side to canvas, `toBlob` as JPEG/PNG, `navigator.share({files})` when available else download), "Remove everything and close this page" with a confirm step. Respect `prefers-reduced-motion` (skip to final frame). Hidden items are excluded from both animation and export.

Performance notes: use thumbnails for tiles; preload and decode with `createImageBitmap`; render with a single canvas and `requestAnimationFrame`; cap at about 2400 cells.

## Visual design ("Subtle Gradient")

Dark everywhere except the printed sign. Tokens live at the top of `public/css/app.css`:

- Canvas `#090909`, cards `#141414` (surface 1) and `#1c1c1c` (surface 2), hairline `#262626`; text white or `#999999`, nothing in between.
- Every action is a pill. The main action on a screen is the white pill; everything else is charcoal.
- Blue `#0099ff` only for links, focus, and selection (checkboxes, pressed toggles, the focused review card). Never a fill.
- At most one gradient card per screen (fan page hero, "Sent!" card, intro card on the reveal, "Waiting for review" on the dashboard). The far gradient stops are a bit deeper than the source anchors so white body text passes 4.5:1.
- Geist (headings, tight negative tracking) and Inter (text), both SIL OFL, **self-hosted** in `public/fonts/` with their licenses. No font requests to other sites.
- On phones, the reveal's Manage drawer and the photo editor are bottom sheets.
- Reveal layout: landscape puts notes in a column on each side of the mosaic; portrait (phones) puts the mosaic full width under the title with the notes in a grid below it, so there are no empty bands.

## Photo editing (`public/js/edit.js`)

Two places, one editor (`public/js/editor.js`, which builds its own dialog):

- **Fan page, before sending.** A cosplayer can't fix hundreds of photos, so each fan can fix their own: "Edit photo" next to the preview. The fan's edit is applied to the photo that gets sent (it's their photo); the unedited resized copy stays in memory until sending, so they can re-edit or reset without losing quality.
- **Reveal page, afterwards.** The cosplayer can still adjust any photo. These edits are **non-destructive**: the submission stores a small `edit` object and the fan's file is never changed, so an edit can always be undone. `edit.js` is **pure and DOM-free** like `mosaic.js`; the browser (preview, Save photo, mosaic tiles and cards) and the server (ZIP, via sharp raw pixels) run the same code, so every copy matches.

- Edit: `rot` (0/90/180/270 clockwise), `crop` (`{ratio, zoom, cx, cy}`: shape presets Original, 1:1, 4:5, 9:16, 16:9, zoom up to 3x in the UI, drag or arrow keys to move), `auto` (strength plus measured numbers), and `exposure`, `contrast`, `warmth`, `saturation` in -1..1. `normalizeEdit` validates and clamps untrusted input and returns null for an edit that changes nothing.
- Auto (one tap, strength slider, default 75%): white balance from near-gray pixels only, halfway and capped (event lighting and costume colors are often deliberate); levels from the 0.5% and 99.5% brightness percentiles, stretching at most about 1.7x; a gamma curve toward a mid-gray median; vibrance that boosts dull colors more than strong ones and skin tones only a little. It is measured once in the browser on a small copy and stored as numbers, so the server never re-measures.
- Per-channel steps fold into a lookup table; saturation and vibrance run per pixel afterwards.
- Not included: skin smoothing, reshaping, background removal (these need ML models; cosplayers already use dedicated apps). The ZIP's `unedited/` folder (the stored re-encoded copy, never the raw upload) and the 2560 px upload size are for editing elsewhere.

## Fairness between cosplayers

Cosplayers at the same event compare reveals, and fan counts differ a lot. The app must never keep score:

- No counts, rankings, or comparisons on fan-facing or cosplayer-facing pages. The reveal says "Photos and notes from your fans", never a number. Counts are for the organizer dashboard only.
- Each cosplayer can have their own mosaic image (for example, a photo of them in costume, used with their OK), so reveals aren't the same picture at different levels of completion. It follows the same retention rule as submissions and is deleted with the cosplayer.
- "Release all" lets the organizer give everyone their link at the same moment.
- Open question: always fill the whole mosaic (coarser grid, more reuse) instead of leaving ghost cells when photos are few.

## Demo seed (`scripts/seed-demo.js [count=150]`)

Creates an event, 2 cosplayers, a synthetic booth image (SVG rendered via sharp), and `count` synthetic colorful "photos" with sample messages and mixed statuses so the whole flow can be seen without real photos. Prints the admin, fan, and reveal URLs.

## Milestones (each ends with something you can run)

1. **Server skeleton and uploads.** `server.js`, media route, submit and delete endpoints, rate limits, purge job. Check: `curl` a JPEG with `consent=1` and get back a delete code; without consent get 400; delete code removes files from disk.
2. **Mosaic module and tests.** As specified. Check: `npm test` green.
3. **Admin API and dashboard.** Event, cosplayers, base image, moderation, QR, print sign, release. Check: full organizer flow in the browser against seeded data.
4. **Fan page.** Check: scan or open the fan URL on a phone, submit a photo, see it appear as pending in the dashboard; delete it with the code.
5. **Reveal page and animation.** Check: with 150 seeded photos you get a recognizable mosaic; with 8 you get float mode; with 30 the subject fills first.
6. **Cosplayer controls and export.** Hide, delete, opt-out (also deletes the cosplayer's own mosaic image), ZIP, mosaic export, and pinch/scroll zoom on the finished mosaic with tap-to-open on a tile so individual fan photos can be found. Check: hidden item disappears from animation and export; opt-out empties the page and closes the fan URL.
7. **Photo editing.** Rotate, crop, Auto, and four sliders, for the fan before sending (applied to the upload) and on the reveal page (from the lightbox and the Manage list), Save photo for one photo, edits applied to the mosaic tiles and the ZIP. Check: an edited photo looks the same in the preview, the lightbox, Save photo, and the ZIP; Reset and Save goes back to the original.
8. **Polish and deploy.** README with host steps, accessibility pass (labels, focus, contrast, reduced motion), a short privacy section, deploy the demo.

## Hosting the demo

**View-only demo (GitHub Pages, no server).** `npm run export` seeds fresh demo data, reads each page's data through the real API (so only what the server would show is published: approved items, credited names, no tokens or delete codes), and writes a static site to `docs/` with a hub page. Pages are marked `<html data-static>` with a relative `<base>`, so the site works under any folder. There, `api()` reads JSON files; hide, delete, edit, opt-out, approve and reject change the page only (gone on reload); sending, uploads, settings and the ZIP are off. Set `PUBLIC_URL` to the Pages address before exporting so the QR codes on the signs point there. `test/export.test.js` checks the output for leaks.

**The full app.** Any small Node host with a persistent disk (Fly.io, Render, Railway). Set `PORT`, `DATA_DIR` (on the persistent volume), `PUBLIC_URL`, optional `CREATE_KEY` so strangers can't create events, and `TRUST_PROXY=1` when behind a proxy. HTTPS is required for phones to open it comfortably and for `navigator.share`.

## Pitching to organizers (later, not now)

Per-event branding, CSV export of approved submissions, multiple cosplayers per booth QR, scheduled auto-release, SQLite or Postgres, object storage for media, an organizer sign-in, and a short one-page explainer of the privacy model. Revisit licensing if an organizer wants to use official key art as the mosaic base.

## Kickoff prompt for Claude Code

> Read PLAN.md and CLAUDE.md. The lib/ files are already written; review them, then build Milestone 1 (server.js with the routes listed in the plan for fans, media, and purge) and run the curl checks. Stop after Milestone 1 and show me the results before starting Milestone 2.
