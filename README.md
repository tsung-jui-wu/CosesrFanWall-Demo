# FanWall

Fans send a guest cosplayer photos and thank-you notes at an event by scanning a QR sign. The organizer reviews everything, then gives each cosplayer one link that plays it back: the photos fly in and assemble into a mosaic, with the notes around it.

**Live demo (view-only, made-up data):** https://tsung-jui-wu.github.io/CosesrFanWall-Demo/

The demo is a static copy: you can play the reveals, zoom in, open photos, and try the photo editor, but nothing can be sent or saved.

## Run it yourself

Needs Node 22 or newer.

```
npm install
npm run seed
npm start
```

`npm run seed` prints the organizer, fan, and reveal links for the demo event. `npm test` runs the tests.

## Rebuild the static demo

```
set "PUBLIC_URL=https://tsung-jui-wu.github.io/CosesrFanWall-Demo/"
npm run export
```

This writes the view-only site to `docs/`, which GitHub Pages serves. See `PLAN.md` for the design, the privacy rules, and how the mosaic works.
