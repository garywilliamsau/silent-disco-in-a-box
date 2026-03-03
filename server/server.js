'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const liquidsoap = require('./lib/liquidsoap');
const icecast = require('./lib/icecast');
const metadata = require('./lib/metadata');
const config = require('./lib/config');

const conf = config.get();
const PORT = conf.server.api_port || 3000;
const CHANNELS = conf.channels.map(c => c.id);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/api/ws' });

app.use(express.json());

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
  if (filename.includes('..')) return res.status(400).send('Invalid filename');

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

async function broadcastNowPlaying() {
  if (wss.clients.size === 0) return;

  try {
    const [channels, stats] = await Promise.all([
      Promise.all(CHANNELS.map(async (ch) => ({
        id: ch,
        nowPlaying: await liquidsoap.getNowPlaying(ch).catch(() => null),
      }))),
      icecast.getChannelStats().catch(() => ({ channels: {} })),
    ]);

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
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[disco-api] listening on 127.0.0.1:${PORT}`);
});
