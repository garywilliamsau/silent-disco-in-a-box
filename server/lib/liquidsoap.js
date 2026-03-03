'use strict';

const net = require('net');

const TELNET_HOST = '127.0.0.1';
const TELNET_PORT = 1234;
const COMMAND_TIMEOUT_MS = 5000;
const RECONNECT_DELAY_MS = 3000;

class LiquidsoapClient {
  constructor() {
    this._socket = null;
    this._connected = false;
    this._buffer = '';
    this._pending = [];
    this._reconnTimer = null;
    this._connect();
  }

  _connect() {
    if (this._socket) this._socket.destroy();

    this._socket = new net.Socket();
    this._socket.setEncoding('utf8');
    this._socket.setKeepAlive(true, 5000);

    this._socket.connect(TELNET_PORT, TELNET_HOST, () => {
      this._connected = true;
      this._buffer = '';
      console.log('[liquidsoap] connected');
    });

    this._socket.on('data', (data) => {
      this._buffer += data;
      this._processBuffer();
    });

    this._socket.on('close', () => {
      this._connected = false;
      console.warn('[liquidsoap] disconnected, reconnecting...');
      this._rejectAll(new Error('Liquidsoap disconnected'));
      this._scheduleReconnect();
    });

    this._socket.on('error', (err) => {
      console.error('[liquidsoap] socket error:', err.message);
    });
  }

  _scheduleReconnect() {
    if (this._reconnTimer) return;
    this._reconnTimer = setTimeout(() => {
      this._reconnTimer = null;
      this._connect();
    }, RECONNECT_DELAY_MS);
  }

  _rejectAll(err) {
    while (this._pending.length > 0) {
      const item = this._pending.shift();
      clearTimeout(item.timer);
      item.reject(err);
    }
  }

  _processBuffer() {
    while (true) {
      const endMatch = this._buffer.match(/\r?\nEND\r?\n/);
      if (!endMatch) break;

      const endIdx = endMatch.index;
      const responseText = this._buffer.slice(0, endIdx).replace(/\r/g, '');
      this._buffer = this._buffer.slice(endIdx + endMatch[0].length);

      if (this._pending.length > 0) {
        const item = this._pending.shift();
        clearTimeout(item.timer);
        item.resolve(responseText.trim());
      }
    }
  }

  send(command) {
    return new Promise((resolve, reject) => {
      if (!this._connected) {
        return reject(new Error('Not connected to Liquidsoap'));
      }

      const timer = setTimeout(() => {
        const idx = this._pending.findIndex(p => p.timer === timer);
        if (idx !== -1) this._pending.splice(idx, 1);
        reject(new Error(`Command timed out: ${command}`));
      }, COMMAND_TIMEOUT_MS);

      this._pending.push({ resolve, reject, timer });
      this._socket.write(command + '\n');
    });
  }

  isConnected() {
    return this._connected;
  }
}

const client = new LiquidsoapClient();

function parseNowPlaying(raw) {
  const result = { artist: '', title: '', filename: '' };
  if (!raw) return result;
  for (const line of raw.split('\n')) {
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    if (key in result) result[key] = val;
  }
  return result;
}

async function getNowPlaying(channel) {
  const raw = await client.send(`${channel}.now_playing`);
  return parseNowPlaying(raw);
}

async function skipChannel(channel) {
  return client.send(`${channel}.skip`);
}

async function setAlsaMode(channel, enabled) {
  return client.send(`var.set ${channel}_use_alsa = ${enabled ? 'true' : 'false'}`);
}

async function getAlsaMode(channel) {
  const response = await client.send(`var.get ${channel}_use_alsa`);
  return response === 'true';
}

const PLAYLIST_IDS = { red: 'red_playlist', green: 'green_playlist', blue: 'blue_playlist' };

async function reloadPlaylist(channel) {
  const playlistId = PLAYLIST_IDS[channel];
  if (!playlistId) throw new Error(`Unknown channel: ${channel}`);
  return client.send(`${playlistId}.reload`);
}

async function pushTrack(channel, filePath) {
  return client.send(`${channel}_queue.push ${filePath}`);
}

async function setBluetoothMode(channel, enabled) {
  return client.send(`${channel}.set_bt ${enabled ? 'true' : 'false'}`);
}

async function getBluetoothMode(channel) {
  const response = await client.send(`${channel}.get_bt`);
  return response === 'true';
}

async function setTalkoverActive(active) {
  return client.send(`talkover.set_active ${active ? 'true' : 'false'}`);
}

module.exports = {
  client, getNowPlaying, skipChannel, setAlsaMode, getAlsaMode,
  reloadPlaylist, pushTrack, setBluetoothMode, getBluetoothMode, setTalkoverActive,
};
