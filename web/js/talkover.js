'use strict';

const Talkover = {
  ws: null,
  audioCtx: null,
  stream: null,
  processor: null,
  source: null,
  active: false,
  ready: false,
  pending: false,

  async _setup() {
    if (this.ready) return true;
    if (this.pending) return false;
    this.pending = true;
    console.log('[talkover] setting up mic...');

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 44100 },
      });
    } catch (e) {
      console.error('[talkover] Mic access denied:', e);
      this.pending = false;
      return false;
    }

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.ws = new WebSocket(`${protocol}//${location.host}/api/talkover`);
    this.ws.binaryType = 'arraybuffer';

    return new Promise((resolve) => {
      this.ws.onopen = () => {
        console.log('[talkover] WebSocket connected');
        const AC = window.AudioContext || window.webkitAudioContext;
        this.audioCtx = new AC({ sampleRate: 44100 });
        this.source = this.audioCtx.createMediaStreamSource(this.stream);
        this.processor = this.audioCtx.createScriptProcessor(4096, 1, 1);

        this.processor.onaudioprocess = (e) => {
          if (!this.active || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
          const float32 = e.inputBuffer.getChannelData(0);
          const pcm = new Int16Array(float32.length);
          for (let i = 0; i < float32.length; i++) {
            pcm[i] = Math.max(-32768, Math.min(32767, Math.round(float32[i] * 32768)));
          }
          this.ws.send(pcm.buffer);
        };

        this.source.connect(this.processor);
        this.processor.connect(this.audioCtx.destination);
        this.ready = true;
        this.pending = false;
        resolve(true);
      };

      this.ws.onclose = (e) => {
        console.log('[talkover] WebSocket closed:', e.code, e.reason);
        this.ready = false;
        this.pending = false;
        resolve(false);
      };

      this.ws.onerror = () => {
        this.ws.close();
      };
    });
  },

  async start() {
    this.active = true;
    if (!this.ready) {
      const ok = await this._setup();
      if (!ok) { this.active = false; return; }
    }
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }
  },

  stop() {
    this.active = false;
  },
};
