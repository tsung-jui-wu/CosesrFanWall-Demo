# FanWall

Fans send a guest cosplayer photos and thank-you notes at an event by scanning a QR sign. The organizer reviews everything, then gives each cosplayer one link that plays it back: the photos fly in and come together as a mosaic, a polaroid wall, or a constellation, with the notes around them.

English, Simplified Chinese, and Traditional Chinese throughout.

**Live demo (view-only, made-up data):** https://tsung-jui-wu.github.io/CosesrFanWall-Demo/

The demo is a static copy: you can play the reveals in every style, zoom in, open photos, try the photo editor, and look around the organizer dashboard, but nothing can be sent or saved.

## Run it on your computer

Needs Node 22 or newer.

```
npm install
npm run seed
npm start
```

`npm run seed` creates a demo event and prints its organizer, fan, and reveal links. Open them at http://localhost:3000 (or set `PORT`). `npm test` runs the tests.

## Host it for a real event

FanWall is one Node process that keeps its data in a folder (`db.json` plus the photos). Any host that can run Node 22 and give it a disk that survives restarts will do: a small VPS (AWS Lightsail or EC2, DigitalOcean, Hetzner), Fly.io with a volume, Render or Railway with a disk.

1. **Copy the code and install.** `npm ci --omit=dev` (sharp downloads its image library for the host's platform).
2. **Set the environment.**

   | Variable | What it does |
   |---|---|
   | `PORT` | Port to listen on (default 3000). |
   | `DATA_DIR` | Where the data lives. Put it on the persistent disk. |
   | `PUBLIC_URL` | The site's public address, e.g. `https://fanwall.example.org`. The QR codes on the signs point here. |
   | `CREATE_KEY` | Optional. When set, creating an event asks for this key, so strangers can't create events on your server. |
   | `TRUST_PROXY` | The number of proxies in front of the app (usually `1`). Needed behind a proxy or load balancer so rate limits see the real visitor; leave unset otherwise. |

3. **Put HTTPS in front.** Phones need it for the share sheet ("Save image" straight to Photos), and browsers mark plain `http` pages as not secure, which fans won't trust. On a VPS, Caddy is the simplest (it gets certificates by itself):

   ```
   fanwall.example.org {
       reverse_proxy 127.0.0.1:3000
       log {
           output discard
       }
   }
   ```

   **Turn the proxy's access log off, or strip IP addresses from it.** FanWall itself never stores or logs IP addresses, but most proxies and load balancers do by default (nginx `access_log`, AWS load balancer access logs, CDN logs). Uploads can be up to 12 MB, so raise the proxy's body limit if it has one (nginx: `client_max_body_size 13m;`).
4. **Keep it running.** Use the host's process manager (systemd, `pm2`, or the platform's own). Run **one** instance: the data file and the rate limits live in one process.
5. **Backups, if you make them, must expire too.** FanWall deletes everything on schedule; a backup kept longer would quietly break that promise to fans. Keep backups no longer than the event's retention window, or don't back up `DATA_DIR` at all.

After the event, nothing needs doing: the purge runs every hour on its own.

## Privacy, and why the keepsake lives on the cosplayer's phone

FanWall is built so the server forgets. These are rules in the code, with tests behind them:

- **Fans need no account and give no email.** A name is optional and shown only if the fan ticks "credit me". Before sending, fans see the full consent text in their language and must tick a box; the server records which version they agreed to.
- **Fans can take it back.** After sending, a fan gets a delete code. The server keeps only a hash of it.
- **Nothing reaches a cosplayer until the organizer approves it and releases their page.**
- **Photos are re-saved on arrival** (which drops hidden location data); the original upload is never kept or served. Photo files have random names and are only served through one checked route.
- **Everything is deleted automatically**, by default 30 days after the event closes, and never kept longer than 90 days after upload. This includes the cosplayer's own mosaic image. Each reveal page shows "Saved until <date>" so nobody is surprised.
- **No IP addresses or emails are stored or logged.** Rate limits use a keyed hash of the address held in memory for a few minutes.
- **No analytics, trackers, or third-party scripts.** Fonts are served from the app itself. A strict Content Security Policy enforces it.
- **No counts or rankings on fan or cosplayer pages.** Cosplayers at one event compare their pages, so nothing says who got more. Counts appear only on the organizer's dashboard.

The cosplayer can hide or delete any item, or wipe their whole page. Before their page is deleted, they can save everything with **Download all**: a ZIP with the photos, the notes, an offline gallery page (`index.html`, works with no connection), and a `manifest.json` described in [BUNDLE-FORMAT.md](BUNDLE-FORMAT.md). The ZIP holds no ids, tokens, or delete codes.

**Local-first year in review.** Anything that outlasts the deletion window lives on the cosplayer's own device, never on the server. At `/review`, a cosplayer picks the ZIPs they saved during the year and gets one page per event, grouped by year. The files are read inside the browser; nothing is uploaded, and the page holds no data of its own. On their reveal page, "Add reminders to my calendar" gives them a calendar file (made on the device, no email) with a reminder to download before the page is deleted and one in December for the year in review.

**What the cosplayer may post.** The image from **Save** (a still image or an animated GIF of it coming together) shows fans' photos only as small tiles, with no notes or names. The consent text tells fans that the cosplayer may post it.

## Rebuild the static demo

```
set "PUBLIC_URL=https://tsung-jui-wu.github.io/CosesrFanWall-Demo/"
npm run export
```

This writes the view-only site to `docs/`, which GitHub Pages serves. See [PLAN.md](PLAN.md) for the design, the routes, and how each reveal style is laid out.

## Translations

The words live in `public/locales/` (one file per language) and the consent text in `lib/consent.js`. The Chinese text is a draft and still needs a native reader for each of Simplified and Traditional before a real event.
