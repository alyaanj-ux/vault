export type SidebarTab =
  | 'all'
  | 'installed'
  | 'uninstalled'
  | 'by-platform'
  | 'emulators'
  | 'hidden'
  | 'settings';

interface NavItem {
  id: SidebarTab;
  label: string;
  icon: string;
  countKey?: string;
  dividerBefore?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { id: 'all',         label: 'All Games',   icon: '🎮', countKey: 'all' },
  { id: 'installed',   label: 'Installed',   icon: '✅', countKey: 'installed' },
  { id: 'uninstalled', label: 'Uninstalled', icon: '☁️', countKey: 'uninstalled' },
  { id: 'by-platform', label: 'By Platform', icon: '🗂️' },
  { id: 'emulators',   label: 'Emulators',   icon: '🕹️', countKey: 'emulators' },
  { id: 'hidden',      label: 'Hidden',      icon: '🙈', countKey: 'hidden', dividerBefore: true },
  { id: 'settings',   label: 'Settings',    icon: '⚙️', dividerBefore: true },
];

export class Sidebar {
  private el: HTMLElement;
  private activeTab: SidebarTab = 'all';
  private counts: Record<string, number> = {};
  private onTabChange: (tab: SidebarTab) => void;

  constructor(container: HTMLElement, onTabChange: (tab: SidebarTab) => void) {
    this.onTabChange = onTabChange;
    this.el = document.createElement('nav');
    this.el.className = 'sidebar';
    container.appendChild(this.el);
    this.render();
  }

  setCounts(counts: Record<string, number>): void {
    this.counts = counts;
    this.render();
  }

  setActive(tab: SidebarTab): void {
    this.activeTab = tab;
    this.render();
  }

  private render(): void {
    this.el.innerHTML = `<div class="sidebar-section-label">Library</div>`;

    for (const item of NAV_ITEMS) {
      if (item.dividerBefore) {
        const divider = document.createElement('div');
        divider.style.cssText = 'height:1px;background:var(--border-subtle);margin:6px 4px';
        this.el.appendChild(divider);
      }

      const div = document.createElement('div');
      div.className = `nav-item${this.activeTab === item.id ? ' active' : ''}`;

      const count = item.countKey !== undefined ? this.counts[item.countKey] : undefined;
      div.innerHTML = `
        <span class="nav-icon">${item.icon}</span>
        <span>${item.label}</span>
        ${count !== undefined ? `<span class="nav-count">${count}</span>` : ''}`;

      div.addEventListener('click', () => {
        this.activeTab = item.id;
        this.render();
        this.onTabChange(item.id);
      });

      this.el.appendChild(div);
    }
  }
}
