// Client title bar = the window's drag region (-webkit-app-region: drag).
// Electron resolves drag regions below the DOM, so a button positioned OVER
// the title bar never gets clicks (2.1.0: "Back to Store does nothing").
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../../client/renderer/index.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../../client/renderer/style.css', import.meta.url), 'utf8');

test('game-page Back is a real title-bar button', () => {
  const header = html.slice(html.indexOf('<header>'), html.indexOf('</header>'));
  assert.match(header, /id="header-back"/, 'Back lives inside <header>');
  assert.match(css, /#header-back\s*\{[^}]*-webkit-app-region:\s*no-drag/);
});

test('no back button is absolutely positioned over the title bar', () => {
  for (const m of css.matchAll(/([^{}]*back-btn[^{}]*)\{([^}]*)\}/g)) {
    assert.ok(!/position:\s*(absolute|fixed)/.test(m[2]), `${m[1].trim()} must not float over the drag region`);
  }
});
