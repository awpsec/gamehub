#!/usr/bin/env node
/**
 * Probe a live Gamehub server for installer recognition.
 *
 * Usage (on a machine that can reach the server — your Windows PC / Tailscale):
 *   node scripts/probe-silent-installers.mjs http://zeddserver:6767
 *   node scripts/probe-silent-installers.mjs http://zeddserver:6767 --token <authToken>
 *   node scripts/probe-silent-installers.mjs http://zeddserver:6767 --limit 40
 *
 * For each matched game it finds a likely setup.exe / setup.bat via /files,
 * Range-downloads the head+tail (not the whole package), fingerprints it, and
 * prints a table: which engines we'd auto-run vs fall back to the wizard.
 *
 * Never writes to the Store. Temp samples are deleted.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { fingerprintInstaller, SCAN_BYTES, INNO_SETUP_LDR_MAGIC } = require('../lib/fingerprint.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  if (i === -1) return fallback;
  return process.argv[i + 1] ?? fallback;
}
function has(name) { return process.argv.includes(name); }

const baseUrl = (process.argv[2] || '').replace(/\/+$/, '');
if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
  console.error('Usage: node scripts/probe-silent-installers.mjs <serverUrl> [--token T] [--limit N]');
  process.exit(2);
}
const token = arg('--token', process.env.GAMEHUB_TOKEN || '');
const limit = parseInt(arg('--limit', '50'), 10) || 50;

const headers = {};
if (token) headers['X-Auth-Token'] = token;

async function getJson(p) {
  const res = await fetch(`${baseUrl}${p}`, { headers });
  if (!res.ok) throw new Error(`${p} → ${res.status}`);
  return res.json();
}

async function downloadWindows(gameId, relPath, destPath) {
  const q = relPath ? `?path=${encodeURIComponent(relPath)}` : '';
  const url = `${baseUrl}/api/games/${gameId}/download${q}`;

  // Full size via HEAD-ish GET with Range for first byte to read Content-Range
  // Fall back: GET with Range bytes=0-(SCAN-1), then a second GET for the tail
  // if Content-Range total is known.
  const headRes = await fetch(url, {
    headers: { ...headers, Range: `bytes=0-${SCAN_BYTES - 1}` },
  });
  if (!headRes.ok && headRes.status !== 206) {
    throw new Error(`download head ${headRes.status}`);
  }
  const headBuf = Buffer.from(await headRes.arrayBuffer());
  let total = headBuf.length;
  const cr = headRes.headers.get('content-range'); // bytes 0-N/TOTAL
  const m = cr && /\/(\d+)\s*$/.exec(cr);
  if (m) total = parseInt(m[1], 10);

  const parts = [headBuf];
  if (total > SCAN_BYTES * 2) {
    const start = total - SCAN_BYTES;
    const tailRes = await fetch(url, {
      headers: { ...headers, Range: `bytes=${start}-${total - 1}` },
    });
    if (tailRes.ok || tailRes.status === 206) {
      parts.push(Buffer.from(await tailRes.arrayBuffer()));
    }
  } else if (total > headBuf.length) {
    // Small-ish file — grab the rest
    const restRes = await fetch(url, {
      headers: { ...headers, Range: `bytes=${headBuf.length}-${total - 1}` },
    });
    if (restRes.ok || restRes.status === 206) {
      parts.push(Buffer.from(await restRes.arrayBuffer()));
    }
  }

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  // Stitch into a sparse-ish sample: head + gap marker + tail so offsets in
  // the middle aren't falsely matched. For fingerprinting we only need the
  // windows concatenated — fingerprintInstaller reads head+tail of ONE file,
  // so write head, then if we have a separate tail append it (the scanner
  // treats the whole file; for samples where head+tail were far apart, writing
  // them adjacent still finds the markers).
  fs.writeFileSync(destPath, Buffer.concat(parts));
  return { bytes: Buffer.concat(parts).length, total };
}

function pickSetupCandidate(files) {
  // Prefer root-ish setup.exe / setup.bat / install.exe
  const names = files.map((f) => ({
    ...f,
    base: path.basename(f.path || f.name || ''),
    depth: String(f.path || '').split(/[/\\]/).length - 1,
  }));
  const scored = names
    .filter((f) => /\.(exe|bat|cmd|msi)$/i.test(f.base))
    .filter((f) => !/(unins|vcredist|dxsetup|directx|dotnet|redist)/i.test(f.base))
    .map((f) => {
      let score = 0;
      if (/^setup\.(exe|bat)$/i.test(f.base)) score += 100;
      else if (/setup/i.test(f.base)) score += 50;
      else if (/install/i.test(f.base)) score += 40;
      if (/\.msi$/i.test(f.base)) score += 30;
      score -= f.depth * 10;
      return { ...f, score };
    })
    .sort((a, b) => b.score - a.score);
  return scored[0] || null;
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-probe-'));
const rows = [];

try {
  console.log(`Probing ${baseUrl} …`);
  const status = await getJson('/api/status').catch((e) => ({ error: e.message }));
  if (status.error) throw new Error(`Cannot reach server: ${status.error}`);
  console.log(`Server OK. Scanning up to ${limit} matched games for setup files…\n`);

  const games = await getJson('/api/games?status=matched');
  const list = (Array.isArray(games) ? games : games.games || []).slice(0, limit);

  let i = 0;
  for (const g of list) {
    i++;
    const title = g.meta_title || g.clean_name || g.raw_name || `#${g.id}`;
    process.stdout.write(`[${i}/${list.length}] ${title.slice(0, 60)}… `);
    try {
      const files = await getJson(`/api/games/${g.id}/files`);
      const fileList = Array.isArray(files) ? files : (files.files || []);
      const cand = pickSetupCandidate(fileList);
      if (!cand) {
        console.log('no setup candidate (portable?)');
        rows.push({ title, id: g.id, engine: '—', confidence: '—', auto: false, note: 'no-setup' });
        continue;
      }
      const sample = path.join(tmpRoot, `${g.id}-${cand.base}`);
      const dl = await downloadWindows(g.id, cand.path || '', sample);
      const fp = fingerprintInstaller(sample);
      const auto = fp.automatable ? 'AUTO' : 'wizard';
      console.log(`${cand.base} → ${fp.engine}/${fp.confidence} [${auto}] (${(dl.total / 1e6).toFixed(1)} MB)`);
      rows.push({
        title,
        id: g.id,
        file: cand.base,
        engine: fp.engine,
        confidence: fp.confidence,
        auto: fp.automatable,
        evidence: (fp.evidence || []).slice(0, 4).join('; '),
        note: fp.support,
      });
    } catch (err) {
      console.log(`error: ${err.message}`);
      rows.push({ title, id: g.id, engine: 'error', confidence: '—', auto: false, note: err.message });
    }
  }
} finally {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ }
}

console.log('\n=== Summary ===');
const auto = rows.filter((r) => r.auto);
const wizard = rows.filter((r) => !r.auto && r.engine !== '—' && r.engine !== 'error');
const none = rows.filter((r) => r.note === 'no-setup');
const errs = rows.filter((r) => r.engine === 'error');
console.log(`Automatable (Inno high-confidence): ${auto.length}`);
console.log(`Wizard fallback (detected/unsupported): ${wizard.length}`);
console.log(`No setup candidate (likely portable):   ${none.length}`);
console.log(`Errors:                                 ${errs.length}`);

const byEngine = {};
for (const r of rows) {
  if (r.engine === '—' || r.engine === 'error') continue;
  byEngine[r.engine] = (byEngine[r.engine] || 0) + 1;
}
console.log('\nBy engine:', byEngine);

console.log('\nAutomatable titles:');
for (const r of auto) console.log(`  ✓ ${r.title} (${r.file})`);
console.log('\nWizard titles:');
for (const r of wizard) console.log(`  · ${r.title} — ${r.engine}/${r.confidence} (${r.file})`);

// Also confirm SetupLdr magic constant is loaded (sanity)
if (!INNO_SETUP_LDR_MAGIC || INNO_SETUP_LDR_MAGIC.length !== 12) {
  console.warn('\nWARNING: Inno SetupLdr magic constant missing — fingerprint build is wrong');
  process.exitCode = 1;
}
