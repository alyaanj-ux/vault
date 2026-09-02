import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Game } from '../../shared/types';

const UBISOFT_GAMES_JSON = path.join(
  os.homedir(),
  'AppData',
  'Local',
  'Ubisoft Game Launcher',
  'games.json'
);

const UBISOFT_STORE = (id: string) => `uplay://launch/${id}/0`;

let Registry: typeof import('winreg') | null = null;
try {
  Registry = require('winreg');
} catch {
  console.warn('[Ubisoft] winreg not available');
}

interface UbisoftGameEntry {
  uplay_id?: number | string;
  name?: string;
  installdir?: string;
  exe?: string;
}

function listRegistryKeys(key: string): Promise<{ key: string }[]> {
  return new Promise((resolve) => {
    if (!Registry) return resolve([]);
    const reg = new Registry!({ hive: Registry!.HKLM, key });
    reg.keys((err: Error | null, keys: { key: string }[]) => {
      if (err) resolve([]);
      else resolve(keys ?? []);
    });
  });
}

interface RegistryItem {
  name: string;
  value: string;
}

function readRegistryValues(key: string): Promise<RegistryItem[]> {
  return new Promise((resolve) => {
    if (!Registry) return resolve([]);
    const reg = new Registry!({ hive: Registry!.HKLM, key });
    reg.values((err: Error | null, items: RegistryItem[]) => {
      if (err) resolve([]);
      else resolve(items ?? []);
    });
  });
}

async function scanFromRegistry(): Promise<Game[]> {
  const games: Game[] = [];
  if (!Registry) return games;

  const subkeys = await listRegistryKeys('\\SOFTWARE\\Ubisoft\\Launcher\\Installs');
  for (const subkey of subkeys) {
    try {
      const values = await readRegistryValues(subkey.key);
      const get = (name: string) =>
        values.find((v) => v.name.toLowerCase() === name.toLowerCase())?.value ?? '';

      const installDir = get('InstallDir');
      const uplayId = subkey.key.split('\\').pop() ?? '';

      if (!installDir) continue;
      const installed = fs.existsSync(installDir);

      // Registry doesn't reliably store game name; use folder name as fallback
      const name = path.basename(installDir) || `Ubisoft Game ${uplayId}`;

      games.push({
        id: `ubisoft_${uplayId}`,
        name,
        platform: 'ubisoft',
        appId: uplayId,
        installed,
        installPath: installDir,
        storeUrl: UBISOFT_STORE(uplayId),
      });
    } catch (e) {
      console.error('[Ubisoft] Failed to read registry subkey:', subkey.key, e);
    }
  }
  return games;
}

function scanFromJson(): Game[] {
  const games: Game[] = [];
  if (!fs.existsSync(UBISOFT_GAMES_JSON)) return games;

  try {
    const raw = fs.readFileSync(UBISOFT_GAMES_JSON, 'utf-8');
    const entries: UbisoftGameEntry[] = JSON.parse(raw);

    for (const entry of entries) {
      if (!entry.name) continue;
      const installPath = entry.installdir ?? undefined;
      const installed = !!(installPath && fs.existsSync(installPath));
      const id = String(entry.uplay_id ?? entry.name);

      games.push({
        id: `ubisoft_${id}`,
        name: entry.name,
        platform: 'ubisoft',
        appId: id,
        installed,
        installPath,
        storeUrl: entry.uplay_id ? UBISOFT_STORE(String(entry.uplay_id)) : 'https://www.ubisoft.com',
      });
    }
  } catch (e) {
    console.error('[Ubisoft] Failed to parse games.json:', e);
  }
  return games;
}

export async function scanUbisoft(): Promise<Game[]> {
  const fromJson = scanFromJson();
  if (fromJson.length > 0) return fromJson;

  // Fallback: registry (names are less reliable here)
  return await scanFromRegistry();
}
