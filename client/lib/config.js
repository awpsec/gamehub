const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const DEFAULTS = {
  // 'remote' = connect to a Gamehub server; 'local' = run the server in-process
  // against a library folder on THIS PC, no separate server needed (serverless).
  mode: 'remote',
  libraryDir: '', // local mode: the folder you torrent games into
  serverUrl: 'http://localhost:8686',
  apiKey: '',
  authToken: '',
  username: '',
  gamesDir: '',
  gamesDirs: [], // additional install locations offered in the install picker
  showSteamPrices: true, // show current Steam store prices in the UI
  deleteArchivesAfterExtract: true,
  createDesktopShortcut: true,
  createStartMenuShortcut: true,
  // QoL: re-center a game's window on launch if it opens windowed in an
  // awkward spot. Best-effort, Windows only; set false to disable.
  centerGameWindow: true,
  // Linux groundwork (inert on Windows): how to wrap Windows exes on a Linux
  // host — 'wine' | 'proton' | 'umu'. See lib/platform.js TODO(linux).
  linuxRunner: 'wine',
};

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function loadConfig() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(configPath(), 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
}

function installedPath() {
  return path.join(app.getPath('userData'), 'installed.json');
}

function myLibraryPath() {
  return path.join(app.getPath('userData'), 'library.json');
}

function loadMyLibrary() {
  try {
    const list = JSON.parse(fs.readFileSync(myLibraryPath(), 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function saveMyLibrary(list) {
  fs.writeFileSync(myLibraryPath(), JSON.stringify(list, null, 2));
}

function loadInstalled() {
  try {
    return JSON.parse(fs.readFileSync(installedPath(), 'utf8'));
  } catch {
    return {};
  }
}

function saveInstalled(data) {
  fs.writeFileSync(installedPath(), JSON.stringify(data, null, 2));
}

function jsonFile(name, fallback) {
  const fresh = () => (Array.isArray(fallback) ? [...fallback] : { ...fallback });
  return {
    load() {
      try {
        const v = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), name), 'utf8'));
        // shape must match the fallback — a malformed file must never crash the UI
        if (Array.isArray(fallback)) return Array.isArray(v) ? v : fresh();
        return v && typeof v === 'object' && !Array.isArray(v) ? v : fresh();
      } catch {
        return fresh();
      }
    },
    save(data) {
      fs.writeFileSync(path.join(app.getPath('userData'), name), JSON.stringify(data, null, 2));
    },
  };
}

const favoritesFile = jsonFile('favorites.json', []);
const playtimeFile = jsonFile('playtime.json', {}); // { gameId: { seconds, lastPlayed } }
// Steam-style collections: ordered custom categories (a game may be in many),
// plus remembered collapse state per group. { categories:[{id,name,games:[]}], collapsed:{key:bool} }
const categoriesFile = jsonFile('categories.json', { categories: [], collapsed: {} });

module.exports = {
  loadConfig, saveConfig, loadInstalled, saveInstalled, loadMyLibrary, saveMyLibrary,
  loadFavorites: favoritesFile.load, saveFavorites: favoritesFile.save,
  loadPlaytime: playtimeFile.load, savePlaytime: playtimeFile.save,
  loadCategories: categoriesFile.load, saveCategories: categoriesFile.save,
};
