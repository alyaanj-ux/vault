import { contextBridge, ipcRenderer } from 'electron';
import { Game, Settings, ScrapeProgress } from '../shared/types';

contextBridge.exposeInMainWorld('vault', {
  getSettings: (): Promise<Settings> => ipcRenderer.invoke('get-settings'),
  saveSettings: (s: Settings): Promise<{ success: boolean }> => ipcRenderer.invoke('save-settings', s),
  getLibrary: (): Promise<Game[]> => ipcRenderer.invoke('get-library'),
  scanLibrary: (): Promise<{ games: Game[]; errors: { platform: string; message: string }[] }> =>
    ipcRenderer.invoke('scan-library'),
  launchGame: (game: Game): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('launch-game', game),
  openStore: (url: string): Promise<{ success: boolean }> => ipcRenderer.invoke('open-store', url),
  browseFolder: (): Promise<string | null> => ipcRenderer.invoke('browse-folder'),
  hideGame: (gameId: string): Promise<{ success: boolean }> => ipcRenderer.invoke('hide-game', gameId),
  unhideGame: (gameId: string): Promise<{ success: boolean }> => ipcRenderer.invoke('unhide-game', gameId),
  getExeIcon: (exePath: string): Promise<{ dataUrl: string | null }> => ipcRenderer.invoke('get-exe-icon', exePath),
  onLibraryUpdated: (cb: (games: Game[]) => void) => ipcRenderer.on('library-updated', (_e, games) => cb(games)),
  scrapeArt: (gameId: string, term?: string): Promise<{ success: boolean; error?: string; coverArt?: string }> =>
    ipcRenderer.invoke('scrape-art', gameId, term),
  scrapeAllArt: (): Promise<{ success: boolean; updated?: number; error?: string }> => ipcRenderer.invoke('scrape-all-art'),
  onScrapeProgress: (cb: (p: ScrapeProgress) => void) => ipcRenderer.on('scrape-progress', (_e, p) => cb(p)),
  onRescanRequested: (cb: () => void) => ipcRenderer.on('rescan-requested', () => cb()),
});