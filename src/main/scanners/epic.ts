import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Game } from '../../shared/types';

const MANIFESTS_DIR = path.join(
  'C:\\ProgramData',
  'Epic',
  'EpicGamesLauncher',
  'Data',
  'Manifests'
);

interface EpicManifest {
  DisplayName?: string;
  InstallLocation?: string;
  LaunchExecutable?: string;
  CatalogNamespace?: string;
  CatalogItemId?: string;
  AppName?: string;
  bIsIncompleteInstall?: boolean;
}

function getEpicLaunchUrl(appName: string): string {
  return `com.epicgames.launcher://apps/${appName}?action=launch`;
}

export function scanEpic(): Game[] {
  const games: Game[] = [];

  if (!fs.existsSync(MANIFESTS_DIR)) {
    console.warn('[Epic] Manifests directory not found:', MANIFESTS_DIR);
    return games;
  }

  let files: string[];
  try {
    files = fs.readdirSync(MANIFESTS_DIR).filter((f) => f.endsWith('.item'));
  } catch (e) {
    console.error('[Epic] Failed to read manifests directory:', e);
    return games;
  }

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(MANIFESTS_DIR, file), 'utf-8');
      const manifest: EpicManifest = JSON.parse(raw);

      if (!manifest.DisplayName || !manifest.AppName) continue;
      // Skip incomplete installs
      if (manifest.bIsIncompleteInstall) continue;

      const installPath = manifest.InstallLocation;
      const installed = !!(installPath && fs.existsSync(installPath));
      const executablePath =
        installPath && manifest.LaunchExecutable
          ? path.join(installPath, manifest.LaunchExecutable)
          : undefined;

      games.push({
        id: `epic_${manifest.AppName}`,
        name: manifest.DisplayName,
        platform: 'epic',
        appId: manifest.AppName,
        installed,
        installPath: installPath ?? undefined,
        executablePath: executablePath ?? undefined,
        storeUrl: getEpicLaunchUrl(manifest.AppName ?? ''),
      });
    } catch (e) {
      console.error('[Epic] Failed to parse manifest:', file, e);
    }
  }

  return games;
}
