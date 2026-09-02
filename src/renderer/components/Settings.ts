import { Settings } from '../../shared/types';

// window.vault declared in app.ts

export class SettingsPanel {
  private el: HTMLElement;
  private settings: Settings | null = null;
  private onScanRequest: () => void;

  constructor(container: HTMLElement, onScanRequest: () => void) {
    this.onScanRequest = onScanRequest;
    this.el = document.createElement('div');
    this.el.className = 'content';
    container.appendChild(this.el);
    this.load();

    window.vault.onScrapeProgress((p) => this.showScrapeProgress(p.done, p.total, p.running));
  }

  private showScrapeProgress(done: number, total: number, running: boolean): void {
    const btn = this.el.querySelector<HTMLButtonElement>('#scrape-btn');
    const status = this.el.querySelector<HTMLElement>('#scrape-status');
    if (!btn || !status) return;
    btn.disabled = running;
    if (running) {
      status.textContent = `Fetching artwork… ${done}/${total}`;
    } else if (total > 0) {
      status.textContent = `Done — checked ${total} game${total === 1 ? '' : 's'}.`;
    } else {
      status.textContent = '';
    }
  }

  getElement(): HTMLElement {
    return this.el;
  }

  private async load(): Promise<void> {
    this.settings = await window.vault.getSettings();
    this.render();
  }

  private async save(): Promise<void> {
    if (!this.settings) return;
    await window.vault.saveSettings(this.settings);
    this.showSaved();
  }

  private showSaved(): void {
    const notice = document.createElement('div');
    notice.className = 'error-toast';
    notice.style.cssText = 'background:rgba(74,222,128,0.12);border-color:var(--green);color:var(--green)';
    notice.textContent = '✓ Settings saved';
    this.el.prepend(notice);
    setTimeout(() => notice.remove(), 2500);
  }

  private render(): void {
    if (!this.settings) {
      this.el.innerHTML = '<div class="empty-state"><div class="empty-icon">⚙️</div><div class="empty-title">Loading settings…</div></div>';
      return;
    }

    const s = this.settings;
    this.el.innerHTML = `
      <div class="content-header">
        <div>
          <div class="content-title">Settings</div>
          <div class="content-subtitle">Configure Vault, your API keys, and emulator paths</div>
        </div>
        <button class="btn" id="save-btn">Save Settings</button>
      </div>
      <div class="settings-grid">

        <div class="settings-section">
          <h3>Steam</h3>
          <div class="field">
            <label>Steam API Key</label>
            <input type="password" id="steam-key" value="${escHtml(s.steamApiKey)}" placeholder="Your Steam Web API key">
            <span class="field-hint">Get yours free at <b>steamcommunity.com/dev/apikey</b> — required for uninstalled games tab</span>
          </div>
          <div class="field">
            <label>Steam User ID (64-bit)</label>
            <input type="text" id="steam-uid" value="${escHtml(s.steamUserId)}" placeholder="e.g. 76561198012345678">
            <span class="field-hint">Find at <b>steamid.io</b> — needed to list your owned games</span>
          </div>
        </div>

        <div class="settings-section">
          <h3>Artwork</h3>
          <div class="field">
            <label>SteamGridDB API Key</label>
            <input type="password" id="sgdb-key" value="${escHtml(s.steamGridDbApiKey ?? '')}" placeholder="Optional — best source for emulator & non-Steam art">
            <span class="field-hint">Free key at <b>steamgriddb.com/profile/preferences/api</b>. Without one, only the Steam store is searched, which covers PC games only.</span>
          </div>
          <div class="toggle-row">
            <span class="toggle-label">Fetch missing artwork after each scan</span>
            <label class="toggle">
              <input type="checkbox" id="autoscrape-toggle" ${s.autoScrapeArt !== false ? 'checked' : ''}>
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
            <button class="btn secondary" id="scrape-btn">🖼 Fetch Missing Artwork</button>
            <span class="field-hint" id="scrape-status"></span>
          </div>
          <span class="field-hint">Right-click any game → <b>Fetch Artwork…</b> to re-search with a corrected title.</span>
        </div>

        <div class="settings-section">
          <h3>Appearance</h3>
          <div class="toggle-row">
            <span class="toggle-label">Light Mode</span>
            <label class="toggle">
              <input type="checkbox" id="theme-toggle" ${s.theme === 'light' ? 'checked' : ''}>
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div class="toggle-row">
            <span class="toggle-label">List View by Default</span>
            <label class="toggle">
              <input type="checkbox" id="list-toggle" ${!s.gridView ? 'checked' : ''}>
              <span class="toggle-slider"></span>
            </label>
          </div>
        </div>

        <div class="settings-section" style="grid-column:1/-1">
          <h3>Watched Folders</h3>
          <div class="field-hint" style="margin-bottom:6px">Vault scans these folders for game executables and adds them to your library.</div>
          <div class="folder-list" id="folder-list"></div>
          <button class="btn secondary" id="add-folder-btn" style="margin-top:6px;align-self:flex-start">+ Add Folder</button>
        </div>

        <div class="settings-section" style="grid-column:1/-1">
          <h3>Emulator Paths</h3>
          <div class="field-hint" style="margin-bottom:10px">Leave blank to auto-detect. Fill in if your emulator is installed somewhere unusual.</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            ${['ryujinx', 'shadps4', 'rpcs3', 'pcsx2', 'yuzu'].map((emu) => `
              <div class="field">
                <label>${emu.charAt(0).toUpperCase() + emu.slice(1)} Executable</label>
                <input type="text" class="emu-path" data-emu="${emu}" value="${escHtml((s.emulatorPaths as Record<string, string | undefined>)[emu] ?? '')}" placeholder="Auto-detect">
              </div>`).join('')}
          </div>
        </div>

        <div class="settings-section" style="grid-column:1/-1">
          <h3>Library</h3>
          <div style="display:flex;gap:10px;flex-wrap:wrap">
            <button class="btn" id="rescan-btn">🔄 Rescan Library</button>
          </div>
        </div>

      </div>`;

    this.renderFolders();

    this.el.querySelector('#save-btn')!.addEventListener('click', () => this.collectAndSave());
    this.el.querySelector('#add-folder-btn')!.addEventListener('click', () => this.addFolder());
    this.el.querySelector('#rescan-btn')!.addEventListener('click', () => this.onScanRequest());
    this.el.querySelector('#scrape-btn')!.addEventListener('click', () => { void this.scrapeAll(); });
  }

  private async scrapeAll(): Promise<void> {
    const btn = this.el.querySelector<HTMLButtonElement>('#scrape-btn');
    const status = this.el.querySelector<HTMLElement>('#scrape-status');
    if (btn) btn.disabled = true;
    if (status) status.textContent = 'Starting…';
    try {
      const result = await window.vault.scrapeAllArt();
      if (!result.success && status) status.textContent = result.error ?? 'Could not start artwork fetch.';
      else if (status && result.updated === 0) status.textContent = 'Nothing to fetch — every game already has artwork or was checked recently.';
    } catch (e) {
      if (status) status.textContent = String(e);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  private renderFolders(): void {
    if (!this.settings) return;
    const list = this.el.querySelector('#folder-list');
    if (!list) return;
    list.innerHTML = '';

    if (this.settings.watchedFolders.length === 0) {
      list.innerHTML = '<span style="font-size:12px;color:var(--text-muted)">No folders added yet.</span>';
      return;
    }

    for (let i = 0; i < this.settings.watchedFolders.length; i++) {
      const folder = this.settings.watchedFolders[i];
      const item = document.createElement('div');
      item.className = 'folder-item';
      item.innerHTML = `
        <span class="folder-path" title="${escHtml(folder)}">${escHtml(folder)}</span>
        <button class="folder-remove" data-idx="${i}" title="Remove">✕</button>`;
      item.querySelector('.folder-remove')!.addEventListener('click', (e) => {
        const idx = parseInt((e.currentTarget as HTMLElement).dataset['idx'] ?? '0');
        this.settings!.watchedFolders.splice(idx, 1);
        this.renderFolders();
      });
      list.appendChild(item);
    }
  }

  private async addFolder(): Promise<void> {
    const folder = await window.vault.browseFolder();
    if (!folder || !this.settings) return;
    if (!this.settings.watchedFolders.includes(folder)) {
      this.settings.watchedFolders.push(folder);
      this.renderFolders();
    }
  }

  private collectAndSave(): void {
    if (!this.settings) return;
    const get = (id: string) => (this.el.querySelector(`#${id}`) as HTMLInputElement)?.value.trim() ?? '';

    this.settings.steamApiKey = get('steam-key');
    this.settings.steamUserId = get('steam-uid');
    this.settings.steamGridDbApiKey = get('sgdb-key');
    this.settings.autoScrapeArt = !!(this.el.querySelector('#autoscrape-toggle') as HTMLInputElement)?.checked;
    this.settings.theme = (this.el.querySelector('#theme-toggle') as HTMLInputElement)?.checked ? 'light' : 'dark';
    this.settings.gridView = !(this.el.querySelector('#list-toggle') as HTMLInputElement)?.checked;

    const emuInputs = Array.from(this.el.querySelectorAll<HTMLInputElement>('.emu-path'));
    for (const input of emuInputs) {
      const emu = input.dataset['emu'] as keyof Settings['emulatorPaths'];
      if (emu) {
        (this.settings.emulatorPaths as Record<string, string | undefined>)[emu] = input.value.trim() || undefined;
      }
    }

    document.body.className = this.settings.theme === 'light' ? 'light' : '';
    this.save();
    this.onScanRequest();
  }
}

function escHtml(s: string): string {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
