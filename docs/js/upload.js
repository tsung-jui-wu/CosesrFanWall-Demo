// Getting a photo ready to send: used by the fan page and by the organizer's Add photos tab.
// Kept apart from editor.js so the dashboard doesn't load the editor just to resize.

export const UPLOAD_MAX_EDGE = 2560; // matches PHOTO_MAX_EDGE in lib/images.js
export const UPLOAD_QUALITY = 0.86;

const makeCanvas = (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h });
const toJpeg = (c, quality) =>
  new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/jpeg', quality));

// Resize to UPLOAD_MAX_EDGE before upload: smaller uploads survive bad venue Wi-Fi, and re-encoding
// through a canvas drops the photo's location data before it ever leaves the device.
// Returns null on any failure (a format the browser can't decode, like HEIC on some browsers, or a
// canvas over the device's size limit); the caller then sends the file as is, and the server
// re-encodes everything anyway.
export async function prepareImage(file) {
  let bmp;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, UPLOAD_MAX_EDGE / Math.max(bmp.width, bmp.height));
    const tw = Math.max(1, Math.round(bmp.width * scale)), th = Math.max(1, Math.round(bmp.height * scale));
    // Halve step by step so big reductions average pixels instead of aliasing.
    let source = bmp, w = bmp.width, h = bmp.height;
    while (w / 2 >= tw) {
      w = Math.round(w / 2); h = Math.round(h / 2);
      const step = makeCanvas(w, h);
      step.getContext('2d').drawImage(source, 0, 0, w, h);
      source = step;
    }
    const out = makeCanvas(tw, th);
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, tw, th);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, tw, th);
    return await toJpeg(out, UPLOAD_QUALITY);
  } catch {
    return null;
  } finally {
    bmp?.close();
  }
}
