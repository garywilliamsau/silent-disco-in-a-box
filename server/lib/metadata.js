'use strict';

const path = require('path');
const fs = require('fs');

let mm;
async function loadMusicMetadata() {
  if (!mm) mm = await import('music-metadata');
  return mm;
}

const metadataCache = new Map();

async function readTrackMetadata(filePath) {
  if (metadataCache.has(filePath)) return metadataCache.get(filePath);

  try {
    const { parseFile, selectCover } = await loadMusicMetadata();
    const metadata = await parseFile(filePath, { skipPostHeaders: true });
    const { common, format } = metadata;
    const cover = selectCover(common.picture);

    const result = {
      title: common.title || path.basename(filePath, path.extname(filePath)),
      artist: common.artist || common.albumartist || 'Unknown Artist',
      album: common.album || '',
      duration: format.duration || null,
      hasCover: !!cover,
      coverMimeType: cover ? cover.format : null,
      coverData: cover ? cover.data : null,
    };

    metadataCache.set(filePath, result);
    return result;
  } catch (err) {
    console.error(`Failed to read metadata for ${filePath}:`, err.message);
    return {
      title: path.basename(filePath, path.extname(filePath)),
      artist: 'Unknown Artist',
      album: '',
      duration: null,
      hasCover: false,
      coverMimeType: null,
      coverData: null,
    };
  }
}

async function scanDirectory(dirPath) {
  if (!fs.existsSync(dirPath)) return [];

  const files = fs.readdirSync(dirPath)
    .filter(f => /\.(mp3|m4a|ogg|flac)$/i.test(f))
    .sort();

  return Promise.all(files.map(async (file) => {
    const fullPath = path.join(dirPath, file);
    const meta = await readTrackMetadata(fullPath);
    const { coverData, ...safeMeta } = meta;
    return { filename: file, ...safeMeta };
  }));
}

function getAlbumArt(filePath) {
  const cached = metadataCache.get(filePath);
  if (cached && cached.coverData) {
    return { data: cached.coverData, mimeType: cached.coverMimeType };
  }
  return null;
}

module.exports = { readTrackMetadata, scanDirectory, getAlbumArt };
