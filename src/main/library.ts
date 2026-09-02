import * as fs from 'fs';
import * as path from 'path';
import { Game, ScanResult } from '../shared/types';
import { getVaultDir } from './settings';

let cachedLibrary: Game[] = [];

function getLibraryPath(): string {
  return path.join(getVaultDir(), 'library.json');
}

export function loadLibrary(): Game[] {
  try {
    const p = getLibraryPath();
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, 'utf-8');
      cachedLibrary = JSON.parse(raw) as Game[];
      return cachedLibrary;
    }
  } catch (e) {
    console.error('[Library] Failed to load library:', e);
  }
  return [];
}

export function saveLibrary(games: Game[]): void {
  try {
    fs.writeFileSync(getLibraryPath(), JSON.stringify(games, null, 2), 'utf-8');
    cachedLibrary = games;
  } catch (e) {
    console.error('[Library] Failed to save library:', e);
  }
}

export function getLibrary(): Game[] {
  if (cachedLibrary.length === 0) return loadLibrary();
  return cachedLibrary;
}

/**
 * Merge multiple scan results, deduplicating by id.
 * Preserves lastLaunched, playtime, and hidden flag from cached library.
 */
export function mergeGames(scanResults: ScanResult[]): Game[] {
  const existing = new Map<string, Game>();
  // In-memory library is the source of truth: background enrichment may not have flushed yet.
  for (const g of getLibrary()) {
    existing.set(g.id, g);
  }

  const merged = new Map<string, Game>();

  for (const result of scanResults) {
    for (const game of result.games) {
      if (merged.has(game.id)) continue;
      const prior = existing.get(game.id);
      // Scraped artwork always wins over scanner-provided art (the user may have picked it).
      // Scanner art wins over an extracted exe icon. Otherwise keep whatever we had.
      const priorScraped = prior?.coverSource === 'sgdb' || prior?.coverSource === 'steamstore';
      const keepPriorArt = !!prior?.coverArt && (priorScraped || !game.coverArt);
      merged.set(game.id, {
        ...game,
        coverArt: keepPriorArt ? prior!.coverArt : game.coverArt,
        coverSource: keepPriorArt ? prior!.coverSource : game.coverArt ? (game.coverSource ?? 'store') : undefined,
        artScrapedAt: prior?.artScrapedAt,
        lastLaunched: prior?.lastLaunched ?? game.lastLaunched,
        playtime: prior?.playtime ?? game.playtime,
        // Preserve hidden flag across rescans — user shouldn't have to re-hide after rescan
        hidden: prior?.hidden ?? false,
      });
    }
  }

  const games = Array.from(merged.values());
  games.sort((a, b) => a.name.localeCompare(b.name));
  return games;
}

export function setGameHidden(gameId: string, hidden: boolean): boolean {
  const library = getLibrary();
  const game = library.find((g) => g.id === gameId);
  if (!game) return false;
  game.hidden = hidden;
  saveLibrary(library);
  return true;
}

/**
 * Apply a partial update to one game in the live library. Persisting is optional so callers
 * doing many small updates (icon extraction, scraping) can batch their writes.
 */
export function patchGame(gameId: string, patch: Partial<Game>, persist = true): boolean {
  const library = getLibrary();
  const game = library.find((g) => g.id === gameId);
  if (!game) return false;
  Object.assign(game, patch);
  if (persist) saveLibrary(library);
  return true;
}

export function updateGameLastLaunched(gameId: string): void {
  const library = getLibrary();
  const game = library.find((g) => g.id === gameId);
  if (game) {
    game.lastLaunched = Date.now();
    saveLibrary(library);
  }
}
