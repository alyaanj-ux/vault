import { Game, Settings, ScrapeProgress } from '../shared/types';
import { Sidebar, SidebarTab } from './components/Sidebar';
import { createGameCard, createGameRow, GameCardCallbacks } from './components/GameCard';
import { SettingsPanel } from './components/Settings';

declare global {
  interface Window {
    vault: {
      getSettings(): Promise<Settings>;
      saveSettings(s: Settings): Promise<{ success: boolean }>;
      getLibrary(): Promise<Game[]>;
      scanLibrary(): Promise<{ games: Game[]; errors: { platform: string; message: string }[] }>;
      launchGame(game: Game): Promise<{ success: boolean; error?: string }>;
      openStore(url: string): Promise<{ success: boolean }>;
      browseFolder(): Promise<string | null>;
      hideGame(gameId: string): Promise<{ success: boolean }>;
      unhideGame(gameId: string): Promise<{ success: boolean }>;
      getExeIcon(exePath: string): Promise<{ dataUrl: string | null }>;
      onLibraryUpdated(cb: (games: Game[]) => void): void;
      scrapeArt(gameId: string, term?: string): Promise<{ success: boolean; error?: string; coverArt?: string }>;
      scrapeAllArt(): Promise<{ success: boolean; updated?: number; error?: string }>;
      onScrapeProgress(cb: (p: ScrapeProgress) => void): void;
    };
  }
}

// ─── App State ────────────────────────────────────────────────────────────────

let allGames: Game[] = [];
let activeTab: SidebarTab = 'all';
let searchQuery = '';
let isGridView = true;
let isScanning = false;
let sidebar: Sidebar;
let settingsPanel: SettingsPanel | null = null;

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  const settings = await window.vault.getSettings();
  isGridView = settings.gridView;
  document.body.className = settings.theme === 'light' ? 'light' : '';

  buildLayout();
  allGames = await window.vault.getLibrary();

  if (allGames.length === 0) {
    await runScan();
  } else {
    updateSidebarCounts();
    renderContent();
  }

  // Background rescan every 5 minutes
  setInterval(() => { if (!isScanning) runScan(); }, 5 * 60 * 1000);
  window.vault.onLibraryUpdated((games) => {
    allGames = games;
    updateSidebarCounts();
    renderContent();
  });
}

// ─── Layout ───────────────────────────────────────────────────────────────────

function buildLayout(): void {
  const app = document.getElementById('app')!;
  app.innerHTML = '';

  const topbar = document.createElement('div');
  topbar.className = 'topbar';
  topbar.innerHTML = `
    <div class="topbar-left">
      <span class="topbar-logo">⚡ Vault</span>
    </div>
    <div class="search-box">
      <span class="search-icon">🔍</span>
      <input type="text" id="search-input" placeholder="Search games…" autocomplete="off">
    </div>
    <div class="topbar-actions">
      <button class="icon-btn" id="refresh-btn" title="Rescan library">↻</button>
      <button class="icon-btn" id="settings-btn" title="Settings">⚙</button>
    </div>`;
  app.appendChild(topbar);

  const body = document.createElement('div');
  body.className = 'body';
  app.appendChild(body);

  sidebar = new Sidebar(body, (tab) => {
    activeTab = tab;
    renderContent();
  });

  const content = document.createElement('div');
  content.id = 'content-root';
  content.style.flex = '1';
  content.style.overflow = 'auto';
  body.appendChild(content);

  settingsPanel = new SettingsPanel(content, () => runScan());
  settingsPanel.getElement().id = 'settings-panel';
  settingsPanel.getElement().style.display = 'none';

  const main = document.createElement('div');
  main.className = 'content';
  main.id = 'main-content';
  content.appendChild(main);

  document.getElementById('search-input')!.addEventListener('input', (e) => {
    searchQuery = (e.target as HTMLInputElement).value.toLowerCase();
    renderContent();
  });
  document.getElementById('refresh-btn')!.addEventListener('click', () => runScan());
  document.getElementById('settings-btn')!.addEventListener('click', () => {
    activeTab = 'settings';
    sidebar.setActive('settings');
    renderContent();
  });
}

// ─── Scanning ─────────────────────────────────────────────────────────────────

async function runScan(): Promise<void> {
  if (isScanning) return;
  isScanning = true;

  const refreshBtn = document.getElementById('refresh-btn');
  if (refreshBtn) refreshBtn.classList.add('spinning');

  const main = document.getElementById('main-content');
  if (main && activeTab !== 'settings') {
    main.innerHTML = `
      <div class="content-header">
        <div><div class="content-title">Scanning Library</div><div class="content-subtitle">Detecting games from all platforms…</div></div>
      </div>
      <div class="scan-bar">
        <div class="scan-progress"><div class="scan-fill" style="width:100%"></div></div>
        <span class="scan-label">Scanning…</span>
      </div>`;
  }

  try {
    const result = await window.vault.scanLibrary();
    allGames = result.games;
    if (result.errors.length > 0) console.warn('[Vault] Scan errors:', result.errors);
  } catch (e) {
    console.error('[Vault] Scan failed:', e);
  } finally {
    isScanning = false;
    if (refreshBtn) refreshBtn.classList.remove('spinning');
    updateSidebarCounts();
    renderContent();
  }
}

// ─── Hide / Unhide ────────────────────────────────────────────────────────────

async function hideGame(game: Game): Promise<void> {
  await window.vault.hideGame(game.id);
  const g = allGames.find((x) => x.id === game.id);
  if (g) g.hidden = true;
  updateSidebarCounts();
  renderContent();
}

async function unhideGame(game: Game): Promise<void> {
  await window.vault.unhideGame(game.id);
  const g = allGames.find((x) => x.id === game.id);
  if (g) g.hidden = false;
  updateSidebarCounts();
  renderContent();
}

// ─── Sidebar Counts ───────────────────────────────────────────────────────────

function updateSidebarCounts(): void {
  const emuPlatforms = ['ryujinx', 'shadps4', 'rpcs3', 'pcsx2', 'yuzu'];
  const visible = allGames.filter((g) => !g.hidden);
  sidebar.setCounts({
    all:        visible.length,
    installed:  visible.filter((g) => g.installed).length,
    uninstalled: visible.filter((g) => !g.installed).length,
    emulators:  visible.filter((g) => emuPlatforms.includes(g.platform)).length,
    hidden:     allGames.filter((g) => g.hidden).length,
  });
}

// ─── Callbacks ────────────────────────────────────────────────────────────────

function makeCallbacks(): GameCardCallbacks {
  return {
    onClick: handleGameClick,
    onHide: hideGame,
    onUnhide: unhideGame,
    onFetchArt: openArtDialog,
  };
}

// ─── Artwork Dialog ───────────────────────────────────────────────────────────

/**
 * Manual artwork fetch. Pre-fills the game name so the user can correct it when the
 * automatic match picked the wrong game (same idea as Cocoon's "change search title").
 */
function openArtDialog(game: Game): void {
  document.getElementById('art-dialog')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'art-dialog';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-title">Fetch artwork</div>
      <div class="modal-desc">Searches SteamGridDB (if a key is set) and the Steam store. If the wrong game gets matched, adjust the title below and search again.</div>
      <input type="text" id="art-term" value="${escHtml(game.name)}" autocomplete="off" spellcheck="false">
      <div class="modal-status" id="art-status"></div>
      <div class="modal-actions">
        <button class="btn secondary" id="art-cancel">Cancel</button>
        <button class="btn" id="art-search">Search</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const input = overlay.querySelector<HTMLInputElement>('#art-term')!;
  const status = overlay.querySelector<HTMLElement>('#art-status')!;
  const searchBtn = overlay.querySelector<HTMLButtonElement>('#art-search')!;
  const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') close(); };
  const close = (): void => { overlay.remove(); document.removeEventListener('keydown', onKey); };

  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('#art-cancel')!.addEventListener('click', close);
  document.addEventListener('keydown', onKey);

  const run = async (): Promise<void> => {
    searchBtn.disabled = true;
    status.className = 'modal-status';
    status.textContent = 'Searching…';
    try {
      const result = await window.vault.scrapeArt(game.id, input.value.trim() || undefined);
      if (result.success && result.coverArt) {
        const g = allGames.find((x) => x.id === game.id);
        if (g) g.coverArt = result.coverArt;
        renderContent();
        close();
        return;
      }
      status.className = 'modal-status error';
      status.textContent = result.error ?? 'No artwork found.';
    } catch (e) {
      status.className = 'modal-status error';
      status.textContent = String(e);
    }
    searchBtn.disabled = false;
  };

  searchBtn.addEventListener('click', () => { void run(); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') void run(); });
  input.focus();
  input.select();
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Content Rendering ────────────────────────────────────────────────────────

function renderContent(): void {
  const main = document.getElementById('main-content');
  const settingsPanelEl = document.getElementById('settings-panel');
  if (!main || !settingsPanelEl) return;

  if (activeTab === 'settings') {
    main.style.display = 'none';
    settingsPanelEl.style.display = '';
    return;
  }

  main.style.display = '';
  settingsPanelEl.style.display = 'none';

  const filtered = filterGames();
  main.innerHTML = '';

  const { title, subtitle } = getTabMeta();
  const header = document.createElement('div');
  header.className = 'content-header';
  header.innerHTML = `
    <div>
      <div class="content-title">${title}</div>
      <div class="content-subtitle">${subtitle} · ${filtered.length} game${filtered.length !== 1 ? 's' : ''}</div>
    </div>
    <div class="view-toggle">
      <button class="view-btn${isGridView ? ' active' : ''}" id="grid-btn" title="Grid view">⊞</button>
      <button class="view-btn${!isGridView ? ' active' : ''}" id="list-btn" title="List view">☰</button>
    </div>`;
  main.appendChild(header);

  header.querySelector('#grid-btn')!.addEventListener('click', () => { isGridView = true; renderContent(); });
  header.querySelector('#list-btn')!.addEventListener('click', () => { isGridView = false; renderContent(); });

  if (filtered.length === 0) {
    main.appendChild(buildEmptyState());
    return;
  }

  if (activeTab === 'by-platform') {
    renderByPlatform(main, filtered);
    return;
  }

  renderGameList(main, filtered);
}

function filterGames(): Game[] {
  const emuPlatforms = ['ryujinx', 'shadps4', 'rpcs3', 'pcsx2', 'yuzu'];

  let games: Game[];

  if (activeTab === 'hidden') {
    // Hidden tab: show ONLY hidden games
    games = allGames.filter((g) => g.hidden);
  } else {
    // All other tabs: never show hidden games
    games = allGames.filter((g) => !g.hidden);
    switch (activeTab) {
      case 'installed':    games = games.filter((g) => g.installed); break;
      case 'uninstalled':  games = games.filter((g) => !g.installed); break;
      case 'emulators':    games = games.filter((g) => emuPlatforms.includes(g.platform)); break;
      default: break;
    }
  }

  if (searchQuery) {
    games = games.filter((g) => g.name.toLowerCase().includes(searchQuery));
  }

  return games;
}

function getTabMeta(): { title: string; subtitle: string } {
  const map: Record<SidebarTab, { title: string; subtitle: string }> = {
    all:           { title: 'All Games',    subtitle: 'Your complete library' },
    installed:     { title: 'Installed',    subtitle: 'Games ready to play' },
    uninstalled:   { title: 'Uninstalled',  subtitle: 'Games you own but haven\'t installed' },
    'by-platform': { title: 'By Platform',  subtitle: 'Grouped by launcher' },
    emulators:     { title: 'Emulators',    subtitle: 'Games via emulation' },
    hidden:        { title: 'Hidden Games', subtitle: 'Right-click any game to unhide it' },
    settings:      { title: 'Settings',     subtitle: '' },
  };
  return map[activeTab] ?? { title: 'Library', subtitle: '' };
}

function renderGameList(container: HTMLElement, games: Game[]): void {
  const grid = document.createElement('div');
  grid.className = isGridView ? 'game-grid' : 'game-list-view';
  const cbs = makeCallbacks();
  for (const game of games) {
    grid.appendChild(isGridView ? createGameCard(game, cbs) : createGameRow(game, cbs));
  }
  container.appendChild(grid);
}

function renderByPlatform(container: HTMLElement, games: Game[]): void {
  const grouped = new Map<string, Game[]>();
  for (const g of games) {
    const arr = grouped.get(g.platform) ?? [];
    arr.push(g);
    grouped.set(g.platform, arr);
  }

  const PLATFORM_LABELS: Record<string, string> = {
    steam: 'Steam', epic: 'Epic Games', gog: 'GOG', ea: 'EA / Origin',
    ubisoft: 'Ubisoft Connect', battlenet: 'Battle.net', xbox: 'Xbox / Game Pass',
    ryujinx: 'Ryujinx', shadps4: 'shadPS4', rpcs3: 'RPCS3', pcsx2: 'PCSX2',
    yuzu: 'Yuzu / Suyu', custom: 'Custom Folders',
  };

  const cbs = makeCallbacks();
  for (const [platform, platformGames] of Array.from(grouped.entries()).sort()) {
    const section = document.createElement('div');
    section.innerHTML = `<div style="font-size:15px;font-weight:700;margin-bottom:12px;color:var(--text-primary)">${PLATFORM_LABELS[platform] ?? platform} <span style="color:var(--text-muted);font-weight:400;font-size:13px">(${platformGames.length})</span></div>`;
    const grid = document.createElement('div');
    grid.className = isGridView ? 'game-grid' : 'game-list-view';
    for (const g of platformGames) {
      grid.appendChild(isGridView ? createGameCard(g, cbs) : createGameRow(g, cbs));
    }
    section.appendChild(grid);
    section.style.marginBottom = '28px';
    container.appendChild(section);
  }
}

function buildEmptyState(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'empty-state';
  const isHiddenTab = activeTab === 'hidden';
  el.innerHTML = `
    <div class="empty-icon">${isHiddenTab ? '🙈' : '🎮'}</div>
    <div class="empty-title">${searchQuery ? `No results for "${searchQuery}"` : isHiddenTab ? 'No hidden games' : 'No games found'}</div>
    <div class="empty-desc">${
      searchQuery ? 'Try a different search term.'
      : isHiddenTab ? 'Right-click any game and select "Hide Game" to hide it from your library.'
      : 'Try rescanning your library or adding a watched folder in Settings.'
    }</div>`;
  return el;
}

// ─── Game Click ───────────────────────────────────────────────────────────────

async function handleGameClick(game: Game): Promise<void> {
  if (game.hidden) return; // no-op click on hidden games in the hidden tab
  if (game.installed) {
    const result = await window.vault.launchGame(game);
    if (!result.success) alert(`Could not launch ${game.name}:\n${result.error ?? 'Unknown error'}`);
  } else if (game.storeUrl) {
    await window.vault.openStore(game.storeUrl);
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  init().catch((e) => console.error('[Vault] Init failed:', e));
});
