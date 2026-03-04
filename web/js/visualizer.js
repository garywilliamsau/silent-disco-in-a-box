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

        // Kick existing particles
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
        this.strobeAlpha *= 0.72; // decay ~80ms at 60fps
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
        // Seed particles to maintain baseline population
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

          // Wrap at edges
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
      for (let i = 0; i < Math.floor(this.maxParticles * 0.4); i++) {
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
