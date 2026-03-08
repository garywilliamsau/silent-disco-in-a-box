# Admin Listener Screen & Sankey Flow Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an admin overlay to the listener page (`/?admin=1`) with listener counts and skip, plus a Sankey flow diagram in the Stats tab showing listener migration between channels.

**Architecture:** Feature 1 adds a thin authenticated overlay bar to the existing listener portal. Feature 2 adds server-side switch logging (JSONL) and a canvas-rendered Sankey diagram to the admin Stats tab. Both features are independent and can be built in sequence.

**Tech Stack:** Node.js/Express server, vanilla JS frontend, HTML5 Canvas for Sankey rendering.

---

## Task 1: Add requireAdmin to skip endpoint (security fix)

**Files:**
- Modify: `server/server.js:129-142`

**Step 1: Move the skip endpoint after requireAdmin definition**

The skip endpoint at line 129 is before `requireAdmin` (defined at line 303). Move it after line 310 (after requireAdmin) and add the middleware.

Find the current skip handler:
```js
// --- POST /api/channels/:id/skip ---
app.post('/api/channels/:id/skip', async (req, res) => {
```

Change to:
```js
// --- POST /api/channels/:id/skip ---
app.post('/api/channels/:id/skip', requireAdmin, async (req, res) => {
```

Since `requireAdmin` is defined at line 303, the simplest approach: just add `requireAdmin` to the route AND move the endpoint below line 310. Or alternatively, hoist the `requireAdmin` function definition above all route handlers (before line 70).

**Recommended approach:** Hoist `requireAdmin` to just after `app.use(express.json())` (line 48), since multiple endpoints already use it and more will.

Move lines 302-310 to just after line 48:
```js
app.use(express.json());

// --- Admin auth middleware ---
function requireAdmin(req, res, next) {
  const auth = req.headers.authorization;
  const queryToken = req.query.token;
  if (auth === `Bearer ${conf.admin.password}` || queryToken === conf.admin.password) {
    return next();
  }
  return res.status(401).json({ ok: false, error: 'Unauthorized' });
}
```

Then add `requireAdmin` to the skip endpoint:
```js
app.post('/api/channels/:id/skip', requireAdmin, async (req, res) => {
```

**Step 2: Verify the server starts**

Run: `cd /Users/gary/Documents/AI\ Silent\ Disco && node -c server/server.js`
Expected: No syntax errors

**Step 3: Commit**

```bash
git add server/server.js
git commit -m "fix: add auth to skip endpoint and hoist requireAdmin"
```

---

## Task 2: Admin overlay HTML + CSS

**Files:**
- Modify: `web/index.html:32-44` (add overlay div inside playerScreen)
- Modify: `web/css/main.css` (add overlay styles)

**Step 1: Add admin overlay div to index.html**

Inside `#playerScreen`, after the `<audio>` element (line 44), before closing `</div>` (line 45), add:

```html
    <!-- Admin overlay (visible only with ?admin=1) -->
    <div id="adminOverlay" class="admin-overlay hidden">
      <div class="admin-overlay-bar">
        <div class="admin-overlay-stats">
          <span id="adminTotalListeners" class="admin-stat-total">0 listeners</span>
          <span class="admin-stat-ch" style="--dot-color:#ff1744">R:<span id="adminCountRed">0</span></span>
          <span class="admin-stat-ch" style="--dot-color:#00e676">G:<span id="adminCountGreen">0</span></span>
          <span class="admin-stat-ch" style="--dot-color:#2979ff">B:<span id="adminCountBlue">0</span></span>
        </div>
        <button id="adminSkipBtn" class="admin-skip-btn hidden" onclick="App.adminSkip()">Skip</button>
      </div>
    </div>

    <!-- Admin login prompt -->
    <div id="adminLoginPrompt" class="admin-login-prompt hidden">
      <div class="admin-login-box">
        <p>Admin access</p>
        <input type="password" id="adminPasswordInput" placeholder="Password" autocomplete="off">
        <button id="adminLoginBtn" onclick="App.adminLogin()">OK</button>
      </div>
    </div>
```

**Step 2: Add CSS to main.css**

Append to `web/css/main.css`:

```css
/* --- Admin Overlay (/?admin=1) --- */
.admin-overlay {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  z-index: 20;
  pointer-events: none;
}

.admin-overlay-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.5rem 1rem;
  padding-bottom: calc(0.5rem + var(--safe-bottom));
  background: rgba(0, 0, 0, 0.7);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  pointer-events: auto;
}

.admin-overlay-stats {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  font-size: 0.8rem;
}

.admin-stat-total {
  font-weight: 600;
  color: #fff;
  margin-right: 0.25rem;
}

.admin-stat-ch {
  color: var(--dot-color);
  font-weight: 500;
}

.admin-skip-btn {
  background: rgba(255, 255, 255, 0.15);
  border: 1px solid rgba(255, 255, 255, 0.25);
  color: #fff;
  padding: 0.35rem 1rem;
  border-radius: 20px;
  font-size: 0.8rem;
  cursor: pointer;
  pointer-events: auto;
}

.admin-skip-btn:active {
  background: rgba(255, 255, 255, 0.3);
}

/* Admin login prompt */
.admin-login-prompt {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.8);
}

.admin-login-box {
  background: #1a1a24;
  padding: 1.5rem;
  border-radius: 12px;
  text-align: center;
  min-width: 250px;
}

.admin-login-box p {
  margin: 0 0 1rem 0;
  font-weight: 600;
}

.admin-login-box input {
  width: 100%;
  padding: 0.5rem;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
  font-size: 1rem;
  margin-bottom: 0.75rem;
  box-sizing: border-box;
}

.admin-login-box button {
  background: #2979ff;
  color: #fff;
  border: none;
  padding: 0.5rem 2rem;
  border-radius: 6px;
  font-size: 1rem;
  cursor: pointer;
}
```

**Step 3: Bump cache version in index.html**

Change `main.css?v=4` to `main.css?v=5`.

**Step 4: Commit**

```bash
git add web/index.html web/css/main.css
git commit -m "feat: admin overlay HTML and CSS for listener page"
```

---

## Task 3: Admin overlay JS logic in app.js

**Files:**
- Modify: `web/js/app.js`

**Step 1: Add admin properties and init logic**

In the `App` object, add these properties after `_toastTimer: null,` (line 8):

```js
  _adminMode: false,
  _adminToken: null,
```

At the end of `init()` (before the closing brace, after `DiscoAPI.onUpdate` setup around line 38), add:

```js
    // Admin overlay mode
    if (new URLSearchParams(location.search).has('admin')) {
      this._adminToken = localStorage.getItem('adminToken');
      if (this._adminToken) {
        this._adminMode = true;
        document.getElementById('adminOverlay').classList.remove('hidden');
      } else {
        document.getElementById('adminLoginPrompt').classList.remove('hidden');
      }
    }
```

**Step 2: Add adminLogin method**

After the `handleUpdate` method, add:

```js
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
      } else {
        document.getElementById('adminPasswordInput').value = '';
        document.getElementById('adminPasswordInput').placeholder = 'Wrong password';
      }
    } catch {
      document.getElementById('adminPasswordInput').placeholder = 'Connection error';
    }
  },
```

**Step 3: Add adminSkip method**

```js
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
```

**Step 4: Update handleUpdate to refresh admin overlay**

Inside `handleUpdate`, after the existing `if (this.currentChannel)` block (around line 223), add:

```js
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
```

**Step 5: Adjust player-bar padding when admin overlay is visible**

In the admin init code (from Step 1), after showing the overlay, add bottom padding to player-bar so it doesn't sit behind the overlay:

```js
document.querySelector('.player-bar').style.marginBottom = '44px';
```

Add this line in both places the overlay becomes visible (after login and on init when token exists).

**Step 6: Bump app.js version**

In `index.html`, change `app.js?v=14` to `app.js?v=15`.

**Step 7: Commit**

```bash
git add web/js/app.js web/index.html
git commit -m "feat: admin overlay logic — auth, skip, live listener counts"
```

---

## Task 4: Deploy and test admin listener screen

**Step 1: Deploy to Pi**

```bash
cd "/Users/gary/Documents/AI Silent Disco"
sshpass -p 'raspberry' rsync -az web/ silentdisco@192.168.0.152:/tmp/disco-web/
sshpass -p 'raspberry' rsync -az server/ silentdisco@192.168.0.152:/tmp/disco-server/
sshpass -p 'raspberry' ssh silentdisco@192.168.0.152 "sudo cp -r /tmp/disco-web/* /var/www/disco/ && sudo cp -r /tmp/disco-server/* /opt/disco/server/ && sudo systemctl restart disco-api"
```

**Step 2: Test**

1. Visit `http://silentdisco.local/?admin=1` — should see password prompt
2. Enter `disco2024` — overlay bar should appear at bottom
3. Join a channel — should see listener counts update, skip button visible
4. Verify normal `http://silentdisco.local/` has no overlay

**Step 3: Commit any fixes, then move on**

---

## Task 5: Server-side channel switch logging

**Files:**
- Modify: `server/server.js:1029-1041` (WS connection handler)
- Modify: `server/lib/event-stats.js` (add switch logging methods)

**Step 1: Add switch logging to EventStats**

In `server/lib/event-stats.js`, add a `_switchesFile` property in the constructor, after `this._tracksFile`:

```js
    this._switchesFile = path.join(this._statsDir, 'channel-switches.jsonl');
```

Add a new method after `recordTrackChange`:

```js
  // Log a listener channel switch with what was playing on both channels
  recordSwitch(from, to, nowPlayingMap) {
    const songFrom = nowPlayingMap[from]?.title || 'Unknown';
    const songTo = nowPlayingMap[to]?.title || 'Unknown';
    const artistFrom = nowPlayingMap[from]?.artist || '';
    const artistTo = nowPlayingMap[to]?.artist || '';
    const entry = { ts: Date.now(), from, to, songFrom, artistFrom, songTo, artistTo };
    try {
      fs.appendFileSync(this._switchesFile, JSON.stringify(entry) + '\n');
    } catch (e) {
      console.warn('[event-stats] switch log error:', e.message);
    }
  }

  // Read all switch events (optionally filtered by time range)
  getSwitches(sinceTs = 0) {
    try {
      const raw = fs.readFileSync(this._switchesFile, 'utf8');
      return raw.trim().split('\n').filter(Boolean).map(line => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(e => e && e.ts >= sinceTs);
    } catch {
      return [];
    }
  }
```

Update the `reset()` method to also clear switches:

```js
  reset() {
    try { fs.unlinkSync(this._statsFile); } catch { /* ok */ }
    try { fs.unlinkSync(this._tracksFile); } catch { /* ok */ }
    try { fs.unlinkSync(this._switchesFile); } catch { /* ok */ }
    this._trackLog = {};
    this._lastTrack = {};
  }
```

**Step 2: Log switches in WS handler**

In `server/server.js`, modify the WS connection handler (line 1029-1041). We need to capture what's currently playing when a switch happens. Add a module-level variable to track latest now-playing:

After `const lastKnownFile = {};` (line 927), add:

```js
// Latest now-playing per channel for switch logging
const latestNowPlaying = {};
```

In `broadcastNowPlaying()`, after the result is built (around line 1004), add:

```js
    // Cache latest now-playing for switch logging
    for (const ch of result) {
      latestNowPlaying[ch.id] = ch.nowPlaying;
    }
```

Now update the WS handler:

```js
wss.on('connection', (ws) => {
  ws.channel = null;
  broadcastNowPlaying();
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'listen' && validChannel(msg.channel)) {
        const prev = ws.channel;
        ws.channel = msg.channel;
        // Log channel switch (not initial connection)
        if (prev && prev !== msg.channel) {
          eventStats.recordSwitch(prev, msg.channel, latestNowPlaying);
        }
      }
    } catch { /* ignore malformed messages */ }
  });
  ws.on('close', () => {});
});
```

**Step 3: Add API endpoint for channel switches**

After the `event-stats/reset` endpoint (around line 326), add:

```js
// --- GET /api/admin/channel-switches --- channel switch log
app.get('/api/admin/channel-switches', requireAdmin, (req, res) => {
  try {
    const since = parseInt(req.query.since) || 0;
    const switches = eventStats.getSwitches(since);
    res.json({ ok: true, switches });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
```

**Step 4: Verify syntax**

Run: `node -c server/server.js && node -c server/lib/event-stats.js`

**Step 5: Commit**

```bash
git add server/server.js server/lib/event-stats.js
git commit -m "feat: log channel switches with song context for flow visualisation"
```

---

## Task 6: Sankey flow chart — HTML scaffold + data loading

**Files:**
- Modify: `web/admin.html:126-131` (add Sankey section in Stats tab)
- Modify: `web/js/admin.js` (add data fetching)

**Step 1: Add Sankey section to Stats tab HTML**

In `web/admin.html`, after the "Listeners Over Time" panel (line 131), add:

```html
        <div class="stats-panel">
          <h3>Listener Flow</h3>
          <div class="sankey-container">
            <canvas id="sankeyChart" width="900" height="500"></canvas>
          </div>
          <div id="sankeyDetail" class="sankey-detail hidden"></div>
          <div class="sankey-empty" id="sankeyEmpty">No channel switch data yet — listeners need to switch channels during an event</div>
        </div>
```

**Step 2: Add data fetch in admin.js loadEventStats**

In the `loadEventStats` method, after fetching event stats, also fetch channel switches:

```js
    // Fetch channel switch data for Sankey
    try {
      const swRes = await fetch('/api/admin/channel-switches', {
        headers: { 'Authorization': `Bearer ${this.token}` },
      });
      const swData = await swRes.json();
      if (swData.ok && swData.switches.length > 0) {
        document.getElementById('sankeyEmpty').classList.add('hidden');
        this.renderSankeyChart(swData.switches);
      } else {
        document.getElementById('sankeyEmpty').classList.remove('hidden');
      }
    } catch (e) {
      console.warn('Failed to load channel switches:', e);
    }
```

**Step 3: Bump HTML cache versions**

Change `admin.css?v=17` to `admin.css?v=18` and `admin.js?v=22` to `admin.js?v=23`.

**Step 4: Commit**

```bash
git add web/admin.html web/js/admin.js
git commit -m "feat: Sankey chart scaffold and data loading in Stats tab"
```

---

## Task 7: Sankey flow chart — canvas rendering

**Files:**
- Modify: `web/js/admin.js` (add renderSankeyChart method)

**Step 1: Add the renderSankeyChart method**

Add to the Admin object:

```js
  renderSankeyChart(switches) {
    const canvas = document.getElementById('sankeyChart');
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    if (!switches.length) return;

    const channels = this.channels; // ['red', 'green', 'blue']
    const colors = this.channelColors; // { red: '#ff1744', green: '#00e676', blue: '#2979ff' }

    // Time range
    const minTs = switches[0].ts;
    const maxTs = switches[switches.length - 1].ts;
    const totalMs = maxTs - minTs || 1;

    // Bucket into 5-minute windows
    const BUCKET_MS = 5 * 60 * 1000;
    const bucketStart = Math.floor(minTs / BUCKET_MS) * BUCKET_MS;
    const bucketEnd = Math.ceil(maxTs / BUCKET_MS) * BUCKET_MS;
    const buckets = [];

    for (let t = bucketStart; t < bucketEnd; t += BUCKET_MS) {
      const bucketSwitches = switches.filter(s => s.ts >= t && s.ts < t + BUCKET_MS);
      // Count flows between each pair
      const flows = {};
      for (const s of bucketSwitches) {
        const key = `${s.from}->${s.to}`;
        if (!flows[key]) flows[key] = { from: s.from, to: s.to, count: 0, switches: [] };
        flows[key].count++;
        flows[key].switches.push(s);
      }
      buckets.push({ ts: t, flows: Object.values(flows), total: bucketSwitches.length });
    }

    // Layout
    const LANE_W = 120;
    const MARGIN_LEFT = 80;
    const MARGIN_TOP = 30;
    const MARGIN_BOTTOM = 20;
    const laneGap = (W - MARGIN_LEFT - 3 * LANE_W) / 2;
    const laneX = channels.map((_, i) => MARGIN_LEFT + i * (LANE_W + laneGap));
    const rowH = (H - MARGIN_TOP - MARGIN_BOTTOM) / Math.max(buckets.length, 1);

    // Store bucket rects for click detection
    this._sankeyBuckets = [];

    // Draw lane headers
    ctx.font = 'bold 14px system-ui, sans-serif';
    ctx.textAlign = 'center';
    channels.forEach((ch, i) => {
      ctx.fillStyle = colors[ch];
      ctx.fillText(ch.toUpperCase(), laneX[i] + LANE_W / 2, 20);
    });

    // Draw each bucket row
    buckets.forEach((bucket, rowIdx) => {
      const y = MARGIN_TOP + rowIdx * rowH;
      const midY = y + rowH / 2;

      // Time label
      const d = new Date(bucket.ts);
      const label = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      ctx.font = '11px system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillStyle = '#888';
      ctx.fillText(label, MARGIN_LEFT - 10, midY + 4);

      // Draw lane blocks (thin rectangles)
      channels.forEach((ch, i) => {
        ctx.fillStyle = colors[ch] + '20';
        ctx.fillRect(laneX[i], y + 2, LANE_W, rowH - 4);
      });

      // Draw flow curves
      const maxFlow = Math.max(...bucket.flows.map(f => f.count), 1);
      for (const flow of bucket.flows) {
        const fromIdx = channels.indexOf(flow.from);
        const toIdx = channels.indexOf(flow.to);
        if (fromIdx === -1 || toIdx === -1) continue;

        const x1 = laneX[fromIdx] + (fromIdx < toIdx ? LANE_W : 0);
        const x2 = laneX[toIdx] + (fromIdx < toIdx ? 0 : LANE_W);
        const thickness = Math.max(2, (flow.count / maxFlow) * 12);

        ctx.beginPath();
        ctx.moveTo(x1, midY);
        const cpx = (x1 + x2) / 2;
        ctx.bezierCurveTo(cpx, midY, cpx, midY, x2, midY);
        ctx.strokeStyle = colors[flow.from] + '80';
        ctx.lineWidth = thickness;
        ctx.stroke();

        // Flow count label at midpoint
        if (flow.count > 1) {
          ctx.font = '10px system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.fillStyle = '#fff';
          ctx.fillText(flow.count, (x1 + x2) / 2, midY - thickness / 2 - 3);
        }
      }

      // Store bucket rect for click handling
      this._sankeyBuckets.push({
        x: 0, y, w: W, h: rowH,
        bucket,
      });
    });

    // Click handler for drill-down
    canvas.onclick = (e) => {
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const cx = (e.clientX - rect.left) * scaleX;
      const cy = (e.clientY - rect.top) * scaleY;

      for (const b of this._sankeyBuckets) {
        if (cy >= b.y && cy < b.y + b.h && b.bucket.total > 0) {
          this.showSankeyDetail(b.bucket);
          return;
        }
      }
      // Click outside buckets — hide detail
      document.getElementById('sankeyDetail').classList.add('hidden');
    };
  },

  showSankeyDetail(bucket) {
    const el = document.getElementById('sankeyDetail');
    const d = new Date(bucket.ts);
    const timeLabel = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const endD = new Date(bucket.ts + 5 * 60 * 1000);
    const endLabel = endD.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    // Net per channel
    const net = {};
    for (const ch of this.channels) net[ch] = 0;
    for (const flow of bucket.flows) {
      net[flow.from] -= flow.count;
      net[flow.to] += flow.count;
    }

    let html = `<h4>${timeLabel} – ${endLabel}</h4>`;
    html += `<div class="sankey-detail-flows">`;
    for (const flow of bucket.flows.sort((a, b) => b.count - a.count)) {
      // Group by song pair
      const songPairs = {};
      for (const s of flow.switches) {
        const key = `${s.songFrom}|||${s.songTo}`;
        if (!songPairs[key]) songPairs[key] = { ...s, count: 0 };
        songPairs[key].count++;
      }
      for (const pair of Object.values(songPairs)) {
        html += `<div class="sankey-flow-item">
          <span class="sankey-flow-count">${pair.count}</span>
          left <span style="color:${this.channelColors[flow.from]}">${flow.from}</span>
          <span class="sankey-flow-song">"${this.escapeHtml(pair.songFrom)}"</span>
          → <span style="color:${this.channelColors[flow.to]}">${flow.to}</span>
          <span class="sankey-flow-song">"${this.escapeHtml(pair.songTo)}"</span>
        </div>`;
      }
    }
    html += `</div>`;
    html += `<div class="sankey-detail-net">Net: `;
    for (const ch of this.channels) {
      const v = net[ch];
      const sign = v > 0 ? '+' : '';
      html += `<span style="color:${this.channelColors[ch]}">${ch} ${sign}${v}</span> `;
    }
    html += `</div>`;

    el.innerHTML = html;
    el.classList.remove('hidden');
  },
```

**Step 2: Commit**

```bash
git add web/js/admin.js
git commit -m "feat: Sankey flow canvas rendering with drill-down"
```

---

## Task 8: Sankey CSS styles

**Files:**
- Modify: `web/css/admin.css`

**Step 1: Add Sankey styles**

Append to `web/css/admin.css`:

```css
/* --- Sankey Flow Chart --- */
.sankey-container {
  overflow-x: auto;
  margin: 0.5rem 0;
}

.sankey-container canvas {
  display: block;
  max-width: 100%;
  cursor: pointer;
}

.sankey-empty {
  color: var(--dim);
  font-size: 0.85rem;
  padding: 1rem;
  text-align: center;
}

.sankey-detail {
  background: var(--card);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  padding: 1rem;
  margin-top: 0.75rem;
}

.sankey-detail h4 {
  margin: 0 0 0.75rem 0;
  font-size: 0.95rem;
}

.sankey-detail-flows {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  margin-bottom: 0.75rem;
}

.sankey-flow-item {
  font-size: 0.85rem;
  line-height: 1.4;
}

.sankey-flow-count {
  display: inline-block;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 4px;
  padding: 0 0.4rem;
  font-weight: 600;
  margin-right: 0.25rem;
  min-width: 1.5em;
  text-align: center;
}

.sankey-flow-song {
  color: var(--dim);
  font-style: italic;
}

.sankey-detail-net {
  font-size: 0.85rem;
  font-weight: 600;
  padding-top: 0.5rem;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  display: flex;
  gap: 1rem;
}
```

**Step 2: Commit**

```bash
git add web/css/admin.css
git commit -m "feat: Sankey flow chart and drill-down panel styles"
```

---

## Task 9: Deploy and test both features end-to-end

**Step 1: Deploy everything to Pi**

```bash
cd "/Users/gary/Documents/AI Silent Disco"
sshpass -p 'raspberry' rsync -az web/ silentdisco@192.168.0.152:/tmp/disco-web/
sshpass -p 'raspberry' rsync -az server/ silentdisco@192.168.0.152:/tmp/disco-server/
sshpass -p 'raspberry' ssh silentdisco@192.168.0.152 "sudo cp -r /tmp/disco-web/* /var/www/disco/ && sudo cp -r /tmp/disco-server/* /opt/disco/server/ && sudo systemctl restart disco-api"
```

**Step 2: Test admin listener screen**

1. `http://silentdisco.local/?admin=1` — password prompt → enter `disco2024`
2. Join a channel — overlay bar visible with counts
3. Skip button visible when on playlist channel
4. Switch channels — skip button hides if on external source
5. Normal `http://silentdisco.local/` — no overlay

**Step 3: Test Sankey flow**

1. Open two browser tabs as listeners, switch channels several times
2. Go to Admin → Stats tab — Sankey chart should show flow data
3. Click a time bucket — detail panel shows songs and switch counts
4. Reset stats — Sankey data clears

**Step 4: Fix any issues, commit, and push**
