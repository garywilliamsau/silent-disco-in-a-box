'use strict';

const AudioManager = {
  audioEl: null,
  audioCtx: null,
  source: null,
  analyser: null,
  currentChannel: null,
  initialized: false,

  init() {
    this.audioEl = document.getElementById('audioPlayer');

    this.audioEl.addEventListener('error', () => {
      console.warn('Stream error, reconnecting...');
      const src = this.audioEl.src;
      this.audioEl.src = '';
      setTimeout(() => {
        this.audioEl.src = src;
        this.audioEl.play().catch(() => {});
      }, 2000);
    });

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.audioCtx) {
        if (this.audioCtx.state === 'suspended' || this.audioCtx.state === 'interrupted') {
          this.audioCtx.resume().catch(console.error);
        }
      }
    });
  },

  initAudioContext() {
    if (this.initialized) return;

    const AC = window.AudioContext || window.webkitAudioContext;
    this.audioCtx = new AC();
    this.source = this.audioCtx.createMediaElementSource(this.audioEl);
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0.8;

    this.source.connect(this.analyser);
    this.analyser.connect(this.audioCtx.destination);
    this.initialized = true;
  },

  async play(channelId) {
    this.initAudioContext();

    if (this.audioCtx.state === 'suspended') {
      await this.audioCtx.resume();
    }

    this.currentChannel = channelId;
    this.audioEl.src = DiscoAPI.getStreamUrl(channelId);

    try {
      await this.audioEl.play();
      return true;
    } catch (err) {
      console.error('Playback failed:', err);
      return false;
    }
  },

  async switchChannel(channelId) {
    if (this.currentChannel === channelId) return;
    return this.play(channelId);
  },

  getAnalyser() {
    return this.analyser;
  }
};
