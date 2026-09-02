import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Game } from '../../shared/types';

// NOTE: Battle.net's product.db is a protobuf file with an undocumented schema.
// The schema changes with Blizzard client updates and there is no public spec.
// Attempting to parse it would break unpredictably. Instead, we read
// Battle.net.config (JSON) which reliably stores install paths, and do a
// directory scan of the default install location.

const BNET_CONFIG = path.join(
  os.homedir(),
  'AppData',
  'Roaming',
  'Battle.net',
  'Battle.net.config'
);

const DEFAULT_INSTALL_DIR = 'C:\\Program Files (x86)\\Battle.net';
const BNET_STORE = 'https://www.blizzard.com/en-us/download';

// Known Battle.net product IDs → display names
const PRODUCT_NAMES: Record<string, string> = {
  'wow': 'World of Warcraft',
  'wow_classic': 'World of Warcraft Classic',
  'wow_classic_era': 'World of Warcraft Classic Era',
  's1': 'StarCraft: Remastered',
  's2': 'StarCraft II',
  'prometheus': 'Overwatch 2',
  'd3': 'Diablo III',
  'd4': 'Diablo IV',
  'dst2': 'Destiny 2',
  'hs': 'Hearthstone',
  'hero': 'Heroes of the Storm',
  'viper': 'Call of Duty: Black Ops Cold War',
  'auks': 'Call of Duty: Vanguard',
  'lazarus': 'Call of Duty: Modern Warfare',
  'fore': 'Call of Duty: Modern Warfare II',
  'wlby': 'Crash Bandicoot 4',
  'odin': 'Call of Duty: Modern Warfare',
  'fenris': 'Diablo IV',
};

interface BnetConfig {
  Client?: {
    'Install'?: Record<string, { Path?: string }>;
  };
  Games?: Record<string, { Path?: string; LastPlayed?: string }>;
}

export function scanBattlenet(): Game[] {
  const games: Game[] = [];

  let config: BnetConfig = {};
  if (fs.existsSync(BNET_CONFIG)) {
    try {
      config = JSON.parse(fs.readFileSync(BNET_CONFIG, 'utf-8')) as BnetConfig;
    } catch (e) {
      console.error('[BattleNet] Failed to parse config:', e);
    }
  }

  // Extract game paths from Games section
  const gamePaths = config?.Games ?? {};
  const seen = new Set<string>();

  for (const [productId, entry] of Object.entries(gamePaths)) {
    const installPath = entry?.Path;
    const name = PRODUCT_NAMES[productId.toLowerCase()] ?? productId;
    const installed = !!(installPath && fs.existsSync(installPath));
    const id = `battlenet_${productId}`;

    if (seen.has(id)) continue;
    seen.add(id);

    games.push({
      id,
      name,
      platform: 'battlenet',
      appId: productId,
      installed,
      installPath: installPath ?? undefined,
      storeUrl: BNET_STORE,
    });
  }

  // Fallback: scan default install directory for known game folders
  const scanDir = config?.Client?.Install?.['Default']?.Path ?? DEFAULT_INSTALL_DIR;
  if (fs.existsSync(scanDir)) {
    try {
      const entries = fs.readdirSync(scanDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const productId = entry.name;
        const id = `battlenet_${productId}`;
        if (seen.has(id)) continue;
        seen.add(id);

        const installPath = path.join(scanDir, entry.name);
        const name = PRODUCT_NAMES[productId.toLowerCase()] ?? entry.name;

        games.push({
          id,
          name,
          platform: 'battlenet',
          appId: productId,
          installed: true,
          installPath,
          storeUrl: BNET_STORE,
        });
      }
    } catch (e) {
      console.error('[BattleNet] Failed to scan install dir:', e);
    }
  }

  return games;
}
