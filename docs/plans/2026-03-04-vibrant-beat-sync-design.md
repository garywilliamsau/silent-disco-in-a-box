# Vibrant Beat-Sync Backgrounds — Design

## Problem

The current visualizer does a subtle brightness pulse reacting to RMS energy. It's barely noticeable, especially in a lit room. The goal is a dramatically more impactful visual: full-screen strobes, expanding neon rings, and energy-reactive particles — all snapping to the actual beat.

## Constraints

- Must work on guests' phones (mix of old/new) — graceful degradation required
- iOS Safari: no Web Audio API analyser on streaming audio (existing GOTCHA) — beat detection must be server-side
- Performance: middle ground — impressive but scaled to device capability

---

## Architecture

### Server — `server/lib/energy.js`

Add beat detection to the existing PCM pipeline. No extra processes or dependencies.

**Algorithm (spectral flux on bass band):**

1. Apply first-order IIR low-pass filter to each PCM buffer (cutoff ~200Hz) to isolate kick drum frequencies
2. Compute RMS on the filtered bass signal
3. Maintain a rolling window (~2 seconds) of recent bass RMS values
4. Trigger a beat when: `bassRMS > rollingAverage × 1.8` AND `timeSinceLastBeat > 250ms`
   - The 250ms minimum prevents double-triggers and caps at 240BPM

**Broadcast payload change:**

Before: `{ type: 'energy', energy: { red: 0.72, green: 0.45, blue: 0.31 } }`
After:  `{ type: 'energy', energy: { red: 0.72, ... }, beats: { red: true, green: false, blue: false } }`

### Client — `web/js/api.js`

Minor: `onEnergy` callbacks now receive `(energy, beats)` — pass both from the WebSocket message.

### Client — `web/js/visualizer.js`

Three layered effects, all drawn in the single `requestAnimationFrame` loop on the existing canvas.

**1. Beat Strobe**
- On beat: overlay entire canvas with white at 55% opacity
- Exponential decay over ~80ms (≈5 frames at 60fps)
- Most dramatic effect — whole screen flashes

**2. Burst Rings**
- On beat: add 2 expanding rings to a pool (max 6 active)
- Each ring: starts radius 0, expands to 1.5× screen diagonal over 600ms
- Line width starts thick, thins as it expands; opacity fades with radius
- Colour: channel colour (brightened)

**3. Particles**
- Pool of N drifting dots, always present
- On beat: all get velocity kick, 3 new ones spawn
- Energy controls baseline brightness and speed
- Particles wrap at screen edges
- Object pool (pre-allocated) to avoid GC pressure

**Graceful degradation** — checked once at `init()` via `navigator.hardwareConcurrency`:
- ≤2 cores: particles disabled (strobe + rings only)
- 3–4 cores: 20 particles
- ≥5 cores: 50 particles

---

## Files Changed

| File | Change |
|------|--------|
| `server/lib/energy.js` | Add IIR low-pass filter + beat detection + `beats` in broadcast |
| `web/js/api.js` | Pass `beats` arg to `onEnergy` callbacks |
| `web/js/visualizer.js` | Replace pulse with strobe + rings + particles |

No HTML, CSS, or other server files need to change.
