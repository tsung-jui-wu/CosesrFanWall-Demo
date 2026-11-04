# FanWall bundle format (schema 1)

The bundle is what a cosplayer gets from **Download all** on their reveal page. It's meant to outlast the
server: FanWall deletes everything `retentionDays` after the event closes (90 days at most), and the bundle
is the copy that lives on the cosplayer's own device. The year in review (Step 5) reads it, and so would any
later source of the same bundle. Write readers against this document, not against `lib/bundle.js`.

## Container

- A ZIP file, **stored** (no compression), file names in UTF-8 (general-purpose flag bit 11), no ZIP64.
  So: under 4 GB and under 65,535 entries. A cosplayer has at most 1,500 items.
- Named `fanwall-<cosplayer name in ASCII>.zip`, or `fanwall-photos.zip` when the name has no ASCII letters.
  Don't rely on the file name; read `manifest.json`.
- All paths below are relative to the ZIP root. There's no top-level folder.

## Layout

| Path | What it is |
|---|---|
| `index.html` | The gallery: photos (grid of thumbnails, each linking to the full photo) and notes, with a fan's name only when they asked for credit. Plain HTML and CSS: no scripts, no network requests, system fonts only. Opens from a phone's Files app with the network off. |
| `manifest.json` | Everything a program needs, described below. |
| `messages.txt` | The notes and credits as plain text (UTF-8, CRLF line ends), with the photo file each one came with. |
| `photos/photo-NNNN.jpg` | Each photo at full size (up to 2560 px on the long side). If the cosplayer edited it, this is the edited version. |
| `thumbs/photo-NNNN.jpg` | The same photo, edited if it was, at most 600 px on the long side, for grids. |
| `unedited/photo-NNNN.jpg` | Only for edited photos: the photo as the fan sent it (after FanWall's re-encode; never the raw upload). |

`NNNN` counts photos from `0001` in upload order. Notes without a photo have no files.

The mosaic image isn't in the bundle. It's drawn in the browser, and the reveal page's **Save image** saves it.

## `manifest.json`

```json
{
  "schemaVersion": 1,
  "language": "zh-Hant",
  "event": { "name": "FanWall Demo Con", "date": "2026-11-03" },
  "cosplayer": { "name": "Yuki" },
  "revealStyle": "mosaic",
  "items": [
    { "type": "photo", "file": "photos/photo-0001.jpg", "thumb": "thumbs/photo-0001.jpg", "edited": false, "credit": "Mika", "note": null, "favorite": true },
    { "type": "photo", "file": "photos/photo-0002.jpg", "thumb": "thumbs/photo-0002.jpg", "unedited": "unedited/photo-0002.jpg", "edited": true, "credit": null, "note": "Best cosplay of the con!", "favorite": false },
    { "type": "note", "credit": null, "note": "See you next year!", "favorite": false }
  ]
}
```

| Field | Type | Meaning |
|---|---|---|
| `schemaVersion` | integer | `1` for this document. See Versioning. |
| `language` | `"en"`, `"zh-Hans"`, or `"zh-Hant"` | The language of the bundle's own words (`index.html`, `messages.txt`). Fans' notes are in whatever language they wrote. |
| `event.name` | string | The event's name. |
| `event.date` | `"YYYY-MM-DD"` | The day the event's first item in this bundle arrived, on the cosplayer's own calendar (their browser's time zone when they downloaded). With no items it falls back to when the event closed, or was created, in UTC. Good for sorting and grouping by year. It's not the official event date, and it has no time of day. |
| `cosplayer.name` | string | The cosplayer's name as the organizer entered it. |
| `revealStyle` | string | The reveal style the event used. Always `"mosaic"` for now; more styles are planned. Unknown values should be treated as `"mosaic"`. |
| `items` | array | Everything the cosplayer could see when they downloaded, in upload order. Hidden items aren't here; neither is anything that wasn't approved. |
| `items[].type` | `"photo"` or `"note"` | A photo (which may also have a note), or a note on its own. |
| `items[].file` | path | Photos only: the full-size photo. |
| `items[].thumb` | path | Photos only: the 600 px copy. |
| `items[].unedited` | path | Edited photos only: the copy before the cosplayer's edit. |
| `items[].edited` | boolean | Photos only: whether `file` has the cosplayer's edit applied. |
| `items[].credit` | string or `null` | The fan's name, only if the fan asked to be credited. Otherwise `null`, even if they typed a name. |
| `items[].note` | string or `null` | The fan's note exactly as written (up to 280 characters, may contain line breaks and emoji). Plain text: escape it before putting it in HTML. |
| `items[].favorite` | boolean | The cosplayer starred it. Added after schema 1 shipped (an additive field, so no bump): treat a missing value as `false`. A bundle downloaded with "only my favorites" holds only starred items. |

## What is never in a bundle

These are guarantees, covered by `test/api.test.js` and `test/bundle.test.js`:

- No ids of any kind: no event, cosplayer, submission, or file ids, and no reveal or organizer tokens. Nothing in a bundle can be used against the FanWall API.
- No delete codes and no hashes of them.
- No hidden, pending, or rejected items.
- No fan names unless the fan asked for credit.
- No upload times beyond `event.date`, and no consent records, IP addresses, or emails (FanWall never stores the last two anyway).
- No original uploads. Photos are FanWall's re-encoded copies, without EXIF or location data.

## Versioning

- `schemaVersion` changes only for a change that would break a reader written against the previous version, such as renaming, removing, or changing the meaning of a field.
- New optional fields, new files, and new `revealStyle` values are added without a bump. Readers must ignore fields and files they don't know.
- A reader that sees a higher `schemaVersion` than it knows should say so rather than guess.

## Reading a bundle

1. Find `manifest.json` at the ZIP root. Entries are stored, so a reader only needs to walk the local headers or the central directory and slice out the bytes; no inflate is needed.
2. Check `schemaVersion`.
3. Use `items[].file`, `thumb`, and `unedited` as given. Don't build paths from the numbering.

A source other than a file the cosplayer picks (a link, a cloud drive) would mean bundles leaving the device. That reopens the retention rule and needs its own constraints review first.
