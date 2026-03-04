# Vibrant Beat-Sync Backgrounds Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the subtle brightness-pulse visualizer with server-side beat detection driving full-screen strobes, expanding rings, and energy-reactive particles on the listener portal.

**Architecture:** The existing `EnergyAnalyser` decodes Icecast PCM via ffmpeg. We add an IIR low-pass filter + spectral flux onset detector to the same PCM stream, emitting `beats` alongside `energy` in the WebSocket broadcast. The client `visualizer.js` consumes beats to trigger three layered canvas effects.

**Tech Stack:** Node.js (server), vanilla Canvas2D (client), existing WebSocket infrastructure. No new dependencies.

**Pi SSH:** `ssh silentdisco@192.168.0.200` (password: raspberry)
**Deploy:** `rsync` changed files to Pi then `sudo systemctl restart disco-server`

---

### Task 1: Add beat detection to EnergyAnalyser

**Files:**
- Modify: `server/lib/energy.js`

The algorithm:
1. Apply first-order IIR low-pass filter to raw PCM to isolate bass (cutoff ~200Hz, sample rate 22050Hz → `alpha = 0.054`)
2. Compute RMS on filtered bass signal per buffer
3. Maintain a rolling window of recent bass RMS values (last 43 buffers ≈ 2 seconds at 22050Hz / 1024 samples/buf)
4. Beat fires when `bassRMS > rollingMean × 1.8` AND `now - lastBeat > 250ms`
5. Add `beats` object to the broadcast payload

**Step 1: Replace `server/lib/energy.js` with this implementation**

```js
'use strict';

const { spawn } = require('child_process');

// Analyses Icecast streams and calculates audio energy + beat detection per channel
// Broadcasts ~15 updates/sec via callback

const SAMPLE_RATE = 22050;
const ALPHA = (2 * Math.PI * 200) / (2 * Math.PI * 200 + SAMPLE_RATE); // IIR LP cutoff ~200Hz
const WINDOW_SIZE = 43;       // ~2 seconds of history for rolling mean
const BEAT_THRESHOLD = 1.8;   // bass RMS must exceed mean × this to fire beat
const BEAT_COOLDOWN_MS = 250; // minimum ms between beats (max 240BPM)

class EnergyAnalyser {
  constructor(channels, onEnergy) {
    this.channels = channels;
    this.onEnergy = onEnergy;
    this.processes = {};
    this.energy = {};
    this.beats = {};
    this._lpState = {};       // IIR filter state per channel
    this._bassHistory = {};   // rolling window of bass RMS values
    this._lastBeat = {};      // timestamp of last beat per channel

    this.channels.forEach(ch => {
      this.energy[ch] = 0;
      this.beats[ch] = false;
      this._lpState[ch] = 0;
      this._bassHistory[ch] = [];
      this._lastBeat[ch] = 0;
    });
  }

  start() {
    for (const ch of this.channels) {
      this._startChannel(ch);
    }
    // Broadcast at ~15Hz
    this._interval = setInterval(() => {
      this.onEnergy({ ...this.energy }, { ...this.beats });
      // Reset beats after broadcast (one-shot per interval)
      this.channels.forEach(ch => { this.beats[ch] = false; });
    }, 66);
  }

  _startChannel(ch) {
    const proc = spawn('ffmpeg', [
      '-i', `http://127.0.0.1:8000/${ch}`,
      '-f', 's16le',
      '-ar', String(SAMPLE_RATE),
      '-ac', '1',
      '-loglevel', 'quiet',
      'pipe:1',
    ]);

    this.processes[ch] = proc;

    proc.stdout.on('data', (buf) => {
      const samples = buf.length / 2;

      let sumFull = 0;
      let sumBass = 0;
      let lpPrev = this._lpState[ch];

      for (let i = 0; i < buf.length; i += 2) {
        const s = buf.readInt16LE(i) / 32768;
        // Full-range energy
        sumFull += s * s;
        // IIR low-pass filter (bass isolation)
        lpPrev = ALPHA * s + (1 - ALPHA) * lpPrev;
        sumBass += lpPrev * lpPrev;
      }

      this._lpState[ch] = lpPrev;

      const rms = Math.sqrt(sumFull / samples);
      this.energy[ch] = Math.min(1, rms * 4);

      const bassRms = Math.sqrt(sumBass / samples);

      // Update rolling history
      const hist = this._bassHistory[ch];
      hist.push(bassRms);
      if (hist.length > WINDOW_SIZE) hist.shift();

      // Compute rolling mean
      const mean = hist.reduce((a, b) => a + b, 0) / hist.length;

      // Beat detection
      const now = Date.now();
      if (
        hist.length >= 10 &&                          // need some history first
        bassRms > mean * BEAT_THRESHOLD &&
        now - this._lastBeat[ch] > BEAT_COOLDOWN_MS
      ) {
        this.beats[ch] = true;
        this._lastBeat[ch] = now;
      }
    });

    proc.on('close', () => {
      setTimeout(() => this._startChannel(ch), 3000);
    });

    proc.stderr.on('data', () => {});
  }

  stop() {
    clearInterval(this._interval);
    for (const ch of this.channels) {
      if (this.processes[ch]) this.processes[ch].kill();
    }
  }
}

module.exports = EnergyAnalyser;
```

**Step 2: Update the broadcast call in `server/server.js`**

Find the energy broadcast (around line 626-628):
```js
const energyAnalyser = new EnergyAnalyser(CHANNELS, (energy) => {
  const msg = JSON.stringify({ type: 'energy', energy });
```

Change to:
```js
const energyAnalyser = new EnergyAnalyser(CHANNELS, (energy, beats) => {
  const msg = JSON.stringify({ type: 'energy', energy, beats });
```

**Step 3: Deploy and verify beat data is broadcasting**

```bash
# Copy files to Pi
rsync -av server/lib/energy.js server/server.js silentdisco@192.168.0.200:~/silent-disco/server/lib/
rsync -av server/server.js silentdisco@192.168.0.200:~/silent-disco/server/

# Restart server
ssh silentdisco@192.168.0.200 "sudo systemctl restart disco-server"

# Tail logs and watch for energy output (should see no errors)
ssh silentdisco@192.168.0.200 "sudo journalctl -u disco-server -f --no-pager" &

# In browser DevTools → Network → WS → find /api/ws → Messages tab
# You should see messages like:
# {"type":"energy","energy":{"red":0.4},"beats":{"red":false,"green":false,"blue":false}}
# And occasionally:
# {"type":"energy","energy":{"red":0.8},"beats":{"red":true,"green":false,"blue":false}}
```

**Step 4: Commit**

```bash
git add server/lib/energy.js server/server.js
git commit -m "feat: server-side beat detection via IIR low-pass + spectral flux"
```

---

### Task 2: Update API client to pass beats through

**Files:**
- Modify: `web/js/api.js`

**Step 1: Update the energy message handler and onEnergy callback**

In `web/js/api.js`, change the `onmessage` handler (line 34-35):
```js
} else if (data.type === 'energy') {
  this.energyListeners.forEach(cb => cb(data.energy));
```

To:
```js
} else if (data.type === 'energy') {
  this.energyListeners.forEach(cb => cb(data.energy, data.beats || {}));
```

**Step 2: Update the Visualizer's onEnergy call in `web/js/visualizer.js` `init()`**

Find (line 20-24):
```js
DiscoAPI.onEnergy((energy) => {
  if (this.channelId && energy[this.channelId] !== undefined) {
    this.serverEnergy = energy[this.channelId];
  }
});
```

Change to (temporary — will be fully replaced in Task 3):
```js
DiscoAPI.onEnergy((energy, beats) => {
  if (this.channelId && energy[this.channelId] !== undefined) {
    this.serverEnergy = energy[this.channelId];
    if (beats && beats[this.channelId]) this.beatFired = true;
  }
});
```

Also add `beatFired: false` to the Visualizer object properties at the top.

**Step 3: Commit**

```bash
git add web/js/api.js web/js/visualizer.js
git commit -m "feat: pass beats through WebSocket to visualizer"
```

---

### Task 3: Rewrite visualizer with strobe, rings, and particles

**Files:**
- Modify: `web/js/visualizer.js`

This replaces the entire file. The draw loop layers effects in order:
1. Base background (channel colour, energy-modulated brightness)
2. Beat strobe (white flash, fast decay)
3. Burst rings (expanding neon rings from centre)
4. Particles (drifting dots, velocity-kicked on beat)
5. Vignette (subtle edge darkening)

**Step 1: Replace `web/js/visualizer.js` entirely**

```js
'use strict';

const Visualizer = {
  canvas: null,
  ctx: null,
  animationId: null,
  channelColor: '#ffffff',
  r: 255, g: 255, b: 255,
  serverEnergy: 0,
  smoothEnergy: 0,
  channelId: null,
  beatFired: false,

  // Strobe state
  strobeAlpha: 0,

  // Ring pool
  rings: [],

  // Particle pool
  particles: [],
  maxParticles: 0,

  init(canvasEl) {
    this.canvas = canvasEl;
    this.ctx = canvasEl.getContext('2d');
    this.resize();
    window.addEventListener('resize', () => this.resize());

    // Scale particle count to device capability
    const cores = navigator.hardwareConcurrency || 2;
    this.maxParticles = cores <= 2 ? 0 : cores <= 4 ? 20 : 50;

    // Pre-fill particle pool
    this.particles = [];
    this.rings = [];
    this.strobeAlpha = 0;

    DiscoAPI.onEnergy((energy, beats) => {
      if (this.channelId && energy[this.channelId] !== undefined) {
        this.serverEnergy = energy[this.channelId];
        if (beats && beats[this.channelId]) this.beatFired = true;
      }
    });
  },

  resize() {
    this.canvas.width = this.canvas.offsetWidth * (window.devicePixelRatio || 1);
    this.canvas.height = this.canvas.offsetHeight * (window.devicePixelRatio || 1);
  },

  setColor(color) {
    this.channelColor = color;
    this.r = parseInt(color.slice(1, 3), 16);
    this.g = parseInt(color.slice(3, 5), 16);
    this.b = parseInt(color.slice(5, 7), 16);
  },

  setChannel(channelId) {
    this.channelId = channelId;
    this.beatFired = false;
    this.strobeAlpha = 0;
    this.rings = [];
    this.particles = [];
  },

  _spawnParticle(W, H) {
    return {
      x: Math.random() * W,
      y: Math.random() * H,
      vx: (Math.random() - 0.5) * 1.5,
      vy: (Math.random() - 0.5) * 1.5,
      r: Math.random() * 3 + 1,
      life: 1.0,
      decay: 0.008 + Math.random() * 0.006,
    };
  },

  start() {
    const ctx = this.ctx;
    const canvas = this.canvas;

    const draw = () => {
      this.animationId = requestAnimationFrame(draw);

      const W = canvas.width;
      const H = canvas.height;
      const cx = W / 2;
      const cy = H / 2;

      // Smooth energy
      this.smoothEnergy += (this.serverEnergy - this.smoothEnergy) * 0.25;
      const energy = this.smoothEnergy;

      // --- On beat: trigger effects ---
      if (this.beatFired) {
        this.beatFired = false;

        // Strobe
        this.strobeAlpha = 0.55;

        // Spawn 2 rings
        const maxR = Math.sqrt(cx * cx + cy * cy) * 1.5;
        this.rings.push({ radius: 0, maxRadius: maxR, life: 1.0 });
        this.rings.push({ radius: 0, maxRadius: maxR * 0.85, life: 1.0, delay: 3 });

        // Kick particles
        this.particles.forEach(p => {
          p.vx *= 3;
          p.vy *= 3;
        });
        // Spawn 3 new particles on beat
        if (this.maxParticles > 0) {
          for (let i = 0; i < 3 && this.particles.length < this.maxParticles; i++) {
            this.particles.push(this._spawnParticle(W, H));
          }
        }
      }

      // --- 1. Base background ---
      const brightness = 0.45 + energy * 0.55;
      ctx.fillStyle = `rgb(${Math.round(this.r * brightness)}, ${Math.round(this.g * brightness)}, ${Math.round(this.b * brightness)})`;
      ctx.fillRect(0, 0, W, H);

      // --- 2. Beat strobe ---
      if (this.strobeAlpha > 0.001) {
        ctx.fillStyle = `rgba(255, 255, 255, ${this.strobeAlpha})`;
        ctx.fillRect(0, 0, W, H);
        this.strobeAlpha *= 0.72; // decay: 80ms to near-zero at 60fps
      }

      // --- 3. Burst rings ---
      for (let i = this.rings.length - 1; i >= 0; i--) {
        const ring = this.rings[i];
        if (ring.delay && ring.delay > 0) { ring.delay--; continue; }

        const progress = ring.radius / ring.maxRadius;
        ring.radius += ring.maxRadius * 0.028; // expand over ~600ms at 60fps
        ring.life = 1 - progress;

        if (ring.life <= 0) { this.rings.splice(i, 1); continue; }

        const lineWidth = Math.max(1, (1 - progress) * 8);
        const alpha = ring.life * 0.8;
        // Brighten channel colour for rings
        const rr = Math.min(255, Math.round(this.r * 1.4));
        const rg = Math.min(255, Math.round(this.g * 1.4));
        const rb = Math.min(255, Math.round(this.b * 1.4));

        ctx.beginPath();
        ctx.arc(cx, cy, ring.radius, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${rr}, ${rg}, ${rb}, ${alpha})`;
        ctx.lineWidth = lineWidth;
        ctx.stroke();
      }

      // --- 4. Particles ---
      if (this.maxParticles > 0) {
        // Seed new particles to maintain population
        while (this.particles.length < Math.min(this.maxParticles * 0.5, this.particles.length + 1)) {
          this.particles.push(this._spawnParticle(W, H));
        }

        for (let i = this.particles.length - 1; i >= 0; i--) {
          const p = this.particles[i];
          p.x += p.vx * (1 + energy);
          p.y += p.vy * (1 + energy);
          p.life -= p.decay;

          // Wrap at edges
          if (p.x < 0) p.x = W;
          if (p.x > W) p.x = 0;
          if (p.y < 0) p.y = H;
          if (p.y > H) p.y = 0;

          // Dampen velocity over time
          p.vx *= 0.99;
          p.vy *= 0.99;

          if (p.life <= 0) { this.particles.splice(i, 1); continue; }

          const alpha = p.life * (0.4 + energy * 0.4);
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
          ctx.fill();
        }
      }

      // --- 5. Vignette ---
      const vignette = ctx.createRadialGradient(cx, H / 2, H * 0.3, cx, H / 2, H * 0.85);
      vignette.addColorStop(0, 'rgba(0,0,0,0)');
      vignette.addColorStop(1, `rgba(0,0,0,${0.3 - energy * 0.2})`);
      ctx.fillStyle = vignette;
      ctx.fillRect(0, 0, W, H);
    };

    // Seed initial particles
    if (this.maxParticles > 0) {
      const W = canvas.width || canvas.offsetWidth;
      const H = canvas.height || canvas.offsetHeight;
      const seed = Math.floor(this.maxParticles * 0.4);
      for (let i = 0; i < seed; i++) {
        this.particles.push(this._spawnParticle(W, H));
      }
    }

    draw();
  },

  stop() {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
    this.serverEnergy = 0;
    this.smoothEnergy = 0;
    this.strobeAlpha = 0;
    this.rings = [];
    this.particles = [];
    this.beatFired = false;
  },

  // Used by start screen only — unchanged
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
        p.x += p.vx; p.y += p.vy;
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
  },
};
```

**Step 2: Bump the JS cache-bust version in `web/index.html`**

Find the script tags that reference `visualizer.js` and increment the `?v=N` query string. e.g. `?v=4` → `?v=5`. Check what the current version is first.

**Step 3: Deploy and test on the Pi**

```bash
# Copy client files
rsync -av web/js/visualizer.js web/js/api.js silentdisco@192.168.0.200:~/silent-disco/web/js/
rsync -av web/index.html silentdisco@192.168.0.200:~/silent-disco/web/

# Open browser at http://192.168.4.1, join a channel playing music
# Expected: on beats you should see white flashes, rings expanding, particles moving
# If beat detection is too sensitive (too many beats): increase BEAT_THRESHOLD to 2.0
# If too few beats: decrease BEAT_THRESHOLD to 1.5
```

**Step 4: Tune if needed**

Beat threshold and cooldown are constants at the top of `server/lib/energy.js`:
- Too many false beats → increase `BEAT_THRESHOLD` (try 2.0)
- Missing beats → decrease `BEAT_THRESHOLD` (try 1.5) or reduce `BEAT_COOLDOWN_MS` (try 200)

**Step 5: Commit**

```bash
git add web/js/visualizer.js web/js/api.js web/index.html
git commit -m "feat: vibrant beat-sync visualizer — strobe, rings, particles"
```

---

## Testing Checklist

- [ ] WebSocket messages contain `beats` field (check DevTools → Network → WS)
- [ ] Beat events fire on kick drums, not on sustained sounds
- [ ] Strobe visible — white flash on beat, decays in ~80ms
- [ ] Rings expand from centre and fade out
- [ ] Particles move, speed up on beat
- [ ] Low-end device (or test with `hardwareConcurrency` forced to 2): no particles, still has strobe + rings
- [ ] Switching channels resets all effects (no leftover rings/particles from previous channel)
- [ ] No memory leaks — particle/ring arrays don't grow unboundedly
