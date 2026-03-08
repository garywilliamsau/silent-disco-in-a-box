'use strict';

const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { WebSocketServer } = require('ws');
const liquidsoap = require('./lib/liquidsoap');
const icecast = require('./lib/icecast');
const metadata = require('./lib/metadata');
const bluetooth = require('./lib/bluetooth');
const EnergyAnalyser = require('./lib/energy');
const playlist = require('./lib/playlist');
const config = require('./lib/config');
const library = require('./lib/library');
const playlistManager = require('./lib/playlist-manager');
const channelPlaylists = require('./lib/channel-playlists');
const EventStats = require('./lib/event-stats');
const { migrate } = require('./lib/migrate');

const conf = config.get();
const PORT = conf.server.api_port || 3000;
const CHANNELS = conf.channels.map(c => c.id);

// Spotify track metadata per channel — set by librespot track_changed event hook
const spotifyMeta = {};

// Event stats collector
const eventStats = new EventStats(CHANNELS);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const talkoverWss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const { pathname } = new URL(request.url, `http://${request.headers.host}`);
  if (pathname === '/api/ws') {
    wss.handleUpgrade(request, socket, head, (ws) => { wss.emit('connection', ws, request); });
  } else if (pathname === '/api/talkover') {
    talkoverWss.handleUpgrade(request, socket, head, (ws) => { talkoverWss.emit('connection', ws, request); });
  } else {
    socket.destroy();
  }
});

app.use(express.json());

// --- Admin auth middleware ---
function requireAdmin(req, res, next) {
  const auth = req.headers.authorization;
  const queryToken = req.query.token;
  if (auth === `Bearer ${conf.admin.password}` || queryToken === conf.admin.password) {
    return next();
  }
  return res.status(401).json({ ok: false, error: 'Unauthorized' });
}

// --- Talkover state ---
let talkoverEnabled = true; // admin can toggle
let talkoverFifo = null;

function validChannel(id) {
  return CHANNELS.includes(id);
}

function getChannelConfig(id) {
  return conf.channels.find(c => c.id === id);
}

// --- GET /api/config --- public event config
app.get('/api/config', (req, res) => {
  res.json({
    ok: true,
    event: conf.event,
    channels: conf.channels.map(c => ({
      id: c.id,
      name: c.name,
      color: c.color,
    })),
  });
});

// --- GET /api/channels --- all channels with now-playing + stats
app.get('/api/channels', async (req, res) => {
  try {
    const [npResults, statsResult] = await Promise.allSettled([
      Promise.all(CHANNELS.map(async (ch) => ({
        id: ch,
        nowPlaying: spotifyMeta[ch] || await liquidsoap.getNowPlaying(ch).catch(() => null),
        alsaMode: await liquidsoap.getAlsaMode(ch).catch(() => false),
        bluetoothMode: await liquidsoap.getBluetoothMode(ch).catch(() => false),
        spotifyMode: await liquidsoap.getSpotifyMode(ch).catch(() => false),
      }))),
      icecast.getChannelStats(),
    ]);

    const channels = npResults.status === 'fulfilled'
      ? npResults.value
      : CHANNELS.map(id => ({ id, nowPlaying: null, alsaMode: false }));

    const stats = statsResult.status === 'fulfilled'
      ? statsResult.value.channels
      : {};

    const wsListeners = {};
    for (const ws of wss.clients) {
      if (ws.readyState === ws.OPEN && ws.channel) {
        wsListeners[ws.channel] = (wsListeners[ws.channel] || 0) + 1;
      }
    }

    const result = channels.map(ch => ({
      ...ch,
      ...getChannelConfig(ch.id),
      listeners: wsListeners[ch.id] || 0,
    }));

    res.json({ ok: true, channels: result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- GET /api/channels/:id/now-playing ---
app.get('/api/channels/:id/now-playing', async (req, res) => {
  const { id } = req.params;
  if (!validChannel(id)) return res.status(404).json({ ok: false, error: 'Unknown channel' });

  try {
    const nowPlaying = await liquidsoap.getNowPlaying(id);
    res.json({ ok: true, channel: id, nowPlaying });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- POST /api/channels/:id/skip ---
app.post('/api/channels/:id/skip', requireAdmin, async (req, res) => {
  const { id } = req.params;
  if (!validChannel(id)) return res.status(404).json({ ok: false, error: 'Unknown channel' });

  try {
    await liquidsoap.skipChannel(id);
    await new Promise(r => setTimeout(r, 300));
    const nowPlaying = await liquidsoap.getNowPlaying(id);
    res.json({ ok: true, channel: id, nowPlaying });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- POST /api/channels/:id/alsa ---
app.post('/api/channels/:id/alsa', async (req, res) => {
  const { id } = req.params;
  if (!validChannel(id)) return res.status(404).json({ ok: false, error: 'Unknown channel' });

  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ ok: false, error: 'Body must be { "enabled": true|false }' });
  }

  try {
    await liquidsoap.setAlsaMode(id, enabled);
    res.json({ ok: true, channel: id, alsaMode: enabled });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- GET /api/channels/:id/tracks --- list tracks in channel directory
app.get('/api/channels/:id/tracks', async (req, res) => {
  const { id } = req.params;
  if (!validChannel(id)) return res.status(404).json({ ok: false, error: 'Unknown channel' });

  const chConf = getChannelConfig(id);
  try {
    const tracks = await metadata.scanDirectory(chConf.music_dir);
    // Return in playlist order
    const order = playlist.getOrderedFiles(chConf.music_dir);
    const ordered = order.map(f => tracks.find(t => t.filename === f)).filter(Boolean);
    res.json({ ok: true, channel: id, tracks: ordered });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- GET /api/channels/:id/album-art/:filename --- serve album art
app.get('/api/channels/:id/album-art/:filename', async (req, res) => {
  const { id, filename } = req.params;
  if (!validChannel(id)) return res.status(404).send('Unknown channel');
  if (filename.includes('/') || filename.includes('\\')) return res.status(400).send('Invalid filename');

  const chConf = getChannelConfig(id);
  const filePath = path.join(chConf.music_dir, filename);

  await metadata.readTrackMetadata(filePath);
  const art = metadata.getAlbumArt(filePath);

  if (art) {
    res.set('Content-Type', art.mimeType || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(Buffer.from(art.data));
  } else {
    res.redirect('/assets/default-art.png');
  }
});

// --- GET /api/channels/:id/color.png --- solid colour artwork for lock screen
const zlib = require('zlib');
const colorPngCache = {};

function generateColorPng(hex) {
  if (colorPngCache[hex]) return colorPngCache[hex];

  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const size = 64;

  // Build raw image data: filter byte + RGB per pixel, per row
  const raw = Buffer.alloc(size * (1 + size * 3));
  for (let y = 0; y < size; y++) {
    const offset = y * (1 + size * 3);
    raw[offset] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const px = offset + 1 + x * 3;
      raw[px] = r;
      raw[px + 1] = g;
      raw[px + 2] = b;
    }
  }

  const compressed = zlib.deflateSync(raw);

  // PNG file structure
  function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      c = (c >>> 8) ^ crc32Table[(c ^ buf[i]) & 0xff];
    }
    return (c ^ 0xffffffff) >>> 0;
  }
  const crc32Table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crc32Table[n] = c;
  }

  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typeData = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typeData));
    return Buffer.concat([len, typeData, crc]);
  }

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);  // width
  ihdr.writeUInt32BE(size, 4);  // height
  ihdr[8] = 8;                  // bit depth
  ihdr[9] = 2;                  // color type: RGB

  const png = Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', compressed), chunk('IEND', Buffer.alloc(0))]);
  colorPngCache[hex] = png;
  return png;
}

app.get('/api/channels/:id/color.png', (req, res) => {
  const { id } = req.params;
  const chConf = getChannelConfig(id);
  if (!chConf) return res.status(404).send('Unknown channel');

  const png = generateColorPng(chConf.color);
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(png);
});

// --- GET /api/system --- CPU + memory + temperature
app.get('/api/system', (req, res) => {
  const os = require('os');
  const fs = require('fs');
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const load = os.loadavg()[0];
  const cpuPct = Math.round((load / cpus.length) * 100);
  const memPct = Math.round(((totalMem - freeMem) / totalMem) * 100);
  let tempC = null;
  try {
    const raw = fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8');
    tempC = Math.round(parseInt(raw, 10) / 1000);
  } catch { /* not available */ }
  res.json({ ok: true, cpu: cpuPct, mem: memPct, cores: cpus.length, temp: tempC });
});

// --- GET /api/stats ---
app.get('/api/stats', async (req, res) => {
  try {
    const stats = await icecast.getChannelStats();
    res.json({ ok: true, liquidsoapUp: liquidsoap.client.isConnected(), ...stats });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- GET /api/admin/event-stats --- event stats summary
app.get('/api/admin/event-stats', requireAdmin, (req, res) => {
  try {
    const summary = eventStats.getSummary();
    res.json({ ok: true, ...summary });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- POST /api/admin/event-stats/reset --- reset stats for new event
app.post('/api/admin/event-stats/reset', requireAdmin, (req, res) => {
  eventStats.reset();
  res.json({ ok: true });
});

// --- GET /api/admin/channel-switches --- channel switch log
app.get('/api/admin/channel-switches', requireAdmin, (req, res) => {
  try {
    const since = parseInt(req.query.since) || 0;
    const switches = eventStats.getSwitches(since);
    res.json({ ok: true, switches });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- POST /api/admin/login ---
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === conf.admin.password) {
    res.json({ ok: true, token: conf.admin.password });
  } else {
    res.status(401).json({ ok: false, error: 'Wrong password' });
  }
});

// --- Multer setup for file uploads ---
const upload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) {
      const chConf = getChannelConfig(req.params.id);
      if (!chConf) return cb(new Error('Unknown channel'));
      fs.mkdirSync(chConf.music_dir, { recursive: true });
      cb(null, chConf.music_dir);
    },
    filename(req, file, cb) {
      // Sanitize: keep original name, replace path separators
      const safe = file.originalname.replace(/[/\\]/g, '_');
      cb(null, safe);
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024, files: 20 },
  fileFilter(req, file, cb) {
    if (/\.(mp3|m4a|ogg|flac)$/i.test(file.originalname)) {
      cb(null, true);
    } else {
      cb(new Error('Only audio files are allowed (.mp3, .m4a, .ogg, .flac)'));
    }
  },
});

// --- Play history (in-memory, last 10 filenames per channel) ---
const playHistory = {};
CHANNELS.forEach(ch => { playHistory[ch] = []; });

// Rich play history for the history log (separate from playHistory which stores filenames for "previous")
const trackHistory = {};
CHANNELS.forEach(ch => { trackHistory[ch] = []; });
const MAX_TRACK_HISTORY = 200;

// Persist history to disk so it survives restarts
const HISTORY_PATH = path.join(path.dirname(conf.library?.path || '/home/silentdisco/music/library'), 'track-history.json');
let _historySaveTimer = null;

function loadHistory() {
  try {
    const data = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
    for (const ch of CHANNELS) {
      if (Array.isArray(data[ch])) trackHistory[ch] = data[ch].slice(-MAX_TRACK_HISTORY);
    }
    console.log(`[history] loaded from ${HISTORY_PATH}`);
  } catch { /* first run or corrupt — start fresh */ }
}

function saveHistoryDebounced() {
  if (_historySaveTimer) return;
  _historySaveTimer = setTimeout(() => {
    _historySaveTimer = null;
    try {
      fs.writeFileSync(HISTORY_PATH, JSON.stringify(trackHistory, null, 2));
    } catch (err) {
      console.error('[history] save failed:', err.message);
    }
  }, 10000); // write at most every 10 seconds
}

loadHistory();

// --- POST /api/channels/:id/upload ---
app.post('/api/channels/:id/upload', requireAdmin, (req, res, next) => {
  const { id } = req.params;
  if (!validChannel(id)) return res.status(404).json({ ok: false, error: 'Unknown channel' });
  next();
}, upload.array('files', 20), async (req, res) => {
  const { id } = req.params;
  const chConf = getChannelConfig(id);

  try {
    metadata.invalidateDirectory(chConf.music_dir);
    playlist.ensureM3u(chConf.music_dir);
    await liquidsoap.reloadPlaylist(id).catch(() => {});
    const tracks = await metadata.scanDirectory(chConf.music_dir);
    const order = playlist.getOrderedFiles(chConf.music_dir);
    const ordered = order.map(f => tracks.find(t => t.filename === f)).filter(Boolean);
    res.json({ ok: true, channel: id, uploaded: req.files.length, tracks: ordered });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- DELETE /api/channels/:id/tracks/:filename ---
app.delete('/api/channels/:id/tracks/:filename', requireAdmin, async (req, res) => {
  const { id, filename } = req.params;
  if (!validChannel(id)) return res.status(404).json({ ok: false, error: 'Unknown channel' });
  if (filename.includes('/') || filename.includes('\\')) {
    return res.status(400).json({ ok: false, error: 'Invalid filename' });
  }

  const chConf = getChannelConfig(id);
  const filePath = path.join(chConf.music_dir, filename);

  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }

  metadata.invalidateFile(filePath);
  playlist.ensureM3u(chConf.music_dir);
  await liquidsoap.reloadPlaylist(id).catch(() => {});
  const tracks = await metadata.scanDirectory(chConf.music_dir);
  const order = playlist.getOrderedFiles(chConf.music_dir);
  const ordered = order.map(f => tracks.find(t => t.filename === f)).filter(Boolean);
  res.json({ ok: true, channel: id, tracks: ordered });
});

// --- POST /api/channels/:id/tracks/move --- reorder a track up or down
app.post('/api/channels/:id/tracks/move', requireAdmin, async (req, res) => {
  const { id } = req.params;
  if (!validChannel(id)) return res.status(404).json({ ok: false, error: 'Unknown channel' });

  const { filename, direction } = req.body;
  if (!filename || !['up', 'down'].includes(direction)) {
    return res.status(400).json({ ok: false, error: 'Body must be { "filename": "...", "direction": "up"|"down" }' });
  }

  const chConf = getChannelConfig(id);
  playlist.moveTrack(chConf.music_dir, filename, direction);
  await liquidsoap.reloadPlaylist(id).catch(() => {});
  const tracks = await metadata.scanDirectory(chConf.music_dir);

  // Return tracks in playlist order
  const order = playlist.getOrderedFiles(chConf.music_dir);
  const ordered = order.map(f => tracks.find(t => t.filename === f)).filter(Boolean);

  res.json({ ok: true, channel: id, tracks: ordered });
});

// --- POST /api/channels/:id/tracks/shuffle --- randomize track order
app.post('/api/channels/:id/tracks/shuffle', requireAdmin, async (req, res) => {
  const { id } = req.params;
  if (!validChannel(id)) return res.status(404).json({ ok: false, error: 'Unknown channel' });

  const chConf = getChannelConfig(id);
  playlist.shuffleOrder(chConf.music_dir);
  await liquidsoap.reloadPlaylist(id).catch(() => {});
  const tracks = await metadata.scanDirectory(chConf.music_dir);
  const order = playlist.getOrderedFiles(chConf.music_dir);
  const ordered = order.map(f => tracks.find(t => t.filename === f)).filter(Boolean);

  res.json({ ok: true, channel: id, tracks: ordered });
});

// --- POST /api/channels/:id/previous ---
app.post('/api/channels/:id/previous', requireAdmin, async (req, res) => {
  const { id } = req.params;
  if (!validChannel(id)) return res.status(404).json({ ok: false, error: 'Unknown channel' });

  const history = playHistory[id];
  if (history.length === 0) {
    return res.status(400).json({ ok: false, error: 'No previous track' });
  }

  const prevFile = history.pop();
  try {
    await liquidsoap.pushTrack(id, prevFile);
    await new Promise(r => setTimeout(r, 300));
    const nowPlaying = await liquidsoap.getNowPlaying(id);
    res.json({ ok: true, channel: id, nowPlaying });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- GET /api/bluetooth/status --- connected BT devices + channel assignments
app.get('/api/bluetooth/status', requireAdmin, (req, res) => {
  const status = bluetooth.autoAssign(CHANNELS);
  res.json({ ok: true, ...status });
});

// --- POST /api/channels/:id/spotify --- enable/disable Spotify on a channel
app.post('/api/channels/:id/spotify', requireAdmin, async (req, res) => {
  const { id } = req.params;
  if (!validChannel(id)) return res.status(404).json({ ok: false, error: 'Unknown channel' });

  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ ok: false, error: 'Body must be { "enabled": true|false }' });
  }

  try {
    await liquidsoap.setSpotifyMode(id, enabled);
    if (!enabled) delete spotifyMeta[id]; // clear stale track name on manual disconnect
    res.json({ ok: true, channel: id, spotifyMode: enabled });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- POST /api/channels/:id/spotify-meta --- store track metadata from librespot event hook
app.post('/api/channels/:id/spotify-meta', (req, res) => {
  const { id } = req.params;
  if (!validChannel(id)) return res.status(404).json({ ok: false });
  const { title, artist, album } = req.body;
  spotifyMeta[id] = { title: title || '', artist: artist || '', album: album || '', filename: '' };
  res.json({ ok: true });
});

// --- DELETE /api/channels/:id/spotify-meta --- clear metadata when spotify stops
app.delete('/api/channels/:id/spotify-meta', (req, res) => {
  const { id } = req.params;
  delete spotifyMeta[id];
  res.json({ ok: true });
});

// --- POST /api/channels/:id/bluetooth --- enable/disable BT on a channel
app.post('/api/channels/:id/bluetooth', requireAdmin, async (req, res) => {
  const { id } = req.params;
  if (!validChannel(id)) return res.status(404).json({ ok: false, error: 'Unknown channel' });

  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ ok: false, error: 'Body must be { "enabled": true|false }' });
  }

  try {
    await liquidsoap.setBluetoothMode(id, enabled);
    res.json({ ok: true, channel: id, bluetoothMode: enabled });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- POST /api/bluetooth/assign --- reassign a BT device to a different channel
app.post('/api/bluetooth/assign', requireAdmin, async (req, res) => {
  const { mac, channel } = req.body;
  if (!mac || !channel) {
    return res.status(400).json({ ok: false, error: 'Body must be { "mac": "...", "channel": "..." }' });
  }
  if (!validChannel(channel)) {
    return res.status(400).json({ ok: false, error: 'Unknown channel' });
  }

  const success = bluetooth.assignToChannel(mac, channel);
  if (!success) {
    return res.status(404).json({ ok: false, error: 'Device not found' });
  }

  // Disable BT on all channels, then enable on the assigned one
  try {
    for (const ch of CHANNELS) {
      await liquidsoap.setBluetoothMode(ch, ch === channel).catch(() => {});
    }
  } catch { /* best effort */ }

  const status = bluetooth.getStatus();
  res.json({ ok: true, ...status });
});

// --- DELETE /api/bluetooth/devices/:mac --- remove a paired device
app.delete('/api/bluetooth/devices/:mac', requireAdmin, (req, res) => {
  const { mac } = req.params;
  bluetooth.removePairedDevice(mac);
  res.json({ ok: true });
});

// --- GET /api/talkover/status ---
app.get('/api/talkover/status', (req, res) => {
  res.json({ ok: true, enabled: talkoverEnabled });
});

// --- POST /api/talkover/toggle --- admin toggle for talkover
app.post('/api/talkover/toggle', requireAdmin, (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ ok: false, error: 'Body must be { "enabled": true|false }' });
  }
  talkoverEnabled = enabled;
  res.json({ ok: true, enabled: talkoverEnabled });
});

// === LIBRARY ENDPOINTS ===

// Multer for library uploads (shared music library)
const libraryUpload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) {
      const tmpDir = path.join(library.getLibraryPath(), '.tmp');
      fs.mkdirSync(tmpDir, { recursive: true });
      cb(null, tmpDir);
    },
    filename(req, file, cb) {
      const safe = file.originalname.replace(/[/\\]/g, '_');
      cb(null, `${Date.now()}_${safe}`);
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024, files: 20 },
  fileFilter(req, file, cb) {
    if (/\.(mp3|m4a|ogg|flac)$/i.test(file.originalname)) {
      cb(null, true);
    } else {
      cb(new Error('Only audio files are allowed (.mp3, .m4a, .ogg, .flac)'));
    }
  },
});

// --- GET /api/library --- list all tracks in shared library
app.get('/api/library', requireAdmin, async (req, res) => {
  try {
    const catalog = await library.getCatalog();
    res.json({ ok: true, tracks: catalog });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- POST /api/library/upload --- upload files to shared library
app.post('/api/library/upload', requireAdmin, libraryUpload.array('files', 20), async (req, res) => {
  try {
    const added = await library.addFiles(req.files);
    // Refresh M3Us for any channels using playlists that contain new tracks
    await channelPlaylists.refreshAllM3Us().catch(() => {});
    res.json({ ok: true, added, totalTracks: (await library.getCatalog()).length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- DELETE /api/library/:filename --- delete track from library
app.delete('/api/library/:filename', requireAdmin, async (req, res) => {
  const { filename } = req.params;
  try {
    const removed = library.removeFile(filename);
    await playlistManager.removeTrackFromAll(filename);
    await channelPlaylists.refreshAllM3Us().catch(() => {});
    res.json({ ok: true, removed });
  } catch (err) {
    res.status(err.message === 'File not found in catalog' ? 404 : 500).json({ ok: false, error: err.message });
  }
});

// --- PUT /api/library/:filename/tags --- update tags on a library track
app.put('/api/library/:filename/tags', requireAdmin, async (req, res) => {
  const { filename } = req.params;
  const { tags } = req.body;
  if (!Array.isArray(tags)) return res.status(400).json({ ok: false, error: 'tags must be an array' });
  try {
    const entry = library.updateTags(filename, tags);
    res.json({ ok: true, track: entry });
  } catch (err) {
    res.status(err.message === 'File not found in catalog' ? 404 : 500).json({ ok: false, error: err.message });
  }
});

// --- GET /api/library/stream/:filename --- stream audio file for preview
app.get('/api/library/stream/:filename', requireAdmin, (req, res) => {
  const { filename } = req.params;
  if (filename.includes('/') || filename.includes('\\')) return res.status(400).send('Invalid filename');
  const filePath = path.join(library.getLibraryPath(), filename);
  try {
    const stat = fs.statSync(filePath);
    const ext = path.extname(filename).toLowerCase();
    const mimeTypes = { '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.flac': 'audio/flac' };
    res.set('Content-Type', mimeTypes[ext] || 'audio/mpeg');
    res.set('Content-Length', stat.size);
    res.set('Accept-Ranges', 'bytes');

    // Support range requests for seeking
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      res.status(206);
      res.set('Content-Range', `bytes ${start}-${end}/${stat.size}`);
      res.set('Content-Length', end - start + 1);
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      fs.createReadStream(filePath).pipe(res);
    }
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).send('File not found');
    res.status(500).send(err.message);
  }
});

// --- GET /api/library/album-art/:filename --- serve album art from library
app.get('/api/library/album-art/:filename', async (req, res) => {
  const { filename } = req.params;
  const art = await library.getAlbumArt(filename);
  if (art) {
    res.set('Content-Type', art.mime || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(art.data);
  } else {
    res.redirect('/assets/default-art.png');
  }
});

// === PLAYLIST ENDPOINTS ===

// --- GET /api/playlists --- list all playlists
app.get('/api/playlists', requireAdmin, async (req, res) => {
  try {
    const playlists = await playlistManager.listPlaylists();
    res.json({ ok: true, playlists });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- POST /api/playlists --- create a new playlist
app.post('/api/playlists', requireAdmin, async (req, res) => {
  const { name, tracks } = req.body;
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ ok: false, error: 'Name is required' });
  }
  try {
    const pl = await playlistManager.createPlaylist(name, tracks || []);
    res.json({ ok: true, playlist: pl });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- GET /api/playlists/:id --- get playlist details with track metadata
app.get('/api/playlists/:id', requireAdmin, async (req, res) => {
  try {
    const pl = await playlistManager.getPlaylist(req.params.id);
    if (!pl) return res.status(404).json({ ok: false, error: 'Playlist not found' });
    res.json({ ok: true, playlist: pl });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- PUT /api/playlists/:id --- update playlist (name and/or tracks)
app.put('/api/playlists/:id', requireAdmin, async (req, res) => {
  const { name, tracks } = req.body;
  try {
    const pl = await playlistManager.updatePlaylist(req.params.id, { name, tracks });
    if (!pl) return res.status(404).json({ ok: false, error: 'Playlist not found' });
    // Refresh M3Us for channels using this playlist
    await channelPlaylists.refreshAllM3Us().catch(() => {});
    res.json({ ok: true, playlist: pl });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- DELETE /api/playlists/:id --- delete a playlist
app.delete('/api/playlists/:id', requireAdmin, async (req, res) => {
  const playlistId = req.params.id;
  try {
    // Unassign from any channels using this playlist
    const assignments = await channelPlaylists.getAssignments();
    for (const [channelId, assignedId] of Object.entries(assignments)) {
      if (assignedId === playlistId) {
        await channelPlaylists.unassignPlaylist(channelId);
      }
    }
    const deleted = await playlistManager.deletePlaylist(playlistId);
    if (!deleted) return res.status(404).json({ ok: false, error: 'Playlist not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// === CHANNEL PLAYLIST ASSIGNMENT ENDPOINTS ===

// --- GET /api/channels/:id/playlist --- get assigned playlist for channel
app.get('/api/channels/:id/playlist', requireAdmin, async (req, res) => {
  const { id } = req.params;
  if (!validChannel(id)) return res.status(404).json({ ok: false, error: 'Unknown channel' });
  try {
    const pl = await channelPlaylists.getChannelPlaylist(id);
    const assignments = await channelPlaylists.getAssignments();
    res.json({ ok: true, channel: id, playlistId: assignments[id] || null, playlist: pl });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- PUT /api/channels/:id/playlist --- assign or unassign a playlist
app.put('/api/channels/:id/playlist', requireAdmin, async (req, res) => {
  const { id } = req.params;
  if (!validChannel(id)) return res.status(404).json({ ok: false, error: 'Unknown channel' });
  const { playlistId } = req.body;
  try {
    let assignments;
    if (playlistId === null || playlistId === undefined) {
      assignments = await channelPlaylists.unassignPlaylist(id);
    } else {
      // Verify playlist exists
      const pl = await playlistManager.getPlaylist(playlistId);
      if (!pl) return res.status(404).json({ ok: false, error: 'Playlist not found' });
      assignments = await channelPlaylists.assignPlaylist(id, playlistId);
    }
    res.json({ ok: true, channel: id, assignments });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/history — play history per channel
app.get('/api/history', requireAdmin, (req, res) => {
  res.json({ ok: true, history: trackHistory });
});

// === SCHEDULE ENDPOINTS ===
const schedules = [];
let scheduleNextId = 1;

// Check schedules every 30s
setInterval(async () => {
  const now = new Date();
  for (let i = schedules.length - 1; i >= 0; i--) {
    const sched = schedules[i];
    if (new Date(sched.time) <= now) {
      console.log(`[schedule] firing: ${sched.channel} → playlist ${sched.playlistId}`);
      try {
        await channelPlaylists.assignPlaylist(sched.channel, sched.playlistId);
      } catch (err) {
        console.error(`[schedule] failed to assign:`, err.message);
      }
      schedules.splice(i, 1);
    }
  }
}, 30000);

app.get('/api/schedule', requireAdmin, (req, res) => {
  res.json({ ok: true, schedules });
});

app.post('/api/schedule', requireAdmin, async (req, res) => {
  const { channel, playlistId, time } = req.body;
  if (!validChannel(channel)) return res.status(400).json({ ok: false, error: 'Invalid channel' });
  if (!playlistId || !time) return res.status(400).json({ ok: false, error: 'playlistId and time required' });

  const pl = await playlistManager.getPlaylist(playlistId);
  if (!pl) return res.status(404).json({ ok: false, error: 'Playlist not found' });

  const sched = { id: scheduleNextId++, channel, playlistId, playlistName: pl.name, time };
  schedules.push(sched);
  schedules.sort((a, b) => new Date(a.time) - new Date(b.time));
  res.json({ ok: true, schedule: sched });
});

app.delete('/api/schedule/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const idx = schedules.findIndex(s => s.id === id);
  if (idx === -1) return res.status(404).json({ ok: false, error: 'Schedule not found' });
  schedules.splice(idx, 1);
  res.json({ ok: true });
});

// --- Multer error handler ---
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ ok: false, error: err.message });
  }
  if (err && req.path.includes('/upload')) {
    return res.status(400).json({ ok: false, error: err.message });
  }
  next(err);
});

// --- POST /api/admin/system/:action ---
app.post('/api/admin/system/:action', requireAdmin, (req, res) => {
  const { action } = req.params;
  const { exec } = require('child_process');

  if (action === 'restart') {
    res.json({ ok: true, message: 'Restarting...' });
    setTimeout(() => exec('sudo reboot'), 1000);
  } else if (action === 'shutdown') {
    res.json({ ok: true, message: 'Shutting down...' });
    setTimeout(() => exec('sudo shutdown -h now'), 1000);
  } else {
    res.status(400).json({ ok: false, error: 'Unknown action' });
  }
});

// --- 404 for unknown API routes ---
app.use('/api', (req, res) => {
  res.status(404).json({ ok: false, error: 'Not found' });
});

// --- WebSocket: push now-playing updates ---
const WS_INTERVAL_MS = 3000;

// Track last-known filename per channel for play history
const lastKnownFile = {};

// Latest now-playing per channel for switch logging
const latestNowPlaying = {};

async function broadcastNowPlaying() {
  try {
    const [channels, stats] = await Promise.all([
      Promise.all(CHANNELS.map(async (ch) => ({
        id: ch,
        nowPlaying: await liquidsoap.getNowPlaying(ch).catch(() => null),
        alsaMode: await liquidsoap.getAlsaMode(ch).catch(() => false),
        bluetoothMode: await liquidsoap.getBluetoothMode(ch).catch(() => false),
        spotifyMode: await liquidsoap.getSpotifyMode(ch).catch(() => false),
      }))),
      icecast.getChannelStats().catch(() => ({ channels: {} })),
    ]);

    // Override now-playing based on active source mode
    const btNowPlaying = bluetooth.getNowPlaying();
    for (const ch of channels) {
      if (ch.alsaMode) {
        ch.nowPlaying = { title: 'Line In', artist: 'Live Audio', filename: '' };
      } else if (ch.bluetoothMode && btNowPlaying) {
        ch.nowPlaying = {
          title: btNowPlaying.title,
          artist: btNowPlaying.artist,
          filename: '',
        };
      }
      // Override with Spotify metadata when in Spotify mode
      if (ch.spotifyMode && spotifyMeta[ch.id]) {
        ch.nowPlaying = { ...spotifyMeta[ch.id] };
      }
    }

    // Update play history + event stats when track changes
    for (const ch of channels) {
      const filename = ch.nowPlaying?.filename || '';
      const title = ch.nowPlaying?.title || '';
      // Detect change by filename (playlist tracks) or title (BT/Spotify/Line-In)
      const trackKey = filename || title;
      if (trackKey && trackKey !== lastKnownFile[ch.id]) {
        if (lastKnownFile[ch.id]) {
          // Push previous filename for "previous track" feature (only real files)
          if (filename) {
            playHistory[ch.id].push(filename);
            if (playHistory[ch.id].length > 10) playHistory[ch.id].shift();
          }
        }
        lastKnownFile[ch.id] = trackKey;

        // Record in rich track history
        trackHistory[ch.id].push({
          title: title,
          artist: ch.nowPlaying?.artist || '',
          filename: filename,
          playedAt: new Date().toISOString(),
        });
        if (trackHistory[ch.id].length > MAX_TRACK_HISTORY) trackHistory[ch.id].shift();
        saveHistoryDebounced();
      }
      // Record all track changes (including non-file sources like BT/Spotify)
      eventStats.recordTrackChange(ch.id, ch.nowPlaying);
    }

    // Skip WS broadcast if nobody is listening
    if (wss.clients.size === 0) return;

    // Count WebSocket clients per channel (exact, no Icecast double-connection noise)
    const wsListeners = {};
    for (const ws of wss.clients) {
      if (ws.readyState === ws.OPEN && ws.channel) {
        wsListeners[ws.channel] = (wsListeners[ws.channel] || 0) + 1;
      }
    }

    const result = channels.map(ch => ({
      ...ch,
      listeners: wsListeners[ch.id] || 0,
    }));

    // Cache latest now-playing for switch logging
    for (const ch of result) {
      latestNowPlaying[ch.id] = ch.nowPlaying;
    }

    const msg = JSON.stringify({ type: 'update', channels: result });
    for (const ws of wss.clients) {
      if (ws.readyState === ws.OPEN) ws.send(msg);
    }
  } catch (err) {
    console.warn('[ws] broadcast error:', err.message);
  }
}

setInterval(broadcastNowPlaying, WS_INTERVAL_MS);

// Wire event stats collector into the broadcast loop
eventStats.setListenerSource(() => {
  const wsListeners = {};
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN && ws.channel) {
      wsListeners[ws.channel] = (wsListeners[ws.channel] || 0) + 1;
    }
  }
  return wsListeners;
});
eventStats.start();

wss.on('connection', (ws) => {
  ws.channel = null;
  broadcastNowPlaying();
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'listen' && validChannel(msg.channel)) {
        const prev = ws.channel;
        ws.channel = msg.channel;
        // Log channel switch (not initial connection)
        if (prev && prev !== msg.channel) {
          eventStats.recordSwitch(prev, msg.channel, latestNowPlaying);
        }
      }
    } catch { /* ignore malformed messages */ }
  });
  ws.on('close', () => {});
});

// --- Energy analyser: real-time beat data for listener visualizer ---
const energyAnalyser = new EnergyAnalyser(CHANNELS, (energy, beats) => {
  if (wss.clients.size === 0) return;
  const msg = JSON.stringify({ type: 'energy', energy, beats });
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
});

// Start after a delay to let Icecast streams come up
setTimeout(() => {
  energyAnalyser.start();
  console.log('[energy] analyser started');
}, 10000);

// --- Start ---
// --- Talkover WebSocket: receives mic audio from phones ---
const TALKOVER_FIFO = '/tmp/disco-talkover.pcm';

// Create FIFO if needed
try {
  const { execSync } = require('child_process');
  execSync(`[ -p ${TALKOVER_FIFO} ] || mkfifo ${TALKOVER_FIFO}`);
} catch { /* FIFO might already exist */ }

talkoverWss.on('connection', (ws) => {
  console.log('[talkover] client connected');
  let hasData = false;

  ws.on('message', (data) => {
    if (!talkoverEnabled) return;

    // Handle START/STOP control messages for ducking
    const str = (typeof data === 'string') ? data : (data.length <= 10 ? data.toString('utf8') : null);
    if (str === 'START') {
      console.log('[talkover] ducking ON');
      liquidsoap.setTalkoverActive(true).catch(() => {});
      return;
    }
    if (str === 'STOP') {
      console.log('[talkover] ducking OFF');
      liquidsoap.setTalkoverActive(false).catch(() => {});
      return;
    }

    if (!(data instanceof Buffer)) return;

    // Write raw PCM directly to the FIFO
    try {
      if (!talkoverFifo || talkoverFifo.destroyed) {
        talkoverFifo = fs.createWriteStream(TALKOVER_FIFO, { flags: 'a' });
        talkoverFifo.on('error', () => { talkoverFifo = null; });
      }
      talkoverFifo.write(data);
    } catch { /* drop frame if FIFO not ready */ }
  });

  ws.on('close', () => {
    console.log('[talkover] client disconnected');
    liquidsoap.setTalkoverActive(false).catch(() => {});
  });
});

// Generate M3U playlists on startup so Liquidsoap has files to read
conf.channels.forEach(ch => {
  playlist.ensureM3u(ch.music_dir);
  console.log(`[playlist] ${ch.id}: ${playlist.getOrderedFiles(ch.music_dir).length} tracks`);
});

// Run migration from per-channel layout to shared library (one-time, idempotent)
migrate().then(() => {
  console.log('[startup] migration check complete');
}).catch(err => {
  console.error('[startup] migration error (non-fatal):', err.message);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[disco-api] listening on 127.0.0.1:${PORT}`);
});
