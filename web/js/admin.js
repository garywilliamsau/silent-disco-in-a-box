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
    } catch (e) { /* Connection drops on shutdown/restart */ }
  },
};

document.addEventListener('DOMContentLoaded', () => Admin.init());
