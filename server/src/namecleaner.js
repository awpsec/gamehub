// Turns release/torrent names into a searchable game title.
//   "Elden.Ring.Shadow.of.the.Erdtree.v1.12-RUNE"      -> "Elden Ring Shadow of the Erdtree"
//   "Cyberpunk 2077 [FitGirl Repack] (2020)"           -> "Cyberpunk 2077" (year hint 2020)
//   "The.Witcher.3.Wild.Hunt.GOTY.MULTi14-ElAmigos"    -> "The Witcher 3 Wild Hunt GOTY"

const RELEASE_GROUPS = new Set([
  'fitgirl', 'dodi', 'codex', 'plaza', 'skidrow', 'empress', 'elamigos',
  'rune', 'tenoke', 'flt', 'razor1911', 'cpy', 'reloaded', 'hoodlum',
  'prophet', 'steamrip', 'gog', 'kaos', 'chronos', 'tinyiso', 'anomaly',
  'simplex', 'i_know', 'masquerade', 'onlinefix', 'goldberg', 'p2p',
]);

const JUNK_TOKENS = new Set([
  'repack', 'repacks', 'proper', 'update', 'updates', 'updated', 'hotfix',
  'patch', 'dlc', 'dlcs', 'incl', 'included', 'including', 'bonus', 'ost',
  'soundtrack', 'crack', 'crackfix', 'cracked', 'nocrack', 'drmfree', 'drm',
  'x64', 'x86', 'win64', 'win32', 'windows', 'pc', 'eng', 'rus', 'multi',
  'multilang', 'multilanguage', 'selective', 'language', 'languages',
  'iso', 'rip', 'portable', 'setup', 'installer', 'full', 'unlocked',
  'digital', 'deluxe?', // note: 'deluxe' alone is often part of the real title; handled below
]);
JUNK_TOKENS.delete('deluxe?');

// tokens that mark "everything from here on is junk"
function isCutToken(tok) {
  const t = tok.toLowerCase();
  if (RELEASE_GROUPS.has(t)) return true;
  if (JUNK_TOKENS.has(t)) return true;
  if (/^v\d+(\.\d+)*[a-z]?$/.test(t)) return true;      // v1.04, v2
  if (/^multi\d+$/.test(t)) return true;                 // MULTi12
  if (/^build\d*$/.test(t)) return true;                 // Build, Build12345
  if (/^b\d{4,}$/.test(t)) return true;                  // b12345
  return false;
}

const ARCHIVE_EXT = /\.(zip|rar|7z|iso|nsp|xci|exe|msi|tar|gz|001)$/i;

export function cleanName(rawName) {
  let name = rawName;
  // strip file extension(s)
  while (ARCHIVE_EXT.test(name)) name = name.replace(ARCHIVE_EXT, '');

  let hintYear = null;

  // capture a year inside (...) or [...] before stripping bracketed content
  const bracketed = name.match(/[([][^)\]]*[)\]]/g) || [];
  for (const b of bracketed) {
    const y = b.match(/\b(19[7-9]\d|20[0-2]\d)\b/);
    if (y) hintYear = parseInt(y[1], 10);
  }
  name = name.replace(/[([][^)\]]*[)\]]/g, ' ');

  // strip a trailing "-GROUP" suffix (scene style) — but never roman numerals
  // or plain numbers, which are part of the title ("Skyve CS-II")
  name = name.replace(/-[A-Za-z0-9_]+$/, (m) => {
    const t = m.slice(1).toLowerCase();
    if (/^(\d+|i{1,3}|iv|vi{0,3}|ix|xi{0,3})$/.test(t)) return ' ' + m.slice(1);
    return RELEASE_GROUPS.has(t) || t.length <= 12 ? ' ' : m;
  });

  // tokenize on separators
  const tokens = name.split(/[\s._]+/).filter(Boolean);
  const kept = [];
  for (const tok of tokens) {
    if (kept.length > 0 && isCutToken(tok)) break;
    // standalone trailing year token -> hint, then stop
    if (kept.length > 0 && /^(19[7-9]\d|20[0-2]\d)$/.test(tok)) {
      hintYear = hintYear || parseInt(tok, 10);
      break;
    }
    kept.push(tok);
  }

  const clean = kept.join(' ').replace(/\s+/g, ' ').trim();
  return { clean: clean || rawName, hintYear };
}

// --- similarity scoring (Sørensen–Dice over character bigrams) ---

const ROMAN = { ii: '2', iii: '3', iv: '4', v: '5', vi: '6', vii: '7', viii: '8', ix: '9' };

function normalize(s) {
  return s
    .replace(/[™®©]/g, '') // BEFORE NFKD — it decomposes ™ into the letters "tm"
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics: Ragnarök -> Ragnarok
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .replace(/\bgoty\b/g, ' game of the year ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .map((tok) => ROMAN[tok] || tok) // Crusader Kings III <-> Crusader Kings 3
    .join(' ');
}

// words that mark an *edition* of the same game rather than a different game.
// Sequel markers (numbers, roman numerals) are deliberately absent so
// "Hades" never gets boosted toward "Hades II".
const EDITION_TOKENS = new Set([
  'director', 'directors', 'cut', 'edition', 'definitive', 'complete',
  'enhanced', 'remastered', 'remaster', 'deluxe', 'ultimate', 'gold',
  'goty', 'game', 'of', 'the', 'year', 'anniversary', 'legendary',
  'royal', 'special', 'hd', 'intergrade', 'redux',
]);

// the set of number tokens in a title — "hades 2" -> "2", "hades" -> "".
// Differing signatures almost always mean different games in a series.
export function numberSignature(s) {
  return normalize(s)
    .split(' ')
    .filter((t) => /^\d+$/.test(t))
    .sort()
    .join(',');
}

// true when one title is the other plus only edition words:
// "Ghost of Tsushima" vs "Ghost of Tsushima DIRECTOR'S CUT"
export function isEditionVariant(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb || na === nb) return false;
  const [short, long] = na.length < nb.length ? [na, nb] : [nb, na];
  if (!long.startsWith(short + ' ')) return false;
  const extra = long.slice(short.length).trim().split(' ');
  return extra.every((t) => EDITION_TOKENS.has(t));
}

function bigrams(s) {
  const t = s.replace(/ /g, '');
  const out = [];
  for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
  return out;
}

export function similarity(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const A = bigrams(na);
  const B = bigrams(nb);
  if (A.length === 0 || B.length === 0) return 0;
  const counts = new Map();
  for (const g of A) counts.set(g, (counts.get(g) || 0) + 1);
  let inter = 0;
  for (const g of B) {
    const c = counts.get(g) || 0;
    if (c > 0) {
      inter++;
      counts.set(g, c - 1);
    }
  }
  return (2 * inter) / (A.length + B.length);
}
