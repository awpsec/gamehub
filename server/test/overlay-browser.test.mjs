// Overlay browser profile: omnibox resolve, bookmarks, history suggestions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const browser = require('../../client/lib/overlayBrowser.js');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gh-ov-browser-'));
}

test('resolveOmnibox: bare queries become Google searches', () => {
  const r = browser.resolveOmnibox('half life walkthrough');
  assert.equal(r.kind, 'search');
  assert.equal(r.query, 'half life walkthrough');
  assert.match(r.url, /^https:\/\/www\.google\.com\/search\?q=/);
  assert.match(r.url, /half%20life%20walkthrough/);
});

test('resolveOmnibox: single words search (not forced to a URL)', () => {
  const r = browser.resolveOmnibox('wikipedia');
  assert.equal(r.kind, 'search');
  assert.equal(r.query, 'wikipedia');
});

test('resolveOmnibox: real addresses navigate', () => {
  assert.equal(browser.resolveOmnibox('https://example.com/x').kind, 'url');
  assert.equal(browser.resolveOmnibox('example.com').url, 'https://example.com');
  assert.equal(browser.resolveOmnibox('localhost:3000/app').url, 'https://localhost:3000/app');
});

test('looksLikeAddress rejects search-like input', () => {
  assert.equal(browser.looksLikeAddress('how to beat the boss'), false);
  assert.equal(browser.looksLikeAddress('c++ tips'), false);
  assert.equal(browser.looksLikeAddress('example.com'), true);
});

test('bookmarks + history + suggestions persist', () => {
  const root = tmpRoot();
  browser.addBookmark(root, { url: 'https://wiki.example/hl', title: 'HL Wiki' });
  browser.recordVisit(root, { url: 'https://store.example/game', title: 'Store' });
  browser.recordSearch(root, 'speedrun route');
  browser.setLastUrl(root, 'https://www.google.com/search?q=foo');

  const data = browser.load(root);
  assert.equal(data.bookmarks.length, 1);
  assert.equal(data.bookmarks[0].title, 'HL Wiki');
  assert.equal(data.history[0].url, 'https://store.example/game');
  assert.equal(data.searches[0].q, 'speedrun route');
  assert.ok(browser.isBookmarked(root, 'https://wiki.example/hl'));

  const sug = browser.suggest(root, 'speed');
  assert.ok(sug.some((s) => s.kind === 'search' && s.q === 'speedrun route'));

  const wiki = browser.suggest(root, 'wiki');
  assert.ok(wiki.some((s) => s.kind === 'bookmark'));

  assert.equal(browser.removeBookmark(root, data.bookmarks[0].id), true);
  assert.equal(browser.isBookmarked(root, 'https://wiki.example/hl'), false);
});

test('saveLayout remembers open state, bounds, and tabs', () => {
  const root = tmpRoot();
  const tab = { id: 'abc', url: 'https://guide.example/boss', title: 'Boss Guide' };
  browser.saveLayout(root, {
    browserOpen: true,
    bounds: { x: 40, y: 60, w: 900, h: 500 },
    tabs: [tab],
    activeTabId: 'abc',
  });
  const data = browser.load(root);
  assert.equal(data.browserOpen, true);
  assert.equal(data.bounds.w, 900);
  assert.equal(data.tabs[0].url, 'https://guide.example/boss');
  assert.equal(data.activeTabId, 'abc');
  assert.equal(data.lastUrl, 'https://guide.example/boss');
});
