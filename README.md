# Vault

**One library for every game you own.** Vault is a Windows desktop app that finds the games
already installed on your PC — across Steam, Epic, GOG, EA, Ubisoft, Battle.net, Xbox Game Pass,
five emulators and any folder you point it at — and puts them in a single grid you can launch
from. No account, no sign-up, no telemetry.

<!-- Add a screenshot here once you have one: ![Vault](docs/screenshot.png) -->

---

## Why you'd want it

If you buy games from more than one store, your library is scattered across half a dozen
launchers that each want to be open, updating, and running in the background. Vault is the
opposite of that.

- **Everything in one place.** Your Steam backlog, your Game Pass installs, your GOG classics
  and your emulator ROMs sit side by side in one window.
- **See what you own but haven't installed.** Vault reads Steam's own local data to list games
  you own but don't currently have on disk. Click one and Steam starts the install.
- **It launches things properly.** Steam games go through `steam://` so anti-cheat and wrapped
  launchers behave. Xbox games go through their package identity, which is the only way most
  Game Pass titles will start. Emulator games open in the right emulator with the right ROM.
- **Real cover art, automatically.** Vault reuses the artwork Steam already cached on your disk,
  and fetches the rest from SteamGridDB and the Steam store — including for Switch, PS2, PS3 and
  PS4 titles that no PC launcher would ever have art for.
- **Nothing leaves your machine** except optional artwork lookups. There is no account and no
  analytics. Your library lives in a JSON file in your own AppData folder.
- **Hide what you don't want.** Right-click anything you'd rather not see — redistributables,
  tools, that one game — and it disappears from every view, permanently.
- **It stays out of your way.** Vault lives in the system tray. Close the window and it keeps
  running quietly; click the tray icon whenever you want your library back. It can start with
  Windows too, so it's simply always there.

---

## What it detects

| Source | How it's found |
|---|---|
| **Steam** | `appmanifest_*.acf` for installed games, plus local client data for owned-but-uninstalled ones |
| **Epic Games** | The launcher's manifest folder |
| **GOG** | The Windows registry key GOG has kept stable across Galaxy versions |
| **EA / Origin** | Local install manifests |
| **Ubisoft Connect** | Registry install records |
| **Battle.net** | `Battle.net.config` plus the default install directory |
| **Xbox / Game Pass** | `C:\XboxGames`, reading each title's `MicrosoftGame.Config` |
| **Ryujinx** | `game_dirs` from its config, including portable installs |
| **Yuzu / Suyu** | `qt-config.ini` game directories, honouring deep-scan |
| **RPCS3** | `games.yml` disc dumps plus installed titles in `dev_hdd0` |
| **PCSX2** | `[GameList]` paths from `PCSX2.ini` |
| **shadPS4** | Install directories from `config.toml` |
| **Custom folders** | Any folder you add in Settings, scanned for game executables |

---

## Getting started

### Install

**One file, one download.** Grab `Vault-Setup-<version>.exe` from the
[Releases](../../releases) page and run it. Windows 10 or 11, 64-bit.

That single installer contains everything Vault needs, including its own runtime. There is
nothing else to download, no Node.js, no build step, and nothing to do in a terminal. It:

- installs to your user folder, so it never asks for an administrator password
- adds a desktop shortcut and a Start Menu entry
- lets you choose the install folder if you'd rather not use the default
- uninstalls from Windows Settings like any other program, leaving your library intact

Vault isn't code-signed yet, so Windows SmartScreen may warn you the first time. Click
**More info → Run anyway**. The full source is here if you'd rather build it yourself.

### First run

Vault scans automatically the first time it opens. Most people don't need to configure anything.

Two optional settings make it better:

- **SteamGridDB API key** (Settings → Artwork). A
  [free key](https://www.steamgriddb.com/profile/preferences/api) unlocks cover art for emulator
  and non-Steam games. Without it, Vault only searches the Steam store, which covers PC games.
- **Watched folders** (Settings → Watched Folders). Point Vault at a folder of DRM-free or
  portable games and it will pick up the executables.

A Steam Web API key is *not* required. It only adds games you own but have never installed or
launched on this machine.

### Living in the tray

Vault is meant to stay running so your library is always one click away, rather than something
you launch and wait for.

- **Closing the window hides Vault in the notification area** instead of quitting. Click the tray
  icon to bring it back, or right-click it for *Open Vault*, *Rescan Library* and *Quit Vault*.
- **Windows 11 hides new tray icons by default.** If you don't see Vault's bolt, click the `^`
  chevron next to the clock, then drag the icon out to keep it visible.
- **Settings → Startup & Tray** turns this off if you'd rather Vault quit on close, and lets you
  start Vault with Windows, optionally straight into the tray so it never interrupts your login.
- Launching Vault again while it's in the tray brings the existing window forward. It never opens
  twice.

### Build from source

You'll need [Node.js](https://nodejs.org/) 18 or newer.

```bash
git clone https://github.com/alyaanj-ux/vault.git
cd vault
npm install
npm run dev      # compile, bundle, and launch
npm run build    # produce the installer in release/
```

`npm run build` writes a single self-contained `Vault-Setup-<version>.exe` into `release/`.

On Windows, electron-builder unpacks a signing toolchain containing macOS symlinks, and creating
those needs a privilege normal accounts don't have. If the build stops with `Cannot create
symbolic link`, either turn on Windows **Developer Mode**, or pre-extract the cached archive
without the macOS files:

```bash
7za x "<cache>/winCodeSign/<hash>.7z" -o"<cache>/winCodeSign/winCodeSign-2.6.0" -xr'!darwin'
```

where `<cache>` is `%LOCALAPPDATA%/electron-builder/Cache`.

---

## How it works

Vault is an Electron app split into a main process that does all the reading, and a renderer
that only draws. The renderer has no filesystem or network access at all; it talks to the main
process over a narrow, explicitly-listed bridge.

```
src/
  main/            Everything that touches disk, registry or network
    index.ts       App lifecycle and IPC handlers
    preload.ts     The contextBridge — the only surface the UI can call
    library.ts     Merge, de-duplicate and persist the library
    settings.ts    Settings persistence
    findExe.ts     Picks a game's real executable out of a folder full of them
    tray.ts        System tray icon and menu
    scraper.ts     Cover art lookup and caching
    appinfo.ts     Reads Steam's binary metadata cache
    sfo.ts         Reads PlayStation PARAM.SFO title data
    scanners/      One file per platform
  renderer/        UI only — no Node access
  shared/          Types used by both sides
```

### Scanning

Each scanner is independent and must never throw; a launcher you don't have installed simply
returns nothing. Results are merged by a stable per-game ID, so rescanning preserves your hidden
flags, playtime and hand-picked artwork.

A scan returns as soon as the games are known. Slower work — extracting icons, downloading
artwork — happens afterwards in the background and streams into the UI as it completes, so the
window never sits there empty.

### Getting names for games you haven't installed

This is the part that lets the Uninstalled tab work without an API key. Steam keeps a record of
every app your account has installed, launched or configured in `localconfig.vdf`, and a cache of
store metadata in `appinfo.vdf`. The second file is an undocumented binary format that Valve
revises every few years, so Vault ships its own parser that handles the current revision and the
two before it. If the format changes again, name lookup degrades to nothing rather than breaking
the app.

### Launching

Different platforms need genuinely different treatment, and getting this wrong is why games
"don't start" in other library managers:

- **Steam** always goes through `steam://rungameid/<id>`, never a raw executable. That is what
  makes anti-cheat, wrapped launchers and renamed games work.
- **Xbox** goes through the package identity via the shell, because running a packaged game's
  executable directly bypasses its licensing container.
- **Emulators** are started with the ROM as an argument and their own folder as the working
  directory, which portable emulator builds need to find their config.

### Cover art

Art is looked up by cleaned title against SteamGridDB first, then the Steam store, and cached
locally so it's only fetched once. Matching uses a bigram similarity score with a deliberate
guard against sequels and sub-titles, so "Portal" never picks up *Portal 2*'s banner and
"Minecraft" never picks up *Minecraft Dungeons*'. When the automatic match is wrong anyway,
right-click the game and search again with a corrected title.

### Where your data lives

```
%APPDATA%\Vault\library.json    your game library
%APPDATA%\Vault\settings.json   your settings
%APPDATA%\Vault\art\            cached cover art
```

Delete that folder to reset Vault completely. It never writes anywhere else.

---

## Known limitations

These are deliberate. Each one is a case where the "proper" approach is less reliable than the
fallback, and the reasoning is documented in the source.

- **Xbox / Game Pass** games are sandboxed in encrypted packages. Enumerating them properly needs
  native Windows SDK bindings that can't ship in a portable Electron app, so Vault reads the
  `XboxGames` folder instead. Games installed elsewhere won't appear.
- **Battle.net** stores its library in an undocumented database that breaks on client updates.
  Vault parses the JSON config and the default install directory instead.
- **GOG** uses a SQLite database with a version-shifting schema, so Vault uses the registry.
- **shadPS4** keeps no persistent game list; Vault scans the configured install directories.
- A handful of Steam cover images 404 for games whose local cache holds only newer hashed files.
  The card falls back to a placeholder and the scraper can fill it in.

---

## Contributing

Issues and pull requests are welcome. A few conventions worth knowing before you start:

- All filesystem, registry and network access belongs in the main process. The renderer talks
  through `window.vault` and nothing else.
- Every scanner returns `Game[]` and must not throw. Wrap risky IO and log the failure.
- If a platform can't be detected reliably, implement the best available method and leave a
  comment explaining the limitation rather than failing silently.
- No TODOs or placeholders in committed code.

`CLAUDE.md` in the repo root has deeper implementation notes, including the exact file formats
each scanner reads and the reasoning behind the fallbacks.

---

## License

MIT — see [LICENSE](LICENSE).

Vault is not affiliated with Valve, Epic Games, GOG, Electronic Arts, Ubisoft, Blizzard,
Microsoft, or any emulator project. All trademarks belong to their respective owners.
