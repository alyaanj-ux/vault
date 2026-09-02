import * as fs from 'fs';
import * as path from 'path';
import { Game } from '../../shared/types';

// Executables to skip — system/utility binaries unlikely to be games
const SKIP_PATTERNS = [
  /windows/i,
  /system32/i,
  /syswow64/i,
  /microsoft/i,
  /common files/i,
  /windowsapps/i,
  /vcredist/i,
  /directx/i,
  /dotnet/i,
  /\.net framework/i,
  /visual studio/i,
  /git/i,
  /node_modules/i,
  /uninstall/i,
  /unins\d+/i,
  /setup/i,
  /installer/i,
  /update/i,
  /crash/i,
  /report/i,
  /helper/i,
  /service/i,
  /daemon/i,
];

const GAME_EXE_SIGNALS = [
  /game/i,
  /launcher/i,
  /start/i,
  /play/i,
];

function shouldSkip(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  return SKIP_PATTERNS.some((p) => p.test(normalized));
}

function looksLikeGame(filePath: string): boolean {
  // If in a skip path, never show it
  if (shouldSkip(filePath)) return false;

  const dir = path.dirname(filePath);
  const name = path.basename(filePath, '.exe').toLowerCase();

  // Bonus: if exe name contains game signals, more likely a game
  const hasGameSignal = GAME_EXE_SIGNALS.some((p) => p.test(name));

  // Check if exe is in its own dedicated folder (common for game installs)
  // rather than a shared /bin or /tools directory
  const parentDir = path.basename(dir).toLowerCase();
  const isInOwnFolder = parentDir !== 'bin' && parentDir !== 'tools' && parentDir !== 'system';

  return hasGameSignal || isInOwnFolder;
}

function* walkDir(dir: string, maxDepth: number, currentDepth = 0): Generator<string> {
  if (currentDepth > maxDepth) return;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!shouldSkip(full)) yield* walkDir(full, maxDepth, currentDepth + 1);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.exe')) {
        yield full;
      }
    }
  } catch {
    // skip unreadable dirs
  }
}

export function scanCustomFolders(watchedFolders: string[]): Game[] {
  const games: Game[] = [];
  const seen = new Set<string>();

  for (const folder of watchedFolders) {
    if (!fs.existsSync(folder)) continue;

    for (const exePath of walkDir(folder, 4)) {
      if (seen.has(exePath)) continue;
      if (!looksLikeGame(exePath)) continue;

      seen.add(exePath);
      const name = path.basename(exePath, '.exe')
        .replace(/[\-_]/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase())
        .trim();

      games.push({
        id: `custom_${exePath}`,
        name,
        platform: 'custom',
        installed: true,
        installPath: path.dirname(exePath),
        executablePath: exePath,
      });
    }
  }

  return games;
}
