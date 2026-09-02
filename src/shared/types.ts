export type Platform =
  | 'steam'
  | 'epic'
  | 'gog'
  | 'ea'
  | 'ubisoft'
  | 'battlenet'
  | 'xbox'
  | 'ryujinx'
  | 'shadps4'
  | 'rpcs3'
  | 'pcsx2'
  | 'yuzu'
  | 'custom';

export const EMULATOR_PLATFORMS: Platform[] = ['ryujinx', 'shadps4', 'rpcs3', 'pcsx2', 'yuzu'];

/**
 * Where a game's coverArt came from.
 *  store      — URL provided by the platform scanner (Steam CDN header)
 *  icon       — extracted exe icon (low quality; the scraper will try to replace it)
 *  sgdb       — downloaded from SteamGridDB
 *  steamstore — matched via Steam store search (keyless fallback)
 */
export type CoverSource = 'store' | 'icon' | 'sgdb' | 'steamstore';

export interface Game {
  id: string;
  name: string;
  platform: Platform;
  installPath?: string;
  executablePath?: string;
  installed: boolean;
  coverArt?: string;
  coverSource?: CoverSource;
  /** Last time the scraper looked for art (ms since epoch). Prevents re-querying every scan. */
  artScrapedAt?: number;
  storeUrl?: string;
  appId?: string;
  lastLaunched?: number;
  playtime?: number;
  hidden?: boolean;
}

export interface Settings {
  steamApiKey: string;
  steamUserId: string;
  steamGridDbApiKey: string;
  autoScrapeArt: boolean;
  watchedFolders: string[];
  emulatorPaths: {
    ryujinx?: string;
    shadps4?: string;
    rpcs3?: string;
    pcsx2?: string;
    yuzu?: string;
  };
  theme: 'dark' | 'light';
  gridView: boolean;
  /** Closing the window hides it to the notification area instead of quitting. */
  minimizeToTray: boolean;
  /** Register Vault to start with Windows. Only applied in a packaged build. */
  launchAtStartup: boolean;
  /** When started automatically, open straight to the tray without showing the window. */
  startMinimized: boolean;
}

export interface ScanResult {
  games: Game[];
  errors: { platform: Platform; message: string }[];
}

export interface ScrapeProgress {
  done: number;
  total: number;
  running: boolean;
}

export type IpcChannel =
  | 'scan-library'
  | 'scan-result'
  | 'launch-game'
  | 'open-store'
  | 'get-settings'
  | 'save-settings'
  | 'get-library'
  | 'hide-game'
  | 'unhide-game'
  | 'scrape-art'
  | 'scrape-all-art'
  | 'add-watched-folder'
  | 'remove-watched-folder'
  | 'browse-folder';
