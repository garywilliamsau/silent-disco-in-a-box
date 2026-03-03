'use strict';

const fs = require('fs');
const path = require('path');

const AUDIO_EXTS = /\.(mp3|m4a|ogg|flac)$/i;

// Manages per-channel playlist order
// Stores order in {music_dir}/playlist.json
// Writes {music_dir}/playlist.m3u for Liquidsoap

function getOrderFile(musicDir) {
  return path.join(musicDir, 'playlist.json');
}

function getM3uFile(musicDir) {
  return path.join(musicDir, 'playlist.m3u');
}

function getOrder(musicDir) {
  const orderFile = getOrderFile(musicDir);
  try {
    const raw = fs.readFileSync(orderFile, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function getFiles(musicDir) {
  if (!fs.existsSync(musicDir)) return [];
  return fs.readdirSync(musicDir)
    .filter(f => AUDIO_EXTS.test(f))
    .sort();
}

// Returns ordered list of filenames, merging saved order with actual files
function getOrderedFiles(musicDir) {
  const files = getFiles(musicDir);
  const savedOrder = getOrder(musicDir);

  if (!savedOrder) return files;

  // Start with saved order, filtering out deleted files
  const ordered = savedOrder.filter(f => files.includes(f));
  // Add any new files not in saved order
  const newFiles = files.filter(f => !savedOrder.includes(f));
  return [...ordered, ...newFiles];
}

function saveOrder(musicDir, orderedFiles) {
  const orderFile = getOrderFile(musicDir);
  fs.writeFileSync(orderFile, JSON.stringify(orderedFiles, null, 2));
  writeM3u(musicDir, orderedFiles);
}

function writeM3u(musicDir, orderedFiles) {
  const m3uFile = getM3uFile(musicDir);
  const lines = orderedFiles.map(f => path.join(musicDir, f));
  fs.writeFileSync(m3uFile, lines.join('\n') + '\n');
}

function moveTrack(musicDir, filename, direction) {
  const ordered = getOrderedFiles(musicDir);
  const idx = ordered.indexOf(filename);
  if (idx === -1) return ordered;

  const newIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (newIdx < 0 || newIdx >= ordered.length) return ordered;

  // Swap
  [ordered[idx], ordered[newIdx]] = [ordered[newIdx], ordered[idx]];
  saveOrder(musicDir, ordered);
  return ordered;
}

// Ensure M3U exists (called on startup and after upload/delete)
function ensureM3u(musicDir) {
  const ordered = getOrderedFiles(musicDir);
  writeM3u(musicDir, ordered);
  return ordered;
}

module.exports = { getOrderedFiles, saveOrder, moveTrack, ensureM3u };
