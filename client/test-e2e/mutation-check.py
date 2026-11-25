#!/usr/bin/env python3
"""Prove the tests catch the bugs they were written for.

Each mutation re-introduces one real bug fixed in this work (exact text swap
in one source file), runs the test that guards it, and expects it to FAIL.
The file is always restored. A mutation the test does NOT catch is reported
as "MISSED" and the script exits 1.

    python3 client/test-e2e/mutation-check.py            # all
    python3 client/test-e2e/mutation-check.py ui         # names containing "ui"
"""
import os
import subprocess
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SERVER = os.path.join(ROOT, 'server')
CLIENT = os.path.join(ROOT, 'client')
UNIT = lambda *files: (['node', '--test', '--test-concurrency=1', *[f'test/{f}' for f in files]], SERVER)
UI = (['node', os.path.join(CLIENT, 'test-e2e', 'ui-audit.cjs')], CLIENT)

MUTATIONS = [
    # (name, file, find, replace, test)
    ('giant update button (2.1.1)', 'client/renderer/style.css',
     '.nav-btn.update-pending .update-spinner { width: 20px; height: 20px; flex: none; }',
     '.nav-btn.update-pending .update-spinner { flex: none; }', UNIT('client-chrome.test.mjs')),
    ('giant update button (2.1.1) — UI audit', 'client/renderer/style.css',
     '.nav-btn.update-pending .update-spinner { width: 20px; height: 20px; flex: none; }',
     '.nav-btn.update-pending .update-spinner { flex: none; }', UI),
    ('downloads row broken for games without art — UI audit', 'client/renderer/app.js',
     '<div class="dl-thumb no-art">', '<div class="dl-thumb empty">', UI),
    ('Back button floating over the drag region', 'client/renderer/style.css',
     "#header-back {\n  margin: 0;", "#header-back {\n  position: absolute; margin: 0;", UNIT('client-chrome.test.mjs')),
    ('scene: .s00+ volumes not part of the set', 'client/lib/installer.js',
     "new RegExp(`^${esc(stem)}\\\\.([r-z])(\\\\d{2})$`, 'i')", "new RegExp(`^${esc(stem)}\\\\.([r])(\\\\d{2})$`, 'i')",
     UNIT('scene-release.test.mjs')),
    ('scene: crack folder exe counted as the game', 'client/lib/installer.js',
     '      && !scene.isInCrackDir(path.relative(dir, f))\n  );\n  const MIN_SIZE',
     '\n  );\n  const MIN_SIZE', UNIT('scene-release.test.mjs')),
    ('scene: crack readme overwrites the game readme', 'client/lib/sceneRelease.js',
     '!SKIP_FILE_RE.test(f) && !DOC_RE.test(f)', '!SKIP_FILE_RE.test(f)', UNIT('scene-release.test.mjs')),
    ('installer named by content (WiX bundle) not found', 'client/lib/installer.js',
     '      if (isInstallerEngineExe(f)) candidates.push(f);', '      void f;', UNIT('install-engines.test.mjs')),
    ('MSI property quoting lost on spaced Program Files path', 'client/lib/silentInstall.js',
     "const prop = (k) => rawArg(`${k}=\"${targetDir}\"`);", 'const prop = (k) => `${k}=${targetDir}`;',
     UNIT('install-engines.test.mjs')),
    ('MSI uninstall product code dropped (registry)', 'client/lib/uninstallRegistry.js',
     "      productCode: (String(e.uninstallString || '')", "      productCodeGone: (String(e.uninstallString || '')",
     UNIT('install-engines.test.mjs')),
    ('MSI uninstalled with the registered /I (modify) instead of /X', 'client/lib/silentInstall.js',
     'args: `/X${e.productCode}`', 'args: `/I${e.productCode}`', UNIT('install-engines.test.mjs')),
    ('library grant asks every time', 'client/lib/libraryRoot.js',
     '  if (_isWritable(dir)) return { ok: true, granted: false };', '', UNIT('install-engines.test.mjs')),
    ('emulation: a PC scene ISO taken for a Wii disc', 'server/src/platforms.cjs',
     "      return null; // a PC / other-console ISO", "      return { platform: 'wii', kind: 'iso', confidence: 'low', ids: {} };",
     UNIT('emulation.test.mjs')),
    ('emulation: Switch launches the DLC instead of the base game', 'server/src/platforms.cjs',
     "    const base = files.filter((f) => (f.ids?.role || 'base') === 'base');", "    const base = files;",
     UNIT('emulation.test.mjs')),
    ('emulation: Ryujinx instead of Eden as the Switch default', 'client/lib/emulators.js',
     "  switch: ['eden', 'ryujinx'],", "  switch: ['ryujinx', 'eden'],", UNIT('emulation.test.mjs')),
    ('single-instance lock removed', 'client/main.js',
     'const gotSingleInstanceLock = app.requestSingleInstanceLock();', 'const gotSingleInstanceLock = true;',
     UNIT('app-lifecycle.test.mjs')),
    ('installer quit request file renamed', 'client/build/installer.nsh',
     '$APPDATA\\Gamehub\\quit-for-update" w', '$APPDATA\\Gamehub\\quit-update" w', UNIT('app-lifecycle.test.mjs')),
]


def run(cmd, cwd):
    p = subprocess.run(cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=900)
    return p.returncode, p.stdout


def main():
    only = sys.argv[1] if len(sys.argv) > 1 else ''
    results, missed = [], 0
    for name, rel, find, repl, (cmd, cwd) in MUTATIONS:
        if only and only.lower() not in name.lower():
            continue
        path = os.path.join(ROOT, rel)
        original = open(path, encoding='utf-8').read()
        if original.count(find) != 1:
            results.append(f'SETUP {name}: pattern found {original.count(find)}x in {rel}')
            missed += 1
            continue
        # sanity: the test passes on the real code first
        base_code, _ = run(cmd, cwd)
        try:
            open(path, 'w', encoding='utf-8').write(original.replace(find, repl))
            code, out = run(cmd, cwd)
        finally:
            open(path, 'w', encoding='utf-8').write(original)
        if base_code != 0:
            results.append(f'BASE  {name}: test fails even WITHOUT the mutation')
            missed += 1
        elif code != 0:
            results.append(f'caught  {name}')
        else:
            results.append(f'MISSED  {name}  ({" ".join(cmd[-1:])})')
            missed += 1
    print('\n'.join(results))
    print(f'\n{len(results) - missed}/{len(results)} re-introduced bugs caught')
    sys.exit(1 if missed else 0)


if __name__ == '__main__':
    main()
