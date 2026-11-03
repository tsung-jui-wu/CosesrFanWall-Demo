// Minimal streaming ZIP writer (store-only, no compression). JPEGs don't compress anyway.
import fs from 'node:fs/promises';
import zlib from 'node:zlib';

function dosDateTime(d = new Date()) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

// entries: [{ name: string, path?: string, data?: Buffer | (() => Promise<Buffer>) }]
// A data function runs only when its entry is written, so big generated files aren't all held at once.
// Rejects if the client disconnects; callers should catch and stop. No ZIP64, so the
// archive must stay under 4 GB and 65535 entries (far above our per-cosplayer cap).
export async function streamZip(res, entries) {
  if (entries.length > 0xffff) throw new Error('streamZip: too many entries for a non-ZIP64 archive');
  const { time, date } = dosDateTime();
  const central = [];
  let offset = 0;

  const gone = () => new Error('streamZip: client disconnected');
  const write = (buf) =>
    new Promise((resolve, reject) => {
      if (res.destroyed) return reject(gone());
      if (res.write(buf)) return resolve();
      // Wait for whichever comes first, and always remove both listeners so they don't pile up.
      const done = () => {
        res.off('drain', done);
        res.off('close', done);
        if (res.destroyed) reject(gone());
        else resolve();
      };
      res.on('drain', done);
      res.on('close', done);
    });

  for (const e of entries) {
    const data = typeof e.data === 'function' ? await e.data() : (e.data ?? (await fs.readFile(e.path)));
    const name = Buffer.from(e.name, 'utf8');
    const crc = zlib.crc32(data);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6); // UTF-8 names
    lh.writeUInt16LE(0, 8); // stored
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    await write(lh);
    await write(name);
    await write(data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([ch, name]));

    offset += 30 + name.length + data.length;
    if (offset > 0xffffffff) throw new Error('streamZip: archive over 4 GB needs ZIP64');
  }

  const cd = Buffer.concat(central);
  await write(cd);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  res.end(end);
}
