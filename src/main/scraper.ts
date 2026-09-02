import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { pathToFileURL } from 'url';
import axios from 'axios';
import { Game, Settings, CoverSource } from '../shared/types';
import { getVaultDir } from './settings';

/**
 * Artwork scraper, modelled on the Cocoon frontend's approach: search by cleaned title
 * across prioritised sources, download the best landscape banner, cache it locally.
 *
 * Sources (in priority order):
 *   1. SteamGridDB  — needs a free API key (Settings → Artwork). Covers PC, Switch, PS2/3/4,
 *                     everything. Landscape "grids" (460x215 / 920x430), falling back to heroes.
 *   2. Steam store  — keyless. Store search by name → header.jpg. PC games only, so we demand
 *                     a very close name match to avoid pairing a Switch dump with a random PC game.
 *
 * Cached files live in %APPDATA%\Vault\art\ and are referenced from library.json as file:// URLs.
 */

const SGDB_API = 'https://www.steamgriddb.com/api/v2';
const STEAM_SEARCH = 'https://store.steampowered.com/api/storesearch/';
const STEAM_HEADER = (appId: number | string) => `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg`;
const USER_AGENT = 'Vault/1.0 (+game library manager)';
const RETRY_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // re-try games with no match once a week
const CONCURRENCY = 3;

export interface ScrapeOptions {
  /** Override the search term (user corrected a bad match). */
  term?: string;
  /** Scrape even if the game already has art / was recently tried. */
  force?: boolean;
}

interface ArtHit {
  url: string;
  source: CoverSource;
  matchedName: string;
}

// ─── Title cleaning & matching ────────────────────────────────────────────────

export function cleanTitle(name: string): string {
  return name
    .replace(/[\[\(\{].*?[\]\)\}]/g, ' ')           // [0100...][v0] (USA) {region}
    .replace(/[™®©]/g, ' ')
    .replace(/\bv?\d+\.\d+(\.\d+)*\b/gi, ' ')      // v1.2.3 / 2.0.1
    .replace(/\b(update|upd|dlc|patch|repack|multi\d*)\b/gi, ' ')
    .replace(/[_]+/g, ' ')
    .replace(/\s*[-–—:]\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim() || name.trim();
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/\b(the|a|an)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.substring(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/**
 * 0..1 similarity. Exact match is 1; otherwise a Dice coefficient over bigrams, with containment
 * handled specially because it is where wrong matches come from.
 *
 * A contained title is only as good as the fraction of the longer name it covers: "Minecraft" sits
 * inside "Minecraft Dungeons" but they are different games, so it must not score highly. A purely
 * numeric remainder is a sequel ("Portal" / "Portal 2") and is capped lower still.
 */
export function similarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) {
    const remainder = na.length > nb.length ? na.replace(nb, '') : nb.replace(na, '');
    if (/^\d+$|^(ii|iii|iv|v|vi|vii|viii|ix|x)$/.test(remainder)) return 0.7;
    // 0.60 when the extra words dominate, approaching 0.95 when the remainder is a short subtitle
    const coverage = Math.min(na.length, nb.length) / Math.max(na.length, nb.length);
    return 0.6 + 0.35 * coverage;
  }

  const ba = bigrams(na);
  const bb = bigrams(nb);
  let overlap = 0;
  for (const [g, c] of ba) overlap += Math.min(c, bb.get(g) ?? 0);
  return (2 * overlap) / (Math.max(na.length - 1, 1) + Math.max(nb.length - 1, 1));
}

function bestMatch<T extends { name: string }>(term: string, items: T[], minScore: number): T | null {
  let best: T | null = null;
  let bestScore = 0;
  for (const item of items) {
    const s = similarity(term, item.name);
    if (s > bestScore) {
      best = item;
      bestScore = s;
    }
  }
  return bestScore >= minScore ? best : null;
}

// ─── Sources ──────────────────────────────────────────────────────────────────

interface SgdbGame { id: number; name: string; verified?: boolean }
interface SgdbAsset { url: string; score?: number; width?: number; height?: number; nsfw?: boolean; humor?: boolean }

async function searchSteamGridDb(term: string, apiKey: string): Promise<ArtHit | null> {
  const headers = { Authorization: `Bearer ${apiKey}`, 'User-Agent': USER_AGENT };

  const search = await axios.get(`${SGDB_API}/search/autocomplete/${encodeURIComponent(term)}`, { headers, timeout: 10000 });
  const candidates: SgdbGame[] = search.data?.data ?? [];
  if (candidates.length === 0) return null;

  // Autocomplete is already ranked; only reject if nothing is even vaguely similar.
  const game = bestMatch(term, candidates, 0.5) ?? (similarity(term, candidates[0].name) >= 0.35 ? candidates[0] : null);
  if (!game) return null;

  const pickAsset = (assets: SgdbAsset[]): string | null => {
    const usable = assets.filter((a) => a.url && !a.nsfw && !a.humor);
    usable.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    return usable[0]?.url ?? null;
  };

  // Landscape grids match the card aspect ratio (460x215)
  const grids = await axios.get(`${SGDB_API}/grids/game/${game.id}`, {
    headers, timeout: 10000,
    params: { dimensions: '460x215,920x430', types: 'static', nsfw: 'false', humor: 'false' },
  });
  let url = pickAsset(grids.data?.data ?? []);

  if (!url) {
    const heroes = await axios.get(`${SGDB_API}/heroes/game/${game.id}`, {
      headers, timeout: 10000,
      params: { types: 'static', nsfw: 'false', humor: 'false' },
    });
    url = pickAsset(heroes.data?.data ?? []);
  }

  return url ? { url, source: 'sgdb', matchedName: game.name } : null;
}

interface SteamSearchItem { id: number; name: string; type?: string }

async function searchSteamStore(term: string): Promise<ArtHit | null> {
  const res = await axios.get(STEAM_SEARCH, {
    params: { term, l: 'english', cc: 'US' },
    headers: { 'User-Agent': USER_AGENT },
    timeout: 10000,
  });
  const items: SteamSearchItem[] = (res.data?.items ?? []).filter((i: SteamSearchItem) => !i.type || i.type === 'app');
  // Deliberately strict: this source is PC-only and keyless, so a partial title match is far more
  // likely to be a different game ("Hollow Knight" vs "Hollow Knight: Silksong") than the right one.
  const match = bestMatch(term, items, 0.85);
  return match ? { url: STEAM_HEADER(match.id), source: 'steamstore', matchedName: match.name } : null;
}

// ─── Download & cache ─────────────────────────────────────────────────────────

function artDir(): string {
  const dir = path.join(getVaultDir(), 'art');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function removeCachedArt(game: Game): void {
  if (!game.coverArt?.startsWith('file:')) return;
  try {
    const p = decodeURIComponent(new URL(game.coverArt).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {
    // ignore
  }
}

async function downloadArt(game: Game, hit: ArtHit): Promise<string | null> {
  const res = await axios.get<ArrayBuffer>(hit.url, {
    responseType: 'arraybuffer',
    timeout: 20000,
    headers: { 'User-Agent': USER_AGENT },
    validateStatus: (s) => s === 200,
  });
  const contentType = String(res.headers['content-type'] ?? '');
  if (!contentType.startsWith('image/')) return null;

  const ext = contentType.includes('png') ? '.png' : contentType.includes('webp') ? '.webp' : '.jpg';
  const hash = crypto.createHash('sha1').update(game.id).digest('hex').substring(0, 20);
  const file = path.join(artDir(), `${hash}${ext}`);

  removeCachedArt(game);
  fs.writeFileSync(file, Buffer.from(res.data));
  // Query string busts the renderer image cache when art for the same game is replaced
  return pathToFileURL(file).href + "?v=" + Date.now();
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Games worth sending to the scraper on an automatic pass. */
export function needsArt(game: Game): boolean {
  if (game.hidden) return false;
  if (game.platform === 'steam') return false; // Steam CDN art already; force via context menu if wanted
  if (game.coverArt && game.coverSource !== 'icon') return false;
  if (game.artScrapedAt && Date.now() - game.artScrapedAt < RETRY_AFTER_MS) return false;
  return true;
}

/**
 * Try each source in turn for one game. Mutates `game` in place and returns true if art changed.
 * Never throws — a failed lookup just stamps artScrapedAt so it is not retried immediately.
 */
export async function scrapeArt(game: Game, settings: Settings, opts: ScrapeOptions = {}): Promise<boolean> {
  const term = (opts.term ?? cleanTitle(game.name)).trim();
  if (!term) return false;

  const sources: { name: string; run: () => Promise<ArtHit | null> }[] = [];
  if (settings.steamGridDbApiKey?.trim()) {
    sources.push({ name: 'SteamGridDB', run: () => searchSteamGridDb(term, settings.steamGridDbApiKey.trim()) });
  }
  sources.push({ name: 'Steam store', run: () => searchSteamStore(term) });

  for (const source of sources) {
    try {
      const hit = await source.run();
      if (!hit) continue;
      const fileUrl = await downloadArt(game, hit);
      if (!fileUrl) continue;

      game.coverArt = fileUrl;
      game.coverSource = hit.source;
      game.artScrapedAt = Date.now();
      console.log(`[Scraper] ${game.name} ← ${source.name} ("${hit.matchedName}")`);
      return true;
    } catch (e) {
      const status = axios.isAxiosError(e) ? e.response?.status : undefined;
      if (status === 401 || status === 403) {
        console.error(`[Scraper] ${source.name} rejected the API key (${status}). Check Settings → Artwork.`);
      } else {
        console.warn(`[Scraper] ${source.name} failed for "${term}":`, status ?? String(e));
      }
    }
  }

  game.artScrapedAt = Date.now();
  return false;
}

/**
 * Scrape every game that needs art, a few at a time. `onResult` fires after each game so the
 * caller can persist and push updates incrementally.
 */
export async function scrapeMissingArt(
  games: Game[],
  settings: Settings,
  onResult: (game: Game, changed: boolean, done: number, total: number) => void,
): Promise<number> {
  const queue = games.filter(needsArt);
  const total = queue.length;
  let done = 0;
  let changedCount = 0;
  if (total === 0) return 0;

  console.log(`[Scraper] Looking up artwork for ${total} game(s)…`);

  const workers = Array.from({ length: Math.min(CONCURRENCY, total) }, async () => {
    while (queue.length > 0) {
      const game = queue.shift()!;
      const changed = await scrapeArt(game, settings);
      if (changed) changedCount++;
      done++;
      onResult(game, changed, done, total);
    }
  });
  await Promise.all(workers);

  console.log(`[Scraper] Done — ${changedCount}/${total} games got artwork.`);
  return changedCount;
}
