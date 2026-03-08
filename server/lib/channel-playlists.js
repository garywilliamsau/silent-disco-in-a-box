'use strict';

const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const playlistManager = require('./playlist-manager');
const liquidsoap = require('./liquidsoap');

const ASSIGNMENTS_PATH = '/home/pi/music/assignments.json';
const CHANNEL_M3U_DIR = '/home/pi/music';
const DEFAULT_CHANNELS = ['red', 'green', 'blue'];

function getAssignmentsPath() {
  return ASSIGNMENTS_PATH;
}

function getChannelM3UPath(channelId) {
  return path.join(CHANNEL_M3U_DIR, `channel-${channelId}.m3u`);
}

async function getAssignments() {
  try {
    const raw = await fs.readFile(ASSIGNMENTS_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    const defaults = {};
    for (const ch of DEFAULT_CHANNELS) {
      defaults[ch] = null;
    }
    return defaults;
  }
}

async function saveAssignments(assignments) {
  const dir = path.dirname(ASSIGNMENTS_PATH);
  fsSync.mkdirSync(dir, { recursive: true });
  await fs.writeFile(ASSIGNMENTS_PATH, JSON.stringify(assignments, null, 2));
}

async function getChannelPlaylist(channelId) {
  const assignments = await getAssignments();
  const playlistId = assignments[channelId];
  if (!playlistId) return null;
  return playlistManager.getPlaylist(playlistId);
}

async function assignPlaylist(channelId, playlistId) {
  const assignments = await getAssignments();
  assignments[channelId] = playlistId;
  await saveAssignments(assignments);

  // Generate the M3U file for this channel
  const m3uPath = getChannelM3UPath(channelId);
  await playlistManager.generateM3U(playlistId, m3uPath);

  // Reload the Liquidsoap playlist
  try {
    await liquidsoap.reloadPlaylist(channelId);
  } catch (err) {
    console.error(`[channel-playlists] failed to reload liquidsoap playlist for ${channelId}:`, err.message);
  }

  return assignments;
}

async function unassignPlaylist(channelId) {
  const assignments = await getAssignments();
  assignments[channelId] = null;
  await saveAssignments(assignments);

  // Write an empty M3U so Liquidsoap has silence
  const m3uPath = getChannelM3UPath(channelId);
  const dir = path.dirname(m3uPath);
  fsSync.mkdirSync(dir, { recursive: true });
  await fs.writeFile(m3uPath, '');

  // Reload the Liquidsoap playlist
  try {
    await liquidsoap.reloadPlaylist(channelId);
  } catch (err) {
    console.error(`[channel-playlists] failed to reload liquidsoap playlist for ${channelId}:`, err.message);
  }

  return assignments;
}

async function refreshChannelM3U(channelId) {
  const assignments = await getAssignments();
  const playlistId = assignments[channelId];

  const m3uPath = getChannelM3UPath(channelId);
  const dir = path.dirname(m3uPath);
  fsSync.mkdirSync(dir, { recursive: true });

  if (!playlistId) {
    await fs.writeFile(m3uPath, '');
    return;
  }

  await playlistManager.generateM3U(playlistId, m3uPath);

  try {
    await liquidsoap.reloadPlaylist(channelId);
  } catch (err) {
    console.error(`[channel-playlists] failed to reload liquidsoap playlist for ${channelId}:`, err.message);
  }
}

async function refreshAllM3Us() {
  const assignments = await getAssignments();

  for (const channelId of Object.keys(assignments)) {
    await refreshChannelM3U(channelId);
  }
}

module.exports = {
  getAssignmentsPath,
  getChannelM3UPath,
  getAssignments,
  getChannelPlaylist,
  assignPlaylist,
  unassignPlaylist,
  refreshChannelM3U,
  refreshAllM3Us,
};
