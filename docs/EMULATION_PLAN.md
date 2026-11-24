# Emulation in Gamehub — implementation plan

**Goal:** console games sit in the same Store and Library as PC games. Install
downloads them like anything else. The primary button becomes
**Set up emulator** until an emulator is chosen, then **Play** launches the game
in that emulator from inside Gamehub, with playtime tracking, shortcuts, the
overlay and sorting, just like a PC game. Every game shows a platform badge
(Switch, Wii, PS2…).

Already in place: the server tags `.nsp`/`.xci` folders as `switch-rom`, and
the client copies them into `Switch/<title>` (`mode: 'rom'`). That gets
generalised below.

---

## 1. How we recognise the platform

Detection runs on the **server scanner**, so the Store can show badges and
filters before anything is downloaded. The **client re-checks** after download,
since an archive's contents are only certain once unpacked. Checks go from
strongest to weakest: **magic bytes / header → file extension → folder layout
→ release name tags** (`[Switch]`, `NSW`, `PS2`, `-VENOM`…). File extension
alone is never trusted for `.iso`, `.bin` or `.chd`.

| Platform | Files | Definitive check | ID we can read (for metadata) |
|---|---|---|---|
| **Switch** | `.nsp` `.nsz` `.xci` `.xcz` | NSP: `PFS0` at 0; XCI: `HEAD` at 0x100 | Title ID from the file name / PFS0 entries (`…000` base, `…800` update, DLC IDs) |
| **Wii** | `.iso` `.wbfs` `.rvz` `.wia` `.gcz` | `0x5D1C9EA3` at 0x18 (ISO), `WBFS` at 0, `RVZ\x01` at 0 | 6-char game ID at 0 (e.g. `RMGE01`) |
| **GameCube** | `.iso` `.gcm` `.rvz` `.ciso` | `0xC2339F3D` at 0x1C | 6-char game ID at 0 |
| **Wii U** | `.wua` `.wux` `.wud`, or a `code/ content/ meta/` folder | WUA archive header / `meta/meta.xml` | Title ID from `meta.xml` |
| **PS1** | `.cue`+`.bin` `.chd` `.pbp` `.m3u` | `SYSTEM.CNF` with `BOOT =` (inside the ISO9660) | Serial (`SLUS_005.94`) |
| **PS2** | `.iso` `.chd` `.cso` `.zso` | `SYSTEM.CNF` with `BOOT2 =` | Serial (`SLUS_209.46`) |
| **PSP** | `.iso` `.cso` `.pbp` | `PSP_GAME/PARAM.SFO` / `UMD_DATA.BIN` | `DISC_ID` from PARAM.SFO |
| **PS3** | folder with `PS3_GAME/PARAM.SFO`, `.iso`, `.pkg` | PARAM.SFO / `PS3_DISC.SFB` | `TITLE_ID` (`BLUS30443`) |
| **3DS** | `.3ds` `.cci` `.cia` `.3dsx` | `NCSD` at 0x100 / CIA header | Title ID |
| **DS** | `.nds` `.dsi` | Header CRC + logo at 0xC0 | Game code at 0xC |
| **GBA / GB / GBC** | `.gba` `.gb` `.gbc` | Nintendo logo at 0x04 (GBA) / 0x104 (GB) | Game code / title in header |
| **N64** | `.z64` `.n64` `.v64` | `80 37 12 40` / byte-swapped variants | Game code at 0x3B |
| **SNES / NES** | `.sfc` `.smc` / `.nes` | `NES\x1A` (NES); SNES internal header | Internal title |
| **Genesis / Mega Drive** | `.md` `.gen` `.bin` | `SEGA` at 0x100 | Product code |
| **Dreamcast** | `.gdi` `.cdi` `.chd` | `SEGA SEGAKATANA` in IP.BIN | Product number |
| **Xbox / Xbox 360** | `.iso` (XISO) / `.iso` `.xex` `GOD` folders | `MICROSOFT*XBOX*MEDIA` at 0x10000 | Title ID (from XEX) |

* `.iso` is the tricky one: a PC scene ISO (the RUNE case) and a PS2/Wii ISO
  share the extension. The header checks above decide. Only "no console header
  found" falls through to the PC pipeline we already have.
* Multi-disc (PS1/PS2/Dreamcast): generate an `.m3u` playlist and launch that,
  so disc swaps work.
* Switch packages often bundle base + update + DLC. The title-ID suffix tells
  them apart. The base game is what we launch; updates and DLC get registered
  with the emulator (§4).
* **New module:** `server/src/platforms.js` (`detectPlatform(entryPath) →
  { platform, confidence, ids }`), shared by the scanner and the client
  (`client/lib/platforms.js` re-exports it via the embedded server copy). Reads
  at most a few KB per file, same as the installer fingerprinting.

## 2. Metadata for console games

* Steam is PC-only. For any non-PC platform, matching skips Steam and goes
  **IGDB first**, filtered by platform: IGDB's `platforms` field maps
  one-to-one to our IDs. RAWG is the fallback, and it also has platforms.
* **Exact IDs beat fuzzy names:** a Wii game ID, PS2 serial or Switch title ID
  can be looked up in public title databases (GameTDB for Wii/GC/Wii U/3DS/DS,
  the Redump/PCSX2 game DB for PS1/PS2, a Switch titledb by title ID) to get
  the clean official name *before* the IGDB search. Matches become near-certain.
* **DB:** `games.platform TEXT`, `games.platform_ids TEXT (json)`. API: `GET
  /api/games?platform=switch`.

## 3. Emulator registry

`client/lib/emulators.js` holds one record per emulator: what it plays, where
the official build comes from, the executable on each OS, how to launch a game,
and what the user must supply.

| Platform(s) | Recommended | Alternatives | Launch template (Windows) | User supplies |
|---|---|---|---|---|
| Switch | **Eden** | **Ryujinx** (community fork), Citron | Eden: `eden.exe -f -g "{rom}"` · Ryujinx: `Ryujinx.exe --fullscreen "{rom}"` | `prod.keys` + firmware (dumped from own console) |
| Wii, GameCube | **Dolphin** | — | `Dolphin.exe -b -e "{rom}"` | — |
| Wii U | **Cemu** | — | `Cemu.exe -f -g "{rom}"` | keys for encrypted dumps |
| PS2 | **PCSX2** | — | `pcsx2-qt.exe -batch -fullscreen -- "{rom}"` | PS2 BIOS (own console) |
| PS1 | **DuckStation** | RetroArch (Beetle PSX) | `duckstation-qt.exe -batch -fullscreen "{rom}"` | PS1 BIOS |
| PSP | **PPSSPP** | — | `PPSSPPWindows64.exe --fullscreen "{rom}"` | — |
| PS3 | **RPCS3** | — | `rpcs3.exe --no-gui "{rom}"` | PS3 firmware (official Sony download) |
| 3DS | **Azahar** | — | `azahar.exe "{rom}"` | — (decrypted dumps) |
| DS | **melonDS** | DeSmuME | `melonDS.exe -f "{rom}"` | optional BIOS |
| GBA/GB/GBC | **mGBA** | RetroArch | `mGBA.exe -f "{rom}"` | — |
| NES, SNES, N64, Genesis, Dreamcast… | **RetroArch** + per-platform core | standalone (e.g. Flycast) | `retroarch.exe -f -L cores\{core}.dll "{rom}"` | per-core BIOS where needed |
| Xbox / Xbox 360 | **xemu** / **Xenia Canary** | — | `xemu.exe -dvd_path "{rom}"` / `xenia_canary.exe "{rom}"` | Xbox BIOS + HDD image (xemu) |

* **Gamehub never downloads BIOS, firmware or keys.** Settings shows what each
  platform needs, where to put it (it opens the right folder), and a
  ✓/missing check. Download sources for emulators are each project's
  **official** release page or GitHub releases, pinned by URL pattern and
  verified the same way as our 7-Zip bundle (hash recorded on first fetch,
  signature where the project publishes one).
* Templates, emulator folder names and project sources move over time (Switch
  emulators especially). The registry is a data file, not code, so it can be
  updated without a release; it ships with the client and can be refreshed from
  the server.

## 4. Emulator management (Settings → Emulators)

A new Settings tab, one row per platform that appears in the library:

```
[Switch icon] Nintendo Switch     Emulator: Eden 0.0.3     ✓ keys  ✓ firmware   [Change ▾] [Open folder]
[Wii icon]    Wii / GameCube      Emulator: Dolphin 2412   —                    [Change ▾]
[PS2 icon]    PlayStation 2       Not set up               ✕ BIOS missing       [Set up…]
```

* **Set up…** opens a small sheet:
  * **Install for me**: downloads the official build into
    `C:\Program Files (x86)\Gamehub\emulators\<id>\`. That folder is already
    writable from the one-time grant, so no extra UAC prompt.
  * **I already have it**: auto-detects common installs (Program Files,
    `%APPDATA%`, Scoop, winget; Flatpak/AppImage on Linux) or lets you pick the
    `.exe`.
* Set a default emulator per platform, with an optional **per-game override**
  (game page → Options → *Play with…*).
* Update check for emulators Gamehub installed. Each one's portable/user
  folder stays put, so saves and settings survive updates.
* Linux: Flatpak IDs (e.g. `org.DolphinEmu.dolphin-emu`) or AppImages, the same
  registry with a `linux` block.

## 5. Install and play flow

1. **Install** (one click, as now): download → unpack if archived (7-Zip
   already handles `.zip/.7z/.rar`) → detect platform → place under
   `Gamehub\roms\<platform>\<Title>\` → pick the **launch file** (base `.nsp`
   over updates, `.cue/.m3u` over `.bin`, largest disc image…).
   Installed entry: `{ mode: 'rom', platform, romPath, extras: { updates:[], dlc:[] } }`.
2. **Switch updates/DLC:** register them with the emulator instead of making
   the user do it. Ryujinx keeps per-title `updates.json` / `dlc.json` that
   point at files. For Eden, use its add-ons directory if exposed, otherwise
   *Install files to NAND* on first launch with a clear one-step prompt.
3. **Primary button**, by state:
   * not installed → **Install**
   * installed, platform has no emulator → **Set up emulator** (opens the
     sheet above, pre-filtered to that platform; when done it becomes Play)
   * installed, emulator set but BIOS/keys missing → **Finish setup** (says
     exactly what's missing)
   * ready → **Play** → launches `{emulator} {args}` from the template. Process
     tracking, playtime, the Shift+Tab overlay and screenshots work as for PC
     games. Shortcuts point at Gamehub's "launch game N" handler.
4. **Uninstall** removes the ROM folder. Saves live in the emulator's own save
   folder and are never touched. "Back up saves" can be added per emulator
   later, since the registry knows each save path.

## 6. UI

* **Platform badges:** a small monochrome glyph + short label (`Switch`,
  `Wii`, `PS2`, `GBA`…) on Store cards (top-left, opposite the NEW badge), in
  Library rows (left of the title) and in the game-page meta line ("Switch ·
  2019 · 13.4 GB"). PC games show nothing, or a Windows glyph if the library is
  mixed. These are **our own simple glyphs and wordmarks, not the companies'
  logos** (trademarks). One SVG sprite, `currentColor`, sized via `.i` (the
  2.1.1 lesson: every icon gets an explicit size).
* **Store:** a platform filter row ("All · PC · Switch · Wii · PS2 …", only
  platforms that exist on the server) plus "Platform" in sort/group.
* **Library:** *Group by platform* option (collapsible sections with counts),
  platform filter chip, and sort by platform.
* **Game page:** "Plays with: Eden" line under the buttons, *Play with…* in
  Options, and setup status ("Keys missing → Open folder") inline.
* **Settings → Emulators** as above.
* Empty/edge states: "No emulator for PS3 yet — Set up", "This Switch game
  needs firmware", and "Unknown platform: pick one" (rare, manual tag).

## 7. Testing (proving it works, not just that it's written)

* **Unit:** platform detection with synthetic headers for every format in §1,
  plus the `.iso` disambiguation (a PC scene ISO must stay PC). Launch-template
  building (paths with spaces, per-game override). Launch-file choice (base vs
  update `.nsp`, `.cue` over `.bin`, `.m3u` generation).
* **E2E on Windows CI:** using legal **homebrew** test ROMs (public-domain
  NES/GBA/N64 homebrew and Wii homebrew; synthetic-header files for Switch),
  the packaged app installs the ROM, auto-installs mGBA/Dolphin from the
  official builds, presses Play, and checks the emulator process starts with
  the right file. A short-lived window screenshot is attached as an artifact.
* **UI audit + mutation check** extended to the new states (badges, Set up
  emulator, Emulators tab), same as today.

## 8. Order of work

| Phase | Scope | Size |
|---|---|---|
| 1 | Platform detection (server + client), DB column, Store/Library badges, platform filter/group/sort | medium |
| 2 | Emulator registry + Settings → Emulators (detect existing / pick exe), **Set up emulator → Play** for Switch, Wii/GC, PS2, PS1, PSP, GBA | medium-large |
| 3 | "Install for me" (official-build downloads), emulator updates, IGDB platform-aware matching + ID-based title DBs | medium |
| 4 | Switch updates/DLC registration, multi-disc `.m3u`, per-game emulator override, Linux Flatpak/AppImage | medium |
| 5 | RetroArch cores for retro platforms, PS3/Xbox/360/Wii U, save backup per emulator | medium |

## 9. Decisions needed from you

1. **Which platforms first?** The suggestion above is Switch + Wii/GC + PS2 +
   PS1 + PSP + GBA.
2. **Switch emulator defaults:** Eden as the default with Ryujinx offered, or
   the other way round?
3. **Auto-download emulators**, or only detect/point at existing installs to
   begin with?
4. **Retro platforms:** RetroArch (one app, many cores) or standalone
   emulators per platform?
