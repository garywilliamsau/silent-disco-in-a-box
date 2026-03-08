'use strict';

const App = {
  config: null,
  channels: [],
  currentChannel: null,

  _toastTimer: null,
  _adminMode: false,
  _adminToken: null,

  async init() {
    AudioManager.init();
    AudioManager.onStreamStatus((status, failCount) => this._showStreamToast(status, failCount));

    try {
      const configRes = await DiscoAPI.getConfig();
      this.config = configRes;
      document.getElementById('eventName').textContent = configRes.event.name;
      document.getElementById('eventTagline').textContent = configRes.event.tagline;
    } catch (e) {
      this.config = {
        event: { name: 'Silent Disco', tagline: 'Put on your headphones' },
        channels: [
          { id: 'red', name: 'Red', color: '#ff1744' },
          { id: 'green', name: 'Green', color: '#00e676' },
          { id: 'blue', name: 'Blue', color: '#2979ff' },
        ],
      };
    }

    Visualizer.drawBackground(document.getElementById('bgCanvas'));

    document.getElementById('startBtn').addEventListener('click', () => {
      this.showScreen('channelScreen');
      this.loadChannels();
    });

    DiscoAPI.connectWebSocket();
    DiscoAPI.onUpdate((channels) => this.handleUpdate(channels));

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

    // Admin overlay mode
    if (new URLSearchParams(location.search).has('admin')) {
      this._adminToken = localStorage.getItem('adminToken');
      if (this._adminToken) {
        this._adminMode = true;
        document.getElementById('adminOverlay').classList.remove('hidden');
        document.querySelector('.player-bar').style.marginBottom = '44px';
      } else {
        document.getElementById('adminLoginPrompt').classList.remove('hidden');
      }
    }
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
      const trackText = np && np.title ? `${np.artist} - ${np.title}` : 'Waiting for music...';
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
    this._lastMode = null; // reset so first update doesn't trigger a reconnect

    const success = await AudioManager.play(channelId);
    if (!success) return;

    Visualizer.stopBackground();
    this.showScreen('playerScreen');

    Visualizer.init(document.getElementById('visualizer'));
    Visualizer.setColor(ch.color);
    Visualizer.setChannel(ch.id);
    Visualizer.start();

    // Full channel color screen — visible from across the room
    document.getElementById('playerScreen').style.backgroundColor = ch.color;
    document.documentElement.style.setProperty('--channel-color', ch.color);

    document.getElementById('channelName').textContent = ch.name;
    document.getElementById('channelName').style.color = ch.color;
    this.renderChannelDots();

    // Show track data immediately from last known state
    const data = this.channels.find(c => c.id === channelId);
    if (data && data.nowPlaying) {
      document.getElementById('trackTitle').textContent = data.nowPlaying.title || 'Unknown Track';
      document.getElementById('trackArtist').textContent = data.nowPlaying.artist || '';
      document.getElementById('listenerCount').textContent = `${data.listeners || 0} listening`;
    }

    MediaSessionManager.setMetadata({ title: ch.name, artist: 'Silent Disco', channelId: ch.id });
    MediaSessionManager.updatePlaybackState(true);
    DiscoAPI.sendListening(channelId);
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
        Visualizer.setChannel(ch.id);
        document.getElementById('playerScreen').style.backgroundColor = ch.color;
        document.documentElement.style.setProperty('--channel-color', ch.color);
        document.getElementById('channelName').textContent = ch.name;
        document.getElementById('channelName').style.color = ch.color;
        this.renderChannelDots();
        MediaSessionManager.setMetadata({ title: ch.name, artist: 'Silent Disco', channelId: ch.id });
        DiscoAPI.sendListening(ch.id);
      });
      container.appendChild(dot);
    });
  },

  _showStreamToast(status, failCount) {
    const toast = document.getElementById('streamToast');
    clearTimeout(this._toastTimer);

    toast.className = 'stream-toast';

    if (status === 'reconnecting') {
      toast.textContent = 'Connection lost \u2014 reconnecting\u2026';
      toast.classList.add('reconnecting', 'visible');
    } else if (status === 'failed') {
      toast.textContent = 'Having trouble connecting. Tap to retry.';
      toast.classList.add('failed', 'visible');
      toast.onclick = () => {
        toast.classList.remove('visible');
        AudioManager.retryNow();
      };
    } else if (status === 'recovered') {
      toast.textContent = 'Reconnected!';
      toast.classList.add('recovered', 'visible');
      toast.onclick = null;
      this._toastTimer = setTimeout(() => toast.classList.remove('visible'), 2000);
    }
  },

  handleUpdate(channels) {
    this.channels = channels;

    if (document.getElementById('channelScreen').classList.contains('active')) {
      this.renderChannelCards();
    }

    if (this.currentChannel) {
      const ch = channels.find(c => c.id === this.currentChannel);
      if (ch) {
        // Track mode changes so we can detect when the DJ switches source.
        // We don't auto-reconnect here — iOS blocks play() without a user gesture
        // and doing so leaves the AudioContext broken. The stalled/error handlers
        // in AudioManager will catch any resulting stream interruption instead.
        const newMode = `${ch.alsaMode}-${ch.btMode}-${ch.spotifyMode}`;
        if (this._lastMode !== null && this._lastMode !== newMode) {
          console.log(`Source mode changed: ${this._lastMode} → ${newMode}`);
        }
        this._lastMode = newMode;

        const np = ch.nowPlaying;
        if (np) {
          document.getElementById('trackTitle').textContent = np.title || 'Unknown Track';
          document.getElementById('trackArtist').textContent = np.artist || '';

          MediaSessionManager.setMetadata({
            title: np.title || 'Unknown Track',
            artist: np.artist || 'Silent Disco',
            channelId: this.currentChannel,
          });
        }
        document.getElementById('listenerCount').textContent =
          `${ch.listeners || 0} listening`;
      }
    }

    // Update admin overlay
    if (this._adminMode) {
      let total = 0;
      for (const c of channels) {
        total += c.listeners || 0;
        const el = document.getElementById('adminCount' + c.id.charAt(0).toUpperCase() + c.id.slice(1));
        if (el) el.textContent = c.listeners || 0;
      }
      document.getElementById('adminTotalListeners').textContent = `${total} listeners`;

      // Show skip only for playlist mode (no alsa, bt, or spotify)
      const current = channels.find(c => c.id === this.currentChannel);
      const skipBtn = document.getElementById('adminSkipBtn');
      if (current && !current.alsaMode && !current.bluetoothMode && !current.spotifyMode) {
        skipBtn.classList.remove('hidden');
      } else {
        skipBtn.classList.add('hidden');
      }
    }
  },

  async adminLogin() {
    const pw = document.getElementById('adminPasswordInput').value;
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw }),
      });
      const data = await res.json();
      if (data.ok) {
        this._adminToken = pw;
        this._adminMode = true;
        localStorage.setItem('adminToken', pw);
        document.getElementById('adminLoginPrompt').classList.add('hidden');
        document.getElementById('adminOverlay').classList.remove('hidden');
        document.querySelector('.player-bar').style.marginBottom = '44px';
      } else {
        document.getElementById('adminPasswordInput').value = '';
        document.getElementById('adminPasswordInput').placeholder = 'Wrong password';
      }
    } catch {
      document.getElementById('adminPasswordInput').placeholder = 'Connection error';
    }
  },

  async adminSkip() {
    if (!this.currentChannel || !this._adminToken) return;
    try {
      await fetch(`/api/channels/${this.currentChannel}/skip`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this._adminToken}`,
        },
      });
    } catch { /* ignore */ }
  },
};

document.addEventListener('DOMContentLoaded', () => App.init());
