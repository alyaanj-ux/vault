import * as fs from 'fs';

/**
 * Reader for Steam's `appcache/appinfo.vdf` — the local cache of store metadata for every app
 * the client has seen. It is the only way to get a NAME for an owned-but-uninstalled game
 * without a Steam Web API key, so it is what makes the "Uninstalled" tab work out of the box.
 *
 * Format: a header, then one record per app, each ending in a binary-VDF blob.
 *
 *   header   magic(u32) universe(u32) [stringTableOffset(i64) — v29 only]
 *   record   appid(u32) size(u32) infoState(u32) lastUpdated(u32) picsToken(u64)
 *            sha1(20) changeNumber(u32) [binarySha1(20) — v28+] <binary VDF>
 *   footer   appid == 0
 *
 * In v29 (current) the binary VDF's KEYS are u32 indices into a string table stored at the end
 * of the file rather than inline strings. Older revisions inline them. Both are handled.
 *
 * Valve changes this format every few years. Every failure path here is non-fatal: a parse error
 * costs us names for uninstalled games, nothing more.
 */

const MAGIC_V29 = 0x07564429; // string table
const MAGIC_V28 = 0x07564428;
const MAGIC_V27 = 0x07564427;

// Binary VDF node types
const T_NESTED = 0x00;
const T_STRING = 0x01;
const T_INT32 = 0x02;
const T_FLOAT32 = 0x03;
const T_POINTER = 0x04;
const T_WIDESTRING = 0x05;
const T_COLOR = 0x06;
const T_UINT64 = 0x07;
const T_END = 0x08;
const T_INT64 = 0x0a;
const T_END_ALT = 0x0b;

export interface AppInfoEntry {
  name: string;
  /** Steam's own classification: Game, Application, Tool, Demo, DLC, Music, Video, Config … */
  type: string;
}

interface VdfNode {
  [key: string]: string | number | VdfNode;
}

function readStringTable(buf: Buffer, offset: number): string[] {
  const count = buf.readUInt32LE(offset);
  const table: string[] = new Array(count);
  let p = offset + 4;
  for (let i = 0; i < count; i++) {
    const end = buf.indexOf(0, p);
    if (end < 0) break;
    table[i] = buf.toString('utf8', p, end);
    p = end + 1;
  }
  return table;
}

/** Parse one binary-VDF node. Returns the node and the offset just past its terminator. */
function parseNode(buf: Buffer, start: number, stringTable: string[] | null, depth = 0): [VdfNode, number] {
  const node: VdfNode = {};
  let p = start;
  if (depth > 16) throw new Error('appinfo node nested too deep');

  for (;;) {
    if (p >= buf.length) throw new Error('unexpected end of appinfo record');
    const type = buf[p];
    p += 1;
    if (type === T_END || type === T_END_ALT) return [node, p];

    let key: string;
    if (stringTable) {
      const idx = buf.readUInt32LE(p);
      p += 4;
      key = stringTable[idx] ?? `__${idx}`;
    } else {
      const end = buf.indexOf(0, p);
      if (end < 0) throw new Error('unterminated key');
      key = buf.toString('utf8', p, end);
      p = end + 1;
    }

    switch (type) {
      case T_NESTED: {
        const [child, next] = parseNode(buf, p, stringTable, depth + 1);
        node[key] = child;
        p = next;
        break;
      }
      case T_STRING:
      case T_WIDESTRING: {
        const end = buf.indexOf(0, p);
        if (end < 0) throw new Error('unterminated string');
        node[key] = buf.toString('utf8', p, end);
        p = end + 1;
        break;
      }
      case T_INT32:
      case T_POINTER:
      case T_COLOR:
        node[key] = buf.readInt32LE(p);
        p += 4;
        break;
      case T_FLOAT32:
        node[key] = buf.readFloatLE(p);
        p += 4;
        break;
      case T_UINT64:
      case T_INT64:
        node[key] = buf.readBigUInt64LE(p).toString();
        p += 8;
        break;
      default:
        throw new Error(`unknown appinfo node type 0x${type.toString(16)}`);
    }
  }
}

/**
 * Read appinfo.vdf and return appid → { name, type }.
 * Returns an empty map (never throws) if the file is missing or the format has changed.
 */
export function parseAppInfo(appInfoPath: string): Map<number, AppInfoEntry> {
  const result = new Map<number, AppInfoEntry>();

  let buf: Buffer;
  try {
    if (!fs.existsSync(appInfoPath)) return result;
    buf = fs.readFileSync(appInfoPath);
  } catch (e) {
    console.warn('[Steam] Could not read appinfo.vdf:', e);
    return result;
  }
  if (buf.length < 16) return result;

  const magic = buf.readUInt32LE(0);
  if (magic !== MAGIC_V29 && magic !== MAGIC_V28 && magic !== MAGIC_V27) {
    console.warn(`[Steam] Unrecognised appinfo.vdf version 0x${magic.toString(16)} — uninstalled game names unavailable`);
    return result;
  }

  let stringTable: string[] | null = null;
  let offset = 8;
  if (magic === MAGIC_V29) {
    try {
      const tableOffset = Number(buf.readBigInt64LE(8));
      if (tableOffset > 0 && tableOffset < buf.length) stringTable = readStringTable(buf, tableOffset);
    } catch {
      // fall through — without the table the records can't be read, handled below
    }
    offset = 16;
    if (!stringTable) {
      console.warn('[Steam] appinfo.vdf string table unreadable — uninstalled game names unavailable');
      return result;
    }
  }

  // sha1 + changeNumber + the v28+ second sha1 sit between the record header and the VDF blob
  const preambleSize = 4 + 4 + 8 + 20 + 4 + (magic === MAGIC_V27 ? 0 : 20);
  let failures = 0;

  while (offset + 8 <= buf.length) {
    const appId = buf.readUInt32LE(offset);
    if (appId === 0) break;
    const size = buf.readUInt32LE(offset + 4);
    const nextOffset = offset + 8 + size;
    if (size === 0 || nextOffset > buf.length) break;

    try {
      const [node] = parseNode(buf, offset + 8 + preambleSize, stringTable);
      const appinfo = node['appinfo'];
      const container = (typeof appinfo === 'object' ? appinfo : node) as VdfNode;
      const common = container['common'];
      if (common && typeof common === 'object') {
        const name = (common as VdfNode)['name'];
        const type = (common as VdfNode)['type'];
        if (typeof name === 'string' && name) {
          result.set(appId, { name, type: typeof type === 'string' ? type : 'Game' });
        }
      }
    } catch {
      failures++;
    }

    offset = nextOffset;
  }

  if (failures > 0) console.warn(`[Steam] appinfo.vdf: ${failures} record(s) unreadable, ${result.size} name(s) recovered`);
  return result;
}
