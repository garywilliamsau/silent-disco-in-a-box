'use strict';

const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const library = require('./library');

function getPlaylistsPath() {
  const conf = config.get();
  const playlistsDir = (conf.playlists && conf.playlists.path) || '/home/pi/music/playlists/';
  return playlistsDir;
}

function ensurePlaylistsDir() {
  fsSync.mkdirSync(getPlaylistsPath(), { recursive: true });
}

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 50);
}

function playlistFile(id) {
  return path.join(getPlaylistsPath(), `${id}.json`);
}

async function listPlaylists() {
  ensurePlaylistsDir();
  const dir = getPlaylistsPath();

  let files;
  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }

  const jsonFiles = files.filter(f => f.endsWith('.json')).sort();
  const playlists = [];

  for (const file of jsonFiles) {
    try {
      const raw = await fs.readFile(path.join(dir, file), 'utf8');
      const data = JSON.parse(raw);
      playlists.push({
        id: data.id,
        name: data.name,
        trackCount: (data.tracks || []).length,
        createdAt: data.createdAt,
      });
    } catch (err) {
      console.error(`[playlist-manager] failed to read ${file}:`, err.message);
    }
  }

  return playlists;
}

async function getPlaylist(id) {
  if (id.includes('/') || id.includes('\\')) return null;

  const filePath = playlistFile(id);
  let data;
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    data = JSON.parse(raw);
  } catch {
    return null;
  }

  // Enrich tracks with metadata from the library catalog
  const catalog = await library.getCatalog();
  const enrichedTracks = (data.tracks || []).map(filename => {
    const entry = catalog.find(e => e.filename === filename);
    if (entry) {
      return {
        filename,
        title: entry.title,
        artist: entry.artist,
        album: entry.album,
        duration: entry.duration,
      };
    }
    return { filename, title: filename, artist: 'Unknown Artist', album: '', duration: null };
  });

  return {
    id: data.id,
    name: data.name,
    createdAt: data.createdAt,
    tracks: enrichedTracks,
  };
}

async function createPlaylist(name, tracks) {
  ensurePlaylistsDir();

  let id = slugify(name);
  if (!id) id = 'playlist';

  // Check for conflicts and append random suffix if needed
  try {
    await fs.access(playlistFile(id));
    const suffix = crypto.randomBytes(3).toString('hex');
    id = `${id}-${suffix}`;
  } catch {
    // No conflict, id is fine
  }

  const playlist = {
    id,
    name,
    createdAt: new Date().toISOString(),
    tracks: tracks || [],
  };

  await fs.writeFile(playlistFile(id), JSON.stringify(playlist, null, 2));
  return playlist;
}

async function updatePlaylist(id, updates) {
  if (id.includes('/') || id.includes('\\')) return null;

  const filePath = playlistFile(id);
  let data;
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    data = JSON.parse(raw);
  } catch {
    return null;
  }

  if (updates.name !== undefined) data.name = updates.name;
  if (updates.tracks !== undefined) data.tracks = updates.tracks;

  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
  return data;
}

async function deletePlaylist(id) {
  if (id.includes('/') || id.includes('\\')) return false;

  const filePath = playlistFile(id);
  try {
    await fs.unlink(filePath);
    return true;
  } catch {
    return false;
  }
}

async function generateM3U(id, outputPath) {
  const filePath = playlistFile(id);
  let data;
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    data = JSON.parse(raw);
  } catch {
    return false;
  }

  const libraryDir = library.getLibraryPath();
  const lines = (data.tracks || []).map(f => path.join(libraryDir, f));

  try {
    await fs.writeFile(outputPath, lines.join('\n') + '\n');
    return true;
  } catch (err) {
    console.error(`[playlist-manager] failed to write M3U to ${outputPath}:`, err.message);
    return false;
  }
}

async function removeTrackFromAll(filename) {
  ensurePlaylistsDir();
  const dir = getPlaylistsPath();

  let files;
  try {
    files = await fs.readdir(dir);
  } catch {
    return;
  }

  const jsonFiles = files.filter(f => f.endsWith('.json'));

  for (const file of jsonFiles) {
    const filePath = path.join(dir, file);
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const data = JSON.parse(raw);

      if (!data.tracks || !data.tracks.includes(filename)) continue;

      data.tracks = data.tracks.filter(t => t !== filename);
      await fs.writeFile(filePath, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error(`[playlist-manager] failed to update ${file}:`, err.message);
    }
  }
}

module.exports = {
  getPlaylistsPath,
  listPlaylists,
  getPlaylist,
  createPlaylist,
  updatePlaylist,
  deletePlaylist,
  generateM3U,
  removeTrackFromAll,
};
