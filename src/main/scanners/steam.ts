import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { pathToFileURL } from 'url';
import axios from 'axios';
import * as vdf from '@node-steam/vdf';
import { Game } from '../../shared/types';
import { parseAppInfo, AppInfoEntry } from '../appinfo';

/**
 * Steam scanner.
 *
 * Installed games come from the `appmanifest_*.acf` files in every library folder.
 *
 * OWNED-BUT-UNINSTALLED games are detected entirely from local client data, so the Uninstalled
 * tab works with no API key:
 *   userdata/<accountId>/config/localconfig.vdf  → appids the account owns / has launched
 *   appcache/appinfo.vdf                         → name + type for each appid
 *   appcache/librarycache/<appid>/header.jpg     → cover art already on disk
 *
 * A Steam Web API key still adds anything the local cache has never seen (games owned but never
 * installed or launched on this machine), so it is merged in on top when configured.
 */

let Registry: typeof import('winreg') | null = null;
try {
  Registry = require('winreg');
} catch {
  console.warn('[Steam] winreg not available — falling back to default install paths');
}

const STEAM_CDN_HEADER = (appId: string) =>
  `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg`;

const STEAM_STORE = (appId: string) => `https://store.steampowered.com/app/${appId}`;

/**
 * Steam app types that are never games. `Application` is deliberately NOT here: Wallpaper Engine
 * and similar are things people genuinely keep in their library.
 */
const JUNK_TYPES = new Set(['tool', 'config', 'dlc', 'music', 'video', 'series', 'hardware', 'beta']);

/** Owned by every account and not a real game — Valve's SDK sample and the redist bundle. */
const IGNORED_APP_IDS = new Set(['480', '228980']);

function isJunkType(type: string | undefined): boolean {
  return JUNK_TYPES.has((type ?? '').toLowerCase());
}

// ─── Install location ─────────────────────────────────────────────────────────

function readSteamPathFromRegistry(): Promise<string | null> {
  return new Promise((resolve) => {
    if (!Registry) return resolve(null);
    try {
      const reg = new Registry!({ hive: Registry!.HKCU, key: '\\Software\\Valve\\Steam' });
      reg.get('SteamPath', (err: Error | null, item: { value: string } | null) => {
        if (err || !item?.value) return resolve(null);
        resolve(path.normalize(item.value));
      });
    } catch {
      resolve(null);
    }
  });
}

async function getSteamInstallDir(): Promise<string | null> {
  const candidates: string[] = [];
  const fromRegistry = await readSteamPathFromRegistry();
  if (fromRegistry) candidates.push(fromRegistry);
  candidates.push(
    'C:\\Program Files (x86)\\Steam',
    'C:\\Program Files\\Steam',
    path.join(os.homedir(), 'AppData', 'Local', 'Steam'),
  );

  for (const p of candidates) {
    try {
      // steamapps is the part we actually need; steam.exe is missing on some copies
      if (fs.existsSync(path.join(p, 'steam.exe')) || fs.existsSync(path.join(p, 'steamapps'))) return p;
    } catch {
      // next candidate
    }
  }
  return null;
}

function parseLibraryFolders(steamDir: string): string[] {
  const vdfPath = path.join(steamDir, 'steamapps', 'libraryfolders.vdf');
  const dirs: string[] = [path.join(steamDir, 'steamapps')];
  if (!fs.existsSync(vdfPath)) return dirs;

  try {
    const raw = fs.readFileSync(vdfPath, 'utf-8');
    const parsed = vdf.parse(raw) as Record<string, unknown>;
    const lf = (parsed['libraryfolders'] ?? parsed['LibraryFolders']) as Record<string, unknown>;
    if (!lf) return dirs;

    for (const key of Object.keys(lf)) {
      const entry = lf[key] as Record<string, unknown> | string;
      let libPath: string | undefined;
      if (typeof entry === 'object' && entry !== null && typeof entry['path'] === 'string') {
        libPath = entry['path'];
      } else if (typeof entry === 'string' && fs.existsSync(entry)) {
        libPath = entry;
      }
      if (libPath) {
        const steamapps = path.join(libPath, 'steamapps');
        if (fs.existsSync(steamapps) && !dirs.includes(steamapps)) dirs.push(steamapps);
      }
    }
  } catch (e) {
    console.error('[Steam] Failed to parse libraryfolders.vdf:', e);
  }
  return dirs;
}

// ─── Installed games ──────────────────────────────────────────────────────────

function scanAcfManifests(steamappsDir: string): Map<string, { name: string; installDir: string }> {
  const result = new Map<string, { name: string; installDir: string }>();
  if (!fs.existsSync(steamappsDir)) return result;

  let files: string[];
  try {
    files = fs.readdirSync(steamappsDir).filter((f) => f.startsWith('appmanifest_') && f.endsWith('.acf'));
  } catch {
    return result;
  }

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(steamappsDir, file), 'utf-8');
      const parsed = vdf.parse(raw) as Record<string, unknown>;
      const state = parsed['AppState'] as Record<string, unknown>;
      if (!state) continue;
      const appId = String(state['appid'] ?? '');
      const name = String(state['name'] ?? '');
      const installDir = String(state['installdir'] ?? '');
      if (appId && name) {
        result.set(appId, { name, installDir: path.join(steamappsDir, 'common', installDir) });
      }
    } catch {
      // skip bad manifests
    }
  }
  return result;
}

// ─── Locally-known owned games ────────────────────────────────────────────────

/** Account IDs (32-bit) that have a profile folder under userdata/. */
function listLocalAccountIds(steamDir: string): string[] {
  const userdata = path.join(steamDir, 'userdata');
  try {
    return fs
      .readdirSync(userdata, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d+$/.test(e.name) && e.name !== '0')
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * App IDs this account owns, from localconfig.vdf. Steam records an entry per app the account
 * has installed, launched or configured, whether or not it is installed right now — which is
 * exactly the set needed to show uninstalled games.
 */
function readOwnedAppIds(steamDir: string, accountId: string): Set<string> {
  const owned = new Set<string>();
  const configPath = path.join(steamDir, 'userdata', accountId, 'config', 'localconfig.vdf');

  let parsed: Record<string, unknown>;
  try {
    if (!fs.existsSync(configPath)) return owned;
    parsed = vdf.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
  } catch (e) {
    console.warn('[Steam] Could not parse localconfig.vdf for account', accountId, e);
    return owned;
  }

  // Key casing has changed across client versions, so match case-insensitively at each level.
  const descend = (node: unknown, key: string): unknown => {
    if (!node || typeof node !== 'object') return undefined;
    const rec = node as Record<string, unknown>;
    const match = Object.keys(rec).find((k) => k.toLowerCase() === key.toLowerCase());
    return match === undefined ? undefined : rec[match];
  };

  const root = Object.values(parsed)[0];
  const apps = descend(descend(descend(descend(root, 'Software'), 'Valve'), 'Steam'), 'apps');
  if (!apps || typeof apps !== 'object') return owned;

  for (const [appId, value] of Object.entries(apps as Record<string, unknown>)) {
    if (!/^\d+$/.test(appId)) continue;
    // Entries carrying only cloud-quota data are Steam infrastructure, not owned games
    if (value && typeof value === 'object') {
      const keys = Object.keys(value as Record<string, unknown>);
      if (keys.length === 1 && keys[0].toLowerCase() === 'cloud') continue;
    }
    owned.add(appId);
  }
  return owned;
}

// ─── Local cover art ──────────────────────────────────────────────────────────

/**
 * Steam already caches store art on disk. Using it avoids the CDN 404s that noisy appids
 * (tools, delisted games) produce and means art shows up with no network at all.
 */
function findLocalCoverArt(steamDir: string, accountId: string | null, appId: string): string | null {
  const dirs = [path.join(steamDir, 'appcache', 'librarycache', appId)];
  if (accountId) dirs.push(path.join(steamDir, 'userdata', accountId, 'config', 'librarycache', appId));

  // Landscape banners first — they match the card's 460x215 aspect ratio
  const preferred = ['header.jpg', 'library_header.jpg', 'header_2x.jpg'];
  for (const dir of dirs) {
    for (const file of preferred) {
      const full = path.join(dir, file);
      try {
        if (fs.existsSync(full)) return pathToFileURL(full).href;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

// ─── Steam Web API (optional) ─────────────────────────────────────────────────

async function fetchOwnedGames(apiKey: string, userId: string): Promise<{ appid: number; name: string }[]> {
  try {
    const res = await axios.get('https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/', {
      params: { key: apiKey, steamid: userId, include_appinfo: 1, format: 'json' },
      timeout: 10000,
    });
    return res.data?.response?.games ?? [];
  } catch (e) {
    console.error('[Steam] Web API request failed:', e);
    return [];
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export async function scanSteam(apiKey: string, userId: string): Promise<Game[]> {
  const steamDir = await getSteamInstallDir();
  if (!steamDir) {
    console.log('[Steam] Steam install not found');
    return [];
  }
  console.log('[Steam] Using install dir:', steamDir);

  // 1. Installed games from ACF manifests
  const installedByAppId = new Map<string, { name: string; installDir: string }>();
  for (const dir of parseLibraryFolders(steamDir)) {
    for (const [appId, data] of scanAcfManifests(dir)) installedByAppId.set(appId, data);
  }

  // 2. Local metadata: names/types for everything, plus the owned list per account
  const appInfo = parseAppInfo(path.join(steamDir, 'appcache', 'appinfo.vdf'));
  const accountIds = listLocalAccountIds(steamDir);
  const primaryAccount = accountIds[0] ?? null;

  const ownedAppIds = new Set<string>();
  for (const accountId of accountIds) {
    for (const appId of readOwnedAppIds(steamDir, accountId)) ownedAppIds.add(appId);
  }
  console.log(
    `[Steam] ${installedByAppId.size} installed, ${ownedAppIds.size} known locally, ` +
      `${appInfo.size} cached name(s), ${accountIds.length} account(s)`,
  );

  const games: Game[] = [];
  const seen = new Set<string>();

  const addGame = (appId: string, fallbackName: string, installed: boolean, installDir?: string): void => {
    if (seen.has(appId) || IGNORED_APP_IDS.has(appId)) return;

    const info: AppInfoEntry | undefined = appInfo.get(Number(appId));
    // Tools, DLC and soundtracks are filtered whether or not they are installed — that is what
    // put "Steamworks Common Redistributables" in the library.
    if (isJunkType(info?.type)) return;

    const name = info?.name ?? fallbackName;
    if (!name) return;

    seen.add(appId);
    games.push({
      id: `steam_${appId}`,
      name,
      platform: 'steam',
      appId,
      installed,
      installPath: installDir,
      coverArt: findLocalCoverArt(steamDir, primaryAccount, appId) ?? STEAM_CDN_HEADER(appId),
      coverSource: 'store',
      storeUrl: STEAM_STORE(appId),
    });
  };

  for (const [appId, data] of installedByAppId) addGame(appId, data.name, true, data.installDir);

  // Uninstalled entries need a real name; without one the card would just show an appid.
  let unnamed = 0;
  for (const appId of ownedAppIds) {
    if (installedByAppId.has(appId)) continue;
    if (!appInfo.has(Number(appId))) {
      unnamed++;
      continue;
    }
    addGame(appId, '', false);
  }
  if (unnamed > 0) {
    console.log(`[Steam] ${unnamed} owned appid(s) skipped — not in the local appinfo cache yet`);
  }

  // 3. Web API fills in anything never installed or launched on this machine
  if (apiKey && userId) {
    for (const g of await fetchOwnedGames(apiKey, userId)) {
      const appId = String(g.appid);
      const installed = installedByAppId.get(appId);
      addGame(appId, g.name, !!installed, installed?.installDir);
    }
  }

  return games;
}
