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
  nowPlayingFile: {},
  nowPlayingTitle: {},
  bulkSelectMode: false,
  bulkSelected: new Set(),

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
    if (tabName === 'history') this.loadHistory();
    if (tabName === 'schedule') this.loadSchedules();
    if (tabName === 'stats') this.loadEventStats();
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
                <button class="btn-shuffle" onclick="Admin.shuffleTracks('${id}')" title="Shuffle track order">Shuffle</button>
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
      this.loadTracks(channelId);
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
        this.renderLibrary(this.sortTrackList(data.tracks, this.librarySort));
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
      <div class="track-item" data-filename="${this.escapeAttr(t.filename)}" data-title="${this.escapeAttr(t.title || '')}" data-artist="${this.escapeAttr(t.artist || '')}" data-tags="${this.escapeAttr((t.tags || []).join(','))}">
        ${this.bulkSelectMode ? `<input type="checkbox" class="bulk-checkbox" onchange="Admin.toggleBulkItem('${this.escapeAttr(t.filename)}', this)" ${this.bulkSelected.has(t.filename) ? 'checked' : ''}>` : ''}
        <div class="track-meta">
          <div class="track-name">${this.escapeHtml(t.title || t.filename)}</div>
          <div class="track-artist">${this.escapeHtml(t.artist || '')}${t.duration ? ' &middot; ' + this.formatDuration(t.duration) : ''}${t.bpm ? ' &middot; ' + Math.round(t.bpm) + ' BPM' : ''}</div>
        </div>
        <button class="btn-preview" onclick="Admin.togglePreview('${this.escapeAttr(t.filename)}', this)" title="Preview">&#x25B6;</button>
        <div class="track-tags" data-filename="${this.escapeAttr(t.filename)}">
          ${(t.tags || []).map(tag => `<span class="tag" onclick="Admin.removeTag('${this.escapeAttr(t.filename)}', '${this.escapeAttr(tag)}')">${this.escapeHtml(tag)}</span>`).join('')}
          <button class="tag-add-btn" onclick="Admin.addTagPrompt('${this.escapeAttr(t.filename)}')" title="Add tag">+</button>
        </div>
        <button class="track-delete" onclick="Admin.deleteFromLibrary('${this.escapeAttr(t.filename)}')" title="Delete">&#x2715;</button>
      </div>
    `).join('');
  },

  librarySort: 'title',
  pickerSort: 'title',

  sortLibrary(sort, btn) {
    this.librarySort = sort;
    btn.parentElement.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    if (this.libraryTracks) {
      const sorted = this.sortTrackList(this.libraryTracks, sort);
      this.renderLibrary(sorted);
    }
  },

  sortPicker(sort, btn) {
    this.pickerSort = sort;
    btn.parentElement.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    if (this.currentPlaylistData) {
      const sorted = this.sortTrackList(this.libraryTracks, sort);
      this.renderPlaylistPicker(sorted, this.currentPlaylistData.tracks);
    }
  },

  sortTrackList(tracks, sort) {
    const sorted = [...tracks];
    if (sort === 'title') {
      sorted.sort((a, b) => (a.title || a.filename).localeCompare(b.title || b.filename));
    } else if (sort === 'artist') {
      sorted.sort((a, b) => (a.artist || '').localeCompare(b.artist || '') || (a.title || a.filename).localeCompare(b.title || b.filename));
    } else if (sort === 'recent') {
      sorted.sort((a, b) => (b.uploadedAt || '').localeCompare(a.uploadedAt || ''));
    } else if (sort === 'bpm') {
      sorted.sort((a, b) => (b.bpm || 0) - (a.bpm || 0));
    }
    return sorted;
  },

  filterLibrary() {
    const query = document.getElementById('librarySearch').value.toLowerCase();
    const tagFilter = (document.getElementById('libraryTagFilter')?.value || '').toLowerCase().trim();
    const items = document.querySelectorAll('#libraryTrackList .track-item');
    items.forEach(item => {
      const title = (item.dataset.title || '').toLowerCase();
      const artist = (item.dataset.artist || '').toLowerCase();
      const filename = (item.dataset.filename || '').toLowerCase();
      const tags = (item.dataset.tags || '').toLowerCase();
      const matchesSearch = !query || title.includes(query) || artist.includes(query) || filename.includes(query);
      const matchesTag = !tagFilter || tags.includes(tagFilter);
      item.style.display = (matchesSearch && matchesTag) ? '' : 'none';
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
        <button class="btn btn-sm" onclick="Admin.duplicatePlaylist('${this.escapeAttr(pl.id)}', event)">Duplicate</button>
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
        this.renderPlaylistPicker(this.sortTrackList(libData.tracks, this.pickerSort), plData.ok ? plData.playlist.tracks : []);
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
    const countEl = document.getElementById('playlistTrackCount');
    if (countEl) countEl.textContent = tracks ? `(${tracks.length})` : '';
    if (!tracks || tracks.length === 0) {
      container.innerHTML = '<div class="track-list-empty">No tracks — add from library</div>';
      return;
    }

    container.innerHTML = tracks.map((t, i) => `
      <div class="track-item draggable-track" data-index="${i}">
        <div class="drag-handle" title="Drag to reorder">&#x2630;</div>
        <div class="track-meta">
          <div class="track-name">${this.escapeHtml(t.title || t.filename)}</div>
          <div class="track-artist">${this.escapeHtml(t.artist || '')}${t.duration ? ' &middot; ' + this.formatDuration(t.duration) : ''}${t.bpm ? ' &middot; ' + Math.round(t.bpm) + ' BPM' : ''}</div>
        </div>
        <button class="btn-preview" onclick="Admin.togglePreview('${this.escapeAttr(t.filename)}', this)" title="Preview">&#x25B6;</button>
        <button class="track-delete" onclick="Admin.removeFromPlaylist('${this.escapeAttr(t.filename)}')" title="Remove">&#x2715;</button>
      </div>
    `).join('');

    this.initDragReorder(container);
  },

  // Drag-and-drop reorder (mouse + touch)
  _drag: null,

  initDragReorder(container) {
    const handles = container.querySelectorAll('.drag-handle');
    handles.forEach(handle => {
      handle.addEventListener('mousedown', (e) => this.dragStart(e, handle.parentElement, container));
      handle.addEventListener('touchstart', (e) => this.dragStart(e, handle.parentElement, container), { passive: false });
    });
  },

  dragStart(e, item, container) {
    e.preventDefault();
    const items = [...container.querySelectorAll('.draggable-track')];
    const startIndex = items.indexOf(item);
    const rect = item.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();

    // Create placeholder
    const placeholder = document.createElement('div');
    placeholder.className = 'drag-placeholder';
    placeholder.style.height = rect.height + 'px';

    // Style the dragged item
    item.classList.add('dragging');
    item.style.width = rect.width + 'px';
    item.parentNode.insertBefore(placeholder, item);
    item.style.position = 'fixed';
    item.style.left = rect.left + 'px';
    item.style.top = rect.top + 'px';
    item.style.zIndex = '1000';

    const startY = e.type === 'touchstart' ? e.touches[0].clientY : e.clientY;
    const offsetY = startY - rect.top;
    let currentIndex = startIndex;

    const onMove = (ev) => {
      const clientY = ev.type === 'touchmove' ? ev.touches[0].clientY : ev.clientY;
      item.style.top = (clientY - offsetY) + 'px';

      // Auto-scroll the container
      const cy = clientY - containerRect.top;
      if (cy < 40) container.scrollTop -= 8;
      else if (cy > containerRect.height - 40) container.scrollTop += 8;

      // Find which item we're over
      const siblings = [...container.querySelectorAll('.draggable-track:not(.dragging)')];
      for (let i = 0; i < siblings.length; i++) {
        const sibRect = siblings[i].getBoundingClientRect();
        const midY = sibRect.top + sibRect.height / 2;
        if (clientY < midY) {
          container.insertBefore(placeholder, siblings[i]);
          currentIndex = i;
          return;
        }
      }
      // Past the last item
      if (siblings.length > 0) {
        siblings[siblings.length - 1].after(placeholder);
        currentIndex = siblings.length;
      }
    };

    const onEnd = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onEnd);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);

      item.classList.remove('dragging');
      item.style.position = '';
      item.style.left = '';
      item.style.top = '';
      item.style.width = '';
      item.style.zIndex = '';
      placeholder.replaceWith(item);

      if (currentIndex !== startIndex) {
        this.reorderPlaylistTrack(startIndex, currentIndex);
      }
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onEnd);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd);
  },

  async reorderPlaylistTrack(fromIndex, toIndex) {
    if (!this.currentPlaylistData) return;
    const tracks = this.currentPlaylistData.tracks.map(t => t.filename);
    const [moved] = tracks.splice(fromIndex, 1);
    tracks.splice(toIndex, 0, moved);

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
      console.error('Reorder failed:', e);
    }
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
      const playlistId = this.channelAssignments[id];
      let tracks;

      if (playlistId) {
        // Load tracks from the assigned playlist
        const res = await fetch(`/api/playlists/${encodeURIComponent(playlistId)}`, {
          headers: { 'Authorization': `Bearer ${this.token}` },
        });
        const data = await res.json();
        tracks = data.ok ? data.playlist.tracks : [];
      } else {
        // Fall back to per-channel track listing
        const res = await fetch(`/api/channels/${id}/tracks`, {
          headers: { 'Authorization': `Bearer ${this.token}` },
        });
        const data = await res.json();
        tracks = data.ok ? data.tracks : [];
      }

      this.trackData[id] = tracks;
      this.renderTracks(id, tracks);
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

    container.innerHTML = sorted.map((t, i) => {
      const isPlaying = this.nowPlayingTitle && this.nowPlayingTitle[id] &&
        (t.title === this.nowPlayingTitle[id] || t.filename === (this.nowPlayingFile && this.nowPlayingFile[id]));
      return `
      <div class="track-item ${isPlaying ? 'now-playing' : ''}">
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
    `;}).join('');
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

  async shuffleTracks(id) {
    try {
      const res = await fetch(`/api/channels/${id}/tracks/shuffle`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.token}` },
      });
      const data = await res.json();
      if (data.ok) {
        this.trackData[id] = data.tracks;
        this.trackSort[id] = 'order';
        // Update active sort button
        const bar = document.querySelector(`#tracks-body-${id} .sort-bar`);
        if (bar) {
          bar.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
          const orderBtn = bar.querySelector('[data-sort="order"]');
          if (orderBtn) orderBtn.classList.add('active');
        }
        this.renderTracks(id, data.tracks);
      }
    } catch (e) {
      console.error('Shuffle failed:', e);
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
          // Store now playing filename for highlight
          if (ch.nowPlaying) {
            this.nowPlayingFile[ch.id] = ch.nowPlaying.filename || '';
            this.nowPlayingTitle[ch.id] = ch.nowPlaying.title || '';
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

  // --- Shuffle Playlist ---

  async shufflePlaylist() {
    if (!this.currentPlaylistData) return;
    const tracks = this.currentPlaylistData.tracks.map(t => t.filename);
    for (let i = tracks.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [tracks[i], tracks[j]] = [tracks[j], tracks[i]];
    }
    try {
      const res = await fetch(`/api/playlists/${encodeURIComponent(this.currentPlaylistId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.token}` },
        body: JSON.stringify({ tracks }),
      });
      const data = await res.json();
      if (data.ok) this.openPlaylist(this.currentPlaylistId);
    } catch (e) { console.error('Shuffle failed:', e); }
  },

  // --- Duplicate Playlist ---

  async duplicatePlaylist(id, event) {
    event.stopPropagation(); // don't open the playlist
    try {
      const res = await fetch(`/api/playlists/${encodeURIComponent(id)}`, {
        headers: { 'Authorization': `Bearer ${this.token}` },
      });
      const data = await res.json();
      if (!data.ok) return;
      const pl = data.playlist;
      const createRes = await fetch('/api/playlists', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.token}` },
        body: JSON.stringify({ name: pl.name + ' (copy)', tracks: pl.tracks.map(t => t.filename) }),
      });
      const createData = await createRes.json();
      if (createData.ok) {
        this.loadPlaylists();
        this.loadChannelAssignments();
      }
    } catch (e) { console.error('Duplicate failed:', e); }
  },

  // --- Add All Visible ---

  async addAllVisible() {
    if (!this.currentPlaylistData) return;
    const visible = [...document.querySelectorAll('#playlistPickerList .picker-item:not(.in-playlist)')]
      .filter(el => el.style.display !== 'none');
    if (visible.length === 0) return;
    const newFilenames = visible.map(el => el.dataset.filename);
    const existing = this.currentPlaylistData.tracks.map(t => t.filename);
    const tracks = [...existing, ...newFilenames];
    try {
      const res = await fetch(`/api/playlists/${encodeURIComponent(this.currentPlaylistId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.token}` },
        body: JSON.stringify({ tracks }),
      });
      const data = await res.json();
      if (data.ok) {
        this.openPlaylist(this.currentPlaylistId);
        this.loadChannelAssignments();
      }
    } catch (e) { console.error('Add all failed:', e); }
  },

  // --- History ---

  async loadHistory() {
    try {
      const res = await fetch('/api/history', { headers: { 'Authorization': `Bearer ${this.token}` } });
      const data = await res.json();
      if (!data.ok) return;
      const container = document.getElementById('historyPanels');

      // Build per-channel track blocks with start/end times
      const channelBlocks = {};
      for (const ch of this.channels) {
        const entries = data.history[ch] || [];
        const blocks = [];
        for (let i = 0; i < entries.length; i++) {
          const start = new Date(entries[i].playedAt).getTime();
          const end = (i + 1 < entries.length) ? new Date(entries[i + 1].playedAt).getTime() : Date.now();
          blocks.push({ title: entries[i].title, artist: entries[i].artist, start, end });
        }
        channelBlocks[ch] = blocks;
      }

      // Find global time range
      let minTime = Infinity, maxTime = -Infinity;
      for (const ch of this.channels) {
        for (const b of channelBlocks[ch]) {
          if (b.start < minTime) minTime = b.start;
          if (b.end > maxTime) maxTime = b.end;
        }
      }

      if (minTime === Infinity) {
        container.innerHTML = '<div class="track-list-empty">No history yet</div>';
        return;
      }

      const totalMs = maxTime - minTime;
      const PX_PER_MIN = 40; // pixels per minute
      const totalHeight = Math.max(200, (totalMs / 60000) * PX_PER_MIN);

      // Generate time markers every 5 minutes
      const markerInterval = 5 * 60000;
      const firstMarker = Math.ceil(minTime / markerInterval) * markerInterval;
      let markers = '';
      for (let t = firstMarker; t <= maxTime; t += markerInterval) {
        const topPx = ((maxTime - t) / totalMs) * totalHeight;
        const d = new Date(t);
        const label = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        markers += `<div class="history-marker" style="top:${topPx}px"><span>${label}</span></div>`;
      }

      container.innerHTML = `
        <div class="history-gantt">
          <div class="history-gantt-header">
            ${this.channels.map(ch => `
              <div class="history-gantt-ch-label">
                <span class="panel-dot" style="background:${this.channelColors[ch]}"></span>
                ${this.channelNames[ch]}
              </div>
            `).join('')}
          </div>
          <div class="history-gantt-body" style="height:${totalHeight}px">
            <div class="history-gantt-markers">${markers}</div>
            ${this.channels.map(ch => {
              const blocks = channelBlocks[ch];
              return `<div class="history-gantt-lane">
                ${blocks.map((b, idx) => {
                  const blockH = Math.max(22, ((b.end - b.start) / totalMs) * totalHeight - 4);
                  const topPx = ((maxTime - b.end) / totalMs) * totalHeight;
                  const durationMin = Math.round((b.end - b.start) / 60000);
                  const zIdx = blocks.length - idx;
                  return `<div class="history-block" style="top:${topPx}px;height:${blockH}px;z-index:${zIdx};border-color:${this.channelColors[ch]};--ch-color:${this.channelColors[ch]}" title="${this.escapeAttr(b.title)} - ${this.escapeAttr(b.artist)} (${durationMin}m)">
                    <div class="history-block-title">${this.escapeHtml(b.title || 'Unknown')}</div>
                    <div class="history-block-artist">${this.escapeHtml(b.artist || '')}</div>
                  </div>`;
                }).join('')}
              </div>`;
            }).join('')}
          </div>
        </div>
      `;
    } catch (e) { console.error('History load failed:', e); }
  },

  formatTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  },

  formatDateTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const today = new Date();
    const isToday = d.toDateString() === today.toDateString();
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (isToday) return `today ${time}`;
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    if (d.toDateString() === tomorrow.toDateString()) return `tomorrow ${time}`;
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ` ${time}`;
  },

  // --- Schedule ---

  async loadSchedules() {
    try {
      // Populate playlist dropdown
      const plRes = await fetch('/api/playlists', { headers: { 'Authorization': `Bearer ${this.token}` } });
      const plData = await plRes.json();
      const select = document.getElementById('schedPlaylist');
      if (select && plData.ok) {
        select.innerHTML = plData.playlists.map(pl =>
          `<option value="${this.escapeAttr(pl.id)}">${this.escapeHtml(pl.name)}</option>`
        ).join('');
      }

      const res = await fetch('/api/schedule', { headers: { 'Authorization': `Bearer ${this.token}` } });
      const data = await res.json();
      if (!data.ok) return;
      const container = document.getElementById('scheduleList');
      if (!data.schedules.length) {
        container.innerHTML = '<div class="track-list-empty">No scheduled changes</div>';
        return;
      }
      container.innerHTML = data.schedules.map(s => `
        <div class="schedule-item">
          <span class="panel-dot" style="background:${this.channelColors[s.channel] || '#888'}"></span>
          <span>${this.channelNames[s.channel] || s.channel}</span>
          <span>&rarr;</span>
          <span><strong>${this.escapeHtml(s.playlistName || s.playlistId)}</strong></span>
          <span class="schedule-time">at ${this.formatDateTime(s.time)}</span>
          <button class="track-delete" onclick="Admin.removeSchedule(${s.id})" title="Cancel">&#x2715;</button>
        </div>
      `).join('');
    } catch (e) { console.error('Schedule load failed:', e); }
  },

  async addSchedule() {
    const channel = document.getElementById('schedChannel').value;
    const playlistId = document.getElementById('schedPlaylist').value;
    const timeStr = document.getElementById('schedTime').value;
    if (!timeStr) { alert('Please set a time'); return; }
    if (!playlistId) { alert('Please select a playlist'); return; }
    if (!channel) { alert('Please select a channel'); return; }

    const now = new Date();
    const [h, m] = timeStr.split(':').map(Number);
    const target = new Date(now);
    target.setHours(h, m, 0, 0);
    if (target <= now) target.setDate(target.getDate() + 1);

    try {
      await fetch('/api/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.token}` },
        body: JSON.stringify({ channel, playlistId, time: target.toISOString() }),
      });
      document.getElementById('schedTime').value = '';
      this.loadSchedules();
    } catch (e) { console.error('Add schedule failed:', e); }
  },

  async removeSchedule(id) {
    try {
      await fetch(`/api/schedule/${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${this.token}` },
      });
      this.loadSchedules();
    } catch (e) { console.error('Remove schedule failed:', e); }
  },

  // --- Tags ---

  async addTagPrompt(filename) {
    const tag = prompt('Enter tag (e.g. dance, chill, 90s):');
    if (!tag || !tag.trim()) return;
    const cleanTag = tag.trim().toLowerCase();

    // Find current tags
    const track = this.libraryTracks.find(t => t.filename === filename);
    const currentTags = track ? (track.tags || []) : [];
    if (currentTags.includes(cleanTag)) return;

    const newTags = [...currentTags, cleanTag];
    try {
      const res = await fetch(`/api/library/${encodeURIComponent(filename)}/tags`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.token}` },
        body: JSON.stringify({ tags: newTags }),
      });
      const data = await res.json();
      if (data.ok) this.loadLibrary();
    } catch (e) { console.error('Tag add failed:', e); }
  },

  async removeTag(filename, tag) {
    const track = this.libraryTracks.find(t => t.filename === filename);
    const newTags = (track?.tags || []).filter(t => t !== tag);
    try {
      const res = await fetch(`/api/library/${encodeURIComponent(filename)}/tags`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.token}` },
        body: JSON.stringify({ tags: newTags }),
      });
      const data = await res.json();
      if (data.ok) this.loadLibrary();
    } catch (e) { console.error('Tag remove failed:', e); }
  },

  // --- Bulk Select ---

  toggleBulkSelect() {
    this.bulkSelectMode = !this.bulkSelectMode;
    this.bulkSelected.clear();
    const btn = document.getElementById('bulkSelectBtn');
    btn.textContent = this.bulkSelectMode ? 'Cancel' : 'Select';
    btn.classList.toggle('active', this.bulkSelectMode);
    this.renderLibrary(this.sortTrackList(this.libraryTracks, this.librarySort));
    this.updateBulkBar();
  },

  toggleBulkItem(filename, checkbox) {
    if (checkbox.checked) this.bulkSelected.add(filename);
    else this.bulkSelected.delete(filename);
    this.updateBulkBar();
  },

  updateBulkBar() {
    let bar = document.getElementById('bulkActionBar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'bulkActionBar';
      bar.className = 'bulk-action-bar';
      document.querySelector('.library-section').appendChild(bar);
    }
    if (!this.bulkSelectMode || this.bulkSelected.size === 0) {
      bar.classList.add('hidden');
      return;
    }
    bar.classList.remove('hidden');
    bar.innerHTML = `
      <span>${this.bulkSelected.size} selected</span>
      <button class="btn btn-danger btn-sm" onclick="Admin.bulkDelete()">Delete Selected</button>
    `;
  },

  async bulkDelete() {
    if (!confirm(`Delete ${this.bulkSelected.size} tracks from library?`)) return;
    for (const filename of this.bulkSelected) {
      try {
        await fetch(`/api/library/${encodeURIComponent(filename)}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${this.token}` },
        });
      } catch (e) { /* continue */ }
    }
    this.bulkSelected.clear();
    this.loadLibrary();
    this.updateBulkBar();
  },

  // --- Preview ---

  _previewAudio: null,
  _previewFile: null,
  _previewBtn: null,

  togglePreview(filename, btn) {
    // If already playing this file, stop it
    if (this._previewAudio && this._previewFile === filename) {
      this.stopPreview();
      return;
    }
    // Stop any other preview
    this.stopPreview();

    const audio = new Audio(`/api/library/stream/${encodeURIComponent(filename)}?token=${encodeURIComponent(this.token)}`);
    audio.volume = 0.5;
    audio.play().catch(e => console.error('Preview play failed:', e));
    audio.addEventListener('ended', () => this.stopPreview());

    btn.innerHTML = '&#x25A0;'; // square = stop
    btn.classList.add('previewing');
    this._previewAudio = audio;
    this._previewFile = filename;
    this._previewBtn = btn;
  },

  stopPreview() {
    if (this._previewAudio) {
      this._previewAudio.pause();
      this._previewAudio.src = '';
      this._previewAudio = null;
    }
    if (this._previewBtn) {
      this._previewBtn.innerHTML = '&#x25B6;'; // triangle = play
      this._previewBtn.classList.remove('previewing');
      this._previewBtn = null;
    }
    this._previewFile = null;
  },

  // --- Event Stats ---

  async loadEventStats() {
    try {
      const res = await fetch('/api/admin/event-stats', {
        headers: { 'Authorization': `Bearer ${this.token}` },
      });
      const data = await res.json();
      if (data.ok) this.renderEventStats(data);
    } catch (e) {
      console.error('Failed to load event stats:', e);
    }
  },

  renderEventStats(data) {
    document.getElementById('statPeakListeners').textContent = data.peakListeners || 0;
    document.getElementById('statListenerHours').textContent = data.listenerHours || 0;
    document.getElementById('statTopChannel').textContent =
      data.peakChannel ? (this.channelNames[data.peakChannel] || data.peakChannel) : '-';

    if (data.duration > 0) {
      const hrs = Math.floor(data.duration / 60);
      const mins = data.duration % 60;
      document.getElementById('statDuration').textContent =
        hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
    } else {
      document.getElementById('statDuration').textContent = '-';
    }

    // Peak time
    if (data.peakTime) {
      const d = new Date(data.peakTime);
      document.getElementById('statPeakTime').textContent =
        d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) +
        ` (${data.peakListeners} listeners across all channels)`;
    } else {
      document.getElementById('statPeakTime').textContent = 'No data yet';
    }

    // Channel breakdown bars
    const breakdownEl = document.getElementById('statChannelBreakdown');
    if (data.channelStats && Object.keys(data.channelStats).length > 0) {
      let maxMinutes = 0;
      for (const ch of this.channels) {
        const cs = data.channelStats[ch];
        if (cs && cs.listenerMinutes > maxMinutes) maxMinutes = cs.listenerMinutes;
      }
      breakdownEl.innerHTML = this.channels.map(ch => {
        const cs = data.channelStats[ch] || { listenerMinutes: 0, peakListeners: 0 };
        const pct = maxMinutes > 0 ? (cs.listenerMinutes / maxMinutes * 100) : 0;
        const hrs = (cs.listenerMinutes / 60).toFixed(1);
        return `
          <div class="channel-bar">
            <span class="channel-bar-label" style="color:${this.channelColors[ch]}">${this.channelNames[ch]}</span>
            <div class="channel-bar-fill" style="width:${pct}%;background:${this.channelColors[ch]}"></div>
            <span class="channel-bar-value">${hrs}h &middot; peak ${cs.peakListeners}</span>
          </div>
        `;
      }).join('');
    } else {
      breakdownEl.innerHTML = '<span>No data yet</span>';
    }

    // Timeline chart
    this.renderStatsChart(data.timeline || []);

    // Top tracks
    const tracksEl = document.getElementById('statTopTracks');
    if (data.topTracks && data.topTracks.length > 0) {
      tracksEl.innerHTML = data.topTracks.map((t, i) => `
        <div class="track-item">
          <div class="track-meta">
            <div class="track-name">${i + 1}. ${this.escapeHtml(t.title)}</div>
            <div class="track-artist">${this.escapeHtml(t.artist || '')} &middot; ${t.plays} play${t.plays !== 1 ? 's' : ''}</div>
          </div>
        </div>
      `).join('');
    } else {
      tracksEl.innerHTML = '<div class="track-list-empty">No tracks played yet</div>';
    }
  },

  renderStatsChart(timeline) {
    const canvas = document.getElementById('statsChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;

    canvas.width = canvas.offsetWidth * dpr;
    canvas.height = 200 * dpr;
    ctx.scale(dpr, dpr);

    const w = canvas.offsetWidth;
    const h = 200;
    const pad = { top: 10, right: 10, bottom: 25, left: 35 };
    const plotW = w - pad.left - pad.right;
    const plotH = h - pad.top - pad.bottom;

    ctx.clearRect(0, 0, w, h);

    if (timeline.length < 2) {
      ctx.fillStyle = '#888';
      ctx.font = '13px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Not enough data yet', w / 2, h / 2);
      return;
    }

    // Find max
    let maxVal = 1;
    for (const t of timeline) {
      if (t.total > maxVal) maxVal = t.total;
    }
    maxVal = Math.ceil(maxVal * 1.1);

    // Grid lines
    ctx.strokeStyle = '#2a2a38';
    ctx.lineWidth = 0.5;
    const gridSteps = 4;
    for (let i = 0; i <= gridSteps; i++) {
      const y = pad.top + (plotH * i / gridSteps);
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(w - pad.right, y);
      ctx.stroke();

      // Y-axis labels
      ctx.fillStyle = '#888';
      ctx.font = '10px -apple-system, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(Math.round(maxVal - (maxVal * i / gridSteps)), pad.left - 5, y + 3);
    }

    // X-axis time labels
    const timeLabels = 5;
    ctx.textAlign = 'center';
    for (let i = 0; i < timeLabels; i++) {
      const idx = Math.floor(i * (timeline.length - 1) / (timeLabels - 1));
      const x = pad.left + (idx / (timeline.length - 1)) * plotW;
      const d = new Date(timeline[idx].ts);
      ctx.fillText(d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), x, h - 5);
    }

    // Draw area + line per channel (stacked)
    const channelOrder = [...this.channels].reverse();
    for (const ch of channelOrder) {
      ctx.beginPath();
      ctx.moveTo(pad.left, pad.top + plotH);

      for (let i = 0; i < timeline.length; i++) {
        const x = pad.left + (i / (timeline.length - 1)) * plotW;
        const val = timeline[i][ch] || 0;
        const y = pad.top + plotH - (val / maxVal) * plotH;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }

      ctx.strokeStyle = this.channelColors[ch];
      ctx.lineWidth = 2;
      ctx.stroke();

      // Fill area
      const lastX = pad.left + plotW;
      ctx.lineTo(lastX, pad.top + plotH);
      ctx.lineTo(pad.left, pad.top + plotH);
      ctx.closePath();
      ctx.fillStyle = this.channelColors[ch] + '20';
      ctx.fill();
    }
  },

  async resetEventStats() {
    if (!confirm('Reset all event stats? This cannot be undone.')) return;
    try {
      await fetch('/api/admin/event-stats/reset', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.token}` },
      });
      this.loadEventStats();
    } catch (e) {
      console.error('Reset stats failed:', e);
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
