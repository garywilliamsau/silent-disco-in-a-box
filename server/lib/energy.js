'use strict';

const { spawn } = require('child_process');

// Analyses Icecast streams and calculates audio energy + beat detection per channel
// Broadcasts ~15 updates/sec via callback

const SAMPLE_RATE = 22050;
// First-order IIR low-pass: w0 = 2*pi*fc/fs, alpha = w0/(w0+1), fc=200Hz isolates kick/bass
const _w0 = (2 * Math.PI * 200) / SAMPLE_RATE;
const ALPHA = _w0 / (_w0 + 1); // ~0.054
const WINDOW_SAMPLES = 1024;  // fixed analysis window (~46ms at 22050Hz) — gives stable timing regardless of ffmpeg chunking
const WINDOW_MS = (WINDOW_SAMPLES / SAMPLE_RATE) * 1000; // audio-time per window (~46.4ms) for beat cooldown
const WINDOW_SIZE = 43;       // rolling-mean history length: 43 windows ≈ 2 seconds
const BEAT_THRESHOLD = 1.8;   // bass RMS must exceed mean × this to fire beat
const BEAT_COOLDOWN_MS = 250; // minimum ms between beats (max 240BPM)
const MIN_BASS_ABSOLUTE = 0.006; // gate out silence/noise floor so quiet passages don't false-fire

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
    this._pcmBuffer = {};     // leftover PCM bytes that didn't fill a window
    this._audioMs = {};       // per-channel audio-time cursor (ms) for beat cooldown

    this._stopped = false;

    this.channels.forEach(ch => {
      this.energy[ch] = 0;
      this.beats[ch] = false;
      this._lpState[ch] = 0;
      this._bassHistory[ch] = [];
      this._lastBeat[ch] = 0;
      this._pcmBuffer[ch] = Buffer.alloc(0);
      this._audioMs[ch] = 0;
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
    // Reset filter and detection state on (re)start to avoid stale data causing false beats
    this._lpState[ch] = 0;
    this._bassHistory[ch] = [];
    this._lastBeat[ch] = 0;
    this._pcmBuffer[ch] = Buffer.alloc(0);
    this._audioMs[ch] = 0;

    const proc = spawn('ffmpeg', [
      '-fflags', 'nobuffer',
      '-flags', 'low_delay',
      '-probesize', '32',
      '-analyzeduration', '0',
      '-i', `http://127.0.0.1:8000/${ch}`,
      '-f', 's16le',
      '-ar', String(SAMPLE_RATE),
      '-ac', '1',
      '-loglevel', 'quiet',
      'pipe:1',
    ]);

    this.processes[ch] = proc;

    proc.stdout.on('data', (buf) => {
      // Accumulate PCM and analyse in fixed WINDOW_SAMPLES windows, so the
      // rolling history (WINDOW_SIZE windows) is a stable ~2s regardless of how
      // ffmpeg chunks its stdout. Leftover bytes carry to the next chunk.
      const data = this._pcmBuffer[ch].length
        ? Buffer.concat([this._pcmBuffer[ch], buf])
        : buf;
      const WINDOW_BYTES = WINDOW_SAMPLES * 2; // s16le = 2 bytes/sample
      let offset = 0;
      let lpPrev = this._lpState[ch];
      let audioMs = this._audioMs[ch];

      while (data.length - offset >= WINDOW_BYTES) {
        let sumFull = 0;
        let sumBass = 0;
        for (let i = 0; i < WINDOW_BYTES; i += 2) {
          const s = data.readInt16LE(offset + i) / 32768;
          sumFull += s * s;                              // full-range energy
          lpPrev = ALPHA * s + (1 - ALPHA) * lpPrev;     // IIR low-pass (bass isolation)
          sumBass += lpPrev * lpPrev;
        }

        const rms = Math.sqrt(sumFull / WINDOW_SAMPLES);
        this.energy[ch] = Math.min(1, rms * 4);

        const bassRms = Math.sqrt(sumBass / WINDOW_SAMPLES);
        const hist = this._bassHistory[ch];
        hist.push(bassRms);
        if (hist.length > WINDOW_SIZE) hist.shift();
        const mean = hist.reduce((a, b) => a + b, 0) / hist.length;

        audioMs += WINDOW_MS; // advance audio-time clock (independent of wall clock / chunking)
        if (
          hist.length >= 10 &&                  // need some history first
          bassRms > MIN_BASS_ABSOLUTE &&        // above the noise floor
          bassRms > mean * BEAT_THRESHOLD &&
          audioMs - this._lastBeat[ch] > BEAT_COOLDOWN_MS
        ) {
          this.beats[ch] = true;
          this._lastBeat[ch] = audioMs;
        }

        offset += WINDOW_BYTES;
      }

      this._lpState[ch] = lpPrev;
      this._audioMs[ch] = audioMs;
      this._pcmBuffer[ch] = offset < data.length ? data.subarray(offset) : Buffer.alloc(0);
    });

    proc.on('close', () => {
      if (!this._stopped) setTimeout(() => this._startChannel(ch), 3000);
    });

    proc.stderr.on('data', () => {});
  }

  stop() {
    this._stopped = true;
    clearInterval(this._interval);
    for (const ch of this.channels) {
      if (this.processes[ch]) this.processes[ch].kill();
    }
  }
}

module.exports = EnergyAnalyser;
