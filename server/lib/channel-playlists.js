'use strict';

const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const playlistManager = require('./playlist-manager');
const liquidsoap = require('./liquidsoap');
const library = require('./library');
const config = require('./config');

const DEFAULT_CHANNELS = ['red', 'green', 'blue'];

function getMusicRoot() {
  const conf = config.get();
  // Derive from library path (parent dir) or first channel's music_dir (parent dir)
  if (conf.library && conf.library.path) return path.dirname(conf.library.path);
  if (conf.channels && conf.channels[0]) return path.dirname(conf.channels[0].music_dir);
  return '/home/pi/music';
}

function getAssignmentsPath() {
  return path.join(getMusicRoot(), 'assignments.json');
}

function getChannelM3UPath(channelId) {
  return path.join(getMusicRoot(), `channel-${channelId}.m3u`);
}

async function getAssignments() {
  try {
    const raw = await fs.readFile(getAssignmentsPath(), 'utf8');
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
  const assignPath = getAssignmentsPath();
  const dir = path.dirname(assignPath);
  fsSync.mkdirSync(dir, { recursive: true });
  await fs.writeFile(assignPath, JSON.stringify(assignments, null, 2));
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

// Jump the live channel to a specific track and continue down the playlist from
// there. The clicked track plays immediately via the request queue; the watched
// playlist is rotated to resume at the NEXT track (then wraps around). The saved
// playlist JSON is left untouched — this only affects the live play cursor.
async function playFromTrack(channelId, filename) {
  const assignments = await getAssignments();
  const playlistId = assignments[channelId];
  if (!playlistId) throw new Error('No playlist assigned to this channel');

  const pl = await playlistManager.getPlaylist(playlistId);
  if (!pl) throw new Error('Assigned playlist not found');

  const order = pl.tracks.map(t => t.filename);
  const idx = order.indexOf(filename);
  if (idx === -1) throw new Error('Track is not in this channel\'s playlist');

  const libraryDir = library.getLibraryPath();

  // Playlist resumes at the track after the clicked one, then wraps to the start.
  const rotated = order.slice(idx + 1).concat(order.slice(0, idx + 1));
  const m3uPath = getChannelM3UPath(channelId);
  fsSync.mkdirSync(path.dirname(m3uPath), { recursive: true });
  await fs.writeFile(m3uPath, rotated.map(f => path.join(libraryDir, f)).join('\n') + '\n');

  // Reload the watched playlist (picks up the rotated order for when the queue empties)...
  try {
    await liquidsoap.reloadPlaylist(channelId);
  } catch (err) {
    console.error(`[channel-playlists] reload failed for ${channelId}:`, err.message);
  }
  // ...clear any backlog from previous clicks (otherwise the new track queues
  // behind them and only plays minutes later)...
  try {
    await liquidsoap.flushQueue(channelId);
  } catch (err) {
    console.error(`[channel-playlists] queue flush failed for ${channelId}:`, err.message);
  }
  await new Promise(r => setTimeout(r, 250));
  // ...then push the clicked track to the now-empty queue so it plays right now.
  await liquidsoap.pushTrack(channelId, path.join(libraryDir, filename));

  return { channel: channelId, playing: filename, resumesAt: rotated[0] || null };
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
  playFromTrack,
};
