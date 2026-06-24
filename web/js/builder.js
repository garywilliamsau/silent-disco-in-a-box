/* Silent Disco — Playlist Builder
 * Drag songs from the library (left) into the 3 channel buckets (right).
 * Edits autosave to the playlist JSON instantly (no live reload); the live
 * channel only changes when you hit "Apply to live".
 */
'use strict';

const Builder = {
  token: null,
  channels: [],            // [{id,name,color}]
  library: [],             // catalog
  libIndex: new Map(),     // filename -> track
  playlists: [],           // [{id,name,trackCount}]
  buckets: [],             // per-channel state
  librarySort: { key: 'title', dir: 1 },

  // ---------- boot ----------
  async init() {
    document.getElementById('loginBtn').addEventListener('click', () => this.login());
    document.getElementById('passwordInput').addEventListener('keydown', e => {
      if (e.key === 'Enter') this.login();
    });
    document.getElementById('librarySearch').addEventListener('input', () => this.renderLibrary());
    document.getElementById('refreshLibBtn').addEventListener('click', () => this.reloadLibrary());
    document.querySelectorAll('.sort-btn').forEach(btn =>
      btn.addEventListener('click', () => this.setSort(btn.dataset.sort)));

    const saved = sessionStorage.getItem('disco_admin_token');
    if (saved) {
      this.token = saved;
      try { await this.api('GET', '/api/library'); return this.start(); }
      catch { sessionStorage.removeItem('disco_admin_token'); }
    }
  },

  async login() {
    const password = document.getElementById('passwordInput').value;
    const errEl = document.getElementById('loginError');
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = await res.json();
      if (data.ok) {
        this.token = data.token;
        sessionStorage.setItem('disco_admin_token', this.token);
        this.start();
      } else {
        errEl.textContent = 'Wrong password'; errEl.classList.remove('hidden');
      }
    } catch {
      errEl.textContent = 'Login failed'; errEl.classList.remove('hidden');
    }
  },

  async start() {
    document.getElementById('loginScreen').classList.remove('active');
    document.getElementById('builderScreen').classList.add('active');
    await this.loadAll();
  },

  // ---------- data ----------
  async api(method, path, body) {
    const opts = { method, headers: { 'Authorization': `Bearer ${this.token}` } };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(path, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  },

  async loadAll() {
    const [cfg, lib, pls] = await Promise.all([
      this.api('GET', '/api/config'),
      this.api('GET', '/api/library'),
      this.api('GET', '/api/playlists'),
    ]);
    this.channels = cfg.channels || [];
    this.setLibrary(lib.tracks || []);
    this.playlists = pls.playlists || [];

    // current channel assignments
    const assigns = await Promise.all(
      this.channels.map(ch => this.api('GET', `/api/channels/${ch.id}/playlist`).catch(() => null))
    );

    this.buckets = this.channels.map((ch, i) => {
      const a = assigns[i];
      const pid = a && a.playlistId ? a.playlistId : null;
      const tracks = a && a.playlist ? a.playlist.tracks.map(t => t.filename) : [];
      return {
        id: ch.id, name: ch.name, color: ch.color,
        selectedPlaylistId: pid, assignedPlaylistId: pid,
        tracks, dirty: false,
        _saveTimer: null, _dirtySave: false, _savePromise: null,
      };
    });

    this.renderBuckets();
    this.renderLibrary();
  },

  setLibrary(tracks) {
    this.library = tracks;
    this.libIndex = new Map(tracks.map(t => [t.filename, t]));
  },

  async reloadLibrary() {
    const data = await this.api('GET', '/api/library');
    this.setLibrary(data.tracks || []);
    this.renderLibrary();
  },

  async reloadPlaylists() {
    const data = await this.api('GET', '/api/playlists');
    this.playlists = data.playlists || [];
    this.buckets.forEach(b => this.fillSelect(b));
  },

  // ---------- library pane ----------
  setSort(key) {
    if (this.librarySort.key === key) this.librarySort.dir *= -1;
    else this.librarySort = { key, dir: 1 };
    document.querySelectorAll('.sort-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.sort === key));
    this.renderLibrary();
  },

  renderLibrary() {
    const q = document.getElementById('librarySearch').value.trim().toLowerCase();
    const { key, dir } = this.librarySort;
    let rows = this.library.filter(t => !q ||
      (`${t.title} ${t.artist} ${t.album}`).toLowerCase().includes(q));

    rows.sort((a, b) => {
      let av = a[key], bv = b[key];
      if (key === 'duration') { av = av || 0; bv = bv || 0; return (av - bv) * dir; }
      return String(av || '').localeCompare(String(bv || ''), undefined, { sensitivity: 'base' }) * dir;
    });

    const list = document.getElementById('libraryList');
    document.getElementById('libraryCount').textContent =
      `${rows.length}${q ? ` / ${this.library.length}` : ''} tracks`;

    if (!rows.length) { list.innerHTML = '<div class="empty">No matching tracks</div>'; return; }
    list.innerHTML = rows.map(t => {
      const fn = esc(t.filename);
      return `<div class="lib-row" data-filename="${fn}" title="${esc(t.title)} — ${esc(t.artist)}">
        <img class="art" loading="lazy" src="/api/library/album-art/${encodeURIComponent(t.filename)}" alt="">
        <span class="t-title">${esc(t.title)}</span>
        <span class="t-artist">${esc(t.artist)}</span>
        <span class="t-album">${esc(t.album || '')}</span>
        <span class="t-dur">${fmtDur(t.duration)}</span>
        <button class="preview-btn" data-filename="${fn}" title="Preview">▶</button>
      </div>`;
    }).join('');
  },

  // ---------- buckets ----------
  renderBuckets() {
    const wrap = document.getElementById('buckets');
    wrap.innerHTML = '';
    this.buckets.forEach(b => {
      const el = document.createElement('div');
      el.className = 'bucket';
      el.style.setProperty('--ch', b.color);
      el.innerHTML = `
        <div class="bucket-head">
          <div class="bucket-title">
            <span class="bucket-dot"></span>
            <span class="bucket-name">${esc(b.name)}</span>
            <span class="live-badge">● Live</span>
            <span class="bucket-count"></span>
          </div>
          <div class="bucket-controls">
            <select class="pl-select"></select>
            <button class="btn act-shuffle" title="Shuffle this playlist">🔀</button>
            <button class="btn act-clear" title="Remove all tracks">Clear</button>
            <button class="btn btn-apply act-apply" title="Apply this playlist to the live channel">▶ Apply</button>
          </div>
        </div>
        <div class="bucket-list"><div class="empty">Drag songs here</div></div>`;
      wrap.appendChild(el);

      b.el = el;
      b.selectEl = el.querySelector('.pl-select');
      b.listEl = el.querySelector('.bucket-list');
      b.countEl = el.querySelector('.bucket-count');
      b.liveBadge = el.querySelector('.live-badge');
      b.applyBtn = el.querySelector('.act-apply');

      b.selectEl.addEventListener('change', () => this.onSelectChange(b, b.selectEl.value));
      el.querySelector('.act-shuffle').addEventListener('click', () => this.shuffle(b));
      el.querySelector('.act-clear').addEventListener('click', () => this.clear(b));
      b.applyBtn.addEventListener('click', () => this.applyLive(b));
      b.listEl.addEventListener('click', e => {
        const rm = e.target.closest('.bk-remove');
        if (rm) this.removeTrack(b, rm.closest('[data-filename]').dataset.filename);
      });

      this.fillSelect(b);
      this.renderBucketList(b);
      this.updateChrome(b);

      // eslint-disable-next-line no-undef
      b.sortable = new Sortable(b.listEl, {
        group: { name: 'tracks', pull: true, put: true },
        animation: 120,
        filter: '.bk-remove,.empty',
        ghostClass: 'sortable-ghost',
        chosenClass: 'sortable-chosen',
        dragClass: 'sortable-drag',
        onAdd: () => this.syncFromDom(b),
        onUpdate: () => this.syncFromDom(b),
        onRemove: () => this.syncFromDom(b),
      });
    });
  },

  fillSelect(b) {
    const opts = ['<option value="">— none (silent) —</option>'];
    for (const p of this.playlists) {
      opts.push(`<option value="${esc(p.id)}">${esc(p.name)} (${p.trackCount})</option>`);
    }
    opts.push('<option value="__new__">＋ New playlist…</option>');
    b.selectEl.innerHTML = opts.join('');
    b.selectEl.value = b.selectedPlaylistId || '';
  },

  renderBucketList(b) {
    if (!b.tracks.length) { b.listEl.innerHTML = '<div class="empty">Drag songs here</div>'; return; }
    b.listEl.innerHTML = b.tracks.map(fn => {
      const t = this.libIndex.get(fn);
      const fne = esc(fn);
      if (!t) return `<div class="bk-row missing" data-filename="${fne}">
        <span class="handle">⠿</span>
        <span class="bk-title">⚠ ${fne} <small>· not in library</small></span>
        <span class="bk-dur"></span>
        <button class="bk-remove" title="Remove">✕</button></div>`;
      return `<div class="bk-row" data-filename="${fne}">
        <span class="handle">⠿</span>
        <span class="bk-title">${esc(t.title)} <small>· ${esc(t.artist)}</small></span>
        <span class="bk-dur">${fmtDur(t.duration)}</span>
        <button class="bk-remove" title="Remove">✕</button></div>`;
    }).join('');
  },

  // Re-read order from the DOM after a drag, dedupe, normalize markup.
  syncFromDom(b) {
    const seen = new Set(); const names = [];
    b.listEl.querySelectorAll('[data-filename]').forEach(n => {
      const f = n.dataset.filename;
      if (!seen.has(f)) { seen.add(f); names.push(f); }
    });
    b.tracks = names;
    this.renderBucketList(b);
    this.markEdited(b);
  },

  removeTrack(b, fn) {
    b.tracks = b.tracks.filter(f => f !== fn);
    this.renderBucketList(b);
    this.markEdited(b);
  },

  shuffle(b) {
    for (let i = b.tracks.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [b.tracks[i], b.tracks[j]] = [b.tracks[j], b.tracks[i]];
    }
    this.renderBucketList(b);
    this.markEdited(b);
  },

  clear(b) {
    if (!b.tracks.length) return;
    b.tracks = [];
    this.renderBucketList(b);
    this.markEdited(b);
  },

  async onSelectChange(b, value) {
    if (value === '__new__') {
      const name = prompt(`Name a new playlist for ${b.name}:`, `${b.name} mix`);
      if (!name) { b.selectEl.value = b.selectedPlaylistId || ''; return; }
      try {
        const res = await this.api('POST', '/api/playlists', { name, tracks: [] });
        await this.reloadPlaylists();
        b.selectedPlaylistId = res.playlist.id;
        b.tracks = [];
        b.selectEl.value = res.playlist.id;
        b.dirty = b.selectedPlaylistId !== b.assignedPlaylistId;
        this.renderBucketList(b); this.updateChrome(b);
      } catch (e) { alert('Could not create playlist: ' + e.message); b.selectEl.value = b.selectedPlaylistId || ''; }
      return;
    }
    if (value === '') {
      b.selectedPlaylistId = null; b.tracks = [];
      b.dirty = b.assignedPlaylistId != null;
      this.renderBucketList(b); this.updateChrome(b);
      return;
    }
    try {
      const res = await this.api('GET', `/api/playlists/${encodeURIComponent(value)}`);
      b.selectedPlaylistId = value;
      b.tracks = res.playlist.tracks.map(t => t.filename);
      b.dirty = value !== b.assignedPlaylistId;
      this.renderBucketList(b); this.updateChrome(b);
    } catch (e) { alert('Could not load playlist: ' + e.message); }
  },

  // ---------- edit / save / apply ----------
  async markEdited(b) {
    // a bucket with tracks but no playlist needs somewhere to save them
    if (!b.selectedPlaylistId && b.tracks.length) {
      await this.ensurePlaylist(b);
      if (!b.selectedPlaylistId) return; // user cancelled
    }
    b.dirty = true;
    this.updateChrome(b);
    this.scheduleSave(b);
  },

  async ensurePlaylist(b) {
    const name = prompt(`These tracks need a playlist. Name it for ${b.name}:`, `${b.name} mix`);
    if (!name) return;
    try {
      const res = await this.api('POST', '/api/playlists', { name, tracks: b.tracks.slice() });
      b.selectedPlaylistId = res.playlist.id;
      await this.reloadPlaylists();
      b.selectEl.value = res.playlist.id;
    } catch (e) { alert('Could not create playlist: ' + e.message); }
  },

  scheduleSave(b) {
    if (!b.selectedPlaylistId) return;
    b._dirtySave = true;
    this.setStatus('saving');
    clearTimeout(b._saveTimer);
    b._saveTimer = setTimeout(() => this.doSave(b), 700);
  },

  async doSave(b) {
    if (!b.selectedPlaylistId || !b._dirtySave) return;
    b._dirtySave = false;
    const id = b.selectedPlaylistId;
    const tracks = b.tracks.slice();
    b._savePromise = this.api('PUT', `/api/playlists/${encodeURIComponent(id)}`, { tracks, applyLive: false });
    try { await b._savePromise; this.setStatus('saved'); }
    catch (e) { this.setStatus('error'); console.error('save failed', e); }
  },

  async flushSave(b) {
    clearTimeout(b._saveTimer);
    if (b._dirtySave) await this.doSave(b);
    else if (b._savePromise) await b._savePromise.catch(() => {});
  },

  async applyLive(b) {
    if (!b.dirty) return;
    b.applyBtn.disabled = true;
    try {
      await this.flushSave(b);
      await this.api('PUT', `/api/channels/${b.id}/playlist`, { playlistId: b.selectedPlaylistId || null });
      b.assignedPlaylistId = b.selectedPlaylistId;
      b.dirty = false;
      this.setStatus('applied', b.name);
      await this.reloadPlaylists(); // track counts changed
    } catch (e) {
      alert(`Apply to ${b.name} failed: ` + e.message);
    }
    this.updateChrome(b);
  },

  updateChrome(b) {
    b.countEl.textContent = `${b.tracks.length} track${b.tracks.length === 1 ? '' : 's'}`;
    const live = b.selectedPlaylistId && b.selectedPlaylistId === b.assignedPlaylistId && !b.dirty;
    b.liveBadge.classList.toggle('on', !!live);
    b.applyBtn.disabled = !b.dirty;
    b.applyBtn.classList.toggle('dirty', b.dirty);
  },

  setStatus(kind, extra) {
    const el = document.getElementById('saveStatus');
    el.className = 'save-status';
    if (kind === 'saving') { el.textContent = 'Saving…'; el.classList.add('saving'); }
    else if (kind === 'saved') { el.textContent = 'All changes saved'; el.classList.add('saved'); }
    else if (kind === 'applied') { el.textContent = `${extra} → live ✓`; el.classList.add('saved'); }
    else if (kind === 'error') { el.textContent = 'Save failed'; }
  },

  // ---------- preview ----------
  togglePreview(fn, btn) {
    const audio = document.getElementById('previewAudio');
    const src = `/api/library/stream/${encodeURIComponent(fn)}?token=${encodeURIComponent(this.token)}`;
    document.querySelectorAll('.preview-btn.playing').forEach(b => { b.classList.remove('playing'); b.textContent = '▶'; });
    if (this._playing === fn) { audio.pause(); this._playing = null; return; }
    audio.src = src; audio.play().catch(() => {});
    this._playing = fn; btn.classList.add('playing'); btn.textContent = '⏸';
    audio.onended = () => { btn.classList.remove('playing'); btn.textContent = '▶'; this._playing = null; };
  },
};

// preview click delegation
document.getElementById('libraryList').addEventListener('click', e => {
  const pb = e.target.closest('.preview-btn');
  if (pb) { e.stopPropagation(); Builder.togglePreview(pb.dataset.filename, pb); }
});

// library list as a clone source for drag-into-bucket
// eslint-disable-next-line no-undef
new Sortable(document.getElementById('libraryList'), {
  group: { name: 'tracks', pull: 'clone', put: false },
  sort: false,
  animation: 120,
  filter: '.preview-btn,.empty',
  ghostClass: 'sortable-ghost',
});

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function fmtDur(sec) {
  if (!sec && sec !== 0) return '';
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

Builder.init();
