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

  init(canvasEl) {
    this.canvas = canvasEl;
    this.ctx = canvasEl.getContext('2d');
    this.resize();
    window.addEventListener('resize', () => this.resize());

    // Listen for server-side energy updates
    DiscoAPI.onEnergy((energy) => {
      if (this.channelId && energy[this.channelId] !== undefined) {
        this.serverEnergy = energy[this.channelId];
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
  },

  start() {
    const ctx = this.ctx;
    const canvas = this.canvas;

    const draw = () => {
      this.animationId = requestAnimationFrame(draw);

      const W = canvas.width;
      const H = canvas.height;

      // Smooth the server energy for natural feel
      this.smoothEnergy += (this.serverEnergy - this.smoothEnergy) * 0.25;
      const energy = this.smoothEnergy;

      // Dynamic brightness: base 0.55, pulses up to 1.0 with energy
      const brightness = 0.55 + energy * 0.45;
      const br = Math.round(this.r * brightness);
      const bg = Math.round(this.g * brightness);
      const bb = Math.round(this.b * brightness);

      ctx.fillStyle = `rgb(${br}, ${bg}, ${bb})`;
      ctx.fillRect(0, 0, W, H);

      // Radial glow that reacts to energy
      const cx = W / 2;
      const cy = H * 0.4;
      const glowRadius = Math.max(W, H) * (0.2 + energy * 0.6);
      const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, glowRadius);
      glow.addColorStop(0, `rgba(255, 255, 255, ${0.05 + energy * 0.2})`);
      glow.addColorStop(0.5, `rgba(255, 255, 255, ${0.01 + energy * 0.06})`);
      glow.addColorStop(1, 'rgba(255, 255, 255, 0)');
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, W, H);

      // Vignette
      const vignette = ctx.createRadialGradient(cx, H / 2, H * 0.3, cx, H / 2, H * 0.8);
      vignette.addColorStop(0, 'rgba(0, 0, 0, 0)');
      vignette.addColorStop(1, `rgba(0, 0, 0, ${0.25 + (1 - energy) * 0.15})`);
      ctx.fillStyle = vignette;
      ctx.fillRect(0, 0, W, H);
    };

    draw();
  },

  stop() {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
    this.serverEnergy = 0;
    this.smoothEnergy = 0;
  },

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
        p.x += p.vx;
        p.y += p.vy;
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
  }
};
