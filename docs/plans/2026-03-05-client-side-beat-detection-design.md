# Client-Side Beat Detection Design

**Date:** 2026-03-05
**Status:** Approved

## Problem

The strobe flash in the visualizer fires before the listener hears the beat. The server detects beats from the raw Icecast stream via ffmpeg, but each browser buffers 1–3s of audio before playing. The WebSocket beat event arrives ~buffer-length early relative to the listener's actual audio playback.

## Solution

Move beat detection to the client, analysing the audio the browser is actually playing. `AudioManager` already creates a Web Audio `AnalyserNode` wired to the audio element — we read time-domain data from it inside the visualizer's `draw()` loop.

## Design

### File changed: `web/js/visualizer.js` only

**New state on `Visualizer`:**

| Field | Purpose |
|---|---|
| `_lpState` | IIR filter state (200Hz low-pass, α≈0.054, matches server) |
| `_bassHistory` | Rolling array of per-frame bass RMS (~90 frames = ~1.5s at 60fps) |
| `_lastBeat` | Timestamp of last beat, enforces 250ms cooldown |
| `_tdBuffer` | `Uint8Array(analyser.fftSize)` for time-domain waveform data |

**Beat detection in `draw()` loop (every frame):**

1. `analyser.getByteTimeDomainData(_tdBuffer)` — raw waveform, not FFT-smoothed
2. Convert bytes to floats: `(sample - 128) / 128`
3. IIR low-pass each sample → accumulate bass RMS
4. Append bassRms to rolling history, compute rolling mean
5. If `bassRms > mean × 1.8` AND `now - _lastBeat > 250ms` → `beatFired = true`

**Key:** `getByteTimeDomainData` bypasses `smoothingTimeConstant` (which only affects FFT output), giving raw samples with no pre-smoothing — better transient detection for beat onset.

**`init()`:** allocate `_tdBuffer` (analyser exists by then — `AudioManager.play()` calls `initAudioContext()` before `Visualizer.init()`). Graceful skip if analyser null.

**`setChannel()`:** reset `_lpState`, `_bassHistory`, `_lastBeat` on channel switch.

**`stop()`:** reset all beat state.

### Server energy broadcasts

Keep as-is. `DiscoAPI.onEnergy` still drives `serverEnergy` → background brightness. Server `beats` flag is ignored (strobe no longer driven by it).

### No changes to

- `audio.js`
- `app.js`
- `api.js`
- Any server-side code

## Constants

```js
const LP_ALPHA = (2 * Math.PI * 200) / 44100 / ((2 * Math.PI * 200) / 44100 + 1); // ≈0.054
const BEAT_THRESHOLD = 1.8;
const BEAT_COOLDOWN_MS = 250;
const BEAT_HISTORY_FRAMES = 90; // ~1.5s at 60fps
```

Note: AudioContext sample rate may vary by device (44100 or 48000Hz). α is computed dynamically from `audioCtx.sampleRate` at init time.
