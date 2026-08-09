// NSIS silent args + elevated runner /D= no-quote rule.
// NSIS docs: /D= must be last and must NOT be quoted even with spaces.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { checker, tmp, rm } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const {
  buildNsisArgs,
  quoteSilentArg,
  windowsQuoteArg,
  buildElevatedPowerShell,
  canAutoSilentInstall,
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
const CAN_RUN_PS = !!PS;

test('buildNsisArgs: /S then unquoted /D= last', () => {
  const { check, done } = checker();
  const dir = 'C:\\Games\\Age of Mythology - Retold (2024)';
  const args = buildNsisArgs(dir);
  check('two args', args.length === 2);
  check('/S first', args[0] === '/S');
  check('/D= last', args[1] === `/D=${dir}`);
  check('/D= contains spaces', /\s/.test(args[1]));
  done(assert);
});

test('quoteSilentArg: /D= never quoted; /DIR= is', () => {
  const { check, done } = checker();
  const d = '/D=C:\\Games\\Town to City';
  const dir = '/DIR=C:\\Games\\Town to City';
  check('/D= raw', quoteSilentArg(d) === d);
  check('/DIR= quoted', quoteSilentArg(dir) === windowsQuoteArg(dir));
  check('/DIR= has quotes', quoteSilentArg(dir).startsWith('"'));
  done(assert);
});

test('legacy RunAs line keeps NSIS /D= unquoted', () => {
  const { check, done } = checker();
  const args = buildNsisArgs('C:\\Games\\Age of Mythology - Retold (2024)');
  const ps = buildElevatedPowerShell('C:\\stage\\setup.exe', args, 'C:\\stage', {});
  check('no ArgumentList array', !ps.includes('-ArgumentList @('));
  check('/D= present unquoted in line', /\/D=C:\\Games\\Age of Mythology - Retold \(2024\)/.test(ps));
  check('/D= not wrapped in quotes', !ps.includes('"/D=C:\\Games\\Age of Mythology') && !ps.includes('\\"/D='));
  done(assert);
});

test('canAutoSilentInstall accepts high-confidence NSIS', () => {
  const { check, done } = checker();
  const r = canAutoSilentInstall({
    fingerprint: { engine: 'nsis', confidence: 'high', automatable: true },
    autoSilentPref: true,
    isWindows: true,
  });
  check('eligible', r.ok === true && r.reason === 'eligible');
  // Explicit Linux:false is optional after the isWindows wine-gate fix, but keep
  // the Windows simulation unambiguous on Linux CI hosts.
  const r2 = canAutoSilentInstall({
    fingerprint: { engine: 'nsis', confidence: 'high', automatable: true },
    autoSilentPref: true,
    isWindows: true,
    isLinux: false,
  });
  check('eligible with isLinux false', r2.ok === true);
  done(assert);
});

test('elevatedSilentRunner ConvertTo-QuotedArg leaves /D= unquoted (real PS)', { skip: !CAN_RUN_PS }, () => {
  const { check, done } = checker();
  // Extract and exercise ConvertTo-QuotedArg from the real runner script.
  const body = fs.readFileSync(RUNNER, 'utf8');
  check('has /D= exception', /if \(\$Arg -match '\^\/D='\)/.test(body) || body.includes("'^/D='"));
  const dir = tmp('nsis-quote');
  try {
    const probe = path.join(dir, 'probe.ps1');
    // Pull the function out by dot-sourcing a trimmed copy of just ConvertTo-QuotedArg.
    const fnMatch = body.match(/function ConvertTo-QuotedArg[\s\S]*?\n\}/);
    assert.ok(fnMatch, 'ConvertTo-QuotedArg function present');
    fs.writeFileSync(probe, `${fnMatch[0]}\n` +
      `$a = ConvertTo-QuotedArg '/D=C:\\Games\\Age of Mythology'\n` +
      `$b = ConvertTo-QuotedArg '/DIR=C:\\Games\\Age of Mythology'\n` +
      `$c = ConvertTo-QuotedArg '/S'\n` +
      `Write-Output ("D=" + $a)\n` +
      `Write-Output ("DIR=" + $b)\n` +
      `Write-Output ("S=" + $c)\n`, 'utf8');
    const r = spawnSync(PS, [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', probe,
    ], { encoding: 'utf8', timeout: 30000, windowsHide: true });
    check('probe ok', r.status === 0, String(r.stderr || r.stdout).slice(0, 300));
    const out = String(r.stdout || '');
    check('/D= unquoted', out.includes('D=/D=C:\\Games\\Age of Mythology'));
    check('/DIR= quoted', /DIR="\/DIR=C:\\Games\\Age of Mythology"/.test(out));
    check('/S plain', out.includes('S=/S'));
  } finally {
    rm(dir);
  }
  done(assert);
});

test('elevatedSilentRunner delivers raw /D= command line (NSIS rule)', { skip: !CAN_RUN_PS }, () => {
  const { check, done } = checker();
  const dir = tmp('nsis-raw');
  const out = path.join(dir, 'cmdline.txt');
  try {
    const runnerBody = fs.readFileSync(RUNNER, 'utf8');
    const fnMatch = runnerBody.match(/function ConvertTo-QuotedArg[\s\S]*?\n\}/);
    assert.ok(fnMatch, 'ConvertTo-QuotedArg present');
    const joinProbe = path.join(dir, 'join.ps1');
    const argsFile = path.join(dir, 'setup-args.txt');
    const targetDir = path.join(dir, 'Age of Mythology - Retold (2024)');
    fs.writeFileSync(argsFile, `${buildNsisArgs(targetDir).join('\n')}\n`, 'utf8');
    fs.writeFileSync(joinProbe, `${fnMatch[0]}
$argList = @(Get-Content -LiteralPath $args[0] | ForEach-Object { "$_".TrimEnd() } | Where-Object { $_ -ne '' })
$argLine = (($argList | ForEach-Object { ConvertTo-QuotedArg $_ }) -join ' ')
Set-Content -LiteralPath $args[1] -Value $argLine -Encoding UTF8
`, 'utf8');
    const r = spawnSync(PS, [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', joinProbe, argsFile, out,
    ], { timeout: 30000 });
    check('join probe ok', r.status === 0, String(r.stderr || '').slice(0, 200));
    const line = fs.readFileSync(out, 'utf8').trim();
    check('arg line has /S', line.startsWith('/S '));
    check('/D= unquoted with spaces', line.endsWith(`/D=${targetDir}`));
    check('no quotes around /D=', !line.includes('"/D=') && !line.includes(`'/D=`));
  } finally {
    rm(dir);
  }
  done(assert);
});
