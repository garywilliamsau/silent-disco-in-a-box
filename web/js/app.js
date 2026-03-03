'use strict';

const App = {
  config: null,
  channels: [],
  currentChannel: null,

  async init() {
    AudioManager.init();

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

    const success = await AudioManager.play(channelId);
    if (!success) return;

    this.showScreen('playerScreen');

    Visualizer.init(document.getElementById('visualizer'));
    Visualizer.setColor(ch.color);
    Visualizer.start();

    document.getElementById('channelName').textContent = ch.name;
    document.getElementById('channelName').style.color = ch.color;
    this.renderChannelDots();

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

    if (document.getElementById('channelScreen').classList.contains('active')) {
      this.renderChannelCards();
    }

    if (this.currentChannel) {
      const ch = channels.find(c => c.id === this.currentChannel);
      if (ch) {
        const np = ch.nowPlaying;
        if (np) {
          document.getElementById('trackTitle').textContent = np.title || 'Unknown Track';
          document.getElementById('trackArtist').textContent = np.artist || '';

          if (np.filename) {
            const filename = np.filename.split('/').pop();
            document.getElementById('albumArt').src =
              `/api/channels/${this.currentChannel}/album-art/${encodeURIComponent(filename)}`;
          }

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

document.addEventListener('DOMContentLoaded', () => App.init());
