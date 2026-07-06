// Streaming ZIP writer — store method (no recompression), ZIP64 throughout,
// data descriptors so nothing is buffered. Pure reads: source files are never
// touched, no temp files are written. Content-Length is exact (store method
// is deterministic), so browsers show real download progress.
import fs from 'node:fs';
import zlib from 'node:zlib';

const LOCAL_HEADER_SIZE = 30;
const DESCRIPTOR_SIZE = 24; // sig(4) + crc(4) + csize(8) + usize(8)
const CENTRAL_BASE = 46;
const ZIP64_EXTRA_SIZE = 4 + 24; // header + usize/csize/offset
const ZIP64_EOCD = 56;
const ZIP64_LOCATOR = 20;
const EOCD = 22;

export function zipSize(files) {
  // files: [{ name, size }]
  let total = 0;
  for (const f of files) {
    const nameLen = Buffer.byteLength(f.name, 'utf8');
    total += LOCAL_HEADER_SIZE + nameLen + f.size + DESCRIPTOR_SIZE;
    total += CENTRAL_BASE + nameLen + ZIP64_EXTRA_SIZE;
  }
  return total + ZIP64_EOCD + ZIP64_LOCATOR + EOCD;
}

function u16(v) { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; }
function u32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; }
function u64(v) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; }

function localHeader(nameBuf) {
  return Buffer.concat([
    u32(0x04034b50),
    u16(45),          // version needed: ZIP64
    u16(0x0808),      // bit 3: data descriptor, bit 11: UTF-8 names
    u16(0),           // method: store
    u16(0), u16(0x21),// dos time/date (constant — source mtimes are irrelevant)
    u32(0),           // crc (in descriptor)
    u32(0), u32(0),   // sizes (in descriptor)
    u16(nameBuf.length),
    u16(0),
    nameBuf,
  ]);
}

function descriptor(crc, size) {
  return Buffer.concat([u32(0x08074b50), u32(crc), u64(size), u64(size)]);
}

function centralEntry(e) {
  const zip64Extra = Buffer.concat([
    u16(0x0001), u16(24), u64(e.size), u64(e.size), u64(e.offset),
  ]);
  return Buffer.concat([
    u32(0x02014b50),
    u16(45), u16(45),
    u16(0x0808),
    u16(0),
    u16(0), u16(0x21),
    u32(e.crc),
    u32(0xffffffff), u32(0xffffffff), // sizes -> zip64 extra
    u16(e.nameBuf.length),
    u16(zip64Extra.length),
    u16(0), u16(0), u16(0),
    u32(0),
    u32(0xffffffff),                  // offset -> zip64 extra
    e.nameBuf,
    zip64Extra,
  ]);
}

function endRecords(entries, cdOffset, cdSize) {
  const zip64Eocd = Buffer.concat([
    u32(0x06064b50),
    u64(ZIP64_EOCD - 12),
    u16(45), u16(45),
    u32(0), u32(0),
    u64(entries.length), u64(entries.length),
    u64(cdSize), u64(cdOffset),
  ]);
  const locator = Buffer.concat([
    u32(0x07064b50), u32(0), u64(cdOffset + cdSize), u32(1),
  ]);
  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0), u16(0),
    u16(Math.min(entries.length, 0xffff)), u16(Math.min(entries.length, 0xffff)),
    u32(0xffffffff), u32(0xffffffff),
    u16(0),
  ]);
  return Buffer.concat([zip64Eocd, locator, eocd]);
}

function write(res, buf) {
  return new Promise((resolve, reject) => {
    res.write(buf, (err) => (err ? reject(err) : resolve()));
  });
}

// files: [{ name (zip path, forward slashes), absPath, size }]
export async function streamZip(res, files) {
  const entries = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const entryOffset = offset;
    await write(res, localHeader(nameBuf));
    offset += LOCAL_HEADER_SIZE + nameBuf.length;

    let crc = 0;
    let written = 0;
    const stream = fs.createReadStream(f.absPath);
    for await (const chunk of stream) {
      crc = zlib.crc32(chunk, crc);
      written += chunk.length;
      await write(res, chunk);
    }
    if (written !== f.size) {
      // file changed size since we computed Content-Length — abort cleanly
      throw new Error(`size of ${f.name} changed during download`);
    }
    offset += written;
    await write(res, descriptor(crc, written));
    offset += DESCRIPTOR_SIZE;

    entries.push({ nameBuf, crc, size: written, offset: entryOffset });
  }

  const cdOffset = offset;
  let cdSize = 0;
  for (const e of entries) {
    const buf = centralEntry(e);
    await write(res, buf);
    cdSize += buf.length;
  }
  await write(res, endRecords(entries, cdOffset, cdSize));
  res.end();
}
