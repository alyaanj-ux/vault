# Vault — Project Context & Known Issues

## What this is

Electron + TypeScript desktop app for Windows. A universal game library manager that scans
installed games across Steam, Epic, GOG, EA, Ubisoft, Battle.net, Xbox, emulators (Ryujinx,
shadPS4, RPCS3, PCSX2, Yuzu/Suyu), and user-specified custom folders. Shows them in one
grid/list UI with cover art, lets you launch them, and lets you hide games you don't want visible.

Intended to be published/shared, so it needs to work on other people's machines, not just the
dev's.

## Stack & build

- Electron 28 + TypeScript 5.3, CommonJS for main process
- Renderer is bundled with **webpack** (`webpack.renderer.js`) — NOT plain tsc, because
  tsc's CommonJS output causes `exports is not defined` in the browser context
- `electron-builder` for packaging (NSIS installer + portable exe)
- Build: `npm run dev` = `tsc && webpack --config webpack.renderer.js && npm run copy-static && electron .`
- `copy-static` copies `index.html` and `styles/main.css` into `dist/renderer/` — the main
  process loads HTML from `dist/renderer/index.html`, so static assets MUST be copied there
- Node is NOT on PATH in a default shell on the dev machine; it lives at
  `D:\Software Development\NODE`. Put that on PATH before running the npm scripts.

## Architecture

```
src/
  main/           — Electron main process (all fs, registry, API access lives here)
    index.ts      — app lifecycle, all IPC handlers
    preload.ts    — contextBridge, exposes window.vault to renderer
    library.ts    — merge/dedupe/persist to %APPDATA%\Vault\library.json
    settings.ts   — settings to %APPDATA%\Vault\settings.json
    findExe.ts    — heuristic: given install dir + game name, pick the right .exe
    tray.ts       — system tray icon + menu (close-to-tray, launch at startup)
    scraper.ts    — artwork scraper (SteamGridDB + Steam store), caches to %APPDATA%\Vault\art\
    sfo.ts        — PARAM.SFO reader (PS3/PS4 title + category), used by the RPCS3/shadPS4 scanners
    appinfo.ts    — binary appcache/appinfo.vdf reader (Steam app names + types, no API key needed)
    scanners/     — one file per platform
  renderer/       — UI (no node access, talks via window.vault)
    app.ts        — state, routing, rendering
    components/   — GameCard, Sidebar, Settings
    styles/main.css
  shared/types.ts — Game, Platform, Settings types
```

IPC is contextIsolation:true with a preload bridge. Renderer never touches fs directly.

---

# OPEN ISSUES — these need fixing

## 1. Custom folder scanning doesn't pick up executables (HIGH PRIORITY, currently broken)

**Symptom:** User adds a folder under Settings → Watched Folders, saves, rescans. No games
appear from that folder. This worked at one point and regressed.

**Where to look:** `src/main/scanners/folders.ts` — the `looksLikeGame()` heuristic and
`walkDir()` depth limit. Also verify `scanCustomFolders()` is actually receiving the
`watchedFolders` array from settings (check the IPC path in `index.ts` scan-library handler).

**Suspected causes:**
- `looksLikeGame()` may be too aggressive — it requires either a "game signal" word in the exe
  name OR the exe being in its own folder. Real game exes often fail both checks.
- `walkDir` maxDepth is 4 — may not be deep enough, or the recursion may be silently swallowing
  errors via the bare `catch {}`.
- Settings may not be persisting `watchedFolders` correctly before the scan runs.

**How to verify a fix:** add a folder with a known game exe, save settings, confirm it appears.

## 2. ~~Ryujinx emulator path doesn't work even when set manually~~ — FIXED (2026-09-02)

Root cause was exactly as suspected: `scanRyujinx(emulatorPath)` only used the path to locate the
binary, never the config. All emulator scanners in `scanners/emulators.ts` now follow one pattern —
resolve the exe (user path, which may be the exe OR its folder OR the parent folder, else
auto-detect), then look for a portable config **next to the exe** before falling back to AppData:

| Emulator  | Portable config (checked first)      | Fallback                                     |
|-----------|--------------------------------------|----------------------------------------------|
| Ryujinx   | `<exe>/portable/Config.json`         | `%APPDATA%/Ryujinx/Config.json`              |
| shadPS4   | `<exe>/user/config.toml`             | `%APPDATA%/shadPS4/config.toml`              |
| RPCS3     | `<exe>/config/games.yml`, `<exe>/games.yml`, `<exe>/dev_hdd0/game/*` | (Windows RPCS3 is always portable) |
| PCSX2     | `<exe>/inis/PCSX2.ini` (if portable) | `~/Documents/PCSX2/inis/PCSX2.ini`           |
| Yuzu/Suyu | `<exe>/user/config/qt-config.ini`    | `%APPDATA%/{yuzu,suyu}/config/qt-config.ini` |

Other things fixed in the same pass (don't regress these):
- RPCS3 `games.yml` is `SERIAL: path`, not `path: serial` — the old parser had it backwards, so it
  never matched anything. Titles now come from `PARAM.SFO` via `sfo.ts`; `dev_hdd0/game` is scanned
  for installed PSN titles; `CATEGORY` GD entries (updates) are skipped.
- PCSX2 `[GameList]` uses REPEATED `RecursivePaths=` / `Paths=` keys. Generic ini parsers collapse
  repeated keys, so that section is parsed line by line. The real default config location is
  `Documents\PCSX2\inis`, not AppData.
- shadPS4 `config.toml` is parsed with `@iarna/toml`; the keys are `[GUI] installDirs` plus
  `installDirsEnabled`. Only extracted game folders (`eboot.bin` + `sce_sys/param.sfo`, CATEGORY gd)
  are listed — `.pkg` files are installers, not playable.
- Switch scans filter out updates and DLC by title id (base ids end in `000`) and recurse for
  Ryujinx (matching Ryujinx's own behaviour) or per `deep_scan` for Yuzu.
- Emulator games launch with `cwd` set to the emulator's folder — portable builds need it to find
  their own config. Launch now fails with a clear message if the emulator exe is missing.
- Exe-icon extraction is skipped for emulator platforms: `executablePath` is the emulator, so every
  ROM would otherwise get the same icon.
- Suyu was labelled `yuzu` by a `isYuzu ? 'yuzu' : 'yuzu'` typo. Both forks share the `yuzu`
  platform deliberately now (same config format), shown as "Yuzu/Suyu" in the UI.

**Verified against synthetic portable fixtures** (fake Ryujinx/Yuzu/RPCS3/PCSX2/shadPS4 trees with
real PARAM.SFO binaries): every scanner found its games, updates/DLC were excluded, and a bogus
emulator path returned 0 games without throwing.

## 3. ~~Steam cover art 404s spam the console~~ — mostly resolved (2026-09-02)

Cover art now comes from Steam's own on-disk cache first
(`appcache/librarycache/<appid>/header.jpg`, then `library_header.jpg`), falling back to the CDN
URL only when nothing is cached. Combined with the type filtering below, the tools and DLC that
produced most of the 404s are no longer in the library at all.

A few 404s remain for games whose cache holds only the newer hash-named files. The `error`
listener in `GameCard.ts` swaps in the platform placeholder, and the artwork scraper can fill
them in. Not worth chasing further.

## 4. Exe picking heuristic needs validation

`findExe.ts` was recently rewritten to score candidates by name similarity to the game title
rather than just picking the largest file. This was in response to games shipping utility exes
like `crs-handler.exe` and `crs-video.exe` alongside the real game binary.

The SKIP_EXE blocklist now filters: uninstallers, setup, updaters, redists, crash handlers,
anticheat (EasyAntiCheat, BattlEye), overlays, webview/browser processes, `crs-*`, `handler`,
`video`, `splash`.

**Needs testing** against a real library to confirm it picks correctly. If it picks wrong,
tune the scoring weights in `scoreExe()` — name similarity is weighted 1000x, main-exe-name
signals ("game", "start", "play", "launch") add 500, file size adds size/1000.

## 5. Icon extraction moved to background — reworked (2026-09-02)

Icons for non-Steam games are extracted via `app.getFileIcon()`. This originally ran inline
during the scan and made the scan appear to hang / return nothing. It's now deferred to a
`setImmediate` block that runs after the scan result is returned, then pushes results to the
renderer via a `library-updated` IPC event.

Now part of `enrichLibraryInBackground()`, which operates on the live library via `patchGame()`
rather than on the array captured by the scan closure, then hands off to the artwork scraper.
Emulator platforms are skipped (see issue 2).

**Still to verify in the real app:** scan completes fast, games appear immediately, icons fill in a
moment later, artwork replaces icons after that.

---

# Artwork scraper (`src/main/scraper.ts`)

Modelled on the Cocoon frontend's scraping: clean the title, query sources in priority order, take
the best landscape banner, cache it locally.

- **Sources:** SteamGridDB (needs the user's free API key, Settings → Artwork; covers every
  platform including Switch/PS2/PS3/PS4) → Steam store search (keyless, PC games only, requires a
  very close name match so a Switch dump never picks up random PC art). IGDB, LaunchBox and
  ScreenScraper are deliberately not used: they need credentials or a large metadata dump that
  can't ship in a portable Electron app.
- **Assets:** landscape grids `460x215` / `920x430` (matches the `.card-art` aspect ratio), falling
  back to heroes. Not portrait box art — the card is a banner.
- **Matching:** `cleanTitle()` strips bracketed title ids, region tags, version numbers and
  update/DLC words. `similarity()` is a bigram Dice coefficient with a sequel guard, so
  "Portal" vs "Portal 2" scores 0.70 and fails the 0.80 Steam-store threshold.
- **Cache:** `%APPDATA%\Vault\art\<sha1(game.id)>.<ext>`, referenced as a `file://` URL with a `?v=`
  cache-buster. CSP `img-src` includes `file:` for this.
- **When it runs:** after every scan when `autoScrapeArt` is on, inside
  `enrichLibraryInBackground()` in `index.ts`, 3 games at a time, after exe icons. Results are
  patched into the live library through `patchGame()` so a rescan finishing mid-pass can't clobber
  them. Progress is pushed to the renderer on `scrape-progress`.
- **Skip rules (`needsArt`):** hidden games, Steam games (CDN art already), anything whose
  `coverSource` is already real art, and anything tried within the last 7 days (`artScrapedAt`).
  Exe icons (`coverSource: 'icon'`) count as "no real art" and get replaced when a match is found.
- **Manual control:** right-click any game → *Fetch Artwork…* opens a dialog pre-filled with the
  title so a bad match can be corrected (`scrape-art` IPC, forced). Settings → *Fetch Missing
  Artwork* runs a whole pass (`scrape-all-art`). Scraped art wins over scanner art in `mergeGames`,
  so a rescan never undoes a hand-picked image.
- `Game` gained `coverSource` and `artScrapedAt`; `Settings` gained `steamGridDbApiKey` and
  `autoScrapeArt`. Existing `settings.json` files pick the new defaults up via the spread in
  `loadSettings()`.

# Steam: local-only owned game detection (`scanners/steam.ts`, `appinfo.ts`)

The Uninstalled tab works with **no API key**. Everything comes off disk:

| What | Where |
|------|-------|
| Install location | `HKCU\Software\Valve\Steam\SteamPath`, then the usual defaults |
| Installed games | `appmanifest_*.acf` in every library folder from `libraryfolders.vdf` |
| Owned games (incl. uninstalled) | `userdata/<accountId>/config/localconfig.vdf` → `Software/Valve/Steam/apps` |
| Names and types | `appcache/appinfo.vdf` (binary, parsed by `appinfo.ts`) |
| Cover art | `appcache/librarycache/<appid>/header.jpg`, else the CDN URL |

- `localconfig.vdf` holds an entry per app the account has installed, launched or configured,
  which is exactly the owned set. Entries carrying only a `cloud` block are Steam infrastructure
  and are skipped. Key casing has moved around across client versions, so each level is matched
  case-insensitively.
- **`appinfo.vdf` is the load-bearing piece** — without it an uninstalled game has no name. It is
  a binary format Valve revises every few years: a header, then one record per app ending in a
  binary-VDF blob. In the current v29 the blob's KEYS are u32 indices into a string table at the
  end of the file; v27/v28 inline them. All three are handled and every failure path is non-fatal
  (worst case: uninstalled games are skipped, with a count logged).
- **Type filtering** uses `common.type` from appinfo: `tool`, `config`, `dlc`, `music`, `video`,
  `series`, `hardware` and `beta` are dropped. That is what removed "Steamworks Common
  Redistributables". `Application` is deliberately KEPT — Wallpaper Engine and similar are things
  people want in their library. Appids 480 (Valve's Spacewar sample) and 228980 are always ignored.
- Uninstalled games with no appinfo entry are skipped rather than shown as a bare appid.
- A Web API key is still merged in on top when set — it adds games owned but never installed or
  launched on this machine. It is now an enhancement, not a requirement.
- Clicking an uninstalled Steam game opens `steam://install/<appid>`; installed ones still use
  `steam://rungameid/<appid>`.

# Xbox: real games only, and launching them (`scanners/xbox.ts`)

- **A folder is only a game if `Content/MicrosoftGame.Config` exists.** `C:\XboxGames\GameSave`
  (cloud-save data, `pgs`/`wgs` subfolders) has no such file — that is what used to show up as a
  game called "GameSave". `NON_GAME_FOLDERS` short-circuits the known offenders.
- Names come from `ShellVisuals/DefaultDisplayName`, falling back to a `<DisplayName>` element.
  The config file ships with commented-out example attributes, so **comments are stripped before
  matching** or the examples win.
- Microsoft ships Minecraft with the display name "Minecraft Launcher". `normalizeName()` drops a
  trailing "Launcher" **only when** the executable base name or the AppxManifest Application Id is
  the same word (`Minecraft.exe`, `Id="Minecraft"`), so a genuinely separate launcher keeps its name.
- **Launching goes through the AUMID** (`<packageFamilyName>!<applicationId>`) via
  `explorer.exe shell:appsFolder\<aumid>`, stored in `Game.appId`. Running the exe directly bypasses
  the licensing container and most packaged titles refuse to start that way.
  - The family name comes from `%LOCALAPPDATA%\Packages\<identity>_<hash>` — readable by any user.
  - The Application Id comes from `AppxManifest.xml` in the WindowsApps package folder. **That
    folder denies directory LISTING but still allows reading a file by full path**, so the folder
    name is RECONSTRUCTED as `<identity>_<version>_<arch>__<hash>` from MicrosoftGame.Config plus
    the publisher hash, rather than searched for. The listing scan remains as a fallback.
  - If no AUMID resolves, the entry falls back to launching the executable.
- Cover art starts as the package's own `SplashScreen.png` / `GraphicsLogo.png`, tagged
  `coverSource: 'icon'` so the scraper will replace it with real art when it finds a match.

# Tray, startup and packaging

Vault is a launcher, so it is built to stay resident rather than be cold-started every time.

- **Single instance.** `app.requestSingleInstanceLock()` runs before `whenReady`. A second launch
  quits immediately, and the `second-instance` event calls `showWindow()` on the original. Without
  this, clicking the shortcut while Vault sits in the tray would start a second copy.
- **Close hides, it does not quit.** The window's `close` handler calls `preventDefault()` and
  `hide()` while `minimizeToTray` is on. `isQuitting` — set by the tray's Quit item and by
  `before-quit` — is what lets a real quit through. `window-all-closed` must NOT quit while the
  tray is enabled; that is the bug that makes tray apps die on close.
- **Launch at startup** uses `app.setLoginItemSettings` with `args: ['--hidden']`, and is skipped
  entirely when `!app.isPackaged`. In development `process.execPath` is electron.exe, so writing a
  login item would register the dev runtime in the user's startup list.
- `startMinimized` only takes effect when the `--hidden` argument is present, so starting Vault by
  hand always shows the window. The window is CREATED either way, so the library is scanned and
  ready by the time the user clicks the tray icon.
- **Settings apply immediately.** The `save-settings` handler re-applies the login item and
  creates or destroys the tray rather than waiting for a restart.
- **The tray icon resolves from `app.getAppPath()/assets/icon.ico`**, which works both in
  development and inside the packed asar. Failure is non-fatal: a missing icon logs a warning and
  falls back to a blank image rather than stopping the app.

## Building distributables

`npm run build` produces exactly ONE artifact: `release/Vault-Setup-<version>.exe`.

That is deliberate. Shipping an installer *and* a portable exe made people ask which one they
were supposed to download, so the portable target was dropped. The NSIS installer is per-user
(`perMachine: false`), so it never triggers a UAC prompt, and it carries the whole Electron
runtime — there is nothing else for anyone to fetch. `files` ships `dist/` and `assets/` only;
the raw renderer sources are not packaged because `copy-static` already places the html and css
under `dist/renderer/`.

Two gotchas:

- **The icon must be at least 256x256** or electron-builder hard-fails. `assets/icon.ico` is a
  7-size ICO (16 through 256) with PNG-compressed entries, generated from the app's own palette.
- **electron-builder's winCodeSign archive contains macOS symlinks** that a normal Windows account
  cannot create, so extraction fails with `Cannot create symbolic link`. Fix it by enabling
  Developer Mode, or by pre-extracting the cached `.7z` into a `winCodeSign-2.6.0` folder in the
  same cache directory using `-xr'!darwin'`.

# Platform limitations (intentional — don't "fix" these)

These scanners deliberately use fallback methods because the "proper" approach is unreliable.
Comments explaining this exist in each file. Don't replace them with fragile parsing.

- **Battle.net** — `product.db` is undocumented protobuf that breaks on client updates.
  We parse `Battle.net.config` (JSON) + scan the default install dir instead.
- **Xbox/Game Pass** — games are sandboxed in encrypted WindowsApps packages. The Gaming
  Services COM API needs native Windows SDK bindings that can't ship in a portable Electron
  app. We scan `C:\XboxGames` and `~\XboxGames` and read each title's `Content/MicrosoftGame.Config`
  (plain XML, outside the encrypted part). See the Xbox section below for the details.
- **GOG** — Galaxy's storage is a SQLite DB with an undocumented, version-shifting schema.
  We use the Windows registry (`HKLM\SOFTWARE\GOG.com\Games`) which GOG has kept stable.
- **shadPS4** — no persistent game library manifest exists. We read the configured game
  directory out of `config.toml` and scan it for `.pkg`/`.iso`.

# Recently fixed (don't regress these)

- **Black screen on launch** — was caused by (a) main process loading HTML from `src/` instead
  of `dist/renderer/`, and (b) `<script src>` pointing at the wrong path. Both fixed; static
  files are now copied into dist by the `copy-static` npm script.
- **`exports is not defined`** — renderer was compiled as CommonJS. Fixed by bundling the
  renderer with webpack instead.
- **CSP blocking cover art and inline handlers** — `img-src` now allows `https:`, and all
  inline `onerror=` attributes were replaced with `addEventListener('error', ...)` in
  `GameCard.ts`.
- **CS:GO / CS2 and other wrapped Steam games opening a browser instead of launching** — Steam
  games now always launch via `steam://rungameid/{appid}` rather than hunting for an exe.
  Don't change this back; the protocol handles anti-cheat, launchers, and renamed games.
- **Settings panel couldn't scroll** — `#content-root` had `overflow: hidden`, now `auto`.
- **Hidden games feature** — right-click any card → Hide Game. Hidden games are excluded from
  every view. The `hidden` flag persists across rescans (see `mergeGames` in `library.ts`).
  The separate "Hidden" sidebar tab was removed by request; hidden games are currently only
  unhideable by editing `library.json` directly — **this is a UX gap worth addressing**, e.g.
  a "Hidden Games" section in the Settings panel.

# Conventions

- All fs / registry / network access goes in the main process. Renderer uses `window.vault`.
- Every scanner returns `Game[]` and must not throw — wrap risky IO in try/catch and log.
- Scanners that can't reliably detect games should implement the best available method and
  leave a comment explaining the limitation rather than failing silently.
- No TODOs or placeholders in committed code.
