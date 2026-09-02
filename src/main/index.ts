import { findGameExe } from './findExe';
import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import { createTray, destroyTray } from './tray';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { Game, Settings, ScanResult, ScrapeProgress, EMULATOR_PLATFORMS } from '../shared/types';
import { loadSettings, saveSettings } from './settings';
import { mergeGames, saveLibrary, getLibrary, updateGameLastLaunched, setGameHidden, patchGame } from './library';
import { scrapeArt, scrapeMissingArt } from './scraper';
import { scanSteam } from './scanners/steam';
import { scanEpic } from './scanners/epic';
import { scanGOG } from './scanners/gog';
import { scanEA } from './scanners/ea';
import { scanUbisoft } from './scanners/ubisoft';
import { scanBattlenet } from './scanners/battlenet';
import { scanXbox } from './scanners/xbox';
import { scanRyujinx, scanShadPS4, scanRPCS3, scanPCSX2, scanYuzu } from './scanners/emulators';
import { scanCustomFolders } from './scanners/folders';

let mainWindow: BrowserWindow | null = null;
let enrichRunning = false;
let scrapeRunning = false;
/** Set only by the tray's Quit item, so the close handler knows to let the app exit. */
let isQuitting = false;

/** Set by the installer shortcut / login item when Vault should boot straight to the tray. */
const startedHidden = process.argv.includes('--hidden');

/**
 * Tells Windows this process is Vault rather than a generic Electron host. Without it the taskbar
 * groups the window under Electron, shows Electron's icon, and attributes notifications to
 * Electron. Must be set before the first window is created.
 */
app.setAppUserModelId('com.vault.gamelibrary');

/**
 * Vault's own icon for the window and taskbar. A packaged build picks this up from the exe's
 * resources, but in development the running process is electron.exe, so without an explicit icon
 * the window would wear Electron's.
 */
function appIcon(): string | undefined {
  const candidates = [
    path.join(app.getAppPath(), 'assets', 'icon.ico'),
    path.join(__dirname, '..', '..', 'assets', 'icon.ico'),
  ];
  return candidates.find((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
}

function showWindow(): void {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

function quitApp(): void {
  isQuitting = true;
  destroyTray();
  app.quit();
}

/**
 * Register (or clear) the Windows startup entry.
 *
 * Only meaningful in a packaged build: in development `process.execPath` is electron.exe, so
 * writing a login item would add a stray startup entry pointing at the dev runtime.
 */
function applyLaunchAtStartup(enabled: boolean): void {
  if (!app.isPackaged) {
    if (enabled) console.log('[Startup] Ignoring launch-at-startup in a development run');
    return;
  }
  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      path: process.execPath,
      args: ['--hidden'],
    });
  } catch (e) {
    console.error('[Startup] Could not update the login item:', e);
  }
}

function pushLibrary(): void {
  mainWindow?.webContents.send('library-updated', getLibrary());
}

function sendScrapeProgress(p: ScrapeProgress): void {
  mainWindow?.webContents.send('scrape-progress', p);
}

/**
 * Artwork pass over every game that still lacks proper art. Results are patched into the live
 * library as they arrive (so a rescan that finishes mid-way never clobbers them) and pushed to
 * the renderer in batches. Returns the number of games that got new art, or null if a pass
 * was already running.
 */
async function runScrape(settings: Settings): Promise<number | null> {
  if (scrapeRunning) return null;
  scrapeRunning = true;
  try {
    let lastPush = Date.now();
    let sinceSave = 0;
    const updated = await scrapeMissingArt(getLibrary(), settings, (game, changed, done, total) => {
      patchGame(game.id, { coverArt: game.coverArt, coverSource: game.coverSource, artScrapedAt: game.artScrapedAt }, false);
      sinceSave++;
      if (sinceSave >= 10) { saveLibrary(getLibrary()); sinceSave = 0; }
      sendScrapeProgress({ done, total, running: done < total });
      if (changed && Date.now() - lastPush > 1500) { pushLibrary(); lastPush = Date.now(); }
    });
    saveLibrary(getLibrary());
    pushLibrary();
    sendScrapeProgress({ done: 0, total: 0, running: false });
    return updated;
  } catch (e) {
    console.error('[Scraper] Pass failed:', e);
    sendScrapeProgress({ done: 0, total: 0, running: false });
    return 0;
  } finally {
    scrapeRunning = false;
  }
}

/**
 * Runs after a scan result has been returned to the renderer:
 *  1. exe icons for PC games with no art at all (fast, local) — skipped for emulator titles,
 *     whose executablePath is the emulator itself and would give every ROM the same icon
 *  2. artwork scraping for everything still missing real art (network, slow)
 */
async function enrichLibraryInBackground(settings: Settings): Promise<void> {
  if (enrichRunning) return;
  enrichRunning = true;
  try {
    let changed = false;
    for (const game of getLibrary()) {
      if (game.coverArt || !game.executablePath) continue;
      if (EMULATOR_PLATFORMS.includes(game.platform)) continue;
      if (!fs.existsSync(game.executablePath)) continue;
      try {
        const icon = await app.getFileIcon(game.executablePath, { size: 'large' });
        patchGame(game.id, { coverArt: icon.toDataURL(), coverSource: 'icon' }, false);
        changed = true;
      } catch { /* skip */ }
    }
    if (changed) {
      saveLibrary(getLibrary());
      pushLibrary();
    }

    if (settings.autoScrapeArt) await runScrape(settings);
  } catch (e) {
    console.error('[Vault] Background enrichment failed:', e);
  } finally {
    enrichRunning = false;
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f0f11',
    icon: appIcon(),
    title: 'Vault',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0f0f11',
      symbolColor: '#e0e0e0',
      height: 36,
    },
    // Never show the window at construction time. Presenting it before the renderer's first
    // paint leaves a blank pane — the frame is up but nothing has been composited into it yet.
    // It is shown from 'ready-to-show' below instead.
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  const rendererPath = path.join(__dirname, '../renderer/index.html');
  mainWindow.loadFile(rendererPath);

  // Starting hidden means the window is still built and the library still scans in the
  // background; only the presenting is skipped until the user asks for it via the tray.
  const openHidden = startedHidden && loadSettings().startMinimized;
  let shown = false;
  const revealOnce = (): void => {
    if (shown || openHidden) return;
    shown = true;
    mainWindow?.show();
  };

  // 'ready-to-show' fires once the renderer has painted a frame, so the window is never
  // presented empty. 'did-finish-load' is a backstop: if the first event is ever missed the
  // window must still appear, or the app looks dead with only a tray icon.
  mainWindow.once('ready-to-show', revealOnce);
  mainWindow.webContents.once('did-finish-load', () => setTimeout(revealOnce, 250));

  mainWindow.on('close', (event) => {
    // Closing keeps Vault running in the tray unless the user really is quitting
    if (!isQuitting && loadSettings().minimizeToTray) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// A launcher that lives in the tray must never open twice: clicking the shortcut again should
// bring the existing window forward instead of starting a second copy.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  app.whenReady().then(() => {
    const settings = loadSettings();
    createWindow();
    registerIpcHandlers();

    if (settings.minimizeToTray) {
      createTray({
        onShow: showWindow,
        onRescan: () => mainWindow?.webContents.send('rescan-requested'),
        onQuit: quitApp,
      });
    }
    applyLaunchAtStartup(settings.launchAtStartup);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else showWindow();
    });
  });
}

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('window-all-closed', () => {
  // With the tray enabled the app deliberately outlives its window
  if (process.platform === 'darwin') return;
  if (!loadSettings().minimizeToTray) app.quit();
});

function registerIpcHandlers(): void {
  ipcMain.handle('get-settings', () => loadSettings());

  ipcMain.handle('save-settings', (_event, settings: Settings) => {
    saveSettings(settings);

    // Apply the toggles that change app behaviour rather than just what's drawn
    applyLaunchAtStartup(settings.launchAtStartup);
    if (settings.minimizeToTray) {
      createTray({
        onShow: showWindow,
        onRescan: () => mainWindow?.webContents.send('rescan-requested'),
        onQuit: quitApp,
      });
    } else {
      destroyTray();
    }
    return { success: true };
  });

  ipcMain.handle('get-library', () => getLibrary());

  ipcMain.handle('browse-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('scan-library', async () => {
    const settings = loadSettings();
    const results: ScanResult[] = [];
    const errors: ScanResult['errors'] = [];

    try {
      const steamGames = await scanSteam(settings.steamApiKey, settings.steamUserId);
      results.push({ games: steamGames, errors: [] });
    } catch (e) {
      errors.push({ platform: 'steam', message: String(e) });
    }

    try {
      results.push({ games: scanEpic(), errors: [] });
    } catch (e) {
      errors.push({ platform: 'epic', message: String(e) });
    }

    try {
      const gogGames = await scanGOG();
      results.push({ games: gogGames, errors: [] });
    } catch (e) {
      errors.push({ platform: 'gog', message: String(e) });
    }

    try {
      results.push({ games: scanEA(), errors: [] });
    } catch (e) {
      errors.push({ platform: 'ea', message: String(e) });
    }

    try {
      const ubisoftGames = await scanUbisoft();
      results.push({ games: ubisoftGames, errors: [] });
    } catch (e) {
      errors.push({ platform: 'ubisoft', message: String(e) });
    }

    try {
      results.push({ games: scanBattlenet(), errors: [] });
    } catch (e) {
      errors.push({ platform: 'battlenet', message: String(e) });
    }

    try {
      results.push({ games: scanXbox(), errors: [] });
    } catch (e) {
      errors.push({ platform: 'xbox', message: String(e) });
    }

    try {
      const emu = settings.emulatorPaths;
      results.push({
        games: [
          ...scanRyujinx(emu.ryujinx),
          ...scanShadPS4(emu.shadps4),
          ...scanRPCS3(emu.rpcs3),
          ...scanPCSX2(emu.pcsx2),
          ...scanYuzu(emu.yuzu),
        ],
        errors: [],
      });
    } catch (e) {
      errors.push({ platform: 'ryujinx', message: String(e) });
    }

    try {
      results.push({ games: scanCustomFolders(settings.watchedFolders), errors: [] });
    } catch (e) {
      errors.push({ platform: 'custom', message: String(e) });
    }

    const merged = mergeGames(results);

    // Resolve exe paths for games without one (don't extract icons here — too slow)
    for (const game of merged) {
      if (!game.executablePath && game.installPath && game.platform !== 'steam') {
        const exePath = findGameExe(game.installPath, game.name);
        if (exePath) game.executablePath = exePath;
      }
    }

    saveLibrary(merged);

    // Icons and artwork are filled in after the scan result is returned — doesn't block the UI
    setImmediate(() => { void enrichLibraryInBackground(settings); });

    return { games: merged, errors };
  });

  ipcMain.handle('launch-game', async (_event, game: Game) => {
    try {
      const emuPlatforms = ['ryujinx', 'shadps4', 'rpcs3', 'pcsx2', 'yuzu'];
      if (emuPlatforms.includes(game.platform) && game.executablePath && game.appId) {
        if (!fs.existsSync(game.executablePath)) {
          return { success: false, error: `Emulator not found at ${game.executablePath} — check Settings → Emulator Paths` };
        }
        // cwd matters: portable emulators locate their config relative to it
        spawn(game.executablePath, [game.appId], {
          detached: true,
          stdio: 'ignore',
          cwd: path.dirname(game.executablePath),
        }).unref();
      } else if (game.platform === 'steam' && game.appId) {
        // Always launch Steam games via steam:// protocol — handles wrapped games,
        // anti-cheat, renamed games (e.g. CS:GO -> CS2), etc. Also installs when not installed.
        await shell.openExternal(
          game.installed ? `steam://rungameid/${game.appId}` : `steam://install/${game.appId}`,
        );
      } else if (game.platform === 'xbox' && game.appId) {
        // Packaged games must start through their AUMID: running the exe directly bypasses the
        // licensing container and most Game Pass titles refuse to launch that way.
        spawn('explorer.exe', [`shell:appsFolder\\${game.appId}`], {
          detached: true,
          stdio: 'ignore',
        }).unref();
      } else {
        let exePath = game.executablePath && fs.existsSync(game.executablePath)
          ? game.executablePath
          : game.installPath ? findGameExe(game.installPath, game.name) : null;

        if (exePath) {
          spawn(exePath, [], {
            detached: true,
            stdio: 'ignore',
            cwd: path.dirname(exePath),
          }).unref();
        } else if (game.storeUrl) {
          await shell.openExternal(game.storeUrl!);
        } else {
          return { success: false, error: 'No executable or store URL found' };
        }
      }

      updateGameLastLaunched(game.id);
      return { success: true };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  });

  ipcMain.handle('open-store', async (_event, url: string) => {
    await shell.openExternal(url);
    return { success: true };
  });

  ipcMain.handle('get-exe-icon', async (_event, exePath: string) => {
    try {
      const icon = await app.getFileIcon(exePath, { size: 'large' });
      return { dataUrl: icon.toDataURL() };
    } catch (e) {
      return { dataUrl: null };
    }
  });

  ipcMain.handle('hide-game', (_event, gameId: string) => {
    const ok = setGameHidden(gameId, true);
    return { success: ok };
  });

  ipcMain.handle('unhide-game', (_event, gameId: string) => {
    const ok = setGameHidden(gameId, false);
    return { success: ok };
  });

  // Manual fetch for one game, optionally with a corrected search title (fixes wrong matches)
  ipcMain.handle('scrape-art', async (_event, gameId: string, term?: string) => {
    const game = getLibrary().find((g) => g.id === gameId);
    if (!game) return { success: false, error: 'Game not found in library' };

    const settings = loadSettings();
    const changed = await scrapeArt(game, settings, { term, force: true });
    saveLibrary(getLibrary());
    if (!changed) {
      return {
        success: false,
        error: settings.steamGridDbApiKey
          ? 'No artwork found for that title. Try a shorter or different name.'
          : 'No close match on the Steam store. Add a SteamGridDB API key in Settings → Artwork to cover emulator and non-Steam games.',
      };
    }
    pushLibrary();
    return { success: true, coverArt: game.coverArt };
  });

  ipcMain.handle('scrape-all-art', async () => {
    const updated = await runScrape(loadSettings());
    if (updated === null) return { success: false, error: 'An artwork pass is already running' };
    return { success: true, updated };
  });
}