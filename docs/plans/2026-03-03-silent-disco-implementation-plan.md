# Silent Disco in a Box - Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a portable, self-contained silent disco system on a Raspberry Pi 4 with 3 streaming channels, a party web portal, and an admin panel.

**Architecture:** Raspberry Pi 4 runs as a WiFi hotspot (hostapd + dnsmasq) with Icecast2 streaming 3 MP3 channels fed by Liquidsoap. Nginx serves a web portal and proxies streams/API. A Node.js Express backend manages playlists via Liquidsoap's telnet API and exposes now-playing/stats via REST + WebSocket.

**Tech Stack:** Raspberry Pi OS Lite (64-bit), hostapd, dnsmasq, Icecast2, Liquidsoap 2.x, Node.js 18+, Express, Nginx, vanilla HTML/CSS/JS (no framework - keeps it simple and fast on Pi)

---

## Project Structure

```
/Users/gary/Documents/AI Silent Disco/
├── docs/plans/                    # Design + implementation docs
├── pi-setup/                      # Bash scripts for Pi configuration
│   ├── install.sh                 # Master install script
│   ├── configure-network.sh       # hostapd + dnsmasq setup
│   └── configure-services.sh      # Icecast + Liquidsoap + systemd
├── config/                        # Configuration templates
│   ├── disco.conf                 # Master config (JSON) - event name, passwords, etc.
│   ├── hostapd.conf               # WiFi AP config
│   ├── dnsmasq.conf               # DHCP + captive portal DNS
│   ├── icecast.xml                # Icecast2 config
│   ├── disco.liq                  # Liquidsoap config
│   └── nginx-disco.conf           # Nginx site config
├── server/                        # Node.js admin backend
│   ├── package.json
│   ├── server.js                  # Express app entry point
│   └── lib/
│       ├── liquidsoap.js          # Liquidsoap telnet client
│       ├── icecast.js             # Icecast stats fetcher
│       ├── metadata.js            # MP3 ID3 tag reader
│       └── config.js              # Reads disco.conf
├── web/                           # Static web portal (served by Nginx)
│   ├── index.html                 # Listener SPA
│   ├── admin.html                 # Admin panel SPA
│   ├── css/
│   │   ├── main.css               # Listener styles
│   │   └── admin.css              # Admin styles
│   ├── js/
│   │   ├── app.js                 # Listener app logic
│   │   ├── audio.js               # Audio playback + iOS handling
│   │   ├── visualizer.js          # Web Audio API visualizer
│   │   ├── mediasession.js        # Lock screen controls
│   │   ├── api.js                 # API client + WebSocket
│   │   └── admin.js               # Admin panel logic
│   └── assets/
│       ├── default-art.png        # Placeholder album art
│       └── favicon.ico
└── systemd/                       # Service files
    ├── liquidsoap-disco.service
    └── disco-api.service
```

---

## Task 1: Project Scaffolding + Master Config

**Files:**
- Create: `config/disco.conf`
- Create: `server/package.json`
- Create: `server/lib/config.js`

**Step 1: Create the master configuration file**

This is the single source of truth for all configurable values. All other config files reference or are generated from this.

```json
// config/disco.conf
{
  "event": {
    "name": "Silent Disco",
    "tagline": "Put on your headphones and pick a channel"
  },
  "wifi": {
    "ssid": "SilentDisco",
    "password": "letsdance",
    "channel": 6,
    "country_code": "GB"
  },
  "network": {
    "ip": "192.168.4.1",
    "dhcp_start": "192.168.4.10",
    "dhcp_end": "192.168.4.200",
    "netmask": "255.255.255.0"
  },
  "icecast": {
    "port": 8000,
    "source_password": "hackme",
    "admin_user": "admin",
    "admin_password": "adminpass"
  },
  "liquidsoap": {
    "telnet_port": 1234,
    "bitrate": 128,
    "samplerate": 44100
  },
  "channels": [
    { "id": "red", "name": "Red", "color": "#ff1744", "music_dir": "/home/pi/music/red" },
    { "id": "green", "name": "Green", "color": "#00e676", "music_dir": "/home/pi/music/green" },
    { "id": "blue", "name": "Blue", "color": "#2979ff", "music_dir": "/home/pi/music/blue" }
  ],
  "admin": {
    "password": "disco2024"
  },
  "server": {
    "api_port": 3000
  }
}
```

**Step 2: Create server/package.json**

```json
{
  "name": "silent-disco-api",
  "version": "1.0.0",
  "description": "Silent Disco in a Box - Admin API",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "node --watch server.js"
  },
  "dependencies": {
    "express": "^4.21.0",
    "ws": "^8.18.0",
    "music-metadata": "^10.6.0"
  }
}
```

**Step 3: Create server/lib/config.js**

```javascript
// server/lib/config.js
'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = process.env.DISCO_CONFIG
  || path.join(__dirname, '..', '..', 'config', 'disco.conf');

let config = null;

function load() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  config = JSON.parse(raw);
  return config;
}

function get() {
  if (!config) load();
  return config;
}

module.exports = { load, get };
```

**Step 4: Install dependencies**

Run: `cd server && npm install`

**Step 5: Commit**

```bash
git add config/ server/package.json server/lib/config.js
git commit -m "feat: add project scaffolding with master config and package.json"
```

---

## Task 2: Icecast2 Configuration

**Files:**
- Create: `config/icecast.xml`

**Step 1: Create Icecast config**

```xml
<!-- config/icecast.xml -->
<icecast>
  <limits>
    <clients>200</clients>
    <sources>10</sources>
    <queue-size>524288</queue-size>
    <client-timeout>30</client-timeout>
    <header-timeout>15</header-timeout>
    <source-timeout>10</source-timeout>
    <burst-on-connect>1</burst-on-connect>
    <burst-size>65536</burst-size>
  </limits>

  <authentication>
    <source-password>hackme</source-password>
    <relay-password>hackme-relay</relay-password>
    <admin-user>admin</admin-user>
    <admin-password>adminpass</admin-password>
  </authentication>

  <hostname>disco.local</hostname>
  <location>Silent Disco</location>
  <admin>admin@disco.local</admin>

  <listen-socket>
    <port>8000</port>
    <bind-address>127.0.0.1</bind-address>
  </listen-socket>

  <mount type="normal">
    <mount-name>/red</mount-name>
    <stream-name>Red Channel</stream-name>
    <stream-description>Silent Disco - Red</stream-description>
    <max-listeners>100</max-listeners>
    <public>0</public>
  </mount>

  <mount type="normal">
    <mount-name>/green</mount-name>
    <stream-name>Green Channel</stream-name>
    <stream-description>Silent Disco - Green</stream-description>
    <max-listeners>100</max-listeners>
    <public>0</public>
  </mount>

  <mount type="normal">
    <mount-name>/blue</mount-name>
    <stream-name>Blue Channel</stream-name>
    <stream-description>Silent Disco - Blue</stream-description>
    <max-listeners>100</max-listeners>
    <public>0</public>
  </mount>

  <paths>
    <basedir>/usr/share/icecast2</basedir>
    <logdir>/var/log/icecast2</logdir>
    <webroot>/usr/share/icecast2/web</webroot>
    <adminroot>/usr/share/icecast2/admin</adminroot>
    <pidfile>/run/icecast2/icecast2.pid</pidfile>
    <alias source="/" dest="/status.xsl"/>
  </paths>

  <logging>
    <accesslog>access.log</accesslog>
    <errorlog>error.log</errorlog>
    <loglevel>3</loglevel>
    <logsize>10000</logsize>
  </logging>

  <security>
    <chroot>0</chroot>
  </security>
</icecast>
```

**Step 2: Commit**

```bash
git add config/icecast.xml
git commit -m "feat: add Icecast2 config with 3 mount points (red/green/blue)"
```

---

## Task 3: Liquidsoap Configuration

**Files:**
- Create: `config/disco.liq`

**Step 1: Create Liquidsoap 2.x config**

```liquidsoap
#!/usr/bin/liquidsoap

# Silent Disco in a Box - Liquidsoap 2.x Configuration

# Logging
log.file.set(true)
log.file.path.set("/var/log/liquidsoap/disco.log")
log.stdout.set(false)
log.level.set(3)

# Telnet server for remote control from Node.js
settings.server.telnet.set(true)
settings.server.telnet.bind_addr.set("127.0.0.1")
settings.server.telnet.port.set(1234)

# Audio settings
settings.frame.audio.samplerate.set(44100)
settings.frame.audio.channels.set(2)

# === CHANNEL: RED ===

red_playlist = playlist(
  id="red_playlist",
  mode="randomize",
  reload=3600,
  "/home/pi/music/red"
)

red_use_alsa = interactive.bool("red_use_alsa", false)

red_alsa = input.alsa(
  id="red_alsa",
  bufferize=true,
  fallible=true,
  device="default"
)

red_source = switch(
  id="red_switch",
  track_sensitive=false,
  [
    ({red_use_alsa()}, red_alsa),
    ({true}, red_playlist)
  ]
)

red_safe = mksafe(red_source)

red_now_playing = ref([("artist",""), ("title",""), ("filename","")])

red_safe.on_metadata(fun(m) -> begin
  red_now_playing := m
end)

server.register(
  namespace="red",
  description="Get now-playing metadata for red channel",
  usage="now_playing",
  "now_playing",
  fun(_) -> begin
    m = red_now_playing()
    artist = list.assoc(default="", "artist", m)
    title = list.assoc(default="", "title", m)
    filename = list.assoc(default="", "filename", m)
    "artist=#{artist}\ntitle=#{title}\nfilename=#{filename}"
  end
)

server.register(
  namespace="red",
  description="Skip current track on red channel",
  usage="skip",
  "skip",
  fun(_) -> begin
    source.skip(red_safe)
    "Skipped."
  end
)

output.icecast(
  id="red_icecast",
  %mp3(bitrate=128, samplerate=44100, stereo=true, id3v2=true),
  host="127.0.0.1",
  port=8000,
  password="hackme",
  mount="/red",
  name="Red Channel",
  description="Silent Disco - Red",
  public=false,
  fallible=false,
  red_safe
)

# === CHANNEL: GREEN ===

green_playlist = playlist(
  id="green_playlist",
  mode="randomize",
  reload=3600,
  "/home/pi/music/green"
)

green_use_alsa = interactive.bool("green_use_alsa", false)

green_alsa = input.alsa(
  id="green_alsa",
  bufferize=true,
  fallible=true,
  device="default"
)

green_source = switch(
  id="green_switch",
  track_sensitive=false,
  [
    ({green_use_alsa()}, green_alsa),
    ({true}, green_playlist)
  ]
)

green_safe = mksafe(green_source)

green_now_playing = ref([("artist",""), ("title",""), ("filename","")])

green_safe.on_metadata(fun(m) -> begin
  green_now_playing := m
end)

server.register(
  namespace="green",
  description="Get now-playing metadata for green channel",
  usage="now_playing",
  "now_playing",
  fun(_) -> begin
    m = green_now_playing()
    artist = list.assoc(default="", "artist", m)
    title = list.assoc(default="", "title", m)
    filename = list.assoc(default="", "filename", m)
    "artist=#{artist}\ntitle=#{title}\nfilename=#{filename}"
  end
)

server.register(
  namespace="green",
  description="Skip current track on green channel",
  usage="skip",
  "skip",
  fun(_) -> begin
    source.skip(green_safe)
    "Skipped."
  end
)

output.icecast(
  id="green_icecast",
  %mp3(bitrate=128, samplerate=44100, stereo=true, id3v2=true),
  host="127.0.0.1",
  port=8000,
  password="hackme",
  mount="/green",
  name="Green Channel",
  description="Silent Disco - Green",
  public=false,
  fallible=false,
  green_safe
)

# === CHANNEL: BLUE ===

blue_playlist = playlist(
  id="blue_playlist",
  mode="randomize",
  reload=3600,
  "/home/pi/music/blue"
)

blue_use_alsa = interactive.bool("blue_use_alsa", false)

blue_alsa = input.alsa(
  id="blue_alsa",
  bufferize=true,
  fallible=true,
  device="default"
)

blue_source = switch(
  id="blue_switch",
  track_sensitive=false,
  [
    ({blue_use_alsa()}, blue_alsa),
    ({true}, blue_playlist)
  ]
)

blue_safe = mksafe(blue_source)

blue_now_playing = ref([("artist",""), ("title",""), ("filename","")])

blue_safe.on_metadata(fun(m) -> begin
  blue_now_playing := m
end)

server.register(
  namespace="blue",
  description="Get now-playing metadata for blue channel",
  usage="now_playing",
  "now_playing",
  fun(_) -> begin
    m = blue_now_playing()
    artist = list.assoc(default="", "artist", m)
    title = list.assoc(default="", "title", m)
    filename = list.assoc(default="", "filename", m)
    "artist=#{artist}\ntitle=#{title}\nfilename=#{filename}"
  end
)

server.register(
  namespace="blue",
  description="Skip current track on blue channel",
  usage="skip",
  "skip",
  fun(_) -> begin
    source.skip(blue_safe)
    "Skipped."
  end
)

output.icecast(
  id="blue_icecast",
  %mp3(bitrate=128, samplerate=44100, stereo=true, id3v2=true),
  host="127.0.0.1",
  port=8000,
  password="hackme",
  mount="/blue",
  name="Blue Channel",
  description="Silent Disco - Blue",
  public=false,
  fallible=false,
  blue_safe
)
```

**Step 2: Commit**

```bash
git add config/disco.liq
git commit -m "feat: add Liquidsoap config with 3 channels, telnet control, and line-in support"
```

---

## Task 4: Network Configuration (hostapd + dnsmasq)

**Files:**
- Create: `config/hostapd.conf`
- Create: `config/dnsmasq.conf`

**Step 1: Create hostapd config**

```ini
# config/hostapd.conf
# WiFi Access Point configuration for Silent Disco

interface=wlan0
driver=nl80211
ssid=SilentDisco
ignore_broadcast_ssid=0
country_code=GB
hw_mode=g
channel=6
ieee80211n=1
ht_capab=[HT40][SHORT-GI-20][SHORT-GI-40]
wmm_enabled=1
max_num_sta=75
auth_algs=1
wpa=2
wpa_passphrase=letsdance
wpa_key_mgmt=WPA-PSK
wpa_pairwise=CCMP
rsn_pairwise=CCMP
macaddr_acl=0
logger_syslog=-1
logger_syslog_level=2
logger_stdout=-1
logger_stdout_level=2
```

**Step 2: Create dnsmasq config**

```ini
# config/dnsmasq.conf
# DHCP + captive portal DNS for Silent Disco

interface=wlan0
bind-interfaces
no-resolv
domain-needed
bogus-priv

# DHCP pool
dhcp-range=192.168.4.10,192.168.4.200,255.255.255.0,12h
dhcp-option=option:router,192.168.4.1
dhcp-option=option:dns-server,192.168.4.1

# Redirect ALL DNS to the Pi (captive portal)
address=/#/192.168.4.1

# Local hostnames
address=/disco.local/192.168.4.1

# Lease file on tmpfs to protect SD card
dhcp-leasefile=/tmp/dnsmasq.leases
```

**Step 3: Commit**

```bash
git add config/hostapd.conf config/dnsmasq.conf
git commit -m "feat: add hostapd and dnsmasq configs for WiFi hotspot + captive portal"
```

---

## Task 5: Nginx Configuration

**Files:**
- Create: `config/nginx-disco.conf`

**Step 1: Create Nginx config**

```nginx
# config/nginx-disco.conf
# Nginx config for Silent Disco - serves web portal, proxies streams and API

upstream icecast {
    server 127.0.0.1:8000;
    keepalive 32;
}

upstream api {
    server 127.0.0.1:3000;
    keepalive 16;
}

server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    root /var/www/disco;
    index index.html;

    # --- Captive Portal Detection ---

    # iOS / macOS
    location = /hotspot-detect.html {
        add_header Content-Type "text/html";
        return 200 '<HTML><HEAD><TITLE>Success</TITLE></HEAD><BODY>Success</BODY></HTML>';
    }

    location = /library/test/success.html {
        add_header Content-Type "text/html";
        return 200 '<HTML><HEAD><TITLE>Success</TITLE></HEAD><BODY>Success</BODY></HTML>';
    }

    # Android / Chrome OS
    location = /generate_204 {
        return 302 http://192.168.4.1/;
    }

    location = /gen_204 {
        return 302 http://192.168.4.1/;
    }

    # Windows
    location = /ncsi.txt {
        add_header Content-Type "text/plain";
        return 200 'Microsoft NCSI';
    }

    location = /connecttest.txt {
        add_header Content-Type "text/plain";
        return 200 'Microsoft Connect Test';
    }

    # Firefox
    location = /success.txt {
        add_header Content-Type "text/plain";
        return 200 'success';
    }

    # --- Icecast Stream Proxy ---

    location /stream/ {
        rewrite ^/stream/(.*)$ /$1 break;

        proxy_pass http://icecast;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Connection '';

        proxy_max_temp_file_size 0;
    }

    # --- Node.js API Proxy ---

    location /api/ {
        proxy_pass http://api;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';

        proxy_read_timeout 60s;
        proxy_buffering off;
    }

    # --- Static Files ---

    location / {
        try_files $uri $uri/ /index.html;

        location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf)$ {
            expires 7d;
            add_header Cache-Control "public, immutable";
        }

        location = /index.html {
            add_header Cache-Control "no-store, no-cache, must-revalidate";
        }
    }

    access_log /var/log/nginx/disco_access.log;
    error_log /var/log/nginx/disco_error.log warn;
}
```

**Step 2: Commit**

```bash
git add config/nginx-disco.conf
git commit -m "feat: add Nginx config with stream proxy, API proxy, and captive portal handling"
```

---

## Task 6: Node.js Backend - Liquidsoap Client

**Files:**
- Create: `server/lib/liquidsoap.js`

**Step 1: Create the Liquidsoap telnet client**

```javascript
// server/lib/liquidsoap.js
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
      const endIdx = this._buffer.indexOf('\nEND\n');
      if (endIdx === -1) break;

      const responseText = this._buffer.slice(0, endIdx);
      this._buffer = this._buffer.slice(endIdx + 5);

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

module.exports = { client, getNowPlaying, skipChannel, setAlsaMode, getAlsaMode };
```

**Step 2: Commit**

```bash
git add server/lib/liquidsoap.js
git commit -m "feat: add Liquidsoap telnet client with now-playing, skip, and ALSA mode control"
```

---

## Task 7: Node.js Backend - Icecast Stats + Metadata

**Files:**
- Create: `server/lib/icecast.js`
- Create: `server/lib/metadata.js`

**Step 1: Create Icecast stats fetcher**

```javascript
// server/lib/icecast.js
'use strict';

const http = require('http');

function fetchStats() {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port: 8000, path: '/status-json.xsl' },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error('Failed to parse Icecast stats: ' + e.message));
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('Icecast stats timeout')));
  });
}

async function getChannelStats() {
  const data = await fetchStats();
  const icestats = data.icestats || {};

  let sources = icestats.source || [];
  if (!Array.isArray(sources)) sources = [sources];

  const byMount = {};
  for (const src of sources) {
    const url = src.listenurl || '';
    const mount = '/' + url.split('/').pop();
    byMount[mount] = {
      mount,
      listeners: src.listeners || 0,
      title: src.title || '',
      artist: src.artist || '',
    };
  }

  return {
    totalClients: icestats.clients || 0,
    totalSources: icestats.sources || 0,
    channels: byMount,
  };
}

module.exports = { fetchStats, getChannelStats };
```

**Step 2: Create metadata reader**

```javascript
// server/lib/metadata.js
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
```

**Step 3: Commit**

```bash
git add server/lib/icecast.js server/lib/metadata.js
git commit -m "feat: add Icecast stats fetcher and MP3 metadata reader"
```

---

## Task 8: Node.js Backend - Express Server

**Files:**
- Create: `server/server.js`

**Step 1: Create the Express server with all API routes**

```javascript
// server/server.js
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

// --- Channel validation ---
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

// --- GET /api/channels/:id/album-art/:filename --- serve album art from MP3
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
```

**Step 2: Commit**

```bash
git add server/server.js
git commit -m "feat: add Express server with channel API, admin endpoints, and WebSocket updates"
```

---

## Task 9: Listener Web Portal - HTML + CSS

**Files:**
- Create: `web/index.html`
- Create: `web/css/main.css`

**Step 1: Create the listener HTML shell**

```html
<!-- web/index.html -->
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no, viewport-fit=cover">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="theme-color" content="#0a0a0f">
  <title>Silent Disco</title>
  <link rel="stylesheet" href="/css/main.css">
  <link rel="icon" href="/assets/favicon.ico">
</head>
<body>

  <!-- Start Screen -->
  <div id="startScreen" class="screen active">
    <div class="start-content">
      <div class="logo-pulse"></div>
      <h1 id="eventName">Silent Disco</h1>
      <p id="eventTagline">Put on your headphones and pick a channel</p>
      <button id="startBtn" class="btn-start">Join the Disco</button>
    </div>
    <canvas id="bgCanvas" class="bg-canvas"></canvas>
  </div>

  <!-- Channel Select Screen -->
  <div id="channelScreen" class="screen">
    <h2 class="screen-title">Choose Your Channel</h2>
    <div id="channelCards" class="channel-cards">
      <!-- Populated by JS -->
    </div>
  </div>

  <!-- Player Screen -->
  <div id="playerScreen" class="screen">
    <canvas id="visualizer" class="visualizer"></canvas>
    <div class="player-content">
      <div class="now-playing">
        <img id="albumArt" class="album-art" src="/assets/default-art.png" alt="Album Art">
        <div class="track-info">
          <div id="trackTitle" class="track-title">Loading...</div>
          <div id="trackArtist" class="track-artist"></div>
        </div>
      </div>
      <div id="channelName" class="channel-label"></div>
      <div id="listenerCount" class="listener-count"></div>
      <div class="channel-dots" id="channelDots">
        <!-- Populated by JS -->
      </div>
    </div>
    <audio id="audioPlayer" preload="none"></audio>
  </div>

  <script src="/js/api.js"></script>
  <script src="/js/audio.js"></script>
  <script src="/js/visualizer.js"></script>
  <script src="/js/mediasession.js"></script>
  <script src="/js/app.js"></script>
</body>
</html>
```

**Step 2: Create the listener CSS**

This is the full party experience - dark theme, glowing colors, smooth animations, responsive design.

```css
/* web/css/main.css */

*, *::before, *::after {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

:root {
  --bg: #0a0a0f;
  --bg-card: rgba(255, 255, 255, 0.05);
  --text: #f0f0f5;
  --text-dim: rgba(255, 255, 255, 0.5);
  --red: #ff1744;
  --green: #00e676;
  --blue: #2979ff;
  --radius: 16px;
  --safe-bottom: env(safe-area-inset-bottom, 0px);
}

html, body {
  height: 100%;
  overflow: hidden;
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  -webkit-font-smoothing: antialiased;
  -webkit-tap-highlight-color: transparent;
  user-select: none;
}

/* --- Screens --- */

.screen {
  position: fixed;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.5s ease;
  z-index: 1;
}

.screen.active {
  opacity: 1;
  pointer-events: all;
  z-index: 10;
}

/* --- Start Screen --- */

.bg-canvas {
  position: absolute;
  inset: 0;
  z-index: 0;
  width: 100%;
  height: 100%;
}

.start-content {
  position: relative;
  z-index: 1;
  text-align: center;
  padding: 2rem;
}

.logo-pulse {
  width: 80px;
  height: 80px;
  margin: 0 auto 2rem;
  border-radius: 50%;
  background: radial-gradient(circle, var(--red), var(--blue));
  animation: pulse 2s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { transform: scale(1); box-shadow: 0 0 20px var(--red); }
  50% { transform: scale(1.15); box-shadow: 0 0 60px var(--blue); }
}

.start-content h1 {
  font-size: 2.5rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  margin-bottom: 0.5rem;
}

.start-content p {
  font-size: 1.1rem;
  color: var(--text-dim);
  margin-bottom: 2.5rem;
}

.btn-start {
  padding: 1rem 3rem;
  font-size: 1.2rem;
  font-weight: 600;
  border: none;
  border-radius: 50px;
  background: linear-gradient(135deg, var(--red), var(--blue));
  color: white;
  cursor: pointer;
  transition: transform 0.2s, box-shadow 0.2s;
}

.btn-start:active {
  transform: scale(0.95);
}

/* --- Channel Select Screen --- */

.screen-title {
  font-size: 1.5rem;
  font-weight: 600;
  margin-bottom: 2rem;
}

.channel-cards {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  width: 100%;
  max-width: 400px;
  padding: 0 1.5rem;
}

.channel-card {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 1.25rem 1.5rem;
  border-radius: var(--radius);
  background: var(--bg-card);
  border: 1px solid rgba(255, 255, 255, 0.08);
  cursor: pointer;
  transition: transform 0.2s, border-color 0.3s, box-shadow 0.3s;
}

.channel-card:active {
  transform: scale(0.97);
}

.channel-card .dot {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  flex-shrink: 0;
  box-shadow: 0 0 12px currentColor;
}

.channel-card .card-info {
  flex: 1;
  min-width: 0;
}

.channel-card .card-name {
  font-size: 1.1rem;
  font-weight: 600;
}

.channel-card .card-track {
  font-size: 0.85rem;
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.channel-card .card-listeners {
  font-size: 0.8rem;
  color: var(--text-dim);
}

/* --- Player Screen --- */

.visualizer {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  z-index: 0;
}

.player-content {
  position: relative;
  z-index: 1;
  text-align: center;
  padding: 2rem;
  width: 100%;
  max-width: 400px;
}

.album-art {
  width: 200px;
  height: 200px;
  border-radius: var(--radius);
  object-fit: cover;
  margin-bottom: 1.5rem;
  box-shadow: 0 8px 40px rgba(0, 0, 0, 0.5);
}

.track-info {
  margin-bottom: 1rem;
}

.track-title {
  font-size: 1.3rem;
  font-weight: 700;
  margin-bottom: 0.25rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.track-artist {
  font-size: 1rem;
  color: var(--text-dim);
}

.channel-label {
  font-size: 0.9rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  margin-bottom: 0.5rem;
}

.listener-count {
  font-size: 0.8rem;
  color: var(--text-dim);
  margin-bottom: 2rem;
}

.channel-dots {
  display: flex;
  justify-content: center;
  gap: 1.5rem;
  padding-bottom: var(--safe-bottom);
}

.channel-dot {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.2);
  cursor: pointer;
  transition: transform 0.2s, border-color 0.3s, box-shadow 0.3s;
}

.channel-dot.active {
  border-color: white;
  box-shadow: 0 0 20px currentColor;
  transform: scale(1.15);
}

.channel-dot:active {
  transform: scale(0.9);
}

/* --- Animations --- */

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(20px); }
  to { opacity: 1; transform: translateY(0); }
}

.channel-card {
  animation: fadeIn 0.4s ease forwards;
}

.channel-card:nth-child(2) { animation-delay: 0.1s; }
.channel-card:nth-child(3) { animation-delay: 0.2s; }
```

**Step 3: Create default assets directory**

Run: `mkdir -p web/assets`

Note: We'll need a `default-art.png` (a placeholder album art image) and a `favicon.ico`. For now create a simple SVG-based placeholder — we'll generate proper ones during implementation.

**Step 4: Commit**

```bash
git add web/index.html web/css/main.css
git commit -m "feat: add listener web portal HTML and CSS with full party UI"
```

---

## Task 10: Listener Web Portal - JavaScript (API + Audio + Visualizer)

**Files:**
- Create: `web/js/api.js`
- Create: `web/js/audio.js`
- Create: `web/js/visualizer.js`
- Create: `web/js/mediasession.js`

**Step 1: Create API client with WebSocket**

```javascript
// web/js/api.js
'use strict';

const DiscoAPI = {
  ws: null,
  listeners: [],

  async getConfig() {
    const res = await fetch('/api/config');
    return (await res.json());
  },

  async getChannels() {
    const res = await fetch('/api/channels');
    return (await res.json());
  },

  onUpdate(callback) {
    this.listeners.push(callback);
  },

  connectWebSocket() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.ws = new WebSocket(`${protocol}//${location.host}/api/ws`);

    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'update') {
        this.listeners.forEach(cb => cb(data.channels));
      }
    };

    this.ws.onclose = () => {
      setTimeout(() => this.connectWebSocket(), 3000);
    };

    this.ws.onerror = () => {
      this.ws.close();
    };
  },

  getStreamUrl(channelId) {
    return `/stream/${channelId}`;
  }
};
```

**Step 2: Create audio manager with iOS handling**

```javascript
// web/js/audio.js
'use strict';

const AudioManager = {
  audioEl: null,
  audioCtx: null,
  source: null,
  analyser: null,
  currentChannel: null,
  initialized: false,

  init() {
    this.audioEl = document.getElementById('audioPlayer');

    this.audioEl.addEventListener('error', () => {
      console.warn('Stream error, reconnecting...');
      const src = this.audioEl.src;
      this.audioEl.src = '';
      setTimeout(() => {
        this.audioEl.src = src;
        this.audioEl.play().catch(() => {});
      }, 2000);
    });

    this.audioEl.addEventListener('stalled', () => {
      console.warn('Stream stalled');
    });

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.audioCtx) {
        if (this.audioCtx.state === 'suspended' || this.audioCtx.state === 'interrupted') {
          this.audioCtx.resume().catch(console.error);
        }
      }
    });
  },

  initAudioContext() {
    if (this.initialized) return;

    const AC = window.AudioContext || window.webkitAudioContext;
    this.audioCtx = new AC();
    this.source = this.audioCtx.createMediaElementSource(this.audioEl);
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0.8;

    this.source.connect(this.analyser);
    this.analyser.connect(this.audioCtx.destination);
    this.initialized = true;
  },

  async play(channelId) {
    this.initAudioContext();

    if (this.audioCtx.state === 'suspended') {
      await this.audioCtx.resume();
    }

    this.currentChannel = channelId;
    this.audioEl.src = DiscoAPI.getStreamUrl(channelId);

    try {
      await this.audioEl.play();
      return true;
    } catch (err) {
      console.error('Playback failed:', err);
      return false;
    }
  },

  async switchChannel(channelId) {
    if (this.currentChannel === channelId) return;
    return this.play(channelId);
  },

  getAnalyser() {
    return this.analyser;
  }
};
```

**Step 3: Create audio visualizer**

```javascript
// web/js/visualizer.js
'use strict';

const Visualizer = {
  canvas: null,
  ctx: null,
  animationId: null,
  channelColor: '#ffffff',

  init(canvasEl) {
    this.canvas = canvasEl;
    this.ctx = canvasEl.getContext('2d');
    this.resize();
    window.addEventListener('resize', () => this.resize());
  },

  resize() {
    this.canvas.width = this.canvas.offsetWidth * (window.devicePixelRatio || 1);
    this.canvas.height = this.canvas.offsetHeight * (window.devicePixelRatio || 1);
  },

  setColor(color) {
    this.channelColor = color;
  },

  start() {
    const analyser = AudioManager.getAnalyser();
    if (!analyser) return;

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    const ctx = this.ctx;
    const canvas = this.canvas;

    const draw = () => {
      this.animationId = requestAnimationFrame(draw);
      analyser.getByteFrequencyData(dataArray);

      const W = canvas.width;
      const H = canvas.height;

      // Dark fade for trail effect
      ctx.fillStyle = 'rgba(10, 10, 15, 0.88)';
      ctx.fillRect(0, 0, W, H);

      const barWidth = (W / bufferLength) * 2;
      let x = 0;

      // Parse channel color for glow effect
      const color = this.channelColor;

      for (let i = 0; i < bufferLength; i++) {
        const v = dataArray[i] / 255;
        const barHeight = v * H * 0.8;

        const alpha = 0.3 + v * 0.7;
        ctx.fillStyle = color;
        ctx.globalAlpha = alpha;

        // Draw from bottom center
        const y = H - barHeight;
        ctx.fillRect(x, y, barWidth - 1, barHeight);

        // Mirror from top (subtle)
        ctx.globalAlpha = alpha * 0.15;
        ctx.fillRect(x, 0, barWidth - 1, barHeight * 0.3);

        x += barWidth;
      }

      ctx.globalAlpha = 1;
    };

    draw();
  },

  stop() {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
  },

  clear() {
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(10, 10, 15, 1)';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  },

  // Animated background for start screen
  drawBackground(canvas) {
    const ctx = canvas.getContext('2d');
    canvas.width = canvas.offsetWidth * (window.devicePixelRatio || 1);
    canvas.height = canvas.offsetHeight * (window.devicePixelRatio || 1);
    const W = canvas.width;
    const H = canvas.height;

    const particles = Array.from({ length: 50 }, () => ({
      x: Math.random() * W,
      y: Math.random() * H,
      vx: (Math.random() - 0.5) * 0.5,
      vy: (Math.random() - 0.5) * 0.5,
      r: Math.random() * 3 + 1,
      color: ['#ff1744', '#00e676', '#2979ff'][Math.floor(Math.random() * 3)],
    }));

    const animate = () => {
      requestAnimationFrame(animate);
      ctx.fillStyle = 'rgba(10, 10, 15, 0.15)';
      ctx.fillRect(0, 0, W, H);

      particles.forEach(p => {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0 || p.x > W) p.vx *= -1;
        if (p.y < 0 || p.y > H) p.vy *= -1;

        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = p.color;
        ctx.globalAlpha = 0.4;
        ctx.fill();
        ctx.globalAlpha = 1;
      });
    };

    animate();
  }
};
```

**Step 4: Create media session handler**

```javascript
// web/js/mediasession.js
'use strict';

const MediaSessionManager = {
  isSupported: 'mediaSession' in navigator,

  setMetadata({ title, artist, artworkUrl }) {
    if (!this.isSupported) return;

    navigator.mediaSession.metadata = new MediaMetadata({
      title: title || 'Silent Disco',
      artist: artist || 'Live',
      artwork: artworkUrl ? [
        { src: artworkUrl, sizes: '96x96', type: 'image/jpeg' },
        { src: artworkUrl, sizes: '512x512', type: 'image/jpeg' },
      ] : [],
    });
  },

  setupActions({ onPrevious, onNext }) {
    if (!this.isSupported) return;

    const trySet = (action, handler) => {
      try { navigator.mediaSession.setActionHandler(action, handler); }
      catch (e) { /* unsupported */ }
    };

    trySet('play', async () => {
      const audioEl = document.getElementById('audioPlayer');
      await audioEl.play();
      navigator.mediaSession.playbackState = 'playing';
    });

    trySet('pause', () => {
      document.getElementById('audioPlayer').pause();
      navigator.mediaSession.playbackState = 'paused';
    });

    trySet('previoustrack', onPrevious);
    trySet('nexttrack', onNext);
  },

  updatePlaybackState(playing) {
    if (!this.isSupported) return;
    navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  }
};
```

**Step 5: Commit**

```bash
git add web/js/api.js web/js/audio.js web/js/visualizer.js web/js/mediasession.js
git commit -m "feat: add listener JS modules - API client, audio manager, visualizer, and media session"
```

---

## Task 11: Listener Web Portal - Main App Logic

**Files:**
- Create: `web/js/app.js`

**Step 1: Create the main app controller**

This ties everything together - screen transitions, channel selection, now-playing updates.

```javascript
// web/js/app.js
'use strict';

const App = {
  config: null,
  channels: [],
  currentChannel: null,

  async init() {
    AudioManager.init();

    // Load config
    try {
      const configRes = await DiscoAPI.getConfig();
      this.config = configRes;
      document.getElementById('eventName').textContent = configRes.event.name;
      document.getElementById('eventTagline').textContent = configRes.event.tagline;
    } catch (e) {
      // Fallback if API isn't available yet
      this.config = {
        event: { name: 'Silent Disco', tagline: 'Put on your headphones' },
        channels: [
          { id: 'red', name: 'Red', color: '#ff1744' },
          { id: 'green', name: 'Green', color: '#00e676' },
          { id: 'blue', name: 'Blue', color: '#2979ff' },
        ],
      };
    }

    // Start background animation
    Visualizer.drawBackground(document.getElementById('bgCanvas'));

    // Wire up start button
    document.getElementById('startBtn').addEventListener('click', () => {
      this.showScreen('channelScreen');
      this.loadChannels();
    });

    // Connect WebSocket for live updates
    DiscoAPI.connectWebSocket();
    DiscoAPI.onUpdate((channels) => this.handleUpdate(channels));

    // Set up media session channel switching
    const channelIds = this.config.channels.map(c => c.id);
    MediaSessionManager.setupActions({
      onPrevious: () => {
        const idx = channelIds.indexOf(this.currentChannel);
        const prev = channelIds[(idx - 1 + channelIds.length) % channelIds.length];
        this.selectChannel(prev);
      },
      onNext: () => {
        const idx = channelIds.indexOf(this.currentChannel);
        const next = channelIds[(idx + 1) % channelIds.length];
        this.selectChannel(next);
      },
    });
  },

  showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(screenId).classList.add('active');
  },

  async loadChannels() {
    try {
      const res = await DiscoAPI.getChannels();
      if (res.ok) this.channels = res.channels;
    } catch (e) {
      this.channels = this.config.channels.map(c => ({
        ...c, listeners: 0, nowPlaying: null,
      }));
    }
    this.renderChannelCards();
  },

  renderChannelCards() {
    const container = document.getElementById('channelCards');
    container.innerHTML = '';

    this.config.channels.forEach(ch => {
      const data = this.channels.find(c => c.id === ch.id) || {};
      const card = document.createElement('div');
      card.className = 'channel-card';
      card.style.borderColor = ch.color + '33';

      card.addEventListener('click', () => this.selectChannel(ch.id));

      const np = data.nowPlaying;
      const trackText = np && np.title ? `${np.artist} - ${np.title}` : 'Loading...';
      const listeners = data.listeners || 0;

      card.innerHTML = `
        <div class="dot" style="color:${ch.color}; background:${ch.color}"></div>
        <div class="card-info">
          <div class="card-name" style="color:${ch.color}">${ch.name}</div>
          <div class="card-track">${trackText}</div>
        </div>
        <div class="card-listeners">${listeners} listening</div>
      `;

      container.appendChild(card);
    });
  },

  async selectChannel(channelId) {
    const ch = this.config.channels.find(c => c.id === channelId);
    if (!ch) return;

    this.currentChannel = channelId;

    // Start playing
    const success = await AudioManager.play(channelId);
    if (!success) return;

    // Show player screen
    this.showScreen('playerScreen');

    // Set up visualizer
    Visualizer.init(document.getElementById('visualizer'));
    Visualizer.setColor(ch.color);
    Visualizer.start();

    // Update UI
    document.getElementById('channelName').textContent = ch.name;
    document.getElementById('channelName').style.color = ch.color;

    // Render channel dots
    this.renderChannelDots();

    // Set initial media session metadata
    MediaSessionManager.setMetadata({ title: ch.name, artist: 'Silent Disco' });
    MediaSessionManager.updatePlaybackState(true);
  },

  renderChannelDots() {
    const container = document.getElementById('channelDots');
    container.innerHTML = '';

    this.config.channels.forEach(ch => {
      const dot = document.createElement('div');
      dot.className = 'channel-dot' + (ch.id === this.currentChannel ? ' active' : '');
      dot.style.background = ch.color;
      dot.style.color = ch.color;
      dot.addEventListener('click', () => {
        AudioManager.switchChannel(ch.id);
        this.currentChannel = ch.id;

        Visualizer.setColor(ch.color);
        document.getElementById('channelName').textContent = ch.name;
        document.getElementById('channelName').style.color = ch.color;
        this.renderChannelDots();

        MediaSessionManager.setMetadata({ title: ch.name, artist: 'Silent Disco' });
      });
      container.appendChild(dot);
    });
  },

  handleUpdate(channels) {
    this.channels = channels;

    // Update channel cards if on channel select screen
    if (document.getElementById('channelScreen').classList.contains('active')) {
      this.renderChannelCards();
    }

    // Update player if on player screen
    if (this.currentChannel) {
      const ch = channels.find(c => c.id === this.currentChannel);
      if (ch) {
        const np = ch.nowPlaying;
        if (np) {
          document.getElementById('trackTitle').textContent = np.title || 'Unknown Track';
          document.getElementById('trackArtist').textContent = np.artist || '';

          // Update album art if we have a filename
          if (np.filename) {
            const filename = np.filename.split('/').pop();
            document.getElementById('albumArt').src =
              `/api/channels/${this.currentChannel}/album-art/${encodeURIComponent(filename)}`;
          }

          // Update media session
          MediaSessionManager.setMetadata({
            title: np.title || 'Unknown Track',
            artist: np.artist || 'Silent Disco',
            artworkUrl: np.filename
              ? `/api/channels/${this.currentChannel}/album-art/${encodeURIComponent(np.filename.split('/').pop())}`
              : null,
          });
        }
        document.getElementById('listenerCount').textContent =
          `${ch.listeners || 0} listening`;
      }
    }
  },
};

// Start the app
document.addEventListener('DOMContentLoaded', () => App.init());
```

**Step 2: Commit**

```bash
git add web/js/app.js
git commit -m "feat: add main app controller with screen transitions, channel selection, and live updates"
```

---

## Task 12: Admin Panel

**Files:**
- Create: `web/admin.html`
- Create: `web/css/admin.css`
- Create: `web/js/admin.js`

**Step 1: Create admin HTML**

```html
<!-- web/admin.html -->
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Silent Disco Admin</title>
  <link rel="stylesheet" href="/css/admin.css">
</head>
<body>

  <!-- Login Screen -->
  <div id="loginScreen" class="admin-screen active">
    <div class="login-box">
      <h1>Admin Panel</h1>
      <input type="password" id="passwordInput" placeholder="Enter password" autocomplete="off">
      <button id="loginBtn">Login</button>
      <div id="loginError" class="error hidden"></div>
    </div>
  </div>

  <!-- Dashboard -->
  <div id="dashScreen" class="admin-screen">
    <header class="admin-header">
      <h1>Silent Disco Admin</h1>
      <div class="header-stats">
        <span id="totalListeners">0 listeners</span>
        <span id="lsStatus" class="status-dot"></span>
      </div>
    </header>

    <div id="channelPanels" class="channel-panels">
      <!-- Populated by JS -->
    </div>

    <div class="system-controls">
      <h3>System</h3>
      <button id="restartBtn" class="btn btn-warning">Restart Pi</button>
      <button id="shutdownBtn" class="btn btn-danger">Shutdown Pi</button>
    </div>
  </div>

  <script src="/js/admin.js"></script>
</body>
</html>
```

**Step 2: Create admin CSS**

```css
/* web/css/admin.css */

*, *::before, *::after {
  margin: 0; padding: 0; box-sizing: border-box;
}

:root {
  --bg: #111118;
  --card: #1a1a24;
  --border: #2a2a38;
  --text: #e8e8f0;
  --dim: #888;
  --red: #ff1744;
  --green: #00e676;
  --blue: #2979ff;
}

body {
  min-height: 100vh;
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  padding: 1rem;
}

.admin-screen { display: none; }
.admin-screen.active { display: block; }

.hidden { display: none !important; }

/* Login */
.login-box {
  max-width: 300px;
  margin: 20vh auto;
  text-align: center;
}

.login-box h1 { margin-bottom: 1.5rem; }

.login-box input {
  width: 100%;
  padding: 0.75rem 1rem;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--card);
  color: var(--text);
  font-size: 1rem;
  margin-bottom: 1rem;
}

.login-box button {
  width: 100%;
  padding: 0.75rem;
  border: none;
  border-radius: 8px;
  background: var(--blue);
  color: white;
  font-size: 1rem;
  font-weight: 600;
  cursor: pointer;
}

.error { color: var(--red); margin-top: 0.5rem; font-size: 0.9rem; }

/* Header */
.admin-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1.5rem;
  padding-bottom: 1rem;
  border-bottom: 1px solid var(--border);
}

.header-stats { display: flex; align-items: center; gap: 0.75rem; }

.status-dot {
  width: 10px; height: 10px;
  border-radius: 50%;
  background: var(--green);
}

.status-dot.offline { background: var(--red); }

/* Channel Panels */
.channel-panels {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  margin-bottom: 2rem;
}

.channel-panel {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 1.25rem;
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1rem;
}

.panel-title {
  font-size: 1.1rem;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.panel-dot {
  width: 12px; height: 12px;
  border-radius: 50%;
}

.panel-listeners { font-size: 0.85rem; color: var(--dim); }

.panel-now-playing {
  font-size: 0.9rem;
  margin-bottom: 1rem;
  color: var(--dim);
}

.panel-now-playing strong { color: var(--text); }

.panel-controls {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.btn {
  padding: 0.5rem 1rem;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: transparent;
  color: var(--text);
  font-size: 0.85rem;
  cursor: pointer;
}

.btn:hover { background: rgba(255,255,255,0.05); }
.btn-primary { background: var(--blue); border-color: var(--blue); }
.btn-warning { border-color: orange; color: orange; }
.btn-danger { border-color: var(--red); color: var(--red); }

/* System */
.system-controls {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 1.25rem;
}

.system-controls h3 { margin-bottom: 1rem; }

.system-controls .btn { margin-right: 0.5rem; }
```

**Step 3: Create admin JavaScript**

```javascript
// web/js/admin.js
'use strict';

const Admin = {
  token: null,
  channels: ['red', 'green', 'blue'],
  channelNames: { red: 'Red', green: 'Green', blue: 'Blue' },
  channelColors: { red: '#ff1744', green: '#00e676', blue: '#2979ff' },

  init() {
    document.getElementById('loginBtn').addEventListener('click', () => this.login());
    document.getElementById('passwordInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.login();
    });

    document.getElementById('restartBtn').addEventListener('click', () => {
      if (confirm('Restart the Raspberry Pi?')) this.systemAction('restart');
    });

    document.getElementById('shutdownBtn').addEventListener('click', () => {
      if (confirm('Shut down the Raspberry Pi? You will need physical access to turn it back on.')) {
        this.systemAction('shutdown');
      }
    });

    // Check saved token
    const saved = sessionStorage.getItem('disco_admin_token');
    if (saved) {
      this.token = saved;
      this.showDashboard();
    }
  },

  async login() {
    const password = document.getElementById('passwordInput').value;
    const errorEl = document.getElementById('loginError');

    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });

      const data = await res.json();
      if (data.ok) {
        this.token = data.token;
        sessionStorage.setItem('disco_admin_token', this.token);
        this.showDashboard();
      } else {
        errorEl.textContent = 'Wrong password';
        errorEl.classList.remove('hidden');
      }
    } catch (e) {
      errorEl.textContent = 'Connection error';
      errorEl.classList.remove('hidden');
    }
  },

  showDashboard() {
    document.getElementById('loginScreen').classList.remove('active');
    document.getElementById('dashScreen').classList.add('active');
    this.renderPanels();
    this.startPolling();
  },

  renderPanels() {
    const container = document.getElementById('channelPanels');
    container.innerHTML = '';

    this.channels.forEach(id => {
      const panel = document.createElement('div');
      panel.className = 'channel-panel';
      panel.id = `panel-${id}`;

      panel.innerHTML = `
        <div class="panel-header">
          <div class="panel-title">
            <div class="panel-dot" style="background:${this.channelColors[id]}"></div>
            ${this.channelNames[id]} Channel
          </div>
          <div class="panel-listeners" id="listeners-${id}">0 listeners</div>
        </div>
        <div class="panel-now-playing" id="np-${id}">Loading...</div>
        <div class="panel-controls">
          <button class="btn btn-primary" onclick="Admin.skip('${id}')">Skip Track</button>
          <button class="btn" id="alsa-btn-${id}" onclick="Admin.toggleAlsa('${id}')">Switch to Line-In</button>
        </div>
      `;

      container.appendChild(panel);
    });
  },

  async fetchAndUpdate() {
    try {
      const res = await fetch('/api/channels', {
        headers: { 'Authorization': `Bearer ${this.token}` },
      });
      const data = await res.json();

      if (data.ok) {
        let total = 0;
        data.channels.forEach(ch => {
          total += ch.listeners || 0;

          const npEl = document.getElementById(`np-${ch.id}`);
          const lisEl = document.getElementById(`listeners-${ch.id}`);
          const alsaBtn = document.getElementById(`alsa-btn-${ch.id}`);

          if (npEl && ch.nowPlaying) {
            npEl.innerHTML = `<strong>${ch.nowPlaying.title || 'Unknown'}</strong> - ${ch.nowPlaying.artist || ''}`;
          }
          if (lisEl) lisEl.textContent = `${ch.listeners || 0} listeners`;
          if (alsaBtn) {
            alsaBtn.textContent = ch.alsaMode ? 'Switch to Playlist' : 'Switch to Line-In';
          }
        });

        document.getElementById('totalListeners').textContent = `${total} listeners`;
      }

      // Check Liquidsoap status
      const statsRes = await fetch('/api/stats');
      const stats = await statsRes.json();
      const dot = document.getElementById('lsStatus');
      if (stats.liquidsoapUp) {
        dot.classList.remove('offline');
        dot.title = 'Liquidsoap connected';
      } else {
        dot.classList.add('offline');
        dot.title = 'Liquidsoap disconnected';
      }
    } catch (e) {
      console.error('Update failed:', e);
    }
  },

  startPolling() {
    this.fetchAndUpdate();
    setInterval(() => this.fetchAndUpdate(), 3000);
  },

  async skip(channelId) {
    try {
      await fetch(`/api/channels/${channelId}/skip`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.token}` },
      });
      setTimeout(() => this.fetchAndUpdate(), 500);
    } catch (e) {
      console.error('Skip failed:', e);
    }
  },

  async toggleAlsa(channelId) {
    const btn = document.getElementById(`alsa-btn-${channelId}`);
    const currentlyAlsa = btn.textContent.includes('Playlist');

    try {
      await fetch(`/api/channels/${channelId}/alsa`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`,
        },
        body: JSON.stringify({ enabled: !currentlyAlsa }),
      });
      setTimeout(() => this.fetchAndUpdate(), 500);
    } catch (e) {
      console.error('ALSA toggle failed:', e);
    }
  },

  async systemAction(action) {
    try {
      await fetch(`/api/admin/system/${action}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.token}` },
      });
    } catch (e) {
      // Connection will drop on shutdown/restart
    }
  },
};

document.addEventListener('DOMContentLoaded', () => Admin.init());
```

**Step 4: Commit**

```bash
git add web/admin.html web/css/admin.css web/js/admin.js
git commit -m "feat: add admin panel with channel controls, system management, and live stats"
```

---

## Task 13: Systemd Service Files

**Files:**
- Create: `systemd/liquidsoap-disco.service`
- Create: `systemd/disco-api.service`

**Step 1: Create Liquidsoap service**

```ini
# systemd/liquidsoap-disco.service
[Unit]
Description=Liquidsoap - Silent Disco streaming
After=network.target icecast2.service
Wants=icecast2.service

[Service]
Type=simple
User=liquidsoap
Group=audio
ExecStartPre=/bin/mkdir -p /var/log/liquidsoap
ExecStartPre=/bin/chown liquidsoap:liquidsoap /var/log/liquidsoap
ExecStart=/usr/bin/liquidsoap /etc/liquidsoap/disco.liq
Restart=on-failure
RestartSec=5s
StandardOutput=journal
StandardError=journal
SyslogIdentifier=liquidsoap-disco
Nice=-10

[Install]
WantedBy=multi-user.target
```

**Step 2: Create Node.js API service**

```ini
# systemd/disco-api.service
[Unit]
Description=Silent Disco - Node.js API
After=network.target liquidsoap-disco.service
Wants=liquidsoap-disco.service

[Service]
Type=simple
User=pi
WorkingDirectory=/opt/disco-api
ExecStart=/usr/bin/node /opt/disco-api/server.js
Environment=DISCO_CONFIG=/opt/disco/config/disco.conf
Restart=always
RestartSec=3s
StandardOutput=journal
StandardError=journal
SyslogIdentifier=disco-api

[Install]
WantedBy=multi-user.target
```

**Step 3: Commit**

```bash
git add systemd/
git commit -m "feat: add systemd service files for Liquidsoap and Node.js API"
```

---

## Task 14: Pi Setup Script

**Files:**
- Create: `pi-setup/install.sh`

**Step 1: Create the master install script**

This script is run on a fresh Raspberry Pi OS Lite to install and configure everything.

```bash
#!/bin/bash
# pi-setup/install.sh
# Master installation script for Silent Disco in a Box
# Run on a fresh Raspberry Pi OS Lite (64-bit) install
# Usage: sudo bash install.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
INSTALL_DIR="/opt/disco"
WEB_DIR="/var/www/disco"
MUSIC_DIR="/home/pi/music"

echo "============================================="
echo "  Silent Disco in a Box - Installer"
echo "============================================="

# --- Check root ---
if [ "$EUID" -ne 0 ]; then
  echo "Please run as root: sudo bash install.sh"
  exit 1
fi

# --- Update system ---
echo "[1/10] Updating system packages..."
apt-get update
apt-get upgrade -y

# --- Install dependencies ---
echo "[2/10] Installing dependencies..."
apt-get install -y \
  hostapd \
  dnsmasq \
  icecast2 \
  liquidsoap \
  nginx \
  nodejs \
  npm \
  git

# --- Create users ---
echo "[3/10] Creating service users..."
id -u liquidsoap &>/dev/null || useradd -r -s /bin/false -G audio liquidsoap

# --- Create directories ---
echo "[4/10] Creating directories..."
mkdir -p "$INSTALL_DIR"
mkdir -p "$WEB_DIR"
mkdir -p "$MUSIC_DIR/red" "$MUSIC_DIR/green" "$MUSIC_DIR/blue"
mkdir -p /var/log/liquidsoap
mkdir -p /etc/liquidsoap

chown -R pi:pi "$MUSIC_DIR"
chown liquidsoap:liquidsoap /var/log/liquidsoap

# --- Copy project files ---
echo "[5/10] Copying project files..."
cp -r "$PROJECT_DIR/config" "$INSTALL_DIR/"
cp -r "$PROJECT_DIR/server" "$INSTALL_DIR/"
cp -r "$PROJECT_DIR/web/"* "$WEB_DIR/"
cp -r "$PROJECT_DIR/systemd" "$INSTALL_DIR/"

# --- Install Node.js dependencies ---
echo "[6/10] Installing Node.js dependencies..."
cd "$INSTALL_DIR/server"
npm install --production

# --- Deploy configuration files ---
echo "[7/10] Deploying configuration..."

# Icecast
cp "$INSTALL_DIR/config/icecast.xml" /etc/icecast2/icecast.xml
chown icecast2:icecast /etc/icecast2/icecast.xml

# Liquidsoap
cp "$INSTALL_DIR/config/disco.liq" /etc/liquidsoap/disco.liq
chown liquidsoap:liquidsoap /etc/liquidsoap/disco.liq

# hostapd
cp "$INSTALL_DIR/config/hostapd.conf" /etc/hostapd/hostapd.conf

# Tell hostapd where its config is
sed -i 's|^#\?DAEMON_CONF=.*|DAEMON_CONF="/etc/hostapd/hostapd.conf"|' /etc/default/hostapd

# dnsmasq
cp "$INSTALL_DIR/config/dnsmasq.conf" /etc/dnsmasq.conf

# Nginx
cp "$INSTALL_DIR/config/nginx-disco.conf" /etc/nginx/sites-available/disco
ln -sf /etc/nginx/sites-available/disco /etc/nginx/sites-enabled/disco
rm -f /etc/nginx/sites-enabled/default

# systemd services
cp "$INSTALL_DIR/systemd/liquidsoap-disco.service" /etc/systemd/system/
cp "$INSTALL_DIR/systemd/disco-api.service" /etc/systemd/system/

# --- Configure static IP for wlan0 ---
echo "[8/10] Configuring network..."

# Add static IP to dhcpcd.conf if not already present
if ! grep -q "interface wlan0" /etc/dhcpcd.conf 2>/dev/null; then
  cat >> /etc/dhcpcd.conf << 'DHCPCD'

# Silent Disco hotspot
interface wlan0
    static ip_address=192.168.4.1/24
    nohook wpa_supplicant
DHCPCD
fi

# --- Unmask and enable hostapd ---
echo "[9/10] Enabling services..."
systemctl unmask hostapd
systemctl daemon-reload
systemctl enable hostapd dnsmasq icecast2 liquidsoap-disco disco-api nginx

# --- Test configs ---
echo "[10/10] Testing configuration..."
nginx -t

echo ""
echo "============================================="
echo "  Installation complete!"
echo "============================================="
echo ""
echo "  WiFi SSID:     SilentDisco"
echo "  WiFi Password: letsdance"
echo "  Web Portal:    http://192.168.4.1"
echo "  Admin Panel:   http://192.168.4.1/admin.html"
echo "  Admin Pass:    disco2024"
echo ""
echo "  Music folders:"
echo "    /home/pi/music/red/"
echo "    /home/pi/music/green/"
echo "    /home/pi/music/blue/"
echo ""
echo "  Copy MP3 files to these folders, then reboot:"
echo "    sudo reboot"
echo ""
echo "============================================="
```

**Step 2: Make it executable**

Run: `chmod +x pi-setup/install.sh`

**Step 3: Commit**

```bash
git add pi-setup/
git commit -m "feat: add Pi setup script for one-command installation"
```

---

## Task 15: Default Assets + Final Polish

**Files:**
- Create: `web/assets/default-art.png` (generate a simple placeholder)
- Create: `web/assets/favicon.ico`

**Step 1: Create a simple default album art as an inline SVG data URI fallback**

Update `web/css/main.css` to include a CSS fallback for missing album art, and create a minimal placeholder PNG using a canvas in a build script, or simply use a solid color square. For now, we'll handle the missing image gracefully in CSS:

Add to `web/css/main.css`:
```css
.album-art {
  background: linear-gradient(135deg, #1a1a2e, #16213e);
}
```

**Step 2: Create a simple HTML page to generate the placeholder assets**

Run a quick Node.js script to create a default album art PNG.

Create file `pi-setup/generate-assets.js`:
```javascript
// pi-setup/generate-assets.js
// Generates placeholder assets. Run: node pi-setup/generate-assets.js

const fs = require('fs');
const path = require('path');

// Minimal 1x1 transparent PNG (use as favicon placeholder)
const tinyPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADBwIAMCbHYQAAAABJRU5ErkJggg==',
  'base64'
);

const assetsDir = path.join(__dirname, '..', 'web', 'assets');
fs.mkdirSync(assetsDir, { recursive: true });

fs.writeFileSync(path.join(assetsDir, 'default-art.png'), tinyPng);
fs.writeFileSync(path.join(assetsDir, 'favicon.ico'), tinyPng);

console.log('Assets generated.');
```

Run: `node pi-setup/generate-assets.js`

**Step 3: Commit**

```bash
git add web/assets/ pi-setup/generate-assets.js
git commit -m "feat: add placeholder assets and asset generation script"
```

---

## Task 16: Final Integration Test Checklist

This is a manual test checklist to verify everything works once deployed to the Pi.

**Pre-deployment (on dev machine):**
1. Run `cd server && node server.js` — verify it starts without errors (will fail to connect to Liquidsoap, that's expected)
2. Open `web/index.html` in a browser — verify start screen renders
3. Open `web/admin.html` in a browser — verify login screen renders

**On the Raspberry Pi:**
1. Run `sudo bash pi-setup/install.sh` — verify no errors
2. Copy test MP3 files to `/home/pi/music/red/`, `/green/`, `/blue/`
3. Reboot: `sudo reboot`
4. On your phone, look for "SilentDisco" WiFi network
5. Connect — verify captive portal redirect opens the web portal
6. Tap "Join the Disco" — verify channel select screen appears
7. Tap a channel — verify audio plays through headphones
8. Verify visualizer animates
9. Switch channels — verify audio switches
10. Lock phone screen — verify audio continues
11. Navigate to `http://192.168.4.1/admin.html` — verify admin login works
12. Skip a track from admin — verify it changes on listener
13. Toggle line-in mode — verify it switches (if USB audio connected)

**Step 1: Commit checklist**

```bash
git add docs/plans/
git commit -m "docs: add implementation plan"
```
