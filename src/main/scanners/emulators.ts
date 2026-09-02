import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as ini from 'ini';
import * as TOML from '@iarna/toml';
import { Game } from '../../shared/types';
import { readSfo } from '../sfo';

/**
 * Emulator scanners.
 *
 * Every scanner resolves the emulator exe first (user-configured path, or a best-effort
 * auto-detect) and then looks for a PORTABLE config next to that exe before falling back
 * to the per-user config location. Standalone emulator folders on a secondary drive are the
 * common case for people who use these emulators, and they never write to %APPDATA%.
 *
 * Config locations checked, in order:
 *   Ryujinx   <exe>/portable/Config.json          %APPDATA%/Ryujinx/Config.json
 *   shadPS4   <exe>/user/config.toml              %APPDATA%/shadPS4/config.toml
 *   RPCS3     <exe>/config/games.yml, <exe>/games.yml, <exe>/dev_hdd0/game/*   (%APPDATA%/rpcs3 is Linux-only)
 *   PCSX2     <exe>/inis/PCSX2.ini (portable)     ~/Documents/PCSX2/inis/PCSX2.ini
 *   Yuzu/Suyu <exe>/user/config/qt-config.ini     %APPDATA%/{yuzu,suyu}/config/qt-config.ini
 */

const APPDATA = path.join(os.homedir(), 'AppData', 'Roaming');
const DOCUMENTS = path.join(os.homedir(), 'Documents');

const SWITCH_EXTS = ['.nsp', '.xci', '.nsz', '.xcz'];
const PS2_EXTS = ['.iso', '.bin', '.chd', '.cso', '.zso', '.gz', '.mdf', '.nrg', '.img', '.elf'];

// ─── Small fs helpers ─────────────────────────────────────────────────────────

function exists(p: string | null | undefined): p is string {
  try {
    return !!p && fs.existsSync(p);
  } catch {
    return false;
  }
}

function safeReadFile(filePath: string): string | null {
  try {
    if (fs.existsSync(filePath)) return fs.readFileSync(filePath, 'utf-8');
  } catch {
    // ignore
  }
  return null;
}

function safeParseJson<T>(content: string): T | null {
  try {
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

function listDir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Yield files under dir. maxDepth 0 = only the dir itself. */
function* walkFiles(dir: string, maxDepth: number, depth = 0): Generator<string> {
  for (const entry of listDir(dir)) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth < maxDepth) yield* walkFiles(full, maxDepth, depth + 1);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

function cleanRomName(fileName: string, ext: string): string {
  const base = path.basename(fileName, ext);
  return base.replace(/[\[\(].*?[\]\)]/g, '').replace(/\s+/g, ' ').trim() || base;
}

function unquote(s: string): string {
  return s.trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
}

// ─── Emulator exe resolution ──────────────────────────────────────────────────

/**
 * Turn the user's setting into an actual exe path. Accepts either the exe itself or the
 * folder that contains it (people paste either). Falls back to auto-detect.
 */
function resolveEmulatorExe(
  userPath: string | undefined,
  exeNames: string[],
  folderHint: string,
): string | null {
  if (userPath && userPath.trim()) {
    const p = unquote(userPath);
    try {
      const st = fs.statSync(p);
      if (st.isFile()) return p;
      if (st.isDirectory()) {
        for (const exe of exeNames) {
          const full = path.join(p, exe);
          if (exists(full)) return full;
        }
        // One level down — user pointed at the parent folder of the emulator
        for (const entry of listDir(p)) {
          if (!entry.isDirectory()) continue;
          for (const exe of exeNames) {
            const full = path.join(p, entry.name, exe);
            if (exists(full)) return full;
          }
        }
        console.warn(`[Emulators] No ${exeNames[0]} found under configured folder: ${p}`);
      }
    } catch {
      console.warn(`[Emulators] Configured path does not exist: ${p}`);
    }
  }
  return findEmulatorExe(exeNames, folderHint);
}

function findEmulatorExe(exeNames: string[], folderHint: string): string | null {
  const home = os.homedir();
  const searchDirs = [
    path.join('C:\\', 'Program Files', folderHint),
    path.join('C:\\', 'Program Files (x86)', folderHint),
    path.join(home, 'AppData', 'Local', folderHint),
    path.join(home, 'AppData', 'Local', 'Programs', folderHint),
    path.join(home, 'Downloads', folderHint),
    path.join(home, 'Downloads'),
    path.join(home, 'Desktop', folderHint),
    path.join(home, 'Desktop'),
    path.join(home, 'Documents', folderHint),
  ];

  for (const dir of searchDirs) {
    if (!exists(dir)) continue;
    for (const exe of exeNames) {
      const full = path.join(dir, exe);
      if (exists(full)) return full;
    }
  }
  return null;
}

function exeDirOf(exe: string | null): string | null {
  return exe ? path.dirname(exe) : null;
}

// ─── Switch (shared by Ryujinx and Yuzu/Suyu) ─────────────────────────────────

/**
 * Filter out updates and DLC that sit next to base games. Uses the 16-hex title id when the
 * filename carries one (base ids end in 000; updates in 800; DLC in 001+), otherwise falls
 * back to name keywords.
 */
function isSwitchBaseGame(fileName: string): boolean {
  const idMatch = fileName.match(/\b(01[0-9a-f]{14})\b/i);
  if (idMatch) return /000$/i.test(idMatch[1]);
  return !/\b(update|upd|dlc|patch)\b/i.test(fileName);
}

function scanSwitchDir(
  dir: string,
  deep: boolean,
  platform: 'ryujinx' | 'yuzu',
  emuExe: string | null,
  seen: Set<string>,
): Game[] {
  const games: Game[] = [];
  if (!exists(dir)) return games;

  for (const filePath of walkFiles(dir, deep ? 3 : 0)) {
    const ext = path.extname(filePath).toLowerCase();
    if (!SWITCH_EXTS.includes(ext)) continue;
    const fileName = path.basename(filePath);
    if (!isSwitchBaseGame(fileName)) continue;

    const key = filePath.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    games.push({
      id: `${platform}_${fileName}`,
      name: cleanRomName(fileName, ext),
      platform,
      installed: true,
      installPath: path.dirname(filePath),
      executablePath: emuExe ?? undefined,
      appId: filePath,
    });
  }
  return games;
}

// ─── Ryujinx ──────────────────────────────────────────────────────────────────

interface RyujinxConfig {
  game_dirs?: string[];
}

function getRyujinxGameDirs(exeDir: string | null): string[] {
  const candidates: string[] = [];
  if (exeDir) candidates.push(path.join(exeDir, 'portable', 'Config.json'));
  candidates.push(path.join(APPDATA, 'Ryujinx', 'Config.json'));

  for (const configPath of candidates) {
    const content = safeReadFile(configPath);
    if (!content) continue;
    const config = safeParseJson<RyujinxConfig>(content);
    if (!config) {
      console.warn('[Ryujinx] Config is not valid JSON:', configPath);
      continue;
    }
    const dirs = (config.game_dirs ?? []).filter((d): d is string => typeof d === 'string' && d.length > 0);
    console.log(`[Ryujinx] Using ${configPath} (${dirs.length} game dirs)`);
    // The first config we find is authoritative: a portable install never uses %APPDATA%.
    return dirs;
  }

  console.log('[Ryujinx] No Config.json found', exeDir ? `(looked next to ${exeDir})` : '');
  return [];
}

export function scanRyujinx(emulatorPath?: string): Game[] {
  const emuExe = resolveEmulatorExe(emulatorPath, ['Ryujinx.exe', 'Ryujinx.Headless.SDL2.exe'], 'Ryujinx');
  const gameDirs = getRyujinxGameDirs(exeDirOf(emuExe));
  const seen = new Set<string>();
  const games: Game[] = [];

  for (const dir of gameDirs) {
    try {
      // Ryujinx itself scans game_dirs recursively, so do the same.
      games.push(...scanSwitchDir(dir, true, 'ryujinx', emuExe, seen));
    } catch (e) {
      console.error('[Ryujinx] Failed to scan dir:', dir, e);
    }
  }
  return games;
}

// ─── shadPS4 ──────────────────────────────────────────────────────────────────

/**
 * shadPS4 keeps no game library manifest. Its config.toml lists the install directories the
 * GUI shows; each installed game is a folder with eboot.bin + sce_sys/param.sfo. We list those
 * folders. Raw .pkg files are installers, not playable, so they are not listed.
 */
function getShadPS4GameDirs(exeDir: string | null): string[] {
  const candidates: string[] = [];
  if (exeDir) candidates.push(path.join(exeDir, 'user', 'config.toml'));
  candidates.push(path.join(APPDATA, 'shadPS4', 'config.toml'));

  for (const tomlPath of candidates) {
    const content = safeReadFile(tomlPath);
    if (!content) continue;

    const dirs: string[] = [];
    try {
      const parsed = TOML.parse(content) as Record<string, Record<string, unknown>>;
      const gui = parsed['GUI'] ?? {};
      const general = parsed['General'] ?? {};

      const installDirs = gui['installDirs'];
      const enabled = gui['installDirsEnabled'];
      if (Array.isArray(installDirs)) {
        installDirs.forEach((d, i) => {
          if (typeof d !== 'string' || !d) return;
          if (Array.isArray(enabled) && enabled[i] === false) return;
          dirs.push(d);
        });
      }
      // Older key names
      for (const key of ['installDir', 'gameInstallDir', 'game_install_dir']) {
        const v = gui[key] ?? general[key];
        if (typeof v === 'string' && v) dirs.push(v);
      }
    } catch (e) {
      console.warn('[shadPS4] Could not parse config.toml, using regex fallback:', tomlPath, e);
      const m = content.match(/install[_a-z]*dirs?\s*=\s*\[([^\]]*)\]/i) ?? content.match(/game_install_dir\s*=\s*"([^"]+)"/);
      if (m) {
        for (const part of m[1].split(',')) {
          const v = unquote(part);
          if (v) dirs.push(v);
        }
      }
    }

    console.log(`[shadPS4] Using ${tomlPath} (${dirs.length} install dirs)`);
    return Array.from(new Set(dirs.map((d) => d.replace(/\\\\/g, '\\'))));
  }

  console.log('[shadPS4] No config.toml found', exeDir ? `(looked next to ${exeDir})` : '');
  return [];
}

export function scanShadPS4(emulatorPath?: string): Game[] {
  const emuExe = resolveEmulatorExe(emulatorPath, ['shadPS4.exe', 'shadps4.exe'], 'shadPS4');
  const gameDirs = getShadPS4GameDirs(exeDirOf(emuExe));
  const games: Game[] = [];
  const seen = new Set<string>();

  for (const gameDir of gameDirs) {
    if (!exists(gameDir)) continue;
    try {
      for (const entry of listDir(gameDir)) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(gameDir, entry.name);
        const eboot = path.join(dir, 'eboot.bin');
        if (!exists(eboot)) continue;

        const sfo = readSfo(path.join(dir, 'sce_sys', 'param.sfo'));
        const category = String(sfo?.['CATEGORY'] ?? 'gd').toLowerCase();
        // gd = game, gp = patch, ac = additional content
        if (category !== 'gd' && category !== 'gde') continue;

        const titleId = String(sfo?.['TITLE_ID'] ?? entry.name);
        if (seen.has(titleId)) continue;
        seen.add(titleId);

        const title = typeof sfo?.['TITLE'] === 'string' && sfo['TITLE'] ? String(sfo['TITLE']) : entry.name;

        games.push({
          id: `shadps4_${titleId}`,
          name: title,
          platform: 'shadps4',
          installed: true,
          installPath: dir,
          executablePath: emuExe ?? undefined,
          appId: eboot,
        });
      }
    } catch (e) {
      console.error('[shadPS4] Failed to scan game dir:', gameDir, e);
    }
  }
  return games;
}

// ─── RPCS3 ────────────────────────────────────────────────────────────────────

/**
 * games.yml maps `SERIAL: path` (disc dumps the user added). Installed HDD games live under
 * dev_hdd0/game/<TITLEID>/. On Windows RPCS3 is always portable: everything sits next to the exe.
 */
function rpcs3EbootFor(gameDir: string): { eboot: string; sfo: string } | null {
  // Disc dump root, or the PS3_GAME folder itself, or an HDD game folder
  const layouts = [
    { eboot: path.join(gameDir, 'PS3_GAME', 'USRDIR', 'EBOOT.BIN'), sfo: path.join(gameDir, 'PS3_GAME', 'PARAM.SFO') },
    { eboot: path.join(gameDir, 'USRDIR', 'EBOOT.BIN'), sfo: path.join(gameDir, 'PARAM.SFO') },
  ];
  for (const l of layouts) {
    if (exists(l.sfo)) return l;
  }
  return null;
}

function getRpcs3Hdd0(exeDir: string): string {
  // config.yml can relocate /dev_hdd0/; default is $(EmulatorDir)dev_hdd0/
  for (const cfg of [path.join(exeDir, 'config', 'config.yml'), path.join(exeDir, 'config.yml')]) {
    const content = safeReadFile(cfg);
    if (!content) continue;
    const m = content.match(/^\s*\/dev_hdd0\/:\s*(.+)$/m);
    if (m) {
      const v = unquote(m[1]).replace(/\$\(EmulatorDir\)/g, exeDir + path.sep);
      if (v) return path.normalize(v);
    }
  }
  return path.join(exeDir, 'dev_hdd0');
}

export function scanRPCS3(emulatorPath?: string): Game[] {
  const emuExe = resolveEmulatorExe(emulatorPath, ['rpcs3.exe'], 'RPCS3');
  const exeDir = exeDirOf(emuExe);
  const games: Game[] = [];
  const seen = new Set<string>();

  const pushGame = (gameDir: string, serialHint: string): void => {
    const layout = rpcs3EbootFor(gameDir);
    if (!layout) return;
    const sfo = readSfo(layout.sfo);
    const category = String(sfo?.['CATEGORY'] ?? 'DG').toUpperCase();
    // DG = disc game, HG = HDD game. GD = game data / update, AV/AP/etc. are not games.
    if (category !== 'DG' && category !== 'HG') return;

    const serial = String(sfo?.['TITLE_ID'] ?? serialHint);
    if (seen.has(serial)) return;
    seen.add(serial);

    const title = typeof sfo?.['TITLE'] === 'string' && sfo['TITLE'] ? String(sfo['TITLE']) : path.basename(gameDir);
    games.push({
      id: `rpcs3_${serial}`,
      name: title,
      platform: 'rpcs3',
      installed: true,
      installPath: gameDir,
      executablePath: emuExe ?? undefined,
      appId: exists(layout.eboot) ? layout.eboot : gameDir,
    });
  };

  // 1. games.yml — disc games added through the GUI
  const ymlCandidates: string[] = [];
  if (exeDir) ymlCandidates.push(path.join(exeDir, 'config', 'games.yml'), path.join(exeDir, 'games.yml'));
  ymlCandidates.push(path.join(APPDATA, 'rpcs3', 'games.yml'));

  for (const ymlPath of ymlCandidates) {
    const content = safeReadFile(ymlPath);
    if (!content) continue;
    console.log('[RPCS3] Using', ymlPath);
    try {
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const colon = trimmed.indexOf(':');
        if (colon <= 0) continue;
        const serial = trimmed.substring(0, colon).trim();
        const gamePath = unquote(trimmed.substring(colon + 1));
        if (!gamePath || !exists(gamePath)) continue;
        pushGame(gamePath, serial);
      }
    } catch (e) {
      console.error('[RPCS3] Failed to parse games.yml:', e);
    }
    break;
  }

  // 2. dev_hdd0/game — installed PSN / HDD games
  if (exeDir) {
    const hddGames = path.join(getRpcs3Hdd0(exeDir), 'game');
    if (exists(hddGames)) {
      for (const entry of listDir(hddGames)) {
        if (!entry.isDirectory()) continue;
        try {
          pushGame(path.join(hddGames, entry.name), entry.name);
        } catch (e) {
          console.error('[RPCS3] Failed to read HDD game:', entry.name, e);
        }
      }
    }
  } else {
    console.log('[RPCS3] rpcs3.exe not found — set its path in Settings to scan dev_hdd0');
  }

  return games;
}

// ─── PCSX2 ────────────────────────────────────────────────────────────────────

/**
 * PCSX2.ini [GameList] lists `RecursivePaths = ...` and `Paths = ...`, one line per folder with
 * REPEATED keys. Generic ini parsers collapse repeated keys, so that section is parsed by hand.
 */
function getPcsx2GameDirs(exeDir: string | null): { dir: string; recursive: boolean }[] {
  const candidates: string[] = [];
  if (exeDir) {
    const portableIni = path.join(exeDir, 'inis', 'PCSX2.ini');
    const isPortable =
      exists(path.join(exeDir, 'portable.ini')) || exists(path.join(exeDir, 'portable.txt')) || exists(portableIni);
    if (isPortable) candidates.push(portableIni);
  }
  candidates.push(path.join(DOCUMENTS, 'PCSX2', 'inis', 'PCSX2.ini'), path.join(APPDATA, 'PCSX2', 'inis', 'PCSX2.ini'));

  for (const iniPath of candidates) {
    const content = safeReadFile(iniPath);
    if (!content) continue;

    const result: { dir: string; recursive: boolean }[] = [];
    let inGameList = false;
    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim();
      if (line.startsWith('[')) {
        inGameList = /^\[GameList\]$/i.test(line);
        continue;
      }
      if (!inGameList) continue;
      const m = line.match(/^(RecursivePaths|Paths)\s*=\s*(.+)$/i);
      if (!m) continue;
      const dir = unquote(m[2]);
      if (dir && exists(dir)) result.push({ dir, recursive: m[1].toLowerCase() === 'recursivepaths' });
    }
    console.log(`[PCSX2] Using ${iniPath} (${result.length} game dirs)`);
    return result;
  }

  console.log('[PCSX2] No PCSX2.ini found', exeDir ? `(looked next to ${exeDir})` : '');
  return [];
}

export function scanPCSX2(emulatorPath?: string): Game[] {
  const emuExe = resolveEmulatorExe(
    emulatorPath,
    ['pcsx2-qt.exe', 'pcsx2-qtx64-avx2.exe', 'pcsx2-qtx64.exe', 'pcsx2.exe'],
    'PCSX2',
  );
  const games: Game[] = [];
  const seen = new Set<string>();

  for (const { dir, recursive } of getPcsx2GameDirs(exeDirOf(emuExe))) {
    try {
      for (const filePath of walkFiles(dir, recursive ? 4 : 0)) {
        const ext = path.extname(filePath).toLowerCase();
        if (!PS2_EXTS.includes(ext)) continue;
        const key = filePath.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);

        const fileName = path.basename(filePath);
        games.push({
          id: `pcsx2_${fileName}`,
          name: cleanRomName(fileName, ext),
          platform: 'pcsx2',
          installed: true,
          installPath: path.dirname(filePath),
          executablePath: emuExe ?? undefined,
          appId: filePath,
        });
      }
    } catch (e) {
      console.error('[PCSX2] Failed to scan dir:', dir, e);
    }
  }
  return games;
}

// ─── Yuzu / Suyu ─────────────────────────────────────────────────────────────

/**
 * qt-config.ini [UI] holds Paths\gamedirs\N\path and Paths\gamedirs\N\deep_scan.
 * Yuzu, Suyu and the other forks share this layout; portable builds keep it in <exe>/user/.
 */
function getYuzuGameDirs(iniPath: string): { dir: string; deep: boolean }[] {
  const content = safeReadFile(iniPath);
  if (!content) return [];

  const result: { dir: string; deep: boolean }[] = [];
  try {
    const parsed = ini.parse(content) as Record<string, Record<string, unknown>>;
    const ui = parsed['UI'] ?? parsed['ui'] ?? {};
    const byIndex = new Map<string, { path?: string; deep?: boolean }>();

    for (const [k, v] of Object.entries(ui)) {
      const m = k.match(/gamedirs[\\/](\d+)[\\/](path|deep_scan)$/i);
      if (!m) continue;
      const rec = byIndex.get(m[1]) ?? {};
      if (m[2].toLowerCase() === 'path' && typeof v === 'string') rec.path = unquote(v);
      if (m[2].toLowerCase() === 'deep_scan') rec.deep = String(v).toLowerCase() === 'true';
      byIndex.set(m[1], rec);
    }

    for (const rec of byIndex.values()) {
      // Yuzu also lists virtual entries such as SDMC / UserNAND — they are not real folders
      if (rec.path && exists(rec.path)) result.push({ dir: rec.path, deep: rec.deep ?? false });
    }
  } catch (e) {
    console.error('[Yuzu] Failed to parse ini:', iniPath, e);
  }
  return result;
}

export function scanYuzu(emulatorPath?: string): Game[] {
  const emuExe = resolveEmulatorExe(
    emulatorPath,
    ['yuzu.exe', 'suyu.exe', 'sudachi.exe', 'citron.exe', 'eden.exe', 'yuzu-cmd.exe'],
    'yuzu',
  );
  const exeDir = exeDirOf(emuExe);

  const iniCandidates: string[] = [];
  if (exeDir) iniCandidates.push(path.join(exeDir, 'user', 'config', 'qt-config.ini'));
  iniCandidates.push(
    path.join(APPDATA, 'yuzu', 'config', 'qt-config.ini'),
    path.join(APPDATA, 'suyu', 'config', 'qt-config.ini'),
  );

  const games: Game[] = [];
  const seen = new Set<string>();

  for (const iniPath of iniCandidates) {
    const dirs = getYuzuGameDirs(iniPath);
    if (dirs.length === 0) continue;
    console.log(`[Yuzu] Using ${iniPath} (${dirs.length} game dirs)`);
    for (const { dir, deep } of dirs) {
      try {
        games.push(...scanSwitchDir(dir, deep, 'yuzu', emuExe, seen));
      } catch (e) {
        console.error('[Yuzu] Failed to scan dir:', dir, e);
      }
    }
  }
  return games;
}
