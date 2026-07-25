// Client URL helper: Tailscale host:port without a scheme must become http://…
import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { checker } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const { normalizeServerUrl } = require('../../client/lib/serverApi.js');

test('normalizeServerUrl: host:port, trim, strip trailing slash', () => {
  const { check, done } = checker();
  check('adds http for bare host:port', normalizeServerUrl('zeddserver:6767') === 'http://zeddserver:6767');
  check('keeps https', normalizeServerUrl('https://games.example:443/') === 'https://games.example:443');
  check('keeps http', normalizeServerUrl('http://192.168.1.10:8686') === 'http://192.168.1.10:8686');
  check('trims whitespace', normalizeServerUrl('  zeddserver:6767  ') === 'http://zeddserver:6767');
  check('empty stays empty', normalizeServerUrl('') === '' && normalizeServerUrl(null) === '');
  done(assert);
});
