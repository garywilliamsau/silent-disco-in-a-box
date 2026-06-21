'use strict';

// Pure-logic tests for the per-channel playlist ordering / M3U generation.
// Run with: npm test  (uses the built-in node:test runner, no dependencies)

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const playlist = require('../lib/playlist');

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disco-pl-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const touch = (name) => fs.writeFileSync(path.join(dir, name), '');

test('getOrderedFiles returns audio files sorted when there is no saved order', () => {
  ['b.mp3', 'a.mp3', 'c.mp3'].forEach(touch);
  assert.deepStrictEqual(playlist.getOrderedFiles(dir), ['a.mp3', 'b.mp3', 'c.mp3']);
});

test('getOrderedFiles ignores non-audio files', () => {
  ['song.mp3', 'cover.jpg', 'readme.md', 'track.flac'].forEach(touch);
  assert.deepStrictEqual(playlist.getOrderedFiles(dir), ['song.mp3', 'track.flac']);
});

test('getOrderedFiles returns [] for a missing directory', () => {
  assert.deepStrictEqual(playlist.getOrderedFiles(path.join(dir, 'nope')), []);
});

test('getOrderedFiles respects saved order and appends new files', () => {
  ['a.mp3', 'b.mp3', 'c.mp3'].forEach(touch);
  playlist.saveOrder(dir, ['c.mp3', 'a.mp3']); // b.mp3 not yet in saved order
  assert.deepStrictEqual(playlist.getOrderedFiles(dir), ['c.mp3', 'a.mp3', 'b.mp3']);
});

test('getOrderedFiles drops entries whose files no longer exist', () => {
  ['a.mp3', 'b.mp3'].forEach(touch);
  playlist.saveOrder(dir, ['a.mp3', 'gone.mp3', 'b.mp3']);
  assert.deepStrictEqual(playlist.getOrderedFiles(dir), ['a.mp3', 'b.mp3']);
});

test('moveTrack up swaps with the previous track and persists', () => {
  ['a.mp3', 'b.mp3', 'c.mp3'].forEach(touch);
  playlist.saveOrder(dir, ['a.mp3', 'b.mp3', 'c.mp3']);
  assert.deepStrictEqual(playlist.moveTrack(dir, 'b.mp3', 'up'), ['b.mp3', 'a.mp3', 'c.mp3']);
  assert.deepStrictEqual(playlist.getOrderedFiles(dir), ['b.mp3', 'a.mp3', 'c.mp3']);
});

test('moveTrack down swaps with the next track', () => {
  ['a.mp3', 'b.mp3'].forEach(touch);
  playlist.saveOrder(dir, ['a.mp3', 'b.mp3']);
  assert.deepStrictEqual(playlist.moveTrack(dir, 'a.mp3', 'down'), ['b.mp3', 'a.mp3']);
});

test('moveTrack at a boundary is a no-op', () => {
  ['a.mp3', 'b.mp3'].forEach(touch);
  playlist.saveOrder(dir, ['a.mp3', 'b.mp3']);
  assert.deepStrictEqual(playlist.moveTrack(dir, 'a.mp3', 'up'), ['a.mp3', 'b.mp3']);
});

test('moveTrack on an unknown filename is a no-op', () => {
  touch('a.mp3');
  playlist.saveOrder(dir, ['a.mp3']);
  assert.deepStrictEqual(playlist.moveTrack(dir, 'ghost.mp3', 'up'), ['a.mp3']);
});

test('ensureM3u writes absolute paths in saved order', () => {
  ['a.mp3', 'b.mp3'].forEach(touch);
  playlist.saveOrder(dir, ['b.mp3', 'a.mp3']);
  playlist.ensureM3u(dir);
  const m3u = fs.readFileSync(path.join(dir, 'playlist.m3u'), 'utf8');
  assert.strictEqual(m3u, `${path.join(dir, 'b.mp3')}\n${path.join(dir, 'a.mp3')}\n`);
});

test('shuffleOrder preserves the exact set of files and persists', () => {
  const files = ['a.mp3', 'b.mp3', 'c.mp3', 'd.mp3'];
  files.forEach(touch);
  playlist.saveOrder(dir, files);
  const shuffled = playlist.shuffleOrder(dir);
  assert.deepStrictEqual([...shuffled].sort(), files);
  assert.deepStrictEqual([...playlist.getOrderedFiles(dir)].sort(), files);
});

test('saveOrder persists playlist.json', () => {
  touch('a.mp3');
  playlist.saveOrder(dir, ['a.mp3']);
  const json = JSON.parse(fs.readFileSync(path.join(dir, 'playlist.json'), 'utf8'));
  assert.deepStrictEqual(json, ['a.mp3']);
});
