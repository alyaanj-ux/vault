import { Game } from '../../shared/types';

const PLATFORM_LABELS: Record<string, string> = {
  steam: 'Steam', epic: 'Epic', gog: 'GOG', ea: 'EA',
  ubisoft: 'Ubisoft', battlenet: 'Battle.net', xbox: 'Xbox',
  ryujinx: 'Ryujinx', shadps4: 'shadPS4', rpcs3: 'RPCS3',
  pcsx2: 'PCSX2', yuzu: 'Yuzu/Suyu', custom: 'Custom',
};

const PLATFORM_ICONS: Record<string, string> = {
  steam: '🎮', epic: '🎮', gog: '🎮', ea: '🎮', ubisoft: '🎮',
  battlenet: '⚔️', xbox: '🟩', ryujinx: '🔴', shadps4: '🔵',
  rpcs3: '🎮', pcsx2: '🎮', yuzu: '🟡', custom: '📁',
};

export interface GameCardCallbacks {
  onClick: (game: Game) => void;
  onHide: (game: Game) => void;
  onUnhide: (game: Game) => void;
  onFetchArt: (game: Game) => void;
}

let activeMenu: HTMLElement | null = null;

function closeActiveMenu(): void {
  if (activeMenu) { activeMenu.remove(); activeMenu = null; }
}

document.addEventListener('click', closeActiveMenu);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeActiveMenu(); });

function showContextMenu(e: MouseEvent, game: Game, cbs: GameCardCallbacks): void {
  e.preventDefault();
  e.stopPropagation();
  closeActiveMenu();

  const menu = document.createElement('div');
  menu.style.cssText = `
    position:fixed; z-index:9999;
    background:var(--bg-raised); border:1px solid var(--border);
    border-radius:var(--radius-md); padding:4px;
    box-shadow:0 8px 24px rgba(0,0,0,0.5);
    min-width:160px; font-size:13px;`;

  const items = game.hidden
    ? [{ label: '👁 Unhide Game', action: () => cbs.onUnhide(game), danger: false }]
    : [
        { label: '🚀 Launch / Open', action: () => cbs.onClick(game), danger: false },
        { label: '🖼 Fetch Artwork…', action: () => cbs.onFetchArt(game), danger: false },
        { label: '🙈 Hide Game', action: () => cbs.onHide(game), danger: true },
      ];

  for (const item of items) {
    const btn = document.createElement('button');
    btn.style.cssText = `
      display:block; width:100%; text-align:left;
      background:none; border:none; cursor:pointer;
      padding:8px 12px; border-radius:6px;
      color:${item.danger ? 'var(--red)' : 'var(--text-primary)'};
      transition:background 0.1s;`;
    btn.textContent = item.label;
    btn.onmouseenter = () => btn.style.background = 'var(--bg-hover)';
    btn.onmouseleave = () => btn.style.background = 'none';
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      closeActiveMenu();
      item.action();
    });
    menu.appendChild(btn);
  }

  document.body.appendChild(menu);
  const { innerWidth: vw, innerHeight: vh } = window;
  const { offsetWidth: mw, offsetHeight: mh } = menu;
  menu.style.left = `${Math.min(e.clientX, vw - mw - 8)}px`;
  menu.style.top = `${Math.min(e.clientY, vh - mh - 8)}px`;
  activeMenu = menu;
}

export function createGameCard(game: Game, cbs: GameCardCallbacks): HTMLElement {
  const card = document.createElement('div');
  card.className = 'game-card';
  card.title = `${game.name} — right-click for options`;
  if (game.hidden) card.style.opacity = '0.45';

  const placeholder = `<div class="card-art-placeholder">${PLATFORM_ICONS[game.platform] ?? '🎮'}</div>`;

  if (game.coverArt) {
    card.innerHTML = `
      <img class="card-art" src="${game.coverArt}" alt="${escHtml(game.name)}" loading="lazy">
      <div class="card-art-placeholder" style="display:none">${PLATFORM_ICONS[game.platform] ?? '🎮'}</div>
      ${buildCardOverlay(game)}
      <div class="card-body">
        <div class="card-name">${escHtml(game.name)}</div>
        <div class="card-footer">
          <span class="platform-badge badge-${game.platform}">${PLATFORM_LABELS[game.platform] ?? game.platform}</span>
          <span class="installed-dot ${game.installed ? 'yes' : 'no'}"></span>
        </div>
      </div>`;
    const img = card.querySelector<HTMLImageElement>('img.card-art')!;
    img.addEventListener('error', () => {
      img.style.display = 'none';
      const ph = img.nextElementSibling as HTMLElement;
      if (ph) ph.style.display = 'flex';
    });
  } else {
    card.innerHTML = `
      ${placeholder}
      ${buildCardOverlay(game)}
      <div class="card-body">
        <div class="card-name">${escHtml(game.name)}</div>
        <div class="card-footer">
          <span class="platform-badge badge-${game.platform}">${PLATFORM_LABELS[game.platform] ?? game.platform}</span>
          <span class="installed-dot ${game.installed ? 'yes' : 'no'}"></span>
        </div>
      </div>`;
  }

  card.addEventListener('click', (e) => { e.stopPropagation(); cbs.onClick(game); });
  card.addEventListener('contextmenu', (e) => showContextMenu(e, game, cbs));
  return card;
}

function buildCardOverlay(game: Game): string {
  if (game.hidden) {
    return `<div class="card-uninstalled-overlay" style="opacity:1;background:rgba(0,0,0,0.65)">
      <span class="overlay-label" style="background:var(--text-muted)">Hidden</span>
    </div>`;
  }
  if (!game.installed) {
    return `<div class="card-uninstalled-overlay">
      <span class="overlay-label">Get Game</span>
    </div>`;
  }
  return '';
}

export function createGameRow(game: Game, cbs: GameCardCallbacks): HTMLElement {
  const row = document.createElement('div');
  row.className = 'game-row';
  if (game.hidden) row.style.opacity = '0.45';

  if (game.coverArt) {
    row.innerHTML = `
      <img class="row-art" src="${game.coverArt}" alt="" loading="lazy">
      <span class="row-name">${escHtml(game.name)}</span>
      <span class="row-platform"><span class="platform-badge badge-${game.platform}">${PLATFORM_LABELS[game.platform] ?? game.platform}</span></span>
      <span class="row-status">${game.installed ? '✓ Installed' : 'Not installed'}</span>`;
    const img = row.querySelector<HTMLImageElement>('img.row-art')!;
    img.addEventListener('error', () => { img.style.display = 'none'; });
  } else {
    row.innerHTML = `
      <div class="row-art" style="display:flex;align-items:center;justify-content:center;font-size:16px">${PLATFORM_ICONS[game.platform] ?? '🎮'}</div>
      <span class="row-name">${escHtml(game.name)}</span>
      <span class="row-platform"><span class="platform-badge badge-${game.platform}">${PLATFORM_LABELS[game.platform] ?? game.platform}</span></span>
      <span class="row-status">${game.installed ? '✓ Installed' : 'Not installed'}</span>`;
  }

  row.addEventListener('click', (e) => { e.stopPropagation(); cbs.onClick(game); });
  row.addEventListener('contextmenu', (e) => showContextMenu(e, game, cbs));
  return row;
}

function escHtml(s: string): string {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}