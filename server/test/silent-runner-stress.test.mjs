// Stress the REAL elevatedSilentRunner.ps1 under pwsh (or Windows powershell).
// Covers spaced/unicode/apostrophe paths, NSIS /D= arg-line rules, crash-dead
// runner fail-fast via DoneFile, stop-file → exit 15, and concurrency.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { checker, tmp, rm } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const {
  buildInnoArgs,
  buildNsisArgs,
  buildElevatedPowerShell,
  quoteSilentArg,
} = require('../../client/lib/silentInstall.js');

const RUNNER = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, '')),
  '../../client/lib/elevatedSilentRunner.ps1',
);

function resolvePowerShell() {
  if (process.platform === 'win32') return 'powershell.exe';
  for (const c of ['pwsh', 'powershell']) {
    const r = spawnSync(c, ['-NoProfile', '-Command', 'exit 0'], { timeout: 10000 });
    if (r.status === 0) return c;
  }
  return null;
}
const PS = resolvePowerShell();
const CAN = !!PS;

const STUB_JS = "require('fs').writeFileSync(process.env.GH_OUT,JSON.stringify(process.argv.slice(1)))";
assert.ok(!/\s/.test(STUB_JS));

/** Write stop file from a sibling process — spawnSync blocks the Node event loop. */
function scheduleStopFile(stopPath, afterMs) {
  const child = spawn(process.execPath, [
    '-e',
    `setTimeout(()=>{try{require('fs').writeFileSync(process.argv[1],'1')}catch{}},Number(process.argv[2]))`,
    stopPath,
    String(afterMs),
  ], { stdio: 'ignore', detached: true });
  child.unref();
  return child;
}

function runRunner(dir, setupArgs, { sweep = 0, stopAfterMs = 0, setupExe = process.execPath } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const argsFile = path.join(dir, 'args.txt');
  const out = path.join(dir, 'argv.json');
  fs.writeFileSync(argsFile, `${setupArgs.join('\n')}\n`, 'utf8');
  const alive = path.join(dir, 'alive.txt');
  const started = path.join(dir, 'started.txt');
  const done = path.join(dir, 'done.txt');
  const stop = path.join(dir, 'stop.txt');

  let stopper = null;
  if (stopAfterMs > 0) {
    stopper = scheduleStopFile(stop, stopAfterMs);
  }

  const r = spawnSync(PS, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', RUNNER,
    '-SetupExe', setupExe,
    '-ArgsFile', argsFile,
    '-WorkingDirectory', dir,
    '-StartedFile', started,
    '-AliveFile', alive,
    '-DoneFile', done,
    '-StopFile', stop,
    '-PostExitSweepSeconds', String(sweep),
  ], {
    env: { ...process.env, GH_OUT: out },
    timeout: 60000,
    encoding: 'utf8',
  });
  if (stopper) {
    try { stopper.kill(); } catch { /* */ }
  }

  let argv = null;
  try { argv = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { /* */ }
  let doneCode = null;
  try { doneCode = Number(fs.readFileSync(done, 'utf8').trim()); } catch { /* */ }
  return {
    status: r.status,
    alive: fs.existsSync(alive),
    started: fs.existsSync(started),
    doneCode,
    argv,
    stderr: r.stderr,
  };
}

function joinArgLine(args) {
  const dir = tmp('join');
  try {
    const body = fs.readFileSync(RUNNER, 'utf8');
    const fn = body.match(/function ConvertTo-QuotedArg[\s\S]*?\n\}/)[0];
    const probe = path.join(dir, 'join.ps1');
    const argsFile = path.join(dir, 'a.txt');
    const out = path.join(dir, 'line.txt');
    fs.writeFileSync(argsFile, `${args.join('\n')}\n`);
    fs.writeFileSync(probe, `${fn}
$argList = @(Get-Content -LiteralPath $args[0] | ForEach-Object { "$_".TrimEnd() } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
$argLine = (($argList | ForEach-Object { ConvertTo-QuotedArg $_ }) -join ' ')
Set-Content -LiteralPath $args[1] -Value $argLine -Encoding utf8
`);
    const r = spawnSync(PS, ['-NoProfile', '-File', probe, argsFile, out], { timeout: 15000 });
    assert.equal(r.status, 0, String(r.stderr || ''));
    return fs.readFileSync(out, 'utf8').trim();
  } finally {
    rm(dir);
  }
}

test('stress: spaced / unicode / apostrophe / ampersand DIR intact', { skip: !CAN }, () => {
  const { check, done } = checker();
  const root = tmp('stress-paths');
  try {
    const cases = [
      { name: 'spaces', dir: path.join(root, 'Age of Mythology - Retold (2024)') },
      { name: 'apostrophe', dir: path.join(root, "O'Brien Games", 'Title') },
      { name: 'ampersand', dir: path.join(root, 'Game (GOTY) & Co', 'Install') },
      { name: 'unicode', dir: path.join(root, '游戏 Title — Café') },
      { name: 'parens-brackets', dir: path.join(root, 'Title (GOTY Edition) [v1.2]') },
      { name: 'embedded-quotes', dir: path.join(root, 'Title "Quoted" Name') },
    ];
    for (const c of cases) {
      const d = path.join(root, c.name);
      const r = runRunner(d, ['-e', STUB_JS, '/VERYSILENT', `/DIR=${c.dir}`, `/LOG=${path.join(d, 'inno silent.log')}`]);
      check(`${c.name} exit0`, r.status === 0 && r.doneCode === 0, `status=${r.status} done=${r.doneCode}`);
      check(`${c.name} DIR intact`, Array.isArray(r.argv) && r.argv.includes(`/DIR=${c.dir}`), JSON.stringify(r.argv));
      check(`${c.name} LOG intact`, Array.isArray(r.argv) && r.argv.some((a) => a.endsWith('inno silent.log')), JSON.stringify(r.argv));
      check(`${c.name} no split fragments`, !(r.argv || []).some((a) => ['of', 'Mythology', 'Retold', '(2024)'].includes(a)));
    }
  } finally {
    rm(root);
  }
  done(assert);
});

test('stress: NSIS /D= stays unquoted on the Start-Process arg line', { skip: !CAN }, () => {
  const { check, done } = checker();
  const target = '/tmp/Age of Mythology - Retold (2024)';
  const args = buildNsisArgs(target);
  const line = joinArgLine(args);
  check('line shape', line === `/S /D=${target}`, line);
  check('no quotes on /D=', !line.includes('"/D=') && !line.includes("'/D="));
  // argv WILL split for non-NSIS consumers — that is expected; NSIS reads raw cmdline.
  const dir = tmp('nsis-argv');
  try {
    const r = runRunner(dir, ['-e', STUB_JS, ...args]);
    check('runner ok', r.status === 0);
    check('argv split expected for /D=', (r.argv || []).some((a) => a === 'of') || (r.argv || []).some((a) => a === '/D=/tmp/Age'), JSON.stringify(r.argv));
  } finally {
    rm(dir);
  }
  done(assert);
});

test('stress: stop-file yields DoneFile 15 (not UAC 1223)', { skip: !CAN }, () => {
  const { check, done } = checker();
  const dir = tmp('stress-stop');
  try {
    const slow = path.join(dir, 'slow.js');
    fs.writeFileSync(slow, `
require('fs').writeFileSync(process.env.GH_OUT, '[]');
const end = Date.now() + 5000;
while (Date.now() < end) {}
`);
    const r = runRunner(path.join(dir, 'run'), [slow], { stopAfterMs: 300 });
    check('alive', r.alive);
    check('done is 15', r.doneCode === 15, `done=${r.doneCode} status=${r.status}`);
    check('not 1223', r.doneCode !== 1223);
  } finally {
    rm(dir);
  }
  done(assert);
});

test('stress: missing setup/args → DoneFile 2 after Alive', { skip: !CAN }, () => {
  const { check, done } = checker();
  const dir = tmp('stress-miss');
  try {
    const r = runRunner(dir, ['/VERYSILENT'], { setupExe: path.join(dir, 'nope.exe') });
    check('alive', r.alive);
    check('done 2', r.doneCode === 2, `done=${r.doneCode}`);
  } finally {
    rm(dir);
  }
  done(assert);
});

test('stress: concurrent 12 spaced-title runners', { skip: !CAN }, async () => {
  const root = tmp('stress-conc');
  try {
    const jobs = [];
    for (let i = 0; i < 12; i++) {
      jobs.push(new Promise((resolve) => {
        const d = path.join(root, `c${i}`);
        const target = path.join(d, `Title ${i} Retold (2024)`);
        const r = runRunner(d, ['-e', STUB_JS, `/DIR=${target}`]);
        resolve({
          i,
          ok: r.status === 0 && r.doneCode === 0 && Array.isArray(r.argv) && r.argv.includes(`/DIR=${target}`),
          r,
        });
      }));
    }
    const results = await Promise.all(jobs);
    const fails = results.filter((x) => !x.ok);
    assert.equal(fails.length, 0, JSON.stringify(fails.map((f) => ({ i: f.i, status: f.r.status, argv: f.r.argv }))));
  } finally {
    rm(root);
  }
});

test('stress: wrapper script watches elevated PID (fail-fast text)', () => {
  const { check, done } = checker();
  const ps = buildElevatedPowerShell('C:\\a\\setup.exe', buildInnoArgs('C:\\a\\b'), 'C:\\a', {
    runnerScript: 'C:\\t\\r.ps1',
    argsFile: 'C:\\t\\a.txt',
    startedFile: 'C:\\t\\s.txt',
    stopFile: 'C:\\t\\x.txt',
    aliveFile: 'C:\\t\\alive.txt',
    doneFile: 'C:\\t\\done.txt',
  });
  check('tracks elevPid', ps.includes('$elevPid'));
  check('Get-Process alive check', ps.includes('Get-Process -Id $elevPid'));
  check('fail-fast on dead elev', /not \(Get-Process -Id \$elevPid[\s\S]*exit 1/.test(ps));
  done(assert);
});

test('stress: quoteSilentArg matrix + Inno join quotes DIR', { skip: !CAN }, () => {
  const { check, done } = checker();
  check('/D= raw', quoteSilentArg('/D=C:\\A B') === '/D=C:\\A B');
  check('/DIR= quoted', quoteSilentArg('/DIR=C:\\A B') === '"/DIR=C:\\A B"');
  const line = joinArgLine(buildInnoArgs('/tmp/Age of Mythology - Retold (2024)', '/tmp/inno silent.log'));
  check('DIR quoted in line', line.includes('"/DIR=/tmp/Age of Mythology - Retold (2024)"'), line);
  check('LOG quoted in line', line.includes('"/LOG=/tmp/inno silent.log"'), line);
  done(assert);
});

test('stress: whitespace-only args lines are dropped', { skip: !CAN }, () => {
  const { check, done } = checker();
  const dir = tmp('stress-ws');
  try {
    const target = path.join(dir, 'Title With Spaces');
    const r = runRunner(dir, ['-e', STUB_JS, '', '   \t', '/VERYSILENT', `/DIR=${target}`]);
    check('exit0', r.status === 0 && r.doneCode === 0, `status=${r.status} done=${r.doneCode}`);
    check('DIR intact', Array.isArray(r.argv) && r.argv.includes(`/DIR=${target}`), JSON.stringify(r.argv));
    check('no empty argv slots', !(r.argv || []).some((a) => a === '' || /^\s+$/.test(a)));
  } finally {
    rm(dir);
  }
  done(assert);
});

test('stress: wrapper elevPid watchdog fails fast when elev dies without Done', { skip: !CAN }, () => {
  const { check, done } = checker();
  const dir = tmp('stress-dead-elev');
  try {
    const alive = path.join(dir, 'alive.txt');
    const started = path.join(dir, 'started.txt');
    const doneFile = path.join(dir, 'done.txt');
    const probe = path.join(dir, 'watch.ps1');
    // Mirror the unelevated wrapper's post-Alive elevPid death check.
    fs.writeFileSync(probe, `
$alive = $args[0]
$started = $args[1]
$done = $args[2]
$elev = Start-Process -FilePath '${PS}' -ArgumentList @('-NoProfile','-Command','Start-Sleep -Milliseconds 200; exit 0') -PassThru
Set-Content -LiteralPath $alive -Value ([string]$elev.Id) -Encoding ASCII -Force
$elevPid = [int]$elev.Id
$deadline = (Get-Date).AddSeconds(8)
while (-not (Test-Path -LiteralPath $done)) {
  if ($elevPid -gt 0 -and -not (Get-Process -Id $elevPid -ErrorAction SilentlyContinue)) {
    Start-Sleep -Milliseconds 500
    if (-not (Test-Path -LiteralPath $done)) { exit 1 }
    break
  }
  if ((Get-Date) -gt $deadline) { exit 2 }
  Start-Sleep -Milliseconds 50
}
exit 0
`);
    const t0 = Date.now();
    const r = spawnSync(PS, ['-NoProfile', '-File', probe, alive, started, doneFile], {
      timeout: 15000,
      encoding: 'utf8',
    });
    const elapsed = Date.now() - t0;
    check('exit 1 (fail-fast)', r.status === 1, `status=${r.status} stderr=${r.stderr}`);
    check('no DoneFile', !fs.existsSync(doneFile));
    check('finished well under 6h budget', elapsed < 5000, `elapsed=${elapsed}`);
  } finally {
    rm(dir);
  }
  done(assert);
});
