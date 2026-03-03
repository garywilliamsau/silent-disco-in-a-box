'use strict';

const Visualizer = {
  canvas: null,
  ctx: null,
  animationId: null,
  channelColor: '#ffffff',
  r: 255, g: 255, b: 255,
  energy: 0,

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
    if (!analyser) return;

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    const ctx = this.ctx;
    const canvas = this.canvas;

    const draw = () => {
      this.animationId = requestAnimationFrame(draw);
      analyser.getByteFrequencyData(dataArray);

      const W = canvas.width;
      const H = canvas.height;

      // Calculate bass energy (low frequencies 0-15) for the pulse
      let bass = 0;
      for (let i = 0; i < 16; i++) bass += dataArray[i];
      bass = bass / (16 * 255);

      // Calculate overall energy for the glow
      let total = 0;
      for (let i = 0; i < bufferLength; i++) total += dataArray[i];
      total = total / (bufferLength * 255);

      // Smooth the energy for a natural feel
      this.energy += (total - this.energy) * 0.15;

      // Dynamic brightness: base 0.6, pulses up to 1.0 with bass
      const brightness = 0.6 + bass * 0.4;
      const br = Math.round(this.r * brightness);
      const bg = Math.round(this.g * brightness);
      const bb = Math.round(this.b * brightness);

      // Fill with pulsing channel colour
      ctx.fillStyle = `rgb(${br}, ${bg}, ${bb})`;
      ctx.fillRect(0, 0, W, H);

      // Radial glow from center that reacts to energy
      const cx = W / 2;
      const cy = H * 0.4;
      const glowRadius = Math.max(W, H) * (0.3 + this.energy * 0.5);
      const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, glowRadius);
      glow.addColorStop(0, `rgba(255, 255, 255, ${0.08 + bass * 0.15})`);
      glow.addColorStop(0.5, `rgba(255, 255, 255, ${0.02 + bass * 0.05})`);
      glow.addColorStop(1, 'rgba(255, 255, 255, 0)');
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, W, H);

      // Subtle dark vignette at edges
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
