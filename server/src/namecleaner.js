// Turns release/torrent names into a searchable game title.
//   "Elden.Ring.Shadow.of.the.Erdtree.v1.12-RUNE"      -> "Elden Ring Shadow of the Erdtree"
//   "Cyberpunk 2077 [FitGirl Repack] (2020)"           -> "Cyberpunk 2077" (year hint 2020)
//   "The.Witcher.3.Wild.Hunt.GOTY.MULTi14-ElAmigos"    -> "The Witcher 3 Wild Hunt GOTY"
//   "RimWorldRoyalty1-1-2647Win64.zip"                 -> "RimWorld Royalty"
//   "RedDeadRedemption2-CODEX"                         -> "Red Dead Redemption 2"

const RELEASE_GROUPS = new Set([
  'fitgirl', 'dodi', 'codex', 'plaza', 'skidrow', 'empress', 'elamigos',
  'rune', 'tenoke', 'flt', 'razor1911', 'cpy', 'reloaded', 'hoodlum',
  'prophet', 'steamrip', 'gog', 'kaos', 'chronos', 'tinyiso', 'anomaly',
  'simplex', 'i_know', 'masquerade', 'onlinefix', 'goldberg', 'p2p',
  'voices38', 'doge', 'seyter', '0xdeadc0de', 'ali213', '3dm', 'darck', 'johncena',
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

// tokens that mark "everything from here on is junk". Release-group names are
// deliberately NOT in here: several are also real title words (ANOMALY the
// group vs RimWorld "Anomaly" the DLC, RUNE vs the game "Rune", CHRONOS…) —
// cutting on them mid-title eats the title. Groups only ever appear as name
// TAILS, so they're stripped backward from the end instead (see cleanName).
function isCutToken(tok) {
  const t = tok.toLowerCase();
  if (JUNK_TOKENS.has(t)) return true;
  if (/^v\d+(\.\d+)*[a-z]?$/.test(t)) return true;      // v1.04, v2
  if (/^multi\d+$/.test(t)) return true;                 // MULTi12
  if (/^build\d*$/.test(t)) return true;                 // Build, Build12345
  if (/^b\d{4,}$/.test(t)) return true;                  // b12345
  // Digits glued to a platform token: "2647Win64", "12345x64"
  if (/^\d*(win64|win32|x64|x86)$/i.test(t)) return true;
  // scene releaser handle: letters immediately followed by digits (voices38,
  // razor1911, ali213). Only ever cut mid-stream (never the first kept token),
  // so a real leading title like "PES2021" survives.
  if (/^[a-z]{3,}\d{1,4}$/.test(t)) return true;
  return false;
}

// Group names that can double as REAL title words ("RimWorld Anomaly" vs the
// ANOMALY group; the games "Rune", "Chronos"…). These only strip in the
// unambiguous scene form: the release's SINGLE group tag, written ALL-CAPS.
// Everything else in RELEASE_GROUPS is distinctive (FitGirl, TENOKE, voices38)
// and strips from the tail in any case.
const AMBIGUOUS_GROUPS = new Set([
  'anomaly', 'rune', 'chronos', 'empress', 'prophet', 'plaza', 'masquerade',
  'doge', 'kaos', 'reloaded', 'codex', 'simplex', 'flt', 'p2p', 'darck',
]);

// Strip releaser/junk tokens from the END of the token list.
function stripTailTokens(tokens, groupTagSeen) {
  while (tokens.length > 1) {
    const last = tokens[tokens.length - 1];
    if (isCutToken(last)) { tokens.pop(); continue; }
    if (RELEASE_GROUPS.has(last.toLowerCase())) {
      if (!AMBIGUOUS_GROUPS.has(last.toLowerCase())) { tokens.pop(); groupTagSeen = true; continue; }
      if (!groupTagSeen && /^[A-Z0-9_]+$/.test(last)) { tokens.pop(); groupTagSeen = true; continue; }
    }
    break;
  }
}

// Scene names often glue a version run after the title with no "v" marker:
// "…Royalty 1 1 2647 Win64". When there are 2+ pure-digit tokens, strip the
// trailing digit run only (not junk words — those would eat title numbers like
// Anno "2205" before "Update"). A SINGLE trailing number is kept (sequels /
// title years: "Portal 2", "Cyberpunk 2077"). Also always drop a lone trailing
// 5+ digit Steam-style build id ("Game.Name.365306").
function stripTrailingVersionRun(tokens) {
  while (tokens.length > 1 && /^\d{5,}$/.test(tokens[tokens.length - 1])) {
    tokens.pop();
  }
  const digitCount = tokens.filter((t) => /^\d+$/.test(t)).length;
  if (digitCount < 2) return;
  while (tokens.length > 1 && /^\d+$/.test(tokens[tokens.length - 1])) {
    tokens.pop();
  }
}

// Peel known junk/group SEGMENTS before CamelCase splitting — otherwise
// "FitGirl" → "Fit Girl" and "voices38" → "voices 38", and the releaser
// detectors never see the original token.
function stripKnownJunkSegments(name) {
  // Never peel ambiguous groups here — "Anomaly"/"Rune"/… may be real title words.
  // Those only strip as ALL-CAPS scene tails (handled later by stripTailTokens).
  const groups = [...RELEASE_GROUPS]
    .filter((g) => !AMBIGUOUS_GROUPS.has(g))
    .map((g) => g.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/_/g, '[_]?'))
    .join('|');
  name = name.replace(new RegExp(`(?:^|[._\\s-])(?:${groups})(?=[._\\s-]|$)`, 'gi'), ' ');
  name = name.replace(/(?:^|[._\s-])(?:multi\d+|repacks?|dlcs?|win64|win32|x64|x86)(?=[._\s-]|$)/gi, ' ');
  return name;
}

// Single CamelCase tokens that are ONE brand / title word. Splitting these into
// "Rim World" still often finds Steam results, but it also confuses display and
// some providers — keep them intact. Multi-word CamelCase titles
// (RedDeadRedemption, AgeOfMythology) are intentionally NOT listed so they split.
const COMPOUND_TITLE_WORDS = [
  'RimWorld', 'StarCraft', 'WarCraft', 'Warcraft', 'BioShock', 'DeadSpace',
  'DarkSouls', 'CounterStrike', 'BattleField', 'Battlefield', 'NoMansSky',
  'MountAndBlade', 'HalfLife', 'TeamFortress', 'Left4Dead', 'Portal2',
].sort((a, b) => b.length - a.length);

// Unpack scene-style concatenation before tokenizing:
//   RimWorldRoyalty1-1-2647Win64 → RimWorld Royalty 1 1 2647 Win64
//   RedDeadRedemption2           → Red Dead Redemption 2
//   TheWitcher3WildHuntGOTY      → The Witcher 3 Wild Hunt GOTY
function splitConcatenatedName(name) {
  // Shield tokens the digit/letter splitter would otherwise shred. Use Unicode
  // private-use markers so the splitter's [A-Za-z]/d patterns can't touch them.
  const shielded = [];
  const shield = (m) => {
    shielded.push(m);
    return `\uE000${shielded.length - 1}\uE001`;
  };
  for (const w of COMPOUND_TITLE_WORDS) {
    const re = new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    name = name.replace(re, (m, offset, str) => {
      const token = shield(m);
      // Concatenated title continues after the brand (RimWorldRoyalty → RimWorld Royalty).
      // Dotted/spaced forms already have a separator — leave those alone.
      const next = str[offset + m.length];
      if (next && /[A-Za-z0-9]/.test(next)) return `${token} `;
      return token;
    });
  }
  name = name
    .replace(/Win64|Win32|x64|x86/gi, shield)
    .replace(/[vV]\d+(?:\.\d+)*[a-zA-Z]?/g, shield);

  name = name
    .replace(/([a-z])([A-Z])/g, '$1 $2')             // aB → a B
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')       // HTMLParser → HTML Parser
    .replace(/([A-Za-z])(\d)/g, '$1 $2')             // Royalty1 → Royalty 1 ; GTA5 → GTA 5
    .replace(/(\d)([A-Za-z])/g, '$1 $2');            // 2647Foo → 2647 Foo

  return name.replace(/\uE000(\d+)\uE001/g, (_, i) => shielded[Number(i)]);
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

  // strip a trailing bare version like " 1.01" or " 2.3.4b" (scene names often
  // carry the version without a leading "v"). A lone number with no dot is left
  // alone — it may be a sequel ("Portal 2") or a year.
  name = name.replace(/\s+\d+(\.\d+)+[a-z]?\s*$/i, ' ');

  // strip a trailing "-GROUP" suffix (scene style) — but never roman numerals
  // or plain numbers, which are part of the title ("Skyve CS-II")
  let groupTagSeen = false; // scene names carry ONE group tag — once it's
  // stripped, remaining group-words ("Anomaly", "Rune") are title words
  name = name.replace(/-[A-Za-z0-9_]+$/, (m) => {
    const raw = m.slice(1);
    const t = raw.toLowerCase();
    if (/^(\d+|i{1,3}|iv|vi{0,3}|ix|xi{0,3})$/.test(t)) return ' ' + raw; // numerals/roman are title
    if (RELEASE_GROUPS.has(t)) { groupTagSeen = true; return ' '; }       // known scene group
    // Unknown trailing "-word": scene groups are conventionally UPPERCASE
    // (RUNE, CODEX, TENOKE), so strip an all-caps handle — but KEEP a Title-case
    // or lowercase word, which is part of the title ("Black Myth-Wukong",
    // "Cities-Skylines"). normalize()/searchTerm() turn the dash into a space.
    if (/^[A-Z0-9]{2,12}$/.test(raw)) { groupTagSeen = true; return ' '; }
    return m;
  });

  // Peel known releaser/junk segments while they're still whole tokens, THEN
  // unpack CamelCase / digit boundaries. Hyphens are separators too.
  name = stripKnownJunkSegments(name);
  name = splitConcatenatedName(name);
  const tokens = name.split(/[\s._-]+/).filter(Boolean);
  // An UPDATE/patch package (files to overlay onto an existing install), not a
  // full game. Scene form: the update word sits AFTER the title, immediately
  // followed by its version ("Game.Obsidian.Mirror.Update.v100.19"). The
  // position+adjacency rule keeps real titles safe: "Patch Quest v1.2" (update
  // word first = title) and "The.Big.Update.Game" (no version after) are games.
  const isUpdate = tokens.some(
    (t, i) =>
      i > 0 &&
      /^(update|updates|patch|patches|hotfix)$/i.test(t) &&
      tokens[i + 1] != null &&
      (/^v?\d/i.test(tokens[i + 1]) || /^build\d*$/i.test(tokens[i + 1]))
  );
  stripTailTokens(tokens, groupTagSeen);
  stripTrailingVersionRun(tokens);
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
  return { clean: clean || rawName, hintYear, isUpdate };
}

// A provider-search-friendly form of a title. Steam's storesearch endpoint
// returns ZERO results when the query carries a standalone " - " or other
// punctuation noise ("The Last of Us - Part II Remastered" finds nothing, but
// "The Last of Us Part II Remastered" finds it). Drop trademark marks and
// apostrophes, turn "&" into "and" (both forms match on Steam), and flatten
// every other non-alphanumeric run to a single space.
export function searchTerm(s) {
  return s
    .replace(/[™®©]/g, '')
    .replace(/['’]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
