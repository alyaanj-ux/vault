import { app, Tray, Menu, nativeImage, NativeImage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

/**
 * System tray icon. Vault is a launcher, so people expect it to sit in the notification area
 * rather than be started from scratch every time they want to play something. Closing the
 * window hides it here (see `minimizeToTray` in Settings) and the icon brings it back.
 */

export interface TrayActions {
  onShow: () => void;
  onRescan: () => void;
  onQuit: () => void;
}

let tray: Tray | null = null;

/**
 * The icon ships in `assets/` and is packed into the asar by electron-builder, so the same
 * path works in development and when installed. Falls back to an empty image rather than
 * throwing — a missing icon must never stop the app from starting.
 */
function resolveIcon(): NativeImage {
  const candidates = [
    path.join(app.getAppPath(), 'assets', 'icon.ico'),
    path.join(app.getAppPath(), 'assets', 'icon.png'),
    path.join(process.resourcesPath ?? '', 'assets', 'icon.ico'),
    path.join(__dirname, '..', '..', 'assets', 'icon.ico'),
  ];

  for (const candidate of candidates) {
    try {
      if (!candidate || !fs.existsSync(candidate)) continue;
      const image = nativeImage.createFromPath(candidate);
      if (!image.isEmpty()) return image;
    } catch {
      // try the next candidate
    }
  }

  console.warn('[Tray] Icon not found — using a blank tray icon');
  return nativeImage.createEmpty();
}

export function createTray(actions: TrayActions): void {
  if (tray) return;

  try {
    tray = new Tray(resolveIcon());
  } catch (e) {
    console.error('[Tray] Could not create tray icon:', e);
    return;
  }

  console.log('[Tray] Tray icon created — closing the window will hide Vault here');
  tray.setToolTip('Vault — game library');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Vault', click: actions.onShow },
      { type: 'separator' },
      { label: 'Rescan Library', click: actions.onRescan },
      { type: 'separator' },
      { label: 'Quit Vault', click: actions.onQuit },
    ]),
  );

  // Single click is the habit most Windows users have for tray apps
  tray.on('click', actions.onShow);
  tray.on('double-click', actions.onShow);
}

export function destroyTray(): void {
  try {
    tray?.destroy();
  } catch {
    // already gone
  }
  tray = null;
}

export function hasTray(): boolean {
  return tray !== null;
}

export function setTrayTooltip(text: string): void {
  try {
    tray?.setToolTip(text);
  } catch {
    // tray may have been destroyed mid-update
  }
}
