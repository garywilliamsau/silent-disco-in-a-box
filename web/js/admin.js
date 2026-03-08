'use strict';

const Admin = {
  token: null,
  channels: ['red', 'green', 'blue'],
  channelNames: { red: 'Red', green: 'Green', blue: 'Blue' },
  channelColors: { red: '#ff1744', green: '#00e676', blue: '#2979ff' },
  uploadChannel: null,
  btDevices: [],
  trackData: {},    // { channelId: [tracks] }
  trackSort: {},    // { channelId: 'title'|'artist'|'recent' }

  // Playlist/library state
  libraryTracks: [],
  playlists: [],
  currentPlaylistId: null,
  currentPlaylistData: null,
  channelAssignments: {},  // { channelId: playlistId }

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

    document.getElementById('libraryFileInput').addEventListener('change', (e) => {
      if (e.target.files.length > 0) {
        this.uploadToLibrary(e.target.files);
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
    this.loadChannelAssignments();
  },

  // === Tab switching ===

  switchTab(tabName) {
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(tab => tab.classList.remove('active'));
    document.querySelector(`.tab-btn[onclick*="'${tabName}'"]`).classList.add('active');
    document.getElementById(`tab-${tabName}`).classList.add('active');

    if (tabName === 'library') this.loadLibrary();
    if (tabName === 'playlists') this.loadPlaylists();
  },

  // === Channel Panels ===

  renderPanels() {
    const container = document.getElementById('channelPanels');
    container.innerHTML = '';

    this.channels.forEach(id => {
      this.trackSort[id] = this.trackSort[id] || 'order';

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
          <div class="transport">
            <button class="transport-btn" onclick="Admin.previous('${id}')" title="Previous">&#x23EE;</button>
            <button class="transport-btn transport-skip" onclick="Admin.skip('${id}')" title="Skip">&#x23ED;</button>
          </div>
          <div class="source-btns">
            <button class="btn" id="alsa-btn-${id}" onclick="Admin.toggleAlsa('${id}')">Line-In</button>
            <button class="btn btn-bt" id="bt-btn-${id}" onclick="Admin.toggleBluetooth('${id}')">Bluetooth</button>
            <button class="btn btn-spotify" id="spotify-btn-${id}" onclick="Admin.toggleSpotify('${id}')">Spotify</button>
          </div>
        </div>

        <div class="playlist-assign">
          <label>Playlist:</label>
          <select id="playlist-select-${id}" onchange="Admin.assignPlaylist('${id}', this.value)">
            <option value="">-- None --</option>
          </select>
        </div>

        <div class="tracks-section">
          <div class="tracks-header" onclick="Admin.toggleTracks('${id}')">
            <span class="tracks-toggle" id="tracks-toggle-${id}">&#x25B6;</span>
            <span>Tracks</span>
            <span class="tracks-count" id="tracks-count-${id}"></span>
          </div>
          <div class="tracks-body hidden" id="tracks-body-${id}">
            <div class="tracks-toolbar">
              <div class="upload-zone" id="upload-zone-${id}">
                Drop MP3s here or click to browse
              </div>
              <div class="upload-progress" id="upload-progress-${id}">
                <div class="progress-fill" id="progress-fill-${id}"></div>
              </div>
              <div class="sort-bar">
                <span class="sort-label">Sort:</span>
                <button class="sort-btn active" data-sort="order" onclick="Admin.setSort('${id}', 'order', this)">Play Order</button>
                <button class="sort-btn" data-sort="title" onclick="Admin.setSort('${id}', 'title', this)">Title</button>
                <button class="sort-btn" data-sort="artist" onclick="Admin.setSort('${id}', 'artist', this)">Artist</button>
              </div>
            </div>
            <div class="track-list" id="track-list-${id}">
              <div class="track-list-empty">Loading tracks...</div>
            </div>
          </div>
        </div>
      `;

      container.appendChild(panel);
      this.setupUploadZone(id);
      this.loadTracks(id);
    });

    this.loadBluetoothStatus();
  },

  // === Channel Playlist Assignment ===

  async loadChannelAssignments() {
    try {
      const [playlistsRes, ...assignmentResults] = await Promise.all([
        fetch('/api/playlists', { headers: { 'Authorization': `Bearer ${this.token}` } }),
        ...this.channels.map(ch =>
          fetch(`/api/channels/${ch}/playlist`, { headers: { 'Authorization': `Bearer ${this.token}` } })
        ),
      ]);

      const playlistsData = await playlistsRes.json();
      const playlists = playlistsData.ok ? playlistsData.playlists : [];

      for (let i = 0; i < this.channels.length; i++) {
        const chId = this.channels[i];
        const data = await assignmentResults[i].json();
        this.channelAssignments[chId] = data.ok ? data.playlistId : null;

        const select = document.getElementById(`playlist-select-${chId}`);
        if (select) {
          select.innerHTML = '<option value="">-- None --</option>' +
            playlists.map(pl =>
              `<option value="${this.escapeAttr(pl.id)}" ${this.channelAssignments[chId] === pl.id ? 'selected' : ''}>${this.escapeHtml(pl.name)} (${pl.trackCount})</option>`
            ).join('');
        }
      }
    } catch (e) {
      console.error('Failed to load channel assignments:', e);
    }
  },

  async assignPlaylist(channelId, playlistId) {
    try {
      await fetch(`/api/channels/${channelId}/playlist`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`,
        },
        body: JSON.stringify({ playlistId: playlistId || null }),
      });
      this.channelAssignments[channelId] = playlistId || null;
    } catch (e) {
      console.error('Assign playlist failed:', e);
    }
  },

  // === Library ===

  async loadLibrary() {
    try {
      const res = await fetch('/api/library', {
        headers: { 'Authorization': `Bearer ${this.token}` },
      });
      const data = await res.json();
      if (data.ok) {
        this.libraryTracks = data.tracks;
        this.renderLibrary(data.tracks);
      }
    } catch (e) {
      console.error('Failed to load library:', e);
    }
  },

  renderLibrary(tracks) {
    const container = document.getElementById('libraryTrackList');
    const statsEl = document.getElementById('libraryStats');

    if (statsEl) {
      const totalDuration = tracks.reduce((sum, t) => sum + (t.duration || 0), 0);
      const mins = Math.round(totalDuration / 60);
      statsEl.textContent = `${tracks.length} tracks, ${mins} min total`;
    }

    if (!tracks || tracks.length === 0) {
      container.innerHTML = '<div class="track-list-empty">No tracks in library — upload some music</div>';
      return;
    }

    container.innerHTML = tracks.map(t => `
      <div class="track-item" data-filename="${this.escapeAttr(t.filename)}" data-title="${this.escapeAttr(t.title || '')}" data-artist="${this.escapeAttr(t.artist || '')}">
        <div class="track-meta">
          <div class="track-name">${this.escapeHtml(t.title || t.filename)}</div>
          <div class="track-artist">${this.escapeHtml(t.artist || '')}${t.duration ? ' &middot; ' + this.formatDuration(t.duration) : ''}</div>
        </div>
        <button class="track-delete" onclick="Admin.deleteFromLibrary('${this.escapeAttr(t.filename)}')" title="Delete">&#x2715;</button>
      </div>
    `).join('');
  },

  filterLibrary() {
    const query = document.getElementById('librarySearch').value.toLowerCase();
    const items = document.querySelectorAll('#libraryTrackList .track-item');
    items.forEach(item => {
      const title = (item.dataset.title || '').toLowerCase();
      const artist = (item.dataset.artist || '').toLowerCase();
      const filename = (item.dataset.filename || '').toLowerCase();
      item.style.display = (title.includes(query) || artist.includes(query) || filename.includes(query)) ? '' : 'none';
    });
  },

  setupLibraryUpload() {
    const zone = document.getElementById('library-upload-zone');
    if (!zone || zone.dataset.bound) return;
    zone.dataset.bound = 'true';

    zone.addEventListener('click', () => {
      document.getElementById('libraryFileInput').click();
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
        this.uploadToLibrary(e.dataTransfer.files);
      }
    });
  },

  uploadToLibrary(files) {
    const zone = document.getElementById('library-upload-zone');
    const progressBar = document.getElementById('library-upload-progress');
    const progressFill = document.getElementById('library-progress-fill');

    const formData = new FormData();
    for (const file of files) {
      formData.append('files', file);
    }

    zone.classList.add('uploading');
    zone.textContent = `Uploading ${files.length} file${files.length > 1 ? 's' : ''}...`;
    progressBar.classList.add('active');
    progressFill.style.width = '0%';

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/library/upload');
    xhr.setRequestHeader('Authorization', `Bearer ${this.token}`);

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        progressFill.style.width = Math.round((e.loaded / e.total) * 100) + '%';
      }
    });

    xhr.addEventListener('load', () => {
      zone.classList.remove('uploading');
      zone.textContent = 'Drop audio files here or click to browse';
      progressBar.classList.remove('active');
      if (xhr.status === 200) {
        this.loadLibrary();
      } else {
        zone.textContent = 'Upload failed — try again';
        setTimeout(() => { zone.textContent = 'Drop audio files here or click to browse'; }, 2000);
      }
    });

    xhr.addEventListener('error', () => {
      zone.classList.remove('uploading');
      zone.textContent = 'Upload failed — try again';
      progressBar.classList.remove('active');
      setTimeout(() => { zone.textContent = 'Drop audio files here or click to browse'; }, 2000);
    });

    xhr.send(formData);
  },

  async deleteFromLibrary(filename) {
    if (!confirm(`Delete "${filename}" from library? This will remove it from all playlists.`)) return;
    try {
      const res = await fetch(`/api/library/${encodeURIComponent(filename)}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${this.token}` },
      });
      const data = await res.json();
      if (data.ok) {
        this.loadLibrary();
      }
    } catch (e) {
      console.error('Delete from library failed:', e);
    }
  },

  // === Playlists ===

  async loadPlaylists() {
    try {
      const res = await fetch('/api/playlists', {
        headers: { 'Authorization': `Bearer ${this.token}` },
      });
      const data = await res.json();
      if (data.ok) {
        this.playlists = data.playlists;
        this.renderPlaylists(data.playlists);
      }
    } catch (e) {
      console.error('Failed to load playlists:', e);
    }
  },

  renderPlaylists(playlists) {
    const container = document.getElementById('playlistsList');
    const detailEl = document.getElementById('playlistDetail');

    // Hide detail if visible; show list
    if (!detailEl.classList.contains('hidden')) return;

    if (!playlists || playlists.length === 0) {
      container.innerHTML = '<div class="track-list-empty">No playlists yet — create one above</div>';
      return;
    }

    // Find which channels use each playlist
    const usedBy = {};
    for (const [ch, plId] of Object.entries(this.channelAssignments)) {
      if (plId) {
        if (!usedBy[plId]) usedBy[plId] = [];
        usedBy[plId].push(this.channelNames[ch] || ch);
      }
    }

    container.innerHTML = playlists.map(pl => `
      <div class="playlist-card" onclick="Admin.openPlaylist('${this.escapeAttr(pl.id)}')">
        <div class="playlist-card-name">${this.escapeHtml(pl.name)}</div>
        <div class="playlist-card-info">
          ${pl.trackCount} track${pl.trackCount !== 1 ? 's' : ''}
          ${usedBy[pl.id] ? ' &middot; Used by: ' + usedBy[pl.id].join(', ') : ''}
        </div>
      </div>
    `).join('');
  },

  showCreatePlaylist() {
    document.getElementById('createPlaylistForm').classList.remove('hidden');
    document.getElementById('newPlaylistName').focus();
  },

  hideCreatePlaylist() {
    document.getElementById('createPlaylistForm').classList.add('hidden');
    document.getElementById('newPlaylistName').value = '';
  },

  async createPlaylist() {
    const name = document.getElementById('newPlaylistName').value.trim();
    if (!name) return;

    try {
      const res = await fetch('/api/playlists', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`,
        },
        body: JSON.stringify({ name, tracks: [] }),
      });
      const data = await res.json();
      if (data.ok) {
        this.hideCreatePlaylist();
        this.loadPlaylists();
        this.loadChannelAssignments();
      }
    } catch (e) {
      console.error('Create playlist failed:', e);
    }
  },

  async openPlaylist(id) {
    this.currentPlaylistId = id;

    document.getElementById('playlistsList').classList.add('hidden');
    document.querySelector('.playlists-toolbar').classList.add('hidden');
    document.getElementById('playlistDetail').classList.remove('hidden');

    try {
      const [plRes, libRes] = await Promise.all([
        fetch(`/api/playlists/${encodeURIComponent(id)}`, { headers: { 'Authorization': `Bearer ${this.token}` } }),
        fetch('/api/library', { headers: { 'Authorization': `Bearer ${this.token}` } }),
      ]);

      const plData = await plRes.json();
      const libData = await libRes.json();

      if (plData.ok) {
        this.currentPlaylistData = plData.playlist;
        document.getElementById('playlistDetailName').textContent = plData.playlist.name;
        this.renderPlaylistTracks(plData.playlist.tracks);
      }

      if (libData.ok) {
        this.libraryTracks = libData.tracks;
        this.renderPlaylistPicker(libData.tracks, plData.ok ? plData.playlist.tracks : []);
      }
    } catch (e) {
      console.error('Failed to load playlist detail:', e);
    }
  },

  closePlaylistDetail() {
    this.currentPlaylistId = null;
    this.currentPlaylistData = null;

    document.getElementById('playlistDetail').classList.add('hidden');
    document.getElementById('playlistsList').classList.remove('hidden');
    document.querySelector('.playlists-toolbar').classList.remove('hidden');

    this.loadPlaylists();
  },

  renderPlaylistTracks(tracks) {
    const container = document.getElementById('playlistDetailTracks');
    if (!tracks || tracks.length === 0) {
      container.innerHTML = '<div class="track-list-empty">No tracks — add from library above</div>';
      return;
    }

    container.innerHTML = tracks.map((t, i) => `
      <div class="track-item">
        <div class="track-order-btns">
          <button class="track-move" onclick="Admin.movePlaylistTrack(${i}, 'up')" ${i === 0 ? 'disabled' : ''}>&#x25B2;</button>
          <button class="track-move" onclick="Admin.movePlaylistTrack(${i}, 'down')" ${i === tracks.length - 1 ? 'disabled' : ''}>&#x25BC;</button>
        </div>
        <div class="track-meta">
          <div class="track-name">${this.escapeHtml(t.title || t.filename)}</div>
          <div class="track-artist">${this.escapeHtml(t.artist || '')}${t.duration ? ' &middot; ' + this.formatDuration(t.duration) : ''}</div>
        </div>
        <button class="track-delete" onclick="Admin.removeFromPlaylist('${this.escapeAttr(t.filename)}')" title="Remove">&#x2715;</button>
      </div>
    `).join('');
  },

  renderPlaylistPicker(libraryTracks, playlistTracks) {
    const container = document.getElementById('playlistPickerList');
    const inPlaylist = new Set(playlistTracks.map(t => t.filename));

    container.innerHTML = libraryTracks.map(t => {
      const added = inPlaylist.has(t.filename);
      return `
        <div class="track-item picker-item ${added ? 'in-playlist' : ''}" data-filename="${this.escapeAttr(t.filename)}" data-title="${this.escapeAttr(t.title || '')}" data-artist="${this.escapeAttr(t.artist || '')}">
          <div class="track-meta">
            <div class="track-name">${this.escapeHtml(t.title || t.filename)}</div>
            <div class="track-artist">${this.escapeHtml(t.artist || '')}</div>
          </div>
          <button class="btn ${added ? 'btn-added' : 'btn-add'}" onclick="Admin.toggleTrackInPlaylist('${this.escapeAttr(t.filename)}', this)">
            ${added ? 'Added' : '+ Add'}
          </button>
        </div>
      `;
    }).join('');
  },

  filterPicker() {
    const query = document.getElementById('pickerSearch').value.toLowerCase();
    const items = document.querySelectorAll('#playlistPickerList .picker-item');
    items.forEach(item => {
      const title = (item.dataset.title || '').toLowerCase();
      const artist = (item.dataset.artist || '').toLowerCase();
      const filename = (item.dataset.filename || '').toLowerCase();
      item.style.display = (title.includes(query) || artist.includes(query) || filename.includes(query)) ? '' : 'none';
    });
  },

  async toggleTrackInPlaylist(filename, btn) {
    if (!this.currentPlaylistData) return;

    const tracks = this.currentPlaylistData.tracks.map(t => t.filename);
    const idx = tracks.indexOf(filename);

    if (idx !== -1) {
      tracks.splice(idx, 1);
    } else {
      tracks.push(filename);
    }

    try {
      const res = await fetch(`/api/playlists/${encodeURIComponent(this.currentPlaylistId)}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`,
        },
        body: JSON.stringify({ tracks }),
      });
      const data = await res.json();
      if (data.ok) {
        // Re-open to refresh both lists
        this.openPlaylist(this.currentPlaylistId);
        this.loadChannelAssignments();
      }
    } catch (e) {
      console.error('Toggle track in playlist failed:', e);
    }
  },

  async movePlaylistTrack(index, direction) {
    if (!this.currentPlaylistData) return;
    const tracks = this.currentPlaylistData.tracks.map(t => t.filename);
    const newIndex = direction === 'up' ? index - 1 : index + 1;
    if (newIndex < 0 || newIndex >= tracks.length) return;

    [tracks[index], tracks[newIndex]] = [tracks[newIndex], tracks[index]];

    try {
      const res = await fetch(`/api/playlists/${encodeURIComponent(this.currentPlaylistId)}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`,
        },
        body: JSON.stringify({ tracks }),
      });
      const data = await res.json();
      if (data.ok) {
        this.openPlaylist(this.currentPlaylistId);
      }
    } catch (e) {
      console.error('Move playlist track failed:', e);
    }
  },

  async removeFromPlaylist(filename) {
    if (!this.currentPlaylistData) return;
    const tracks = this.currentPlaylistData.tracks.map(t => t.filename).filter(f => f !== filename);

    try {
      const res = await fetch(`/api/playlists/${encodeURIComponent(this.currentPlaylistId)}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`,
        },
        body: JSON.stringify({ tracks }),
      });
      const data = await res.json();
      if (data.ok) {
        this.openPlaylist(this.currentPlaylistId);
        this.loadChannelAssignments();
      }
    } catch (e) {
      console.error('Remove from playlist failed:', e);
    }
  },

  async deleteCurrentPlaylist() {
    if (!this.currentPlaylistId) return;
    if (!confirm(`Delete playlist "${this.currentPlaylistData?.name || this.currentPlaylistId}"?`)) return;

    try {
      await fetch(`/api/playlists/${encodeURIComponent(this.currentPlaylistId)}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${this.token}` },
      });
      this.closePlaylistDetail();
      this.loadChannelAssignments();
    } catch (e) {
      console.error('Delete playlist failed:', e);
    }
  },

  // === Existing functionality (unchanged) ===

  toggleTracks(id) {
    const body = document.getElementById(`tracks-body-${id}`);
    const toggle = document.getElementById(`tracks-toggle-${id}`);
    body.classList.toggle('hidden');
    toggle.innerHTML = body.classList.contains('hidden') ? '&#x25B6;' : '&#x25BC;';
  },

  setSort(id, sort, btn) {
    this.trackSort[id] = sort;
    const bar = btn.parentElement;
    bar.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    if (this.trackData[id]) {
      this.renderTracks(id, this.trackData[id]);
    }
  },

  sortTracks(tracks, sort) {
    const sorted = [...tracks];
    if (sort === 'title') {
      sorted.sort((a, b) => (a.title || a.filename).localeCompare(b.title || b.filename));
    } else if (sort === 'artist') {
      sorted.sort((a, b) => (a.artist || '').localeCompare(b.artist || '') || (a.title || a.filename).localeCompare(b.title || b.filename));
    } else if (sort === 'recent') {
      sorted.reverse();
    }
    return sorted;
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
            this.trackData[id] = data.tracks;
            this.renderTracks(id, data.tracks);
          }
        } catch (e) { /* ignore */ }
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
        this.trackData[id] = data.tracks;
        this.renderTracks(id, data.tracks);
      }
    } catch (e) {
      console.error(`Failed to load tracks for ${id}:`, e);
    }
  },

  renderTracks(id, tracks) {
    const container = document.getElementById(`track-list-${id}`);
    const countEl = document.getElementById(`tracks-count-${id}`);
    if (countEl) countEl.textContent = tracks ? `(${tracks.length})` : '';

    if (!tracks || tracks.length === 0) {
      container.innerHTML = '<div class="track-list-empty">No tracks — upload some music</div>';
      return;
    }

    const sort = this.trackSort[id] || 'order';
    const sorted = sort === 'order' ? tracks : this.sortTracks(tracks, sort);
    const showOrder = sort === 'order';

    container.innerHTML = sorted.map((t, i) => `
      <div class="track-item">
        ${showOrder ? `<div class="track-order-btns">
          <button class="track-move" onclick="Admin.moveTrack('${id}', '${this.escapeAttr(t.filename)}', 'up')" ${i === 0 ? 'disabled' : ''}>&#x25B2;</button>
          <button class="track-move" onclick="Admin.moveTrack('${id}', '${this.escapeAttr(t.filename)}', 'down')" ${i === sorted.length - 1 ? 'disabled' : ''}>&#x25BC;</button>
        </div>` : ''}
        <div class="track-meta">
          <div class="track-name">${this.escapeHtml(t.title || t.filename)}</div>
          <div class="track-artist">${this.escapeHtml(t.artist || '')}</div>
        </div>
        <button class="track-delete" onclick="Admin.deleteTrack('${id}', '${this.escapeAttr(t.filename)}')" title="Delete">&#x2715;</button>
      </div>
    `).join('');
  },

  async moveTrack(id, filename, direction) {
    try {
      const res = await fetch(`/api/channels/${id}/tracks/move`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`,
        },
        body: JSON.stringify({ filename, direction }),
      });
      const data = await res.json();
      if (data.ok) {
        this.trackData[id] = data.tracks;
        this.renderTracks(id, data.tracks);
      }
    } catch (e) {
      console.error('Move failed:', e);
    }
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
        this.trackData[id] = data.tracks;
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

  // --- Spotify ---

  async toggleSpotify(channelId) {
    const btn = document.getElementById(`spotify-btn-${channelId}`);
    const currentlySpotify = btn.classList.contains('active');

    try {
      await fetch(`/api/channels/${channelId}/spotify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`,
        },
        body: JSON.stringify({ enabled: !currentlySpotify }),
      });
      setTimeout(() => this.fetchAndUpdate(), 500);
    } catch (e) {
      console.error('Spotify toggle failed:', e);
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
    } catch (e) { /* Bluetooth might not be available */ }
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
          const spotifyBtn = document.getElementById(`spotify-btn-${ch.id}`);

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
          if (spotifyBtn) {
            if (ch.spotifyMode) {
              spotifyBtn.classList.add('active');
              spotifyBtn.textContent = 'Spotify Active';
            } else {
              spotifyBtn.classList.remove('active');
              spotifyBtn.textContent = 'Spotify';
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
    this.fetchSystemStats();
    this.loadBluetoothStatus();
    this.setupLibraryUpload();
    setInterval(() => this.fetchAndUpdate(), 3000);
    setInterval(() => this.fetchSystemStats(), 5000);
    setInterval(() => this.loadBluetoothStatus(), 10000);
  },

  async fetchSystemStats() {
    try {
      const res = await fetch('/api/system');
      const data = await res.json();
      if (data.ok) {
        document.getElementById('piCpu').textContent = `CPU ${data.cpu}%`;
        document.getElementById('piMem').textContent = `RAM ${data.mem}%`;
        if (data.temp !== null) {
          const t = data.temp;
          document.getElementById('piTemp').textContent = `${t}°C`;
          document.getElementById('piTemp').style.color = t >= 80 ? '#ff4444' : t >= 70 ? '#ffaa00' : '';
        }
      }
    } catch { /* ignore */ }
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

  talkoverStart() {
    document.getElementById('talkoverBtn').classList.add('active');
    Talkover.start();
  },

  talkoverStop() {
    document.getElementById('talkoverBtn').classList.remove('active');
    Talkover.stop();
  },

  async toggleTalkoverEnabled(enabled) {
    try {
      await fetch('/api/talkover/toggle', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`,
        },
        body: JSON.stringify({ enabled }),
      });
    } catch (e) {
      console.error('Talkover toggle failed:', e);
    }
  },

  // --- Helpers ---

  formatDuration(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
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
