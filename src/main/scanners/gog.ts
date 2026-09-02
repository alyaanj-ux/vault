import * as fs from 'fs';
import { Game } from '../../shared/types';

// NOTE: GOG Galaxy's storage DB at %PROGRAMDATA%\GOG.com\Galaxy\storage\ is a SQLite database
// with an undocumented and frequently-changing schema. Parsing it reliably across Galaxy versions
// is not feasible without reverse engineering each update. We use the Windows registry instead,
// which GOG has maintained consistently across versions.

let Registry: typeof import('winreg') | null = null;
try {
  Registry = require('winreg');
} catch {
  console.warn('[GOG] winreg not available — registry scan skipped');
}

const GOG_REGISTRY_KEY = '\\SOFTWARE\\GOG.com\\Games';
const GOG_STORE = (gameId: string) => `https://www.gog.com/en/game/${gameId}`;

interface RegistryItem {
  name: string;
  type: string;
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

export async function scanGOG(): Promise<Game[]> {
  const games: Game[] = [];
  if (!Registry) return games;

  const subkeys = await listRegistryKeys(GOG_REGISTRY_KEY);

  for (const subkey of subkeys) {
    try {
      const values = await readRegistryValues(subkey.key);
      const get = (name: string) =>
        values.find((v) => v.name.toLowerCase() === name.toLowerCase())?.value ?? '';

      const gameId = get('gameID') || get('id');
      const gameName = get('gameName') || get('GAMENAME');
      const installPath = get('path') || get('exe');

      if (!gameName) continue;

      const installed = !!(installPath && fs.existsSync(installPath));

      games.push({
        id: `gog_${gameId || gameName}`,
        name: gameName,
        platform: 'gog',
        appId: gameId,
        installed,
        installPath: installPath || undefined,
        storeUrl: gameId ? GOG_STORE(gameId) : 'https://www.gog.com/games',
      });
    } catch (e) {
      console.error('[GOG] Failed to read subkey:', subkey.key, e);
    }
  }

  return games;
}
