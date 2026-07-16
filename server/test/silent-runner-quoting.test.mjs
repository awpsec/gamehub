// Elevated silent-install arg quoting. Start-Process with an ARRAY ArgumentList
// joins elements with spaces WITHOUT quoting — a spaced /DIR=C:\...\Title With
// Spaces reached the installer split into pieces, so FitGirl/Inno installed
// into a truncated stray folder and verification found the real target empty.
// These tests pin the fix at both layers: the JS quoting helper and the REAL
// elevatedSilentRunner.ps1 driving a stub that reports its parsed argv
// (process.argv comes from CommandLineToArgvW — the same splitting Inno sees).
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { checker, tmp, rm } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const { windowsQuoteArg, buildElevatedPowerShell, buildInnoArgs } = require('../../client/lib/silentInstall.js');

const RUNNER = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, '')), '../../client/lib/elevatedSilentRunner.ps1');
const WIN = process.platform === 'win32';

test('windowsQuoteArg: CommandLineToArgvW round-trip rules', () => {
  const { check, done } = checker();
  check('plain arg untouched', windowsQuoteArg('/VERYSILENT') === '/VERYSILENT');
  check('empty arg quoted', windowsQuoteArg('') === '""');
  check('spaced arg quoted', windowsQuoteArg('/DIR=C:\\Games\\Town to City') === '"/DIR=C:\\Games\\Town to City"');
  check('embedded quote escaped', windowsQuoteArg('a "b" c') === '"a \\"b\\" c"');
  check('trailing backslash doubled', windowsQuoteArg('C:\\path with space\\') === '"C:\\path with space\\\\"');
  done(assert);
});

test('legacy fallback builds ONE pre-quoted argument line (no PS array)', () => {
  const { check, done } = checker();
  const args = buildInnoArgs('C:\\Games\\Age of Mythology - Retold (2024)', null);
  const ps = buildElevatedPowerShell('C:\\stage\\setup.exe', args, 'C:\\stage', {});
  check('no array ArgumentList', !ps.includes('-ArgumentList @('), ps.split('\n').find((l) => l.includes('ArgumentList')));
  check('spaced /DIR is quoted in the line', ps.includes('\\"/DIR=C:\\Games\\Age of Mythology - Retold (2024)\\"') || ps.includes('"/DIR=C:\\Games\\Age of Mythology - Retold (2024)"'), ps.split('\n').find((l) => l.includes('/DIR=')));
  done(assert);
});

test('elevatedSilentRunner delivers spaced /DIR intact to the setup process', { skip: !WIN }, async () => {
  const { check, done } = checker();
  const dir = tmp('runner-quote');
  const out = path.join(dir, 'argv.json');
  try {
    // space-free -e payload: a space inside would itself be split by the old bug
    const js = "require('fs').writeFileSync(process.env.GH_OUT,JSON.stringify(process.argv.slice(1)))";
    assert.ok(!/\s/.test(js), 'stub payload must be space-free');
    const targetDir = 'C:\\GamehubLibrary\\Age of Mythology - Retold (2024)';
    const innoArgs = buildInnoArgs(targetDir, path.join(dir, 'inno silent.log'));
    const argsFile = path.join(dir, 'setup-args.txt');
    fs.writeFileSync(argsFile, ['-e', js, ...innoArgs].join('\n') + '\n', 'utf8');

    const r = spawnSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', RUNNER,
      '-SetupExe', process.execPath,
      '-ArgsFile', argsFile,
      '-WorkingDirectory', dir,
      '-StartedFile', path.join(dir, 'started.txt'),
      '-AliveFile', path.join(dir, 'alive.txt'),
      '-DoneFile', path.join(dir, 'done.txt'),
      '-PostExitSweepSeconds', '0',
    ], { env: { ...process.env, GH_OUT: out }, timeout: 60000, windowsHide: true });
    check('runner exited cleanly', r.status === 0, `status=${r.status} stderr=${String(r.stderr).slice(0, 200)}`);

    let argv = null;
    for (let i = 0; i < 40 && !argv; i++) {
      try { argv = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { await new Promise((res) => setTimeout(res, 250)); }
    }
    check('stub setup ran and reported argv', Array.isArray(argv), String(argv));
    const dirArgs = (argv || []).filter((a) => a.startsWith('/DIR='));
    check('exactly one /DIR argument', dirArgs.length === 1, JSON.stringify(argv));
    check('/DIR path intact with spaces', dirArgs[0] === `/DIR=${targetDir}`, dirArgs[0]);
    const logArgs = (argv || []).filter((a) => a.startsWith('/LOG='));
    check('spaced /LOG path intact', logArgs.length === 1 && logArgs[0].endsWith('inno silent.log'), JSON.stringify(logArgs));
    check('no stray split fragments', !(argv || []).some((a) => ['of', 'Mythology', '-', 'Retold', '(2024)'].includes(a)), JSON.stringify(argv));
  } finally {
    rm(dir);
  }
  done(assert);
});
