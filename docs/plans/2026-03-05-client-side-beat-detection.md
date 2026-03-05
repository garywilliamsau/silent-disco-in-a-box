# Client-Side Beat Detection Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move strobe beat detection from server WebSocket events to client-side Web Audio analysis so the flash lands on the beat the listener actually hears.

**Architecture:** Inside the visualizer's existing `draw()` rAF loop, read time-domain waveform data from the `AnalyserNode` that `AudioManager` already creates, apply an IIR bass low-pass filter, run rolling-window RMS threshold detection, and set `beatFired` locally. Server energy broadcasts still drive background brightness; server beat flags are ignored.

**Tech Stack:** Vanilla JS, Web Audio API (`AnalyserNode.getByteTimeDomainData`), Canvas 2D

---

### Task 1: Add constants and beat-detection state fields

**Files:**
- Modify: `web/js/visualizer.js`

**Step 1: Add three constants before the `Visualizer` object (after `'use strict';`)**

Current line 1–2:
```js
'use strict';

const Visualizer = {
```

Replace with:
```js
'use strict';

const BEAT_THRESHOLD = 1.8;      // bass RMS must exceed mean × this to fire
const BEAT_COOLDOWN_MS = 250;    // min ms between beats (max ~240 BPM)
const BEAT_HISTORY_FRAMES = 90;  // rolling window size (~1.5 s at 60 fps)

const Visualizer = {
```

**Step 2: Add five state fields to the `Visualizer` object** (after the existing `beatFired: false,` on line 12)

Current:
```js
  beatFired: false,

  // Strobe state
```

Replace with:
```js
  beatFired: false,

  // Client-side beat detection
  _lpState: 0,
  _lpAlpha: 0,
  _bassHistory: [],
  _lastBeat: 0,
  _tdBuffer: null,

  // Strobe state
```

**Step 3: Verify the file looks right around those two insertion points, then commit**

```bash
cd "/Users/gary/Documents/AI Silent Disco"
git add web/js/visualizer.js
git commit -m "feat(visualizer): add beat detection constants and state fields"
```

---

### Task 2: Initialise beat detection in `init()`

**Files:**
- Modify: `web/js/visualizer.js` — `init()` method

**Step 1: Append initialisation code at the end of `init()`, just before the closing `},`**

Current end of `init()` (around line 43–45):
```js
    DiscoAPI.onEnergy((energy, beats) => {
      if (this.channelId && energy[this.channelId] !== undefined) {
        this.serverEnergy = energy[this.channelId];
        if (beats && beats[this.channelId]) this.beatFired = true;
      }
    });
  },
```

Replace with:
```js
    DiscoAPI.onEnergy((energy) => {
      if (this.channelId && energy[this.channelId] !== undefined) {
        this.serverEnergy = energy[this.channelId];
        // beats handled client-side — server flag ignored
      }
    });

    // Compute LP alpha from actual AudioContext sample rate (44100 or 48000 Hz)
    const analyser = AudioManager.getAnalyser();
    if (analyser) {
      const sr = analyser.context.sampleRate;
      const w0 = (2 * Math.PI * 200) / sr;
      this._lpAlpha = w0 / (w0 + 1);
      this._tdBuffer = new Uint8Array(analyser.fftSize);
    }
    this._lpState = 0;
    this._bassHistory = [];
    this._lastBeat = 0;
  },
```

Note: `analyser.context.sampleRate` is the standard Web Audio property — no AudioManager changes needed.

**Step 2: Commit**

```bash
git add web/js/visualizer.js
git commit -m "feat(visualizer): initialise client-side beat detection in init()"
```

---

### Task 3: Reset beat state in `setChannel()` and `stop()`

**Files:**
- Modify: `web/js/visualizer.js` — `setChannel()` and `stop()` methods

**Step 1: Update `setChannel()`**

Current:
```js
  setChannel(channelId) {
    this.channelId = channelId;
    this.beatFired = false;
    this.strobeAlpha = 0;
    this.particles = [];
  },
```

Replace with:
```js
  setChannel(channelId) {
    this.channelId = channelId;
    this.beatFired = false;
    this.strobeAlpha = 0;
    this.particles = [];
    this._lpState = 0;
    this._bassHistory = [];
    this._lastBeat = 0;
  },
```

**Step 2: Update `stop()`**

Current:
```js
  stop() {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
    this.serverEnergy = 0;
    this.smoothEnergy = 0;
    this.strobeAlpha = 0;
    this.particles = [];
    this.beatFired = false;
  },
```

Replace with:
```js
  stop() {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
    this.serverEnergy = 0;
    this.smoothEnergy = 0;
    this.strobeAlpha = 0;
    this.particles = [];
    this.beatFired = false;
    this._lpState = 0;
    this._bassHistory = [];
    this._lastBeat = 0;
    this._tdBuffer = null;
  },
```

**Step 3: Commit**

```bash
git add web/js/visualizer.js
git commit -m "feat(visualizer): reset beat detection state on channel switch and stop"
```

---

### Task 4: Add beat detection block inside `draw()` loop

**Files:**
- Modify: `web/js/visualizer.js` — inside `start()` → `draw()` inner function

**Step 1: Find the insertion point**

In `draw()`, the smooth-energy line is followed by the `if (this.beatFired)` block:

```js
      // Smooth energy
      this.smoothEnergy += (this.serverEnergy - this.smoothEnergy) * 0.25;
      const energy = this.smoothEnergy;

      // --- On beat: trigger effects ---
      if (this.beatFired) {
```

**Step 2: Insert the beat detection block between them**

Replace that section with:
```js
      // Smooth energy
      this.smoothEnergy += (this.serverEnergy - this.smoothEnergy) * 0.25;
      const energy = this.smoothEnergy;

      // --- Client-side beat detection ---
      {
        const analyser = AudioManager.getAnalyser();
        if (analyser && this._tdBuffer) {
          analyser.getByteTimeDomainData(this._tdBuffer);
          let lp = this._lpState;
          let sumBass = 0;
          const len = this._tdBuffer.length;
          for (let i = 0; i < len; i++) {
            const s = (this._tdBuffer[i] - 128) / 128;
            lp = this._lpAlpha * s + (1 - this._lpAlpha) * lp;
            sumBass += lp * lp;
          }
          this._lpState = lp;
          const bassRms = Math.sqrt(sumBass / len);

          const hist = this._bassHistory;
          hist.push(bassRms);
          if (hist.length > BEAT_HISTORY_FRAMES) hist.shift();

          if (hist.length >= 15) {
            const mean = hist.reduce((a, b) => a + b, 0) / hist.length;
            const now = performance.now();
            if (bassRms > mean * BEAT_THRESHOLD && now - this._lastBeat > BEAT_COOLDOWN_MS) {
              this.beatFired = true;
              this._lastBeat = now;
            }
          }
        }
      }

      // --- On beat: trigger effects ---
      if (this.beatFired) {
```

The block-scoped `{}` keeps `analyser`, `lp`, `sumBass`, `len`, `hist` out of the wider draw scope.

**Step 3: Commit**

```bash
git add web/js/visualizer.js
git commit -m "feat(visualizer): client-side beat detection from Web Audio time-domain data"
```

---

### Task 5: Bump version and deploy

**Files:**
- Modify: `web/index.html` — visualizer.js version query string

**Step 1: Bump the visualizer script version in `index.html`**

Current (line 48):
```html
  <script src="/js/visualizer.js?v=7"></script>
```

Replace with:
```html
  <script src="/js/visualizer.js?v=8"></script>
```

**Step 2: Commit**

```bash
git add web/index.html
git commit -m "chore: bump visualizer.js to v8 (client-side beat detection)"
```

**Step 3: Deploy to Pi**

```bash
sshpass -p 'raspberry' rsync -av \
  web/js/visualizer.js web/index.html \
  silentdisco@192.168.0.215:/tmp/

sshpass -p 'raspberry' ssh silentdisco@192.168.0.215 \
  "sudo cp /tmp/visualizer.js /tmp/index.html /var/www/disco/ && sudo systemctl reload nginx"
```

**Step 4: Manual verification**

1. Open `http://192.168.4.1` on a phone connected to the SilentDisco WiFi
2. Join a channel with music playing
3. Watch the white strobe flash — it should now feel locked to the kick drum
4. Switch channels and confirm the strobe responds to the new channel's audio immediately
5. Open browser DevTools console — confirm no JS errors

**Expected feel:** strobe fires at the moment the bass hit plays through the headphones, not 1–2s before it.

**If strobe fires too often (false positives):** increase `BEAT_THRESHOLD` from 1.8 → 2.0–2.2
**If strobe misses beats:** decrease `BEAT_THRESHOLD` toward 1.5, or reduce `BEAT_HISTORY_FRAMES` to 60

---

### Summary of changes

| File | Change |
|---|---|
| `web/js/visualizer.js` | Add constants, state fields, init/reset logic, draw-loop beat detection |
| `web/index.html` | Version bump `?v=7` → `?v=8` |
