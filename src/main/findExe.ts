import * as fs from 'fs';
import * as path from 'path';

const SKIP_EXE = [
  /unins/i, /setup/i, /install/i, /update/i, /redist/i,
  /crash/i, /report/i, /helper/i, /service/i, /launcher.*update/i,
  /vcredist/i, /dxsetup/i, /ue4prereq/i, /directx/i,
  /crs-/i, /handler/i, /video/i, /splash/i, /easyanticheat/i,
  /battleye/i, /beclient/i, /overlay/i, /browser/i, /webview/i,
  /notification/i, /tray/i, /agent/i, /updater/i, /patcher/i,
];

// These signal a game's main exe when found in the name
const MAIN_EXE_SIGNALS = [
  /^game$/i, /^start$/i, /^play$/i, /^launch$/i,
];

function shouldSkip(exeName: string): boolean {
  return SKIP_EXE.some((p) => p.test(exeName));
}

function nameSimilarity(exeName: string, gameName: string): number {
  const exe = exeName.toLowerCase().replace(/[^a-z0-9]/g, '');
  const game = gameName.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (exe === game) return 100;
  if (exe.includes(game) || game.includes(exe)) return 80;

  // Count matching words
  const gameWords = game.split(/\s+/).filter((w) => w.length > 2);
  const matchCount = gameWords.filter((w) => exe.includes(w)).length;
  if (gameWords.length > 0) return (matchCount / gameWords.length) * 60;

  return 0;
}

function scoreExe(filePath: string, gameName: string): number {
  const name = path.basename(filePath, '.exe');
  if (shouldSkip(name)) return -1;

  let score = 0;

  // Name similarity is the strongest signal
  score += nameSimilarity(name, gameName) * 1000;

  // Main exe name signals
  if (MAIN_EXE_SIGNALS.some((p) => p.test(name))) score += 500;

  // Larger file = more likely the game binary
  try { score += fs.statSync(filePath).size / 1000; } catch { /* ignore */ }

  return score;
}

export function findGameExe(installDir: string, gameName = ''): string | null {
  if (!installDir || !fs.existsSync(installDir)) return null;

  const candidates: string[] = [];

  function walk(dir: string, depth: number): void {
    if (depth > 2) return;
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, depth + 1);
        else if (entry.name.toLowerCase().endsWith('.exe')) candidates.push(full);
      }
    } catch { /* skip unreadable */ }
  }

  walk(installDir, 0);

  const scored = candidates
    .map((p) => ({ p, score: scoreExe(p, gameName) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score);

  return scored.length > 0 ? scored[0].p : null;
}
