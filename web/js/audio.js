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

    // Auto-reconnect on stream errors or stalls
    this.audioEl.addEventListener('error', () => this._reconnect());
    this.audioEl.addEventListener('stalled', () => {
      console.warn('Stream stalled, reconnecting...');
      setTimeout(() => this._reconnect(), 3000);
    });
    this.audioEl.addEventListener('waiting', () => {
      this._waitTimer = setTimeout(() => this._reconnect(), 8000);
    });
    this.audioEl.addEventListener('playing', () => {
      clearTimeout(this._waitTimer);
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      // Resume AudioContext if suspended
      if (this.audioCtx && (this.audioCtx.state === 'suspended' || this.audioCtx.state === 'interrupted')) {
        this.audioCtx.resume().catch(console.error);
      }
      // iOS auto-sleep silently stalls the stream without firing any events.
      // Reconnect if the audio element is paused/ended/not-loaded when we wake.
      if (this.currentChannel && (this.audioEl.paused || this.audioEl.ended || this.audioEl.readyState < 3)) {
        console.warn('Stream stalled after screen wake, reconnecting...');
        this._reconnect();
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

  _reconnect() {
    console.warn('Stream reconnecting...');
    const src = this.audioEl.src;
    this.audioEl.src = '';
    setTimeout(() => {
      this.audioEl.src = src;
      this.audioEl.play().catch(() => {});
    }, 1000);
  },

  getAnalyser() {
    return this.analyser;
  }
};
