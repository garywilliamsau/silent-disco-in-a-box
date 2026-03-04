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
