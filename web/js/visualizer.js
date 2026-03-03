'use strict';

const Visualizer = {
  canvas: null,
  ctx: null,
  animationId: null,
  channelColor: '#ffffff',
  r: 255, g: 255, b: 255,
  energy: 0,
  hasAnalyserData: false,
  pulsePhase: 0,

  init(canvasEl) {
    this.canvas = canvasEl;
    this.ctx = canvasEl.getContext('2d');
    this.resize();
    window.addEventListener('resize', () => this.resize());
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

  start() {
    const analyser = AudioManager.getAnalyser();
    const hasAnalyser = !!analyser;
    const bufferLength = hasAnalyser ? analyser.frequencyBinCount : 0;
    const dataArray = hasAnalyser ? new Uint8Array(bufferLength) : null;
    const ctx = this.ctx;
    const canvas = this.canvas;
    let checkFrames = 0;

    const draw = () => {
      this.animationId = requestAnimationFrame(draw);

      const W = canvas.width;
      const H = canvas.height;

      let bass = 0;
      let total = 0;

      if (hasAnalyser) {
        analyser.getByteFrequencyData(dataArray);

        // Check if analyser is returning real data (first 30 frames)
        if (checkFrames < 30) {
          checkFrames++;
          let sum = 0;
          for (let i = 0; i < bufferLength; i++) sum += dataArray[i];
          if (sum > 0) this.hasAnalyserData = true;
        }

        if (this.hasAnalyserData) {
          for (let i = 0; i < 16; i++) bass += dataArray[i];
          bass = bass / (16 * 255);
          for (let i = 0; i < bufferLength; i++) total += dataArray[i];
          total = total / (bufferLength * 255);
        }
      }

      // Fallback: gentle CSS-style pulse when no analyser data
      if (!this.hasAnalyserData) {
        this.pulsePhase += 0.02;
        bass = 0.3 + Math.sin(this.pulsePhase) * 0.15 + Math.sin(this.pulsePhase * 2.7) * 0.08;
        total = 0.25 + Math.sin(this.pulsePhase * 0.8) * 0.1;
      }

      this.energy += (total - this.energy) * 0.15;

      // Dynamic brightness
      const brightness = 0.6 + bass * 0.4;
      const br = Math.round(this.r * brightness);
      const bg = Math.round(this.g * brightness);
      const bb = Math.round(this.b * brightness);

      ctx.fillStyle = `rgb(${br}, ${bg}, ${bb})`;
      ctx.fillRect(0, 0, W, H);

      // Radial glow
      const cx = W / 2;
      const cy = H * 0.4;
      const glowRadius = Math.max(W, H) * (0.3 + this.energy * 0.5);
      const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, glowRadius);
      glow.addColorStop(0, `rgba(255, 255, 255, ${0.08 + bass * 0.15})`);
      glow.addColorStop(0.5, `rgba(255, 255, 255, ${0.02 + bass * 0.05})`);
      glow.addColorStop(1, 'rgba(255, 255, 255, 0)');
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, W, H);

      // Vignette
      const vignette = ctx.createRadialGradient(cx, H / 2, H * 0.3, cx, H / 2, H * 0.8);
      vignette.addColorStop(0, 'rgba(0, 0, 0, 0)');
      vignette.addColorStop(1, 'rgba(0, 0, 0, 0.3)');
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
    this.hasAnalyserData = false;
    this.pulsePhase = 0;
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
