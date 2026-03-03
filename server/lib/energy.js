'use strict';

const { spawn } = require('child_process');

// Analyses Icecast streams and calculates audio energy per channel
// Broadcasts ~10 updates/sec via callback

class EnergyAnalyser {
  constructor(channels, onEnergy) {
    this.channels = channels; // ['red', 'green', 'blue']
    this.onEnergy = onEnergy;
    this.processes = {};
    this.energy = {};
    this.channels.forEach(ch => { this.energy[ch] = 0; });
  }

  start() {
    for (const ch of this.channels) {
      this._startChannel(ch);
    }
    // Broadcast energy at ~15Hz
    this._interval = setInterval(() => {
      this.onEnergy({ ...this.energy });
    }, 66);
  }

  _startChannel(ch) {
    // Decode Icecast stream to raw PCM via ffmpeg
    const proc = spawn('ffmpeg', [
      '-i', `http://127.0.0.1:8000/${ch}`,
      '-f', 's16le',
      '-ar', '22050',
      '-ac', '1',
      '-loglevel', 'quiet',
      'pipe:1',
    ]);

    this.processes[ch] = proc;

    proc.stdout.on('data', (buf) => {
      // Calculate RMS energy from S16LE PCM
      let sum = 0;
      const samples = buf.length / 2;
      for (let i = 0; i < buf.length; i += 2) {
        const sample = buf.readInt16LE(i) / 32768;
        sum += sample * sample;
      }
      const rms = Math.sqrt(sum / samples);
      // Boost and clamp to 0-1 (music typically has RMS 0.05-0.3)
      this.energy[ch] = Math.min(1, rms * 4);
    });

    proc.on('close', () => {
      // Restart after delay
      setTimeout(() => this._startChannel(ch), 3000);
    });

    proc.stderr.on('data', () => {}); // suppress
  }

  stop() {
    clearInterval(this._interval);
    for (const ch of this.channels) {
      if (this.processes[ch]) {
        this.processes[ch].kill();
      }
    }
  }
}

module.exports = EnergyAnalyser;
