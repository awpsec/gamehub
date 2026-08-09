// Hotkey accelerator → Win32 VK parsing for the in-game screenshot hook.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseAccel } = require('../../client/lib/hotkeyHook.js');

test('parseAccel: F12', () => {
  assert.deepEqual(parseAccel('F12'), { vk: 0x7B, wantShift: 0, wantCtrl: 0, wantAlt: 0 });
});

test('parseAccel: Shift+F12', () => {
  assert.deepEqual(parseAccel('Shift+F12'), { vk: 0x7B, wantShift: 1, wantCtrl: 0, wantAlt: 0 });
});

test('parseAccel: PrintScreen', () => {
  assert.equal(parseAccel('PrintScreen').vk, 0x2C);
});

test('parseAccel: Shift+Tab', () => {
  assert.deepEqual(parseAccel('Shift+Tab'), { vk: 0x09, wantShift: 1, wantCtrl: 0, wantAlt: 0 });
});

test('parseAccel: rejects empty / unknown', () => {
  assert.equal(parseAccel(''), null);
  assert.equal(parseAccel('MediaPlayPause'), null);
});
