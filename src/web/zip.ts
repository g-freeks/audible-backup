import { crc32 } from "node:zlib";
import * as fs from "fs";
import * as path from "path";

/**
 * Minimal store-only (uncompressed) ZIP writer for streaming converted
 * audiobooks to the browser. MP3s don't compress, so storing keeps this
 * dependency-free and memory usage bounded. No zip64: individual files and
 * the total archive must stay under 4 GB.
 */

export interface ZipEntry {
  diskPath: string;
  /** Name inside the archive, forward-slash separated. */
  archivePath: string;
}

const LOCAL_HEADER_SIG = 0x04034b50;
const CENTRAL_HEADER_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const UTF8_FLAG = 0x0800;
const VERSION = 20;

function dosDateTime(d: Date): { date: number; time: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    time:
      (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
  };
}

async function fileCrc32(filePath: string): Promise<number> {
  let crc = 0;
  for await (const chunk of fs.createReadStream(filePath)) {
    crc = crc32(chunk as Buffer, crc);
  }
  return crc >>> 0;
}

/** Collect all files under a directory as zip entries, sorted by name. */
export function zipDirectoryEntries(dir: string): ZipEntry[] {
  const entries: ZipEntry[] = [];
  const files = fs.readdirSync(dir, { recursive: true, withFileTypes: true });
  for (const file of files) {
    if (file.isFile()) {
      const fullPath = path.join(file.parentPath, file.name);
      entries.push({
        diskPath: fullPath,
        archivePath: path.relative(dir, fullPath).split(path.sep).join("/"),
      });
    }
  }
  entries.sort((a, b) => a.archivePath.localeCompare(b.archivePath));
  return entries;
}

/**
 * Yield a ZIP archive of the given files chunk by chunk. Each file is read
 * twice (once for the CRC, once for the data) so headers can be written
 * up front without buffering file contents in memory.
 */
export async function* zipStream(entries: ZipEntry[]): AsyncGenerator<Buffer> {
  const centralRecords: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const stat = fs.statSync(entry.diskPath);
    const crc = await fileCrc32(entry.diskPath);
    const name = Buffer.from(entry.archivePath, "utf8");
    const { date, time } = dosDateTime(stat.mtime);
    const size = stat.size;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER_SIG, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(0, 8); // method: store
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    yield Buffer.concat([local, name]);

    for await (const chunk of fs.createReadStream(entry.diskPath)) {
      yield chunk as Buffer;
    }

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_HEADER_SIG, 0);
    central.writeUInt16LE(VERSION, 4); // version made by
    central.writeUInt16LE(VERSION, 6); // version needed
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(0, 10); // method: store
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    // extra/comment lengths, disk number, attributes all zero
    central.writeUInt32LE(offset, 42);
    centralRecords.push(Buffer.concat([central, name]));

    offset += 30 + name.length + size;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const record of centralRecords) {
    centralSize += record.length;
    yield record;
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(centralRecords.length, 8);
  eocd.writeUInt16LE(centralRecords.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralStart, 16);
  yield eocd;
}
