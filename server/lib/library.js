'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');

const AUDIO_EXTS = /\.(mp3|m4a|ogg|flac)$/i;
const CATALOG_FILE = 'catalog.json';

let mm;
async function loadMusicMetadata() {
  if (!mm) mm = await import('music-metadata');
  return mm;
}

// In-memory catalog cache
let catalogCache = null;

function getLibraryPath() {
  const conf = config.get();
  const libraryDir = (conf.library && conf.library.path) || '/home/pi/music/library/';
  return libraryDir;
}

function getCatalogFile() {
  return path.join(getLibraryPath(), CATALOG_FILE);
}

function ensureLibraryDir() {
  fs.mkdirSync(getLibraryPath(), { recursive: true });
}

function readCatalogFromDisk() {
  const catalogPath = getCatalogFile();
  try {
    const raw = fs.readFileSync(catalogPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeCatalog(catalog) {
  ensureLibraryDir();
  fs.writeFileSync(getCatalogFile(), JSON.stringify(catalog, null, 2));
  catalogCache = catalog;
}

async function extractMetadata(filePath) {
  try {
    const { parseFile } = await loadMusicMetadata();
    const result = await parseFile(filePath, { skipPostHeaders: true });
    const { common, format } = result;

    return {
      title: common.title || path.basename(filePath, path.extname(filePath)),
      artist: common.artist || common.albumartist || 'Unknown Artist',
      album: common.album || '',
      duration: format.duration || null,
    };
  } catch (err) {
    console.error(`[library] failed to read metadata for ${filePath}:`, err.message);
    return {
      title: path.basename(filePath, path.extname(filePath)),
      artist: 'Unknown Artist',
      album: '',
      duration: null,
    };
  }
}

async function scanLibrary() {
  const libraryDir = getLibraryPath();
  ensureLibraryDir();

  const files = fs.readdirSync(libraryDir)
    .filter(f => AUDIO_EXTS.test(f))
    .sort();

  const catalog = await Promise.all(files.map(async (file) => {
    const fullPath = path.join(libraryDir, file);
    const stat = fs.statSync(fullPath);
    const meta = await extractMetadata(fullPath);

    return {
      filename: file,
      title: meta.title,
      artist: meta.artist,
      album: meta.album,
      duration: meta.duration,
      uploadedAt: stat.mtime.toISOString(),
    };
  }));

  writeCatalog(catalog);
  return catalog;
}

async function getCatalog() {
  if (catalogCache) return catalogCache;

  const fromDisk = readCatalogFromDisk();
  if (fromDisk) {
    catalogCache = fromDisk;
    return catalogCache;
  }

  return scanLibrary();
}

async function addFiles(files) {
  const libraryDir = getLibraryPath();
  ensureLibraryDir();

  const catalog = await getCatalog();
  const added = [];

  for (const file of files) {
    let destName = file.originalname.replace(/[/\\]/g, '_');
    const destPath = path.join(libraryDir, destName);

    // Handle duplicate filenames by appending timestamp
    if (fs.existsSync(destPath)) {
      const ext = path.extname(destName);
      const base = path.basename(destName, ext);
      destName = `${base}_${Date.now()}${ext}`;
    }

    const finalPath = path.join(libraryDir, destName);
    fs.renameSync(file.path, finalPath);

    const meta = await extractMetadata(finalPath);
    const entry = {
      filename: destName,
      title: meta.title,
      artist: meta.artist,
      album: meta.album,
      duration: meta.duration,
      uploadedAt: new Date().toISOString(),
    };

    catalog.push(entry);
    added.push(entry);
  }

  writeCatalog(catalog);
  return added;
}

function removeFile(filename) {
  if (filename.includes('/') || filename.includes('\\')) {
    throw new Error('Invalid filename');
  }

  const libraryDir = getLibraryPath();
  const filePath = path.join(libraryDir, filename);

  // Load catalog (sync path since we need it immediately)
  if (!catalogCache) {
    catalogCache = readCatalogFromDisk() || [];
  }

  const idx = catalogCache.findIndex(e => e.filename === filename);
  if (idx === -1) {
    throw new Error('File not found in catalog');
  }

  const removed = catalogCache.splice(idx, 1)[0];

  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  writeCatalog(catalogCache);
  return removed;
}

async function getAlbumArt(filename) {
  if (filename.includes('/') || filename.includes('\\')) {
    return null;
  }

  const filePath = path.join(getLibraryPath(), filename);

  try {
    const { parseFile, selectCover } = await loadMusicMetadata();
    const result = await parseFile(filePath, { skipPostHeaders: true });
    const cover = selectCover(result.common.picture);

    if (cover) {
      return { data: cover.data, mime: cover.format };
    }
    return null;
  } catch (err) {
    console.error(`[library] failed to read album art for ${filename}:`, err.message);
    return null;
  }
}

module.exports = { getLibraryPath, scanLibrary, getCatalog, addFiles, removeFile, getAlbumArt };
