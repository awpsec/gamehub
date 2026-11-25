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
  for (const m of css.matchAll(/([^{}]*(?:back-btn|#header-back)[^{}]*)\{([^}]*)\}/g)) {
    assert.ok(!/position:\s*(absolute|fixed)/.test(m[2]), `${m[1].trim()} must not float over the drag region`);
  }
});

test('update button icons are sized like the other sidebar icons (2.1.1 giant-button bug)', () => {
  // These SVGs are not .i — without explicit sizes they stretch to the sidebar width.
  assert.match(css, /\.nav-btn\.update-pending \.update-icon,\s*\.nav-btn\.update-pending \.update-spinner\s*\{[^}]*width:\s*20px;[^}]*height:\s*20px/);
});
