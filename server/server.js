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
const config = require('./lib/config');

const conf = config.get();
const PORT = conf.server.api_port || 3000;
const CHANNELS = conf.channels.map(c => c.id);

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
        nowPlaying: await liquidsoap.getNowPlaying(ch).catch(() => null),
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

    const result = channels.map(ch => ({
      ...ch,
      ...getChannelConfig(ch.id),
      listeners: stats['/' + ch.id]?.listeners ?? 0,
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
app.post('/api/channels/:id/skip', async (req, res) => {
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
    res.json({ ok: true, channel: id, tracks });
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

// --- GET /api/stats ---
app.get('/api/stats', async (req, res) => {
  try {
    const stats = await icecast.getChannelStats();
    res.json({ ok: true, liquidsoapUp: liquidsoap.client.isConnected(), ...stats });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Admin auth middleware ---
function requireAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${conf.admin.password}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
}

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
    await liquidsoap.reloadPlaylist(id).catch(() => {});
    const tracks = await metadata.scanDirectory(chConf.music_dir);
    res.json({ ok: true, channel: id, uploaded: req.files.length, tracks });
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
  await liquidsoap.reloadPlaylist(id).catch(() => {});
  const tracks = await metadata.scanDirectory(chConf.music_dir);
  res.json({ ok: true, channel: id, tracks });
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
    res.json({ ok: true, channel: id, spotifyMode: enabled });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
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

async function broadcastNowPlaying() {
  if (wss.clients.size === 0) return;

  try {
    const [channels, stats] = await Promise.all([
      Promise.all(CHANNELS.map(async (ch) => ({
        id: ch,
        nowPlaying: await liquidsoap.getNowPlaying(ch).catch(() => null),
        bluetoothMode: await liquidsoap.getBluetoothMode(ch).catch(() => false),
        spotifyMode: await liquidsoap.getSpotifyMode(ch).catch(() => false),
      }))),
      icecast.getChannelStats().catch(() => ({ channels: {} })),
    ]);

    // Override now-playing with BT AVRCP metadata when in Bluetooth mode
    const btNowPlaying = bluetooth.getNowPlaying();
    for (const ch of channels) {
      if (ch.bluetoothMode && btNowPlaying) {
        ch.nowPlaying = {
          title: btNowPlaying.title,
          artist: btNowPlaying.artist,
          filename: '',
        };
      }
      // Override with Spotify metadata when in Spotify mode
      if (ch.spotifyMode) {
        try {
          const spotifyFile = `/tmp/spotify-${ch.id}.json`;
          const raw = fs.readFileSync(spotifyFile, 'utf8');
          const meta = JSON.parse(raw);
          if (meta.title) {
            ch.nowPlaying = {
              title: meta.title,
              artist: meta.artist || 'Spotify',
              filename: '',
            };
          }
        } catch { /* no spotify metadata yet */ }
      }
    }

    // Update play history when track changes
    for (const ch of channels) {
      const filename = ch.nowPlaying?.filename;
      if (filename && filename !== lastKnownFile[ch.id]) {
        if (lastKnownFile[ch.id]) {
          playHistory[ch.id].push(lastKnownFile[ch.id]);
          if (playHistory[ch.id].length > 10) playHistory[ch.id].shift();
        }
        lastKnownFile[ch.id] = filename;
      }
    }

    const result = channels.map(ch => ({
      ...ch,
      listeners: stats.channels['/' + ch.id]?.listeners ?? 0,
    }));

    const msg = JSON.stringify({ type: 'update', channels: result });
    for (const ws of wss.clients) {
      if (ws.readyState === ws.OPEN) ws.send(msg);
    }
  } catch (err) {
    console.warn('[ws] broadcast error:', err.message);
  }
}

setInterval(broadcastNowPlaying, WS_INTERVAL_MS);

wss.on('connection', (ws) => {
  console.log('[ws] client connected');
  broadcastNowPlaying();
  ws.on('close', () => console.log('[ws] client disconnected'));
});

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

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[disco-api] listening on 127.0.0.1:${PORT}`);
});
