import * as fs from 'fs';

/**
 * Minimal reader for Sony PARAM.SFO files (PS3 and PS4 share the format).
 * Used to get a proper game title and category for RPCS3 / shadPS4 entries
 * instead of falling back to folder names or serials.
 *
 * Layout:
 *   0x00  magic "\0PSF"
 *   0x08  key_table_start (u32 LE)
 *   0x0C  data_table_start (u32 LE)
 *   0x10  entry_count (u32 LE)
 *   0x14  index entries, 16 bytes each:
 *           u16 key_offset, u16 data_fmt, u32 data_len, u32 data_max_len, u32 data_offset
 */
export interface SfoData {
  [key: string]: string | number;
}

export function readSfo(filePath: string): SfoData | null {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(filePath);
  } catch {
    return null;
  }
  if (buf.length < 0x14 || buf.readUInt32LE(0) !== 0x46535000) return null; // "\0PSF"

  const keyTable = buf.readUInt32LE(0x08);
  const dataTable = buf.readUInt32LE(0x0c);
  const count = buf.readUInt32LE(0x10);
  const out: SfoData = {};

  for (let i = 0; i < count; i++) {
    const entry = 0x14 + i * 16;
    if (entry + 16 > buf.length) break;
    const keyOffset = buf.readUInt16LE(entry);
    const fmt = buf.readUInt16LE(entry + 2);
    const len = buf.readUInt32LE(entry + 4);
    const dataOffset = buf.readUInt32LE(entry + 12);

    const keyStart = keyTable + keyOffset;
    const keyEnd = buf.indexOf(0, keyStart);
    if (keyStart >= buf.length || keyEnd < 0) continue;
    const key = buf.toString('utf8', keyStart, keyEnd);

    const dataStart = dataTable + dataOffset;
    if (dataStart + len > buf.length) continue;

    if (fmt === 0x0404) {
      out[key] = buf.readUInt32LE(dataStart);
    } else {
      // 0x0004 = utf8 (not null terminated), 0x0204 = utf8 null terminated
      const raw = buf.subarray(dataStart, dataStart + len);
      const nul = raw.indexOf(0);
      out[key] = raw.toString('utf8', 0, nul >= 0 ? nul : raw.length).trim();
    }
  }
  return out;
}

export function readSfoTitle(filePath: string): string | null {
  const sfo = readSfo(filePath);
  const title = sfo?.['TITLE'];
  return typeof title === 'string' && title.length > 0 ? title.replace(/\s+/g, ' ') : null;
}
