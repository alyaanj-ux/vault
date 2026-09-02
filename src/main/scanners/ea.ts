import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Game } from '../../shared/types';

// Scans EA/Origin installed games from LocalContent manifest XML files.
// The EA Desktop app uses the same LocalContent folder structure as Origin.

const EA_LOCAL_CONTENT = path.join('C:\\ProgramData', 'Origin', 'LocalContent');
const EA_DESKTOP_CONTENT = path.join('C:\\ProgramData', 'EA Desktop', 'InstallData');

const EA_STORE = (id: string) => `https://www.ea.com/games/${id}`;

function extractXmlValue(xml: string, tag: string): string {
  const regex = new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`, 'i');
  const match = xml.match(regex);
  return match ? match[1].trim() : '';
}

function parseEAManifest(xmlContent: string, sourceDir: string): Game | null {
  try {
    const displayName =
      extractXmlValue(xmlContent, 'displayName') ||
      extractXmlValue(xmlContent, 'title') ||
      extractXmlValue(xmlContent, 'gameName');
    const installPath =
      extractXmlValue(xmlContent, 'installPath') ||
      extractXmlValue(xmlContent, 'InstallDir');
    const gameId =
      extractXmlValue(xmlContent, 'contentID') ||
      extractXmlValue(xmlContent, 'id') ||
      extractXmlValue(xmlContent, 'gameId');
    const dipInstallPath =
      extractXmlValue(xmlContent, 'dipInstallPath') || installPath;

    if (!displayName) return null;

    const installed = !!(dipInstallPath && fs.existsSync(dipInstallPath));

    return {
      id: `ea_${gameId || displayName.replace(/\s+/g, '_')}`,
      name: displayName,
      platform: 'ea',
      appId: gameId || undefined,
      installed,
      installPath: dipInstallPath || undefined,
      storeUrl: gameId ? EA_STORE(gameId) : 'https://www.ea.com/games',
    };
  } catch {
    return null;
  }
}

function scanDirectory(dir: string): Game[] {
  const games: Game[] = [];
  if (!fs.existsSync(dir)) return games;

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const gameDir = path.join(dir, entry.name);

      try {
        const files = fs.readdirSync(gameDir);
        const xmlFile = files.find((f) => f.endsWith('.mfst') || f.endsWith('.xml'));
        if (!xmlFile) continue;

        const xmlPath = path.join(gameDir, xmlFile);
        const content = fs.readFileSync(xmlPath, 'utf-8');
        const game = parseEAManifest(content, gameDir);
        if (game) games.push(game);
      } catch {
        // skip unreadable game dirs
      }
    }
  } catch (e) {
    console.error('[EA] Failed to scan directory:', dir, e);
  }

  return games;
}

export function scanEA(): Game[] {
  const games: Game[] = [];
  const seen = new Set<string>();

  for (const dir of [EA_LOCAL_CONTENT, EA_DESKTOP_CONTENT]) {
    const found = scanDirectory(dir);
    for (const g of found) {
      if (!seen.has(g.id)) {
        seen.add(g.id);
        games.push(g);
      }
    }
  }

  return games;
}
