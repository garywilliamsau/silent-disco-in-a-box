'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');
const library = require('./library');
const playlistManager = require('./playlist-manager');
const channelPlaylists = require('./channel-playlists');

const AUDIO_EXTS = /\.(mp3|m4a|ogg|flac)$/i;

function getMusicRoot() {
  const libraryDir = library.getLibraryPath();
  return path.dirname(libraryDir);
}

function getMarkerPath() {
  return path.join(getMusicRoot(), '.migrated');
}

function readChannelPlaylistJson(musicDir) {
  const playlistPath = path.join(musicDir, 'playlist.json');
  try {
    const raw = fs.readFileSync(playlistPath, 'utf8');
    const data = JSON.parse(raw);
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.tracks)) return data.tracks;
    return null;
  } catch {
    return null;
  }
}

function findAudioFiles(dir) {
  try {
    return fs.readdirSync(dir).filter(f => AUDIO_EXTS.test(f));
  } catch {
    return [];
  }
}

function copyFileToLibrary(srcDir, filename, channelId, libraryDir) {
  const srcPath = path.join(srcDir, filename);
  let destName = filename;

  if (fs.existsSync(path.join(libraryDir, destName))) {
    const ext = path.extname(destName);
    const base = path.basename(destName, ext);
    destName = `${base}_${channelId}${ext}`;
  }

  const destPath = path.join(libraryDir, destName);
  fs.copyFileSync(srcPath, destPath);
  return destName;
}

/**
 * One-time migration from per-channel music directories
 * to the shared library + playlist system.
 *
 * Safe to call multiple times — if .migrated marker exists, returns early.
 */
async function migrate() {
  if (fs.existsSync(getMarkerPath())) {
    console.log('[migrate] migration marker found, skipping');
    return;
  }

  console.log('[migrate] starting migration from per-channel layout to shared library');

  const conf = config.get();
  const channels = (conf && conf.channels) || [];

  if (channels.length === 0) {
    console.log('[migrate] no channels defined in config, nothing to migrate');
    return;
  }

  const libraryDir = library.getLibraryPath();
  fs.mkdirSync(libraryDir, { recursive: true });

  // Track the mapping of old filenames to new filenames per channel
  const channelTrackMaps = [];

  // Steps 1-3: Copy audio files from each channel directory to the library
  for (const channel of channels) {
    const channelId = channel.id;
    const musicDir = channel.music_dir;

    if (!musicDir) {
      console.log(`[migrate] channel "${channelId}" has no music_dir, skipping`);
      channelTrackMaps.push({ channel, trackMap: new Map(), orderedTracks: [] });
      continue;
    }

    console.log(`[migrate] processing channel "${channelId}" from ${musicDir}`);

    const audioFiles = findAudioFiles(musicDir);
    if (audioFiles.length === 0) {
      console.log(`[migrate] no audio files found in ${musicDir}`);
      channelTrackMaps.push({ channel, trackMap: new Map(), orderedTracks: [] });
      continue;
    }

    // Copy files and build old->new name mapping
    const trackMap = new Map();
    for (const file of audioFiles) {
      const newName = copyFileToLibrary(musicDir, file, channelId, libraryDir);
      trackMap.set(file, newName);
      console.log(`[migrate]   copied ${file}${newName !== file ? ` -> ${newName}` : ''}`);
    }

    // Determine track order from existing playlist.json or fall back to alphabetical
    const playlistOrder = readChannelPlaylistJson(musicDir);
    let orderedTracks;

    if (playlistOrder) {
      console.log(`[migrate]   using playlist.json track order (${playlistOrder.length} entries)`);
      // Map old names to new names, filtering out entries not found on disk
      orderedTracks = playlistOrder
        .filter(name => trackMap.has(name))
        .map(name => trackMap.get(name));
      // Append any files not listed in playlist.json
      for (const [, newName] of trackMap) {
        if (!orderedTracks.includes(newName)) {
          orderedTracks.push(newName);
        }
      }
    } else {
      console.log('[migrate]   no playlist.json found, using alphabetical order');
      orderedTracks = Array.from(trackMap.values()).sort();
    }

    channelTrackMaps.push({ channel, trackMap, orderedTracks });
  }

  // Step 4: Scan the library to build the catalog
  console.log('[migrate] scanning library to build catalog');
  await library.scanLibrary();

  // Steps 5-6: Create playlists and assign to channels
  for (const { channel, orderedTracks } of channelTrackMaps) {
    if (orderedTracks.length === 0) {
      console.log(`[migrate] channel "${channel.id}" has no tracks, skipping playlist creation`);
      continue;
    }

    const channelName = channel.id.charAt(0).toUpperCase() + channel.id.slice(1);
    const playlistName = `${channelName} Channel`;

    console.log(`[migrate] creating playlist "${playlistName}" with ${orderedTracks.length} tracks`);
    const playlist = await playlistManager.createPlaylist(playlistName, orderedTracks);

    console.log(`[migrate] assigning playlist "${playlist.id}" to channel "${channel.id}"`);
    await channelPlaylists.assignPlaylist(channel.id, playlist.id);
  }

  // Step 7: Write the migration marker
  const markerPath = getMarkerPath();
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(markerPath, JSON.stringify({
    migratedAt: new Date().toISOString(),
    channels: channels.map(ch => ch.id),
  }, null, 2));

  console.log('[migrate] migration complete');
}

module.exports = { migrate };
