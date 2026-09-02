import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { pathToFileURL } from 'url';
import { Game } from '../../shared/types';

// NOTE: Xbox Game Pass games are sandboxed in encrypted WindowsApps packages. The Windows Gaming
// Services COM API that could enumerate them needs native bindings compiled against the Windows
// SDK, which can't ship in a portable Electron app. So we scan the XboxGames folder instead and
// read each title's MicrosoftGame.Config, which is plain XML and sits outside the encrypted part.

const DEFAULT_XBOX_DIRS = [
  path.join('C:\\', 'XboxGames'),
  path.join(os.homedir(), 'XboxGames'),
];

const XBOX_STORE = (storeId: string | null) =>
  storeId ? `https://www.xbox.com/games/store/-/${storeId}` : 'https://www.xbox.com/en-US/games/browse';

/**
 * Folders Windows keeps alongside real games in XboxGames. `GameSave` holds cloud-save data
 * (pgs/wgs subfolders) and is not a game. Anything without a MicrosoftGame.Config is rejected
 * anyway; this list just avoids the wasted stat calls and documents the known offenders.
 */
const NON_GAME_FOLDERS = new Set(['gamesave', 'gamesaves', 'temp', 'windowsapps', '$recycle.bin']);

/** Square logos, biggest usable first. Used as a placeholder until the scraper finds real art. */
const LOGO_CANDIDATES = [
  'SplashScreen.png',
  'GraphicsLogo.png',
  'Logo.png',
  'StoreLogo.png',
  'SmallLogo.scale-400.png',
  'SmallLogo.png',
];

interface GameConfig {
  displayName: string | null;
  identityName: string | null;
  identityVersion: string | null;
  architecture: string | null;
  executable: string | null;
  storeId: string | null;
}

function attr(xml: string, tag: string, name: string): string | null {
  // Attributes may sit on any line of a multi-line tag, so match the whole element first.
  const el = xml.match(new RegExp(`<${tag}\\b[^>]*>`, 'i'));
  if (!el) return null;
  const m = el[0].match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i'));
  return m ? m[1].trim() || null : null;
}

function parseGameConfig(configPath: string): GameConfig | null {
  let xml: string;
  try {
    xml = fs.readFileSync(configPath, 'utf-8');
  } catch {
    return null;
  }
  // Comments in the shipped template contain example attributes — strip them before matching.
  xml = xml.replace(/<!--[\s\S]*?-->/g, '');

  return {
    // Modern GDK titles use ShellVisuals/DefaultDisplayName; older ones a <DisplayName> element.
    displayName:
      attr(xml, 'ShellVisuals', 'DefaultDisplayName') ??
      xml.match(/<DisplayName>([^<]+)<\/DisplayName>/i)?.[1]?.trim() ??
      null,
    identityName: attr(xml, 'Identity', 'Name'),
    identityVersion: attr(xml, 'Identity', 'Version'),
    architecture: xml.match(/<ProcessorArchitecture>([^<]+)<\/ProcessorArchitecture>/i)?.[1]?.trim() ?? null,
    executable: attr(xml, 'Executable', 'Name'),
    storeId: xml.match(/<StoreId>([^<]+)<\/StoreId>/i)?.[1]?.trim() ?? null,
  };
}

/**
 * Resolve the package family name (`<identity>_<publisherHash>`) by looking for the per-user
 * package folder Windows creates for every installed package. Readable without elevation.
 */
function findPackageFamilyName(identityName: string): string | null {
  const packagesDir = path.join(os.homedir(), 'AppData', 'Local', 'Packages');
  try {
    const prefix = `${identityName}_`;
    for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith(prefix)) return entry.name;
    }
  } catch {
    // no package folder — game may be installed for another user
  }
  return null;
}

/**
 * The Application Id from the package's AppxManifest.xml. Combined with the family name it forms
 * the AUMID, which is the only reliable way to start a packaged game: launching the exe directly
 * bypasses the licensing container and most Game Pass titles refuse to run.
 *
 * WindowsApps denies directory LISTING to normal users but still allows reading a file by its
 * full path, so the package folder name is reconstructed rather than searched for. It is
 * `<identity>_<version>_<arch>__<publisherHash>`, and every part is known: identity, version and
 * architecture come from MicrosoftGame.Config, the hash from the per-user package family name.
 */
function findApplicationId(config: GameConfig, familyName: string | null): string | null {
  const identity = config.identityName;
  if (!identity) return null;

  const roots = Array.from(
    new Set([
      path.join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'WindowsApps'),
      path.join(process.env['ProgramW6432'] ?? 'C:\\Program Files', 'WindowsApps'),
    ]),
  );

  const readId = (manifestPath: string): string | null => {
    try {
      const manifest = fs.readFileSync(manifestPath, 'utf-8');
      const id = manifest.match(/<Application\b[^>]*\bId\s*=\s*"([^"]+)"/i);
      return id ? id[1] : null;
    } catch {
      return null;
    }
  };

  // 1. Reconstruct the exact folder name — works despite the listing being blocked
  const publisherHash = familyName?.includes('_') ? familyName.substring(familyName.lastIndexOf('_') + 1) : null;
  if (publisherHash && config.identityVersion) {
    const arches = [config.architecture, 'x64', 'x86', 'arm64', 'neutral'].filter(
      (a): a is string => !!a,
    );
    for (const root of roots) {
      for (const arch of Array.from(new Set(arches.map((a) => a.toLowerCase())))) {
        const folder = `${identity}_${config.identityVersion}_${arch}__${publisherHash}`;
        const id = readId(path.join(root, folder, 'AppxManifest.xml'));
        if (id) return id;
      }
    }
  }

  // 2. Fall back to scanning, for the systems where listing is permitted
  for (const root of roots) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(`${identity}_`)) continue;
      const id = readId(path.join(root, entry.name, 'AppxManifest.xml'));
      if (id) return id;
    }
  }
  return null;
}

function findLocalLogo(contentDir: string): string | null {
  for (const file of LOGO_CANDIDATES) {
    const full = path.join(contentDir, file);
    try {
      if (fs.existsSync(full)) return pathToFileURL(full).href;
    } catch {
      // keep looking
    }
  }
  return null;
}

/**
 * Microsoft ships some titles with the launcher's name as the display name — "Minecraft Launcher"
 * for the Minecraft entry. When the executable or the app id is the same word without the suffix,
 * the suffix is noise, so drop it. Anything whose launcher really is a separate product keeps it.
 */
function normalizeName(displayName: string, executable: string | null, appId: string | null): string {
  const stripped = displayName.replace(/\s+(launcher|game launcher)$/i, '').trim();
  if (stripped === displayName || !stripped) return displayName;

  const exeBase = executable ? path.basename(executable, path.extname(executable)) : '';
  const matches = (v: string): boolean => v.toLowerCase() === stripped.toLowerCase();
  return matches(exeBase) || (appId !== null && matches(appId)) ? stripped : displayName;
}

function findXboxGames(dir: string): Game[] {
  const games: Game[] = [];
  if (!fs.existsSync(dir)) return games;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    console.error('[Xbox] Failed to scan directory:', dir, e);
    return games;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || NON_GAME_FOLDERS.has(entry.name.toLowerCase())) continue;

    const gameDir = path.join(dir, entry.name);
    const contentDir = path.join(gameDir, 'Content');
    const configPath = path.join(contentDir, 'MicrosoftGame.Config');

    // A real installed title always ships this file. Save-data and scratch folders never do,
    // which is what kept "GameSave" showing up as a game.
    if (!fs.existsSync(configPath)) {
      console.log('[Xbox] Skipping non-game folder (no MicrosoftGame.Config):', entry.name);
      continue;
    }

    const config = parseGameConfig(configPath);
    if (!config) continue;

    const familyName = config.identityName ? findPackageFamilyName(config.identityName) : null;
    const applicationId = findApplicationId(config, familyName);
    const aumid = familyName && applicationId ? `${familyName}!${applicationId}` : null;

    const displayName = config.displayName ?? entry.name;
    const name = normalizeName(displayName, config.executable, applicationId);

    const exePath = config.executable ? path.join(contentDir, config.executable) : null;
    const logo = findLocalLogo(contentDir);

    if (!aumid) {
      console.log(`[Xbox] ${name}: no AUMID resolved — will fall back to launching the executable`);
    }

    games.push({
      id: `xbox_${(config.identityName ?? entry.name).replace(/\s+/g, '_')}`,
      name,
      platform: 'xbox',
      installed: true,
      installPath: gameDir,
      executablePath: exePath && fs.existsSync(exePath) ? exePath : undefined,
      // AUMID goes in appId; the launch handler prefers it over the raw executable
      appId: aumid ?? undefined,
      coverArt: logo ?? undefined,
      // Package logos are square placeholders — let the scraper replace them with real art
      coverSource: logo ? 'icon' : undefined,
      storeUrl: XBOX_STORE(config.storeId),
    });
  }

  return games;
}

export function scanXbox(customDirs?: string[]): Game[] {
  const games: Game[] = [];
  const seen = new Set<string>();
  const dirs = customDirs && customDirs.length > 0 ? customDirs : DEFAULT_XBOX_DIRS;

  for (const dir of dirs) {
    for (const g of findXboxGames(dir)) {
      if (!seen.has(g.id)) {
        seen.add(g.id);
        games.push(g);
      }
    }
  }

  return games;
}
