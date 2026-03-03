'use strict';

const Admin = {
  token: null,
  channels: ['red', 'green', 'blue'],
  channelNames: { red: 'Red', green: 'Green', blue: 'Blue' },
  channelColors: { red: '#ff1744', green: '#00e676', blue: '#2979ff' },
  uploadChannel: null,
  btDevices: [],

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

    document.getElementById('fileInput').addEventListener('change', (e) => {
      if (this.uploadChannel && e.target.files.length > 0) {
        this.uploadFiles(this.uploadChannel, e.target.files);
      }
      e.target.value = '';
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
          <button class="btn" onclick="Admin.previous('${id}')">Previous</button>
          <button class="btn btn-primary" onclick="Admin.skip('${id}')">Skip Track</button>
          <button class="btn" id="alsa-btn-${id}" onclick="Admin.toggleAlsa('${id}')">Line-In</button>
          <button class="btn btn-bt" id="bt-btn-${id}" onclick="Admin.toggleBluetooth('${id}')">Bluetooth</button>
        </div>

        <div class="upload-zone" id="upload-zone-${id}">
          Drop MP3s here or click to browse
        </div>
        <div class="upload-progress" id="upload-progress-${id}">
          <div class="progress-fill" id="progress-fill-${id}"></div>
        </div>
        <div class="track-list" id="track-list-${id}">
          <div class="track-list-empty">Loading tracks...</div>
        </div>
      `;

      container.appendChild(panel);
      this.setupUploadZone(id);
      this.loadTracks(id);
    });

    this.loadBluetoothStatus();
  },

  setupUploadZone(id) {
    const zone = document.getElementById(`upload-zone-${id}`);

    zone.addEventListener('click', () => {
      this.uploadChannel = id;
      document.getElementById('fileInput').click();
    });

    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      zone.classList.add('drag-over');
    });

    zone.addEventListener('dragleave', () => {
      zone.classList.remove('drag-over');
    });

    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('drag-over');
      if (e.dataTransfer.files.length > 0) {
        this.uploadFiles(id, e.dataTransfer.files);
      }
    });
  },

  uploadFiles(id, files) {
    const zone = document.getElementById(`upload-zone-${id}`);
    const progressBar = document.getElementById(`upload-progress-${id}`);
    const progressFill = document.getElementById(`progress-fill-${id}`);

    const formData = new FormData();
    for (const file of files) {
      formData.append('files', file);
    }

    zone.classList.add('uploading');
    zone.textContent = `Uploading ${files.length} file${files.length > 1 ? 's' : ''}...`;
    progressBar.classList.add('active');
    progressFill.style.width = '0%';

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/channels/${id}/upload`);
    xhr.setRequestHeader('Authorization', `Bearer ${this.token}`);

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        progressFill.style.width = pct + '%';
      }
    });

    xhr.addEventListener('load', () => {
      zone.classList.remove('uploading');
      zone.textContent = 'Drop MP3s here or click to browse';
      progressBar.classList.remove('active');

      if (xhr.status === 200) {
        try {
          const data = JSON.parse(xhr.responseText);
          if (data.ok) {
            this.renderTracks(id, data.tracks);
          }
        } catch (e) { /* ignore parse error */ }
      } else {
        zone.textContent = 'Upload failed — try again';
        setTimeout(() => { zone.textContent = 'Drop MP3s here or click to browse'; }, 2000);
      }
    });

    xhr.addEventListener('error', () => {
      zone.classList.remove('uploading');
      zone.textContent = 'Upload failed — try again';
      progressBar.classList.remove('active');
      setTimeout(() => { zone.textContent = 'Drop MP3s here or click to browse'; }, 2000);
    });

    xhr.send(formData);
  },

  async loadTracks(id) {
    try {
      const res = await fetch(`/api/channels/${id}/tracks`, {
        headers: { 'Authorization': `Bearer ${this.token}` },
      });
      const data = await res.json();
      if (data.ok) {
        this.renderTracks(id, data.tracks);
      }
    } catch (e) {
      console.error(`Failed to load tracks for ${id}:`, e);
    }
  },

  renderTracks(id, tracks) {
    const container = document.getElementById(`track-list-${id}`);
    if (!tracks || tracks.length === 0) {
      container.innerHTML = '<div class="track-list-empty">No tracks — upload some music</div>';
      return;
    }

    container.innerHTML = tracks.map(t => `
      <div class="track-item">
        <div class="track-meta">
          <div class="track-name">${this.escapeHtml(t.title || t.filename)}</div>
          <div class="track-artist">${this.escapeHtml(t.artist || '')}</div>
        </div>
        <button class="track-delete" onclick="Admin.deleteTrack('${id}', '${this.escapeAttr(t.filename)}')" title="Delete">&#x2715;</button>
      </div>
    `).join('');
  },

  async deleteTrack(id, filename) {
    if (!confirm(`Delete "${filename}"?`)) return;

    try {
      const res = await fetch(`/api/channels/${id}/tracks/${encodeURIComponent(filename)}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${this.token}` },
      });
      const data = await res.json();
      if (data.ok) {
        this.renderTracks(id, data.tracks);
      }
    } catch (e) {
      console.error('Delete failed:', e);
    }
  },

  async previous(channelId) {
    try {
      const res = await fetch(`/api/channels/${channelId}/previous`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.token}` },
      });
      const data = await res.json();
      if (!data.ok) {
        alert(data.error || 'No previous track');
      } else {
        setTimeout(() => this.fetchAndUpdate(), 500);
      }
    } catch (e) {
      console.error('Previous failed:', e);
    }
  },

  // --- Bluetooth ---

  async toggleBluetooth(channelId) {
    const btn = document.getElementById(`bt-btn-${channelId}`);
    const currentlyBt = btn.classList.contains('active');

    try {
      await fetch(`/api/channels/${channelId}/bluetooth`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`,
        },
        body: JSON.stringify({ enabled: !currentlyBt }),
      });
      setTimeout(() => this.fetchAndUpdate(), 500);
    } catch (e) {
      console.error('Bluetooth toggle failed:', e);
    }
  },

  async loadBluetoothStatus() {
    try {
      const res = await fetch('/api/bluetooth/status', {
        headers: { 'Authorization': `Bearer ${this.token}` },
      });
      const data = await res.json();
      if (data.ok) {
        this.btDevices = data.devices || [];
        this.renderBluetoothPanel();
      }
    } catch (e) {
      // Bluetooth might not be available
    }
  },

  renderBluetoothPanel() {
    let panel = document.getElementById('bt-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'bt-panel';
      panel.className = 'bt-panel';
      const systemControls = document.querySelector('.system-controls');
      systemControls.parentNode.insertBefore(panel, systemControls);
    }

    if (this.btDevices.length === 0) {
      panel.innerHTML = `
        <h3>Bluetooth</h3>
        <div class="bt-status">No devices connected — pair a phone via Bluetooth settings</div>
      `;
      return;
    }

    panel.innerHTML = `
      <h3>Bluetooth</h3>
      ${this.btDevices.map(d => `
        <div class="bt-device">
          <div class="bt-device-name">${this.escapeHtml(d.name)}</div>
          <div class="bt-device-channel">
            <select onchange="Admin.reassignBt('${this.escapeAttr(d.mac)}', this.value)">
              ${this.channels.map(ch =>
                `<option value="${ch}" ${d.channel === ch ? 'selected' : ''}>${this.channelNames[ch]}</option>`
              ).join('')}
            </select>
          </div>
        </div>
      `).join('')}
    `;
  },

  async reassignBt(mac, channel) {
    try {
      await fetch('/api/bluetooth/assign', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`,
        },
        body: JSON.stringify({ mac, channel }),
      });
      this.loadBluetoothStatus();
      setTimeout(() => this.fetchAndUpdate(), 500);
    } catch (e) {
      console.error('BT reassign failed:', e);
    }
  },

  // --- Polling ---

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
          const btBtn = document.getElementById(`bt-btn-${ch.id}`);

          if (npEl && ch.nowPlaying) {
            npEl.innerHTML = `<strong>${ch.nowPlaying.title || 'Unknown'}</strong> - ${ch.nowPlaying.artist || ''}`;
          }
          if (lisEl) lisEl.textContent = `${ch.listeners || 0} listeners`;
          if (alsaBtn) {
            alsaBtn.textContent = ch.alsaMode ? 'Switch to Playlist' : 'Line-In';
          }
          if (btBtn) {
            if (ch.bluetoothMode) {
              btBtn.classList.add('active');
              btBtn.textContent = 'BT Active';
            } else {
              btBtn.classList.remove('active');
              btBtn.textContent = 'Bluetooth';
            }
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
    this.loadBluetoothStatus();
    setInterval(() => this.fetchAndUpdate(), 3000);
    setInterval(() => this.loadBluetoothStatus(), 10000);
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

  escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  },

  escapeAttr(str) {
    return str.replace(/'/g, "\\'").replace(/"/g, '&quot;');
  },
};

document.addEventListener('DOMContentLoaded', () => Admin.init());
