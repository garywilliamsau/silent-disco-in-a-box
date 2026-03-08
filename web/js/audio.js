'use strict';

const AudioManager = {
  audioEl: null,
  audioCtx: null,
  source: null,
  analyser: null,
  currentChannel: null,
  initialized: false,
  _reconnecting: false,
  _stalledTimer: null,
  _waitTimer: null,
  _failCount: 0,
  _onStreamStatus: null,

  onStreamStatus(cb) { this._onStreamStatus = cb; },

  _emitStatus(status) {
    if (this._onStreamStatus) this._onStreamStatus(status, this._failCount);
  },

  init() {
    this.audioEl = document.getElementById('audioPlayer');

    this.audioEl.addEventListener('error', () => {
      if (this.currentChannel) this._reconnect();
    });

    this.audioEl.addEventListener('stalled', () => {
      clearTimeout(this._stalledTimer);
      this._stalledTimer = setTimeout(() => this._reconnect(), 3000);
    });

    this.audioEl.addEventListener('waiting', () => {
      clearTimeout(this._waitTimer);
      this._waitTimer = setTimeout(() => this._reconnect(), 8000);
    });

    // Playback resumed — cancel any pending reconnect timers.
    this.audioEl.addEventListener('playing', () => {
      clearTimeout(this._stalledTimer);
      clearTimeout(this._waitTimer);
      this._stalledTimer = null;
      this._waitTimer = null;
      if (this._reconnecting) {
        this._reconnecting = false;
        this._emitStatus('recovered');
      }
      this._failCount = 0;
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      if (this.audioCtx && (this.audioCtx.state === 'suspended' || this.audioCtx.state === 'interrupted')) {
        this.audioCtx.resume().catch(console.error);
      }
      // iOS auto-sleep silently stalls the stream without firing any events.
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
    // Cancel any pending reconnect timers so they don't fire and
    // corrupt state after we've already switched to a new channel.
    clearTimeout(this._stalledTimer);
    clearTimeout(this._waitTimer);
    this._stalledTimer = null;
    this._waitTimer = null;
    this._reconnecting = false;
    this._failCount = 0;

    this.initAudioContext();

    // Always resume — on iOS the AudioContext can silently suspend.
    if (this.audioCtx.state !== 'running') {
      await this.audioCtx.resume();
    }

    // Pause before switching src — ensures the browser closes the existing
    // Icecast HTTP connection before opening a new one. Without this, old
    // connections linger and inflate the listener count.
    this.audioEl.pause();
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
    if (channelId !== this.currentChannel) {
      // Switching to a different channel — always reconnect.
      return this.play(channelId);
    }
    // Same channel tap — only reconnect if audio has actually stalled.
    // This avoids unnecessary re-connections (which restart from a buffer
    // boundary, making songs sound like they're restarting from the top).
    if (this.audioEl.paused || this.audioEl.ended || this.audioEl.readyState < 3) {
      console.warn('Same channel tap, audio stalled — reconnecting');
      return this.play(channelId);
    }
    // Playing fine — nothing to do.
  },

  _reconnect() {
    // Guard: prevent concurrent reconnects.
    // NOTE: only call _reconnect() from user-gesture handlers (tap, visibilitychange).
    // Do NOT call it from auto-timers on iOS — play() without a gesture gets blocked
    // and leaves the AudioContext in a broken state.
    if (this._reconnecting || !this.currentChannel) return;
    this._reconnecting = true;
    this._failCount++;
    clearTimeout(this._stalledTimer);
    clearTimeout(this._waitTimer);
    console.warn('Stream reconnecting...');

    this._emitStatus(this._failCount >= 3 ? 'failed' : 'reconnecting');

    this.audioEl.src = DiscoAPI.getStreamUrl(this.currentChannel);
    this.audioEl.play()
      .catch(console.error)
      .finally(() => { this._reconnecting = false; });
  },

  retryNow() {
    this._failCount = 0;
    this._reconnecting = false;
    if (this.currentChannel) {
      this._reconnect();
    }
  },

  getAnalyser() {
    return this.analyser;
  }
};
