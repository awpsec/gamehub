// Fingerprint installer engines from the file itself — never from group names,
// folder layout, or setup.exe alone.
//
// Signals (independent):
//   1. ASCII banners / SetupLdr magic in the PE or overlay
//   2. UTF-16LE VERSIONINFO / resource strings
//
// Real Inno/FitGirl setup.exe files often keep the definitive
// "Inno Setup Setup Data (x.y.z)" marker in the PE *overlay*, which can sit
// past the first few MB on single-file builds — so we scan HEAD + TAIL.
// Disk-spanning FitGirl packs (setup.exe + .bin) keep the loader stub small;
// SetupLdr magic `rDlPtS…` in the head is definitive on its own.
//
// High-confidence Inno and NSIS are automatable (silent flags proven).
const fs = require('node:fs');
const path = require('node:path');

const SCAN_BYTES = 4 * 1024 * 1024; // per window (head and tail)

// Inno SetupLdr offset-table ID (12 bytes) — definitive when present.
// From Inno source: 'rDlPtS' #$CD#$E6#$D7#$7B#$0B#$2A
const INNO_SETUP_LDR_MAGIC = Buffer.from([
  0x72, 0x44, 0x6c, 0x50, 0x74, 0x53, 0xcd, 0xe6, 0xd7, 0x7b, 0x0b, 0x2a,
]);

const ENGINES = {
  inno: {
    id: 'inno',
    label: 'Inno Setup',
    automatable: true, // v1
    ascii: [
      'Inno Setup Setup Data',
      'Inno Setup Messages',
      'Inno Setup Uninstall Log',
      'InnoSetupLdr',
      'Inno Setup',
      'JR.Software',
      'This installation was built with Inno Setup',
      'My Inno Setup Extensions Setup Data',
    ],
    // Strongest ASCII hits — any one of these + PE ⇒ high confidence
    asciiStrong: [
      'Inno Setup Setup Data',
      'Inno Setup Messages',
      'InnoSetupLdr',
      'My Inno Setup Extensions Setup Data',
    ],
    utf16: ['Inno Setup', 'InnoSetup'],
    magic: [INNO_SETUP_LDR_MAGIC],
  },
  nsis: {
    id: 'nsis',
    label: 'NSIS',
    automatable: true, // /S + unquoted /D= (last arg) — see buildNsisArgs
    ascii: ['NullsoftInst', 'Nullsoft Install System', 'NSIS Error'],
    asciiStrong: ['NullsoftInst', 'Nullsoft Install System'],
    utf16: ['Nullsoft Install System'],
    magic: [],
  },
};

function readWindows(filePath, max = SCAN_BYTES) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const st = fs.fstatSync(fd);
    const size = st.size;
    const headLen = Math.min(size, max);
    const head = Buffer.alloc(headLen);
    fs.readSync(fd, head, 0, headLen, 0);

    let tail = Buffer.alloc(0);
    if (size > max) {
      const tailLen = Math.min(size, max);
      const start = size - tailLen;
      // Avoid double-counting when file is only slightly larger than max
      if (start >= headLen) {
        tail = Buffer.alloc(tailLen);
        fs.readSync(fd, tail, 0, tailLen, start);
      } else {
        // Overlap — just use the full file via a second read of the remainder
        const rem = size - headLen;
        if (rem > 0) {
          tail = Buffer.alloc(rem);
          fs.readSync(fd, tail, 0, rem, headLen);
        }
      }
    }
    return { head, tail, size };
  } finally {
    fs.closeSync(fd);
  }
}

// Back-compat alias used by tests / callers
function readHead(filePath, max = SCAN_BYTES) {
  const { head, size } = readWindows(filePath, max);
  return { buf: head, size };
}

function isPe(buf) {
  if (buf.length < 0x40) return false;
  if (buf[0] !== 0x4d || buf[1] !== 0x5a) return false; // MZ
  const peOff = buf.readUInt32LE(0x3c);
  if (peOff + 4 > buf.length) return false;
  return buf[peOff] === 0x50 && buf[peOff + 1] === 0x45; // PE\0\0
}

function isMsi(buf, filePath) {
  if (/\.msi$/i.test(filePath)) return true;
  // OLE compound document magic (MSI is an OLE file)
  return buf.length >= 8
    && buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0
    && buf[4] === 0xa1 && buf[5] === 0xb1 && buf[6] === 0x1a && buf[7] === 0xe1;
}

function toUtf16le(str) {
  const out = Buffer.alloc(str.length * 2);
  for (let i = 0; i < str.length; i++) out.writeUInt16LE(str.charCodeAt(i), i * 2);
  return out;
}

function findInBuffers(buffers, needle) {
  const n = Buffer.isBuffer(needle) ? needle : Buffer.from(needle, 'utf8');
  for (const buf of buffers) {
    if (buf.length && buf.includes(n)) return true;
  }
  return false;
}

/** True when the PE manifest requests administrator (FitGirl/Inno often do). */
function peRequiresAdmin(buffers) {
  // ASCII manifest XML (common in .rsrc)
  if (findInBuffers(buffers, 'level="requireAdministrator"')) return true;
  if (findInBuffers(buffers, "level='requireAdministrator'")) return true;
  // UTF-16LE resource strings
  if (findInBuffers(buffers, toUtf16le('requireAdministrator'))) return true;
  return false;
}

function countHits(buffers, needles, { labelOf } = {}) {
  const hits = [];
  for (const n of needles) {
    if (findInBuffers(buffers, n)) {
      hits.push(labelOf ? labelOf(n) : (Buffer.isBuffer(n) ? n.toString('latin1') : String(n)));
    }
  }
  return hits;
}

function scoreEngine(buffers, def) {
  const evidence = [];

  const magicHits = countHits(buffers, def.magic || [], {
    labelOf: () => 'SetupLdr',
  });
  for (const h of magicHits) evidence.push(`magic:${h}`);

  const asciiHits = countHits(buffers, def.ascii);
  for (const h of asciiHits) evidence.push(`ascii:${h}`);

  const strongAscii = (def.asciiStrong || []).filter((s) => asciiHits.includes(s));
  const utf16Labels = def.utf16 || [];
  const utf16Needles = utf16Labels.map(toUtf16le);
  const utf16Hits = countHits(buffers, utf16Needles, {
    labelOf: (n) => {
      const i = utf16Needles.indexOf(n);
      // indexOf on buffers is reference equality — map by content instead
      for (let j = 0; j < utf16Needles.length; j++) {
        if (Buffer.isBuffer(n) && n.equals(utf16Needles[j])) return utf16Labels[j];
      }
      return 'utf16';
    },
  });
  for (const h of utf16Hits) evidence.push(`utf16:${h}`);

  // Signal classes: magic (definitive), strong ASCII, weak ASCII, UTF-16
  const hasMagic = magicHits.length > 0;
  const hasStrongAscii = strongAscii.length > 0;
  const hasAscii = asciiHits.length > 0;
  const hasUtf16 = utf16Hits.length > 0;

  let confidence = 'none';
  // SetupLdr magic alone is definitive. Strong ASCII banner alone is nearly so
  // (FitGirl/DODI single-file overlays often only expose the Setup Data marker).
  if (hasMagic || hasStrongAscii || (hasAscii && hasUtf16) || asciiHits.length >= 2) {
    confidence = 'high';
  } else if (hasAscii || hasUtf16) {
    confidence = 'medium';
  }

  const signals = (hasMagic ? 1 : 0) + (hasAscii ? 1 : 0) + (hasUtf16 ? 1 : 0);
  return { confidence, evidence, signals, hasMagic, hasStrongAscii };
}

/**
 * Fingerprint an installer file.
 * @returns {{
 *   engine: 'inno'|'nsis'|'msi'|'batch'|'unknown',
 *   engineLabel: string,
 *   confidence: 'high'|'medium'|'low'|'none',
 *   evidence: string[],
 *   automatable: boolean,
 *   support: 'auto'|'detect-only'|'manual',
 *   path: string,
 *   fileSize?: number,
 * }}
 */
function fingerprintInstaller(filePath) {
  const base = path.basename(filePath || '');
  const result = {
    engine: 'unknown',
    engineLabel: 'Unknown setup',
    confidence: 'none',
    evidence: [],
    automatable: false,
    support: 'manual',
    path: filePath,
  };

  if (!filePath || !fs.existsSync(filePath)) {
    result.evidence.push('missing-file');
    return result;
  }

  // Batch installers (KAOS-style) — detect only, never auto in v1.
  if (/\.(bat|cmd)$/i.test(base)) {
    return {
      ...result,
      engine: 'batch',
      engineLabel: 'Batch setup',
      confidence: 'high',
      evidence: ['extension:bat'],
      support: 'manual',
    };
  }

  let windows;
  try {
    windows = readWindows(filePath);
  } catch (err) {
    result.evidence.push(`read-error:${err.message}`);
    return result;
  }
  const { head, tail, size } = windows;
  result.fileSize = size;
  const buffers = tail.length ? [head, tail] : [head];

  if (isMsi(head, filePath)) {
    return {
      ...result,
      engine: 'msi',
      engineLabel: 'Windows Installer (MSI)',
      confidence: 'high',
      evidence: [/\.msi$/i.test(base) ? 'extension:msi' : 'magic:ole'],
      support: 'detect-only', // no reliable universal DIR property
    };
  }

  const pe = isPe(head);
  const requiresAdmin = peRequiresAdmin(buffers);
  if (pe) result.evidence.push('pe:mz');
  if (requiresAdmin) result.evidence.push('manifest:requireAdministrator');
  if (tail.length) result.evidence.push('scanned:head+tail');

  // Score Inno and NSIS; pick the stronger match.
  let best = null;
  for (const def of Object.values(ENGINES)) {
    const scored = scoreEngine(buffers, def);
    if (scored.confidence === 'none') continue;
    if (!best
      || (scored.confidence === 'high' && best.confidence !== 'high')
      || (scored.signals > best.signals)
      || (scored.hasMagic && !best.hasMagic)) {
      best = { def, ...scored };
    }
  }

  if (best) {
    const automatable = !!(best.def.automatable && best.confidence === 'high' && pe);
    return {
      engine: best.def.id,
      engineLabel: best.def.label,
      confidence: best.confidence,
      evidence: [...result.evidence, ...best.evidence],
      automatable,
      support: automatable ? 'auto' : 'detect-only',
      requiresAdmin,
      path: filePath,
      fileSize: size,
    };
  }

  if (pe) {
    result.evidence.push('pe-unrecognized');
    result.confidence = 'low';
  }
  result.requiresAdmin = requiresAdmin;
  return result;
}

/** Fingerprint from an in-memory buffer (probe script / Range downloads). */
function fingerprintBuffer(buf, filePath = 'setup.exe') {
  const tmpDir = require('node:os').tmpdir();
  const tmp = path.join(tmpDir, `gh-fp-${process.pid}-${Date.now()}-${path.basename(filePath)}`);
  try {
    fs.writeFileSync(tmp, buf);
    return fingerprintInstaller(tmp);
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* */ }
  }
}

module.exports = {
  fingerprintInstaller,
  fingerprintBuffer,
  SCAN_BYTES,
  ENGINES,
  INNO_SETUP_LDR_MAGIC,
  isPe,
  isMsi,
  readHead,
  readWindows,
  peRequiresAdmin,
};
