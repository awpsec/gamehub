// Fingerprint installer engines from the file itself — never from group names,
// folder layout, or setup.exe alone. Two independent signals for Inno/NSIS:
// (1) PE/version-info style UTF-16 markers, (2) ASCII engine banners in the
// binary. v1 only marks high-confidence Inno as automatable.
const fs = require('node:fs');
const path = require('node:path');

const SCAN_BYTES = 4 * 1024 * 1024; // bounded read — enough for PE + overlays

const ENGINES = {
  inno: {
    id: 'inno',
    label: 'Inno Setup',
    automatable: true, // v1
    ascii: [
      'Inno Setup',
      'InnoSetupLdr',
      'Inno Setup Setup Data',
      'JR.Software',
      'This installation was built with Inno Setup',
    ],
    // UTF-16LE encodings of key phrases (VERSIONINFO / resources)
    utf16: ['Inno Setup', 'InnoSetup'],
  },
  nsis: {
    id: 'nsis',
    label: 'NSIS',
    automatable: false, // after proven elevation/arg behavior
    ascii: ['NullsoftInst', 'Nullsoft Install System', 'NSIS Error'],
    utf16: ['Nullsoft Install System'],
  },
};

function readHead(filePath, max = SCAN_BYTES) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const st = fs.fstatSync(fd);
    const size = Math.min(st.size, max);
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, 0);
    return { buf, size: st.size };
  } finally {
    fs.closeSync(fd);
  }
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

function countHits(buf, needles) {
  const hits = [];
  for (const n of needles) {
    if (buf.includes(Buffer.isBuffer(n) ? n : Buffer.from(n, 'utf8'))) hits.push(String(n));
  }
  return hits;
}

function scoreEngine(buf, def) {
  const evidence = [];
  const asciiHits = countHits(buf, def.ascii);
  for (const h of asciiHits) evidence.push(`ascii:${h}`);
  const utf16Needles = (def.utf16 || []).map(toUtf16le);
  const utf16Hits = countHits(buf, utf16Needles);
  for (const h of utf16Hits) evidence.push(`utf16:${h}`);

  // Two independent signal classes: ASCII banner vs UTF-16 resource text.
  const asciiScore = asciiHits.length > 0 ? 1 : 0;
  const utf16Score = utf16Hits.length > 0 ? 1 : 0;
  const signals = asciiScore + utf16Score;
  let confidence = 'none';
  if (signals >= 2 || asciiHits.length >= 2) confidence = 'high';
  else if (signals === 1) confidence = 'medium';
  return { confidence, evidence, signals };
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

  let head;
  try {
    head = readHead(filePath);
  } catch (err) {
    result.evidence.push(`read-error:${err.message}`);
    return result;
  }
  const { buf } = head;

  if (isMsi(buf, filePath)) {
    return {
      ...result,
      engine: 'msi',
      engineLabel: 'Windows Installer (MSI)',
      confidence: 'high',
      evidence: [/\.msi$/i.test(base) ? 'extension:msi' : 'magic:ole'],
      support: 'detect-only', // no reliable universal DIR property
    };
  }

  const pe = isPe(buf);
  if (pe) result.evidence.push('pe:mz');

  // Score Inno and NSIS; pick the stronger match.
  let best = null;
  for (const def of Object.values(ENGINES)) {
    const scored = scoreEngine(buf, def);
    if (scored.confidence === 'none') continue;
    if (!best
      || (scored.confidence === 'high' && best.confidence !== 'high')
      || (scored.signals > best.signals)) {
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
      path: filePath,
    };
  }

  if (pe) {
    result.evidence.push('pe-unrecognized');
    result.confidence = 'low';
  }
  return result;
}

module.exports = {
  fingerprintInstaller,
  SCAN_BYTES,
  ENGINES,
  isPe,
  isMsi,
  readHead,
};
