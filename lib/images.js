// Image pipeline. Every image is decoded and re-encoded with sharp, which drops EXIF/GPS
// (sharp keeps no metadata unless asked). The original upload is never written to disk.
import fs from 'node:fs/promises';
import sharp from 'sharp';
import { newFileId, mediaPath } from './store.js';
import { rotatedSize, cropRect, colorOps, applyColor } from '../public/js/edit.js';

sharp.cache(false);
const INPUT = { limitInputPixels: 100e6 };
// The client's declared MIME type means nothing to sharp, which sniffs the bytes. Only decode
// these raster formats, so an SVG or other exotic file labelled image/png never reaches librsvg etc.
const RASTER = new Set(['jpeg', 'png', 'webp', 'gif', 'heif', 'avif']);

export class ImageDecodeError extends Error {}

async function encode(input, size, quality, { allowSvg = false } = {}) {
  try {
    const img = sharp(input, INPUT);
    const { format } = await img.metadata();
    if (!RASTER.has(format) && !(allowSvg && format === 'svg')) throw new Error(`unsupported format: ${format}`);
    return await img
      .rotate()
      .flatten({ background: '#ffffff' })
      .resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality })
      .toBuffer();
  } catch (err) {
    throw new ImageDecodeError(err.message);
  }
}

async function writeAll(files) {
  const written = [];
  try {
    for (const [name, buf] of files) {
      await fs.writeFile(mediaPath(name), buf, { flag: 'wx' });
      written.push(name);
    }
  } catch (err) {
    // Only undo our own writes: with 'wx', a collision means the existing file belongs to someone else.
    await Promise.allSettled(written.map((name) => fs.unlink(mediaPath(name))));
    throw err;
  }
}

// Fan photo: <id>.jpg (max 2560 px, q82) and <id>_t.jpg (max 360 px, q75). Returns the file id.
// 2560 leaves cosplayers room to crop and edit the photo in their own apps.
// allowSvg is for the demo seed only; never pass it for uploads.
export const PHOTO_MAX_EDGE = 2560;
export async function savePhoto(input, { allowSvg = false } = {}) {
  const full = await encode(input, PHOTO_MAX_EDGE, 82, { allowSvg });
  const thumb = await encode(full, 360, 75);
  const id = newFileId();
  await writeAll([[`${id}.jpg`, full], [`${id}_t.jpg`, thumb]]);
  return id;
}

// Organizer's mosaic base: base_<id>.jpg (max 2400 px, q86). Returns the file id.
export async function saveBase(input, { allowSvg = false } = {}) {
  const buf = await encode(input, 2400, 86, { allowSvg });
  const id = newFileId();
  await writeAll([[`base_${id}.jpg`, buf]]);
  return id;
}

// A fan photo with the cosplayer's edit applied, as a JPEG buffer. Uses the same edit.js as the
// browser preview, so the download matches what they saw. The stored file is never changed.
export async function renderEdited(id, edit, quality = 90) {
  const file = mediaPath(`${id}.jpg`);
  const { width, height } = await sharp(file, INPUT).metadata();
  const rect = cropRect(...rotatedSize(width, height, edit.rot), edit);
  const { data, info } = await sharp(file, INPUT)
    .rotate(edit.rot) // stored files carry no EXIF orientation, so this is the edit's turn only
    .extract(rect)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  applyColor(data, info.channels, colorOps(edit));
  return sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } }).jpeg({ quality }).toBuffer();
}

export async function removePhoto(id) {
  if (id) await Promise.allSettled([fs.unlink(mediaPath(`${id}.jpg`)), fs.unlink(mediaPath(`${id}_t.jpg`))]);
}

export async function removeBase(id) {
  if (id) await fs.unlink(mediaPath(`base_${id}.jpg`)).catch(() => {});
}
