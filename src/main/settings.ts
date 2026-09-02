import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Settings } from '../shared/types';

const VAULT_DIR = path.join(os.homedir(), 'AppData', 'Roaming', 'Vault');
const SETTINGS_PATH = path.join(VAULT_DIR, 'settings.json');

const DEFAULT_SETTINGS: Settings = {
  steamApiKey: '',
  steamUserId: '',
  steamGridDbApiKey: '',
  autoScrapeArt: true,
  watchedFolders: [],
  emulatorPaths: {},
  theme: 'dark',
  gridView: true,
};

function ensureVaultDir(): void {
  if (!fs.existsSync(VAULT_DIR)) {
    fs.mkdirSync(VAULT_DIR, { recursive: true });
  }
}

export function loadSettings(): Settings {
  ensureVaultDir();
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      const raw = fs.readFileSync(SETTINGS_PATH, 'utf-8');
      return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    }
  } catch (e) {
    console.error('[Settings] Failed to load settings:', e);
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(settings: Settings): void {
  ensureVaultDir();
  try {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf-8');
  } catch (e) {
    console.error('[Settings] Failed to save settings:', e);
    throw e;
  }
}

export function getVaultDir(): string {
  ensureVaultDir();
  return VAULT_DIR;
}
