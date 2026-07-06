# Gamehub

An **arr for games**: a self-hosted server that identifies the games in your torrent
download folder **in-place** (nothing is ever renamed, moved, or modified — your
torrents keep seeding), plus a Windows client that downloads from the server,
assembles/unpacks whatever format the release came in, installs it, and creates
shortcuts. Steam-like library for your own files.

```
qBittorrent ──▶ NAS games folder (read-only mount, seed-safe)
                      │
                ┌─────▼─────┐   IGDB / RAWG lookups with confidence scores
                │  server   │   auto-match ≥ threshold, else Activity queue
                │ (Docker)  │   web UI: Library + Sonarr-style manual resolve
                └─────┬─────┘
                      │ HTTP downloads (range-supported)
                ┌─────▼─────┐
                │  client   │   download → assemble .partXX.rar / zip / 7z / iso
                │ (Windows) │   → run installer or find game .exe
                └───────────┘   → Desktop + Start Menu shortcuts → Play
```

## Quick start (portable)

1. **Server** — on your Docker host (Debian box / NAS / etc.):
   ```bash
   git clone <this-repo> gamehub && cd gamehub
   # edit docker-compose.yml:
   #   • point the games volume at your qBittorrent completed-downloads folder
   #   • pick the port to expose (the LEFT side), e.g.  "14888:8686"
   docker compose up -d --build
   ```
   The server is now at `http://<host>:<port>`. Open it once in a browser to
   create your **admin account**.

2. **Desktop client** — on your Windows PC: download the latest
   **`Gamehub Setup <version>.exe`** from this repo's [Releases](../../releases)
   and run it. In the app's Settings, set the server URL and sign in.

3. Browse the **Store**, **Add to Library**, and hit **Install**. Done.

> **Over Tailscale:** put the Docker host and your PC on the same tailnet and use
> the host's MagicDNS name as the server URL — e.g. `http://zeddserver:14888` —
> so nothing is exposed to the public internet. The container always listens on
> `8686` internally; the `14888` above is just the host port you mapped.

Everything below is detail.

## How identification works

1. Every top-level folder/file in your library is scanned. Names are cleaned of
   scene/repack noise: `Elden.Ring.Shadow.of.the.Erdtree.v1.12.MULTi14-DODI` →
   `Elden Ring Shadow of the Erdtree`, `(2020)`-style year hints are extracted.
2. The cleaned name is searched against **IGDB** and/or **RAWG** and each candidate
   gets a similarity score (0–100%), with a bonus for a matching release year.
3. Score ≥ `AUTO_MATCH_THRESHOLD` (default **85%**) → auto-matched into the Library.
   Anything lower lands in the **Activity** tab where you pick the right candidate,
   search manually, or ignore it — exactly like Sonarr/Radarr manual import.
4. Items still downloading in qBittorrent (`.!qB` files present) are held as
   *downloading* and identified automatically once complete.

Your files are **never touched**. The library is mounted read-only in Docker.

## Users & sign-in

On first launch the web UI asks you to create an **admin account** (passwords are
scrypt-hashed locally; sessions are 30-day tokens). Manage accounts under
**Settings → Users**: add users, reset passwords, delete; everyone can change
their own password. The desktop client signs in from its Settings (it stores the
session token, never the password). The optional API key remains as a machine
credential for scripts.

## Metadata sources

- **Steam** — *built-in, zero configuration.* Public storefront API, no key or
  registration. Official portrait artwork, descriptions, release dates. Enabled
  out of the box, so a fresh install starts matching immediately.
- **RAWG** *(optional)* — free key at <https://rawg.io/apidocs>. Adds coverage
  beyond Steam's catalog.
- **IGDB** *(optional)* — Twitch app credentials. Best coverage for console
  titles (Switch, etc.) and non-Steam releases.

All managed under **Settings → Metadata Sources**, with a live "Test sources" check.

Matched games get full detail pages: wide artwork, description, **ratings**
(Steam user reviews %, Metacritic, plus IGDB/RAWG scores when configured), and
**compatibility**: OS badges (Windows / Linux native / macOS), a **Linux-via-
Proton tier cited from ProtonDB** community reports for Windows-only titles,
and **minimum/recommended hardware requirements** from Steam. Store cards show
a compact Linux/Proton chip when relevant. Click any Store card in the web UI
to see it — with direct file downloads.

### Linux support status

Compatibility is **cited** today; the Linux install/launch flow is scaffolded
but not implemented. The seam is `client/lib/platform.js` (`launchCommand`,
`supportsShortcuts`, `sevenZipCandidates`) — every host-specific decision goes
through it, and each Linux branch is marked `TODO(linux)` with implementation
notes (wine/proton/umu runners, per-game WINEPREFIX, `.desktop` shortcuts).
`config.linuxRunner` exists (default `wine`, inert on Windows).

## Desktop client: Store & My Library

The Windows app works like Steam: **Store** browses everything on the server —
click a game for the detail view (wide art, ratings, description) and
**Add to Library**. **My Library** holds your picks, where Install downloads,
unpacks, and sets up the game; then Play / Uninstall from there.

## Server setup (Docker — Debian 12/13 host)

If Docker isn't installed yet on the Debian box:

```bash
sudo apt update && sudo apt install -y docker.io docker-compose-plugin
sudo usermod -aG docker $USER   # log out/in afterwards
```

Then:

1. Edit `docker-compose.yml`: change `/path/to/your/nas/games` to your
   qBittorrent completed-downloads folder.
2. `docker compose up -d --build`
3. Open `http://<server>:8686` — Steam matching works immediately with no keys.
   Watch the Activity tab, resolve the stragglers, and your Library builds
   itself. Rescans run every 15 min plus on demand via the ⟳ button.
4. Optional: add RAWG/IGDB keys or an API key under **Settings**.

### Running without Docker

```
cd server && npm install
LIBRARY_DIR=/mnt/games DATA_DIR=./data RAWG_API_KEY=xxx node src/index.js
```

## Client setup (Windows)

**Prebuilt installer (recommended):** grab `Gamehub Setup <version>.exe` from the
[Releases](../../releases) page and run it — a one-click installer that puts
Gamehub in Start Menu + Desktop, registers an uninstaller in Windows Settings,
and keeps your library/settings on upgrade. Nothing else to install.

**Build the installer yourself:**

```
cd client
npm install
npm run dist
```

This produces `client/dist/Gamehub Setup <version>.exe` — the same one-click
installer. Share the setup exe with any PC that should have the client.

**Development mode:**

```
cd client
npm install
npm start
```

First launch opens Settings: point it at `http://<server>:8686`, choose the games
folder where installs should land, done. For each game:

- **Install** downloads all files, assembles multi-part archives, extracts
  RAR/ZIP/7z and disc images, then:
  - if a `setup.exe`/`.msi` is found → **Run Installer** (complete the wizard,
    then click **Select game .exe** so Gamehub can create shortcuts / Play);
  - if it's a portable game → the game exe is auto-detected, shortcuts are
    created, and it's ready to **Play** immediately;
  - `.nsp`/`.xci` payloads are just downloaded into `<games>\Switch\`.
- **Play** launches the game; **✕** uninstalls (runs the game's own uninstaller
  if one exists, removes the unpacked copy and all shortcuts).

> **RAR archives require full [7-Zip](https://www.7-zip.org) installed**
> (`C:\Program Files\7-Zip`). ZIP/7z/ISO work out of the box via the bundled 7za.

## Configuration

Everything is configured in the web UI under **Settings** and stored in the database
(`./data`) — no container restarts needed:

- **General** — auto-match confidence threshold, minimum candidate score, scan interval
- **Library** — the games folder path, with a live accessibility check
- **Metadata Sources** — RAWG / IGDB credentials, live "Test sources", re-run matching
- **Security** — optional API key (`X-Api-Key` on all API/download requests)

The **Errors** tab is actionable: events link straight to where they're fixed
(an unidentified game → its Activity item, a failing source → Settings → Sources,
a bad library path → Settings → Library), can be dismissed individually, and
game-related warnings clear themselves once the game is matched or ignored.

Env vars (`RAWG_API_KEY`, `AUTO_MATCH_THRESHOLD`, `LIBRARY_DIR`, …) still work as
**first-boot defaults** only. `PORT` and `DATA_DIR` remain env-only bootstrap values.

## Notes / current limitations

- One game per **top-level** entry in the library folder (standard for torrents).
- Dependency installers (DirectX, VC++ redists) inside a release are ignored for
  exe detection but not auto-run — run them from the game folder if a game needs them.
- Installer-based games install wherever the wizard puts them; Gamehub tracks the
  exe you select and its uninstaller.
- Playtime tracking, multi-user, and non-Windows clients are not built yet.
