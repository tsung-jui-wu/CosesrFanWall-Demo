// Reading "Download all" bundles (BUNDLE-FORMAT.md) back, for the year in review. Pure, no DOM: also
// runs under `node --test`. The ZIPs are store-only (lib/zip.js), so reading an entry is just slicing
// its bytes; and only the byte ranges needed are read, so a phone never loads a whole 200 MB ZIP.

const KNOWN_SCHEMA = 1;

// Failures carry a code; the page puts them into words (review.error.<code>).
export class BundleError extends Error {
  constructor(code) { super(code); this.code = code; }
}

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

// read(offset, length) -> Promise<Uint8Array>; size: the file's length in bytes.
// Returns { names, has(name), bytes(name) -> Promise<Uint8Array> }.
export async function openZip(read, size) {
  // The end-of-central-directory record sits in the last 22 bytes, or up to 64 KB earlier if the
  // archive has a comment.
  const tailLen = Math.min(size, 22 + 0xffff);
  const tail = await read(size - tailLen, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (u32(tail, i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new BundleError('not_zip');
  const count = u16(tail, eocd + 10), cdSize = u32(tail, eocd + 12), cdOffset = u32(tail, eocd + 16);
  if (cdOffset + cdSize > size) throw new BundleError('not_zip');
  const cd = await read(cdOffset, cdSize);
  const entries = new Map();
  const decoder = new TextDecoder();
  for (let o = 0, k = 0; k < count; k++) {
    if (u32(cd, o) !== 0x02014b50) throw new BundleError('not_zip');
    const method = u16(cd, o + 10), length = u32(cd, o + 20);
    const nameLen = u16(cd, o + 28), extraLen = u16(cd, o + 30), commentLen = u16(cd, o + 32);
    const name = decoder.decode(cd.subarray(o + 46, o + 46 + nameLen));
    entries.set(name, { method, length, header: u32(cd, o + 42) });
    o += 46 + nameLen + extraLen + commentLen;
  }
  return {
    names: [...entries.keys()],
    has: (name) => entries.has(name),
    async bytes(name) {
      const e = entries.get(name);
      if (!e) throw new BundleError('missing_file');
      if (e.method !== 0) throw new BundleError('compressed'); // FanWall only writes stored entries
      const local = await read(e.header, 30);
      if (u32(local, 0) !== 0x04034b50) throw new BundleError('not_zip');
      return read(e.header + 30 + u16(local, 26) + u16(local, 28), e.length);
    },
  };
}

// A File or Blob the person picked, read in slices.
const blobReader = (blob) => async (offset, length) => new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());

// The one way in: a source -> a bundle. Today the only source is a file the person picks
// ({ kind: 'file', file }). A link or a cloud drive would be another kind here, and would mean
// bundles leaving the device, which needs its own privacy review first (BUNDLE-FORMAT.md).
// Returns { manifest, has(path), blob(path, type) }.
export async function readBundle(source) {
  if (source?.kind !== 'file') throw new BundleError('unknown_source');
  const zip = await openZip(blobReader(source.file), source.file.size);
  if (!zip.has('manifest.json')) throw new BundleError('not_bundle');
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(await zip.bytes('manifest.json')));
  } catch (err) {
    if (err instanceof BundleError) throw err;
    throw new BundleError('not_bundle');
  }
  if (!Number.isInteger(manifest?.schemaVersion) || !Array.isArray(manifest.items) || !manifest.event?.name) {
    throw new BundleError('not_bundle');
  }
  if (manifest.schemaVersion > KNOWN_SCHEMA) throw new BundleError('newer_bundle');
  return {
    manifest,
    has: (path) => typeof path === 'string' && zip.has(path),
    blob: async (path, type = 'image/jpeg') => new Blob([await zip.bytes(path)], { type }),
  };
}
