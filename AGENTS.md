# Gamehub

An "arr for games": a self-hosted **server** (Node/Express + SQLite) that identifies
games in a torrent folder in-place and serves a web UI, plus a Windows **Electron
client** that downloads/installs/plays them. See `README.md` for full product docs.

## Cursor Cloud specific instructions

The startup update script already runs `npm install` in both `server/` and `client/`,
so dependencies are present when a session begins. Notes below are the non-obvious
bits for running things in this Linux cloud VM.

### Services

| Component | Path | Runs on Linux? | How to run (dev) |
|-----------|------|----------------|------------------|
| Server (API + web UI) | `server/` | Yes (fully) | `LIBRARY_DIR=<games> DATA_DIR=<data> PORT=8686 node src/index.js` |
| Client (Electron) | `client/` | Boots only | `npm start` (see caveats) |

### Server (primary, fully testable here)

- Standard scripts live in `server/package.json`: `npm test` (Node built-in runner,
  runs serially) and `npm start`. Tests: 74 pass / 4 skipped (the 4 skips are
  Windows-only elevation cases).
- `npm start` defaults `DATA_DIR=/config` which is not writable here. Run with explicit
  env instead: `LIBRARY_DIR=/tmp/gamehub-library DATA_DIR=/tmp/gamehub-data PORT=8686 node src/index.js`.
- `LIBRARY_DIR` must point at a folder whose **top-level entries are game folders**
  (e.g. `Elden.Ring.v1.12.MULTi14-DODI/`). The scanner matches those names against the
  Steam public API (no key needed) on boot, so outbound network is required for
  metadata/artwork. An empty dir boots fine but matches nothing.
- First browser visit to `http://localhost:8686` creates the admin account
  (`setupRequired` in `GET /api/auth/status`). There is no separate "Library" nav item —
  the **Store** view is the game library.
- SQLite (`better-sqlite3`) is a local file DB; no external DB service to start.

### Client (Electron — Windows-primary)

- Windows-only for the real install/play flow; on Linux it only **boots to the welcome
  screen**. Do not expect download/install/play or `npm run dist` (Windows installer) to
  work here.
- `npm start` runs `sync-server` first (copies `server/src` → `client/embedded`) then
  launches Electron. In this headless VM, Electron needs a display and no sandbox:
  `DISPLAY=:1 npx electron . --no-sandbox`. GPU/dbus errors in the log are non-fatal.
- No lint config exists in this repo (nothing to run for lint).
