'use strict';

const BEAT_THRESHOLD = 1.8;      // bass RMS must exceed mean × this to fire
const BEAT_COOLDOWN_MS = 250;    // min ms between beats (max ~240 BPM)
const BEAT_HISTORY_FRAMES = 90;  // rolling window size (~1.5 s at 60 fps)
const MIN_BASS_ABSOLUTE = 0.008; // ~-42 dB — gate out silence/noise floor
// Delay applied to the server-beat fallback (iOS, where the analyser is silent),
// to compensate for the phone's playback buffer so the flash lands with the
// audio instead of ahead of it. Tune live with ?beatdelay=<ms>.
const DEFAULT_BEAT_DELAY_MS = 1000;
// Strong beats flash this colour (gold); soft beats stay white, blended by strength.
const STRONG_BEAT_COLOR = [255, 200, 60];

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

  // Client-side beat detection (falls back to server beats when the analyser
  // reads silent — e.g. iOS, where Web Audio gives flat data for a stream).
  _lpState: 0,
  _lpAlpha: 0,
  _bassHistory: [],
  _lastBeat: 0,
  _tdBuffer: null,
  _lastClientSignal: -Infinity, // last time the analyser delivered a real waveform
  _serverBeatQueue: [],         // server beats scheduled to fire after _beatDelayMs
  _beatDelayMs: 0,
  _beatArrivals: [],            // recent server-beat arrival times (tempo estimate)
  _beatInterval: 500,           // estimated ms between beats
  _lastStrobeFire: 0,           // last fallback strobe time (for min-spacing)
  _beatStrength: 0.7,           // 0-1 intensity of the last beat (scales the strobe)
  _strobeR: 255, _strobeG: 255, _strobeB: 255, // strobe colour for the current flash
  effect: 'none',               // visualizer effect: 'none' | 'christmas'
  _snow: [],                    // snow flakes (christmas mode)
  _xmasBeat: 0,                 // alternates festive strobe colours
  _listenersBound: false,
  // Debug overlay — enable with ?vdebug=1
  _debug: false,
  _dbgClientBeats: 0,
  _dbgServerBeats: 0,
  _dbgMaxDev: 0,
  _dbgAlive: false,

  // Strobe state
  strobeAlpha: 0,

  // Particle pool
  particles: [],
  maxParticles: 0,

  // Cached vignette gradients (10 discrete energy levels)
  _vignetteCache: [],
  _bgAnimId: null,

  init(canvasEl) {
    this.canvas = canvasEl;
    this.ctx = canvasEl.getContext('2d');
    this.resize();

    // Bind global/WS listeners once — init() runs again on every channel switch.
    if (!this._listenersBound) {
      window.addEventListener('resize', () => this.resize());
      DiscoAPI.onEnergy((energy, beats) => {
        if (this.channelId && energy[this.channelId] !== undefined) {
          this.serverEnergy = energy[this.channelId];
        }
        // Queue server beats (with the compensation delay) — the draw loop only
        // uses them as a fallback when the local analyser is silent (iOS).
        if (beats && this.channelId && beats[this.channelId]) {
          const t = performance.now();
          // Estimate tempo from arrival rate. Counting over a window averages out
          // the WS burst clustering, so the interval stays accurate.
          const arr = this._beatArrivals;
          arr.push(t);
          while (arr.length > 2 && t - arr[0] > 12000) arr.shift();
          // Only trust the tempo once arrivals span a few seconds — a single
          // batched cluster spans little wall-clock and would collapse it.
          const span = arr[arr.length - 1] - arr[0];
          if (arr.length >= 6 && span >= 3000) {
            this._beatInterval = Math.max(250, Math.min(1200, span / (arr.length - 1)));
          }
          this._serverBeatQueue.push({ at: t + this._beatDelayMs, strength: energy[this.channelId] || 0.6 });
          // Bound the queue even if rAF is paused (backgrounded tab).
          if (this._serverBeatQueue.length > 6) this._serverBeatQueue.shift();
        }
      });
      this._listenersBound = true;
    }

    // Scale particle count to device capability
    const cores = navigator.hardwareConcurrency || 2;
    this.maxParticles = cores <= 2 ? 0 : cores <= 4 ? 20 : 50;

    this.particles = [];
    this.strobeAlpha = 0;
    this._vignetteCache = [];

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
    this._lastClientSignal = -Infinity;
    this._serverBeatQueue = [];
    this._beatArrivals = [];
    this._lastStrobeFire = 0;
    this._beatInterval = 500;
  },

  resize() {
    this.canvas.width = this.canvas.offsetWidth * (window.devicePixelRatio || 1);
    this.canvas.height = this.canvas.offsetHeight * (window.devicePixelRatio || 1);
    this._vignetteCache = []; // invalidate on resize
  },

  // Toggle a global visualizer effect ('none' | 'christmas'). Idempotent.
  setEffect(effect) {
    effect = effect || 'none';
    if (effect === this.effect) return;
    this.effect = effect;
    if (effect === 'christmas') this._initSnow();
    else this._snow = [];
  },

  _initSnow() {
    const dpr = window.devicePixelRatio || 1;
    const W = this.canvas ? this.canvas.width : 0;
    const H = this.canvas ? this.canvas.height : 0;
    const tier = this.maxParticles === 0 ? 0 : this.maxParticles <= 20 ? 1 : 2;
    const dots = [40, 70, 100][tier];     // fine white snow
    const emojis = [6, 12, 18][tier];     // trees / reindeer / big flakes
    const chars = ['🎄', '🦌', '❄️', '⭐'];
    const arr = [];
    for (let i = 0; i < dots; i++) arr.push(this._makeFlake(W, H, dpr, null));
    for (let i = 0; i < emojis; i++) arr.push(this._makeFlake(W, H, dpr, chars[i % chars.length]));
    this._snow = arr;
  },

  _makeFlake(W, H, dpr, char) {
    const upright = (char === '🎄' || char === '🦌'); // these shouldn't tumble
    return {
      x: Math.random() * (W || 1),
      y: Math.random() * (H || 1),
      char,
      r: (Math.random() * 2.2 + 0.8) * dpr,          // dot radius (plain snow)
      size: (Math.random() * 16 + 26) * dpr,         // emoji font size
      vy: (char ? Math.random() * 0.6 + 0.5 : Math.random() * 1.1 + 0.4) * dpr,
      sway: (Math.random() * 0.6 + 0.2) * dpr,
      phase: Math.random() * Math.PI * 2,
      rot: upright ? 0 : Math.random() * Math.PI * 2,
      vrot: upright ? 0 : (Math.random() - 0.5) * 0.03,
    };
  },

  _drawSnow(ctx, W, H) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    for (const f of this._snow) {
      f.y += f.vy;
      f.phase += 0.02;
      f.x += Math.sin(f.phase) * f.sway;
      const m = f.char ? f.size : 4;
      if (f.y > H + m) { f.y = -m; f.x = Math.random() * W; }
      if (f.x < -m) f.x = W + m; else if (f.x > W + m) f.x = -m;
      if (f.char) {
        f.rot += f.vrot;
        ctx.save();
        ctx.translate(f.x, f.y);
        if (f.rot) ctx.rotate(f.rot);
        ctx.font = `${f.size}px serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(f.char, 0, 0);
        ctx.restore();
      } else {
        ctx.beginPath();
        ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
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
    this.particles = [];
    this._lpState = 0;
    this._bassHistory = [];
    this._lastBeat = 0;
    this._lastClientSignal = -Infinity;
    this._serverBeatQueue = [];
    this._beatArrivals = [];
    this._lastStrobeFire = 0;
    this._beatInterval = 500;
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

  _getVignette(ctx, cx, H, energy) {
    // Quantise to 10 levels to avoid per-frame gradient allocation
    const level = Math.round(energy * 10);
    if (!this._vignetteCache[level]) {
      const g = ctx.createRadialGradient(cx, H / 2, H * 0.3, cx, H / 2, H * 0.85);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, `rgba(0,0,0,${(0.3 - (level / 10) * 0.2).toFixed(2)})`);
      this._vignetteCache[level] = g;
    }
    return this._vignetteCache[level];
  },

  start() {
    if (this.animationId) cancelAnimationFrame(this.animationId); // avoid stacking draw loops on re-init
    const params = (typeof location !== 'undefined') ? new URLSearchParams(location.search) : new URLSearchParams();
    this._debug = params.has('vdebug');
    const bd = parseInt(params.get('beatdelay'), 10);
    this._beatDelayMs = (params.has('beatdelay') && Number.isFinite(bd) && bd >= 0)
      ? bd
      : DEFAULT_BEAT_DELAY_MS;
    const ctx = this.ctx;
    const canvas = this.canvas;
    if (this.effect === 'christmas') this._initSnow(); // size snow to the live canvas

    const draw = () => {
      this.animationId = requestAnimationFrame(draw);

      // Guard against canvas not yet laid out (iOS Safari timing)
      const W = canvas.width || canvas.offsetWidth * (window.devicePixelRatio || 1);
      const H = canvas.height || canvas.offsetHeight * (window.devicePixelRatio || 1);
      if (!W || !H) return;

      const cx = W / 2;
      const cy = H / 2;

      // Smooth energy
      this.smoothEnergy += (this.serverEnergy - this.smoothEnergy) * 0.25;
      const energy = this.smoothEnergy;

      // --- Beat detection: client-side from the audio actually playing, with a
      // server fallback when the analyser reads silent (notably iOS, where Web
      // Audio gives flat data for a streaming <audio>). ---
      {
        const nowMs = performance.now();
        const analyser = AudioManager.getAnalyser();
        let clientBeat = false;

        if (analyser && this._tdBuffer) {
          analyser.getByteTimeDomainData(this._tdBuffer);
          let lp = this._lpState;
          let sumBass = 0;
          let maxDev = 0;
          const len = this._tdBuffer.length;
          for (let i = 0; i < len; i++) {
            const raw = this._tdBuffer[i] - 128;
            const dev = raw < 0 ? -raw : raw;
            if (dev > maxDev) maxDev = dev;
            const s = raw / 128;
            lp = this._lpAlpha * s + (1 - this._lpAlpha) * lp;
            sumBass += lp * lp;
          }
          this._lpState = lp;
          // Any real waveform means the analyser is delivering audio to us.
          if (maxDev > 1) this._lastClientSignal = nowMs;
          this._dbgMaxDev = maxDev;

          const bassRms = Math.sqrt(sumBass / len);
          const hist = this._bassHistory;
          hist.push(bassRms);
          if (hist.length > BEAT_HISTORY_FRAMES) hist.shift();

          if (hist.length >= 15 && bassRms > MIN_BASS_ABSOLUTE) {
            const mean = hist.reduce((a, b) => a + b, 0) / hist.length;
            if (bassRms > mean * BEAT_THRESHOLD && nowMs - this._lastBeat > BEAT_COOLDOWN_MS) {
              clientBeat = true;
              this._lastBeat = nowMs;
            }
          }
        }

        const analyserAlive = (nowMs - this._lastClientSignal) < 2000;
        this._dbgAlive = analyserAlive;
        if (analyserAlive) {
          // Web Audio is feeding us samples — use the buffer-aligned client beat.
          if (clientBeat) { this.beatFired = true; this._beatStrength = 0.73; this._dbgClientBeats++; }
          this._serverBeatQueue.length = 0; // client-driven: drop pending server beats
        } else {
          // Analyser silent (iOS): the WebSocket can deliver beats in bursts, so
          // fire from the queue no faster than ~the tempo. This re-spaces a
          // cluster into an even strobe while leaving on-time beats untouched
          // (their gap already exceeds minGap). _beatDelayMs aligned them to audio.
          // Fire from the queue no faster than ~the tempo, re-spacing a cluster
          // into an even strobe. The queue is bounded on push, so no stale-drop
          // is needed here (which could otherwise discard real beats mid-spread).
          const minGap = this._beatInterval * 0.8;
          if (this._serverBeatQueue.length &&
              this._serverBeatQueue[0].at <= nowMs &&
              nowMs - this._lastStrobeFire >= minGap) {
            const b = this._serverBeatQueue.shift();
            this.beatFired = true;
            this._beatStrength = b.strength;
            this._dbgServerBeats++;
            this._lastStrobeFire = nowMs;
          }
        }
      }

      // --- On beat: trigger effects ---
      if (this.beatFired) {
        this.beatFired = false;

        // Strobe — brightness scales with beat strength (big flash on the downbeat)
        this.strobeAlpha = 0.2 + this._beatStrength * this._beatStrength * 0.65;
        if (this.effect === 'christmas') {
          // Festive lights: alternate red / green on each beat.
          this._xmasBeat++;
          if (this._xmasBeat % 2 === 0) { this._strobeR = 255; this._strobeG = 45; this._strobeB = 45; }
          else { this._strobeR = 40; this._strobeG = 220; this._strobeB = 70; }
        } else {
          // Colour: soft beats flash white, strong beats shift toward the accent colour.
          const k = this._beatStrength;
          this._strobeR = Math.round(255 - (255 - STRONG_BEAT_COLOR[0]) * k);
          this._strobeG = Math.round(255 - (255 - STRONG_BEAT_COLOR[1]) * k);
          this._strobeB = Math.round(255 - (255 - STRONG_BEAT_COLOR[2]) * k);
        }

        // Kick existing particles — capped to prevent escape at high BPM
        this.particles.forEach(p => {
          p.vx = Math.sign(p.vx || 1) * Math.min(Math.abs(p.vx * 3), 6);
          p.vy = Math.sign(p.vy || 1) * Math.min(Math.abs(p.vy * 3), 6);
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
        ctx.fillStyle = `rgba(${this._strobeR}, ${this._strobeG}, ${this._strobeB}, ${this.strobeAlpha})`;
        ctx.fillRect(0, 0, W, H);
        this.strobeAlpha *= 0.72; // decay ~80ms at 60fps
      }

      // --- 3. Particles ---
      if (this.maxParticles > 0) {
        while (this.particles.length < Math.floor(this.maxParticles * 0.4)) {
          this.particles.push(this._spawnParticle(W, H));
        }

        for (let i = this.particles.length - 1; i >= 0; i--) {
          const p = this.particles[i];
          p.x += p.vx * (1 + energy);
          p.y += p.vy * (1 + energy);
          p.life -= p.decay;
          p.vx *= 0.99;
          p.vy *= 0.99;

          if (p.x < 0) p.x = W;
          if (p.x > W) p.x = 0;
          if (p.y < 0) p.y = H;
          if (p.y > H) p.y = 0;

          if (p.life <= 0) { this.particles.splice(i, 1); continue; }

          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(255, 255, 255, ${p.life * (0.4 + energy * 0.4)})`;
          ctx.fill();
        }
      }

      // --- 5. Vignette (cached gradient) ---
      ctx.fillStyle = this._getVignette(ctx, cx, H, energy);
      ctx.fillRect(0, 0, W, H);

      // --- Christmas: falling snow on top ---
      if (this.effect === 'christmas') this._drawSnow(ctx, W, H);

      // --- Debug overlay (?vdebug=1) ---
      if (this._debug) {
        const dpr = window.devicePixelRatio || 1;
        ctx.save();
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.fillRect(0, 0, 260 * dpr, 96 * dpr);
        ctx.fillStyle = '#0f0';
        ctx.font = `${13 * dpr}px monospace`;
        ctx.fillText(`alive:${this._dbgAlive} srvE:${this.serverEnergy.toFixed(2)}`, 8 * dpr, 22 * dpr);
        ctx.fillText(`maxDev:${this._dbgMaxDev}  delay:${this._beatDelayMs}`, 8 * dpr, 44 * dpr);
        ctx.fillText(`clientBeats:${this._dbgClientBeats}`, 8 * dpr, 66 * dpr);
        ctx.fillText(`serverBeats:${this._dbgServerBeats} iv:${Math.round(this._beatInterval)}`, 8 * dpr, 88 * dpr);
        ctx.restore();
      }
    };

    // Seed initial particles
    if (this.maxParticles > 0) {
      const W = canvas.width || canvas.offsetWidth;
      const H = canvas.height || canvas.offsetHeight;
      if (W && H) {
        for (let i = 0; i < Math.floor(this.maxParticles * 0.4); i++) {
          this.particles.push(this._spawnParticle(W, H));
        }
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
    this.particles = [];
    this.beatFired = false;
    this._lpState = 0;
    this._bassHistory = [];
    this._lastBeat = 0;
    this._lastClientSignal = -Infinity;
    this._serverBeatQueue = [];
    this._beatArrivals = [];
    this._lastStrobeFire = 0;
    this._beatInterval = 500;
    this._tdBuffer = null;
  },

  // Used by start screen — returns rAF id so caller can cancel on scene transition
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
      this._bgAnimId = requestAnimationFrame(animate);
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

  stopBackground() {
    if (this._bgAnimId) {
      cancelAnimationFrame(this._bgAnimId);
      this._bgAnimId = null;
    }
  },
};
