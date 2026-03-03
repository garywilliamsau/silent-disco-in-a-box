'use strict';

const Talkover = {
  ws: null,
  audioCtx: null,
  stream: null,
  processor: null,
  active: false,

  async start() {
    if (this.active) return;

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 44100 },
      });
    } catch (e) {
      console.error('Mic access denied:', e);
      return;
    }

    // Connect WebSocket for audio data
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.ws = new WebSocket(`${protocol}//${location.host}/api/talkover`);
    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = () => {
      // Set up audio capture
      const AC = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new AC({ sampleRate: 44100 });
      const source = this.audioCtx.createMediaStreamSource(this.stream);

      // ScriptProcessor for broad compatibility (including iOS Safari)
      this.processor = this.audioCtx.createScriptProcessor(4096, 1, 1);

      this.processor.onaudioprocess = (e) => {
        if (!this.active || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;

        const float32 = e.inputBuffer.getChannelData(0);
        // Convert Float32 → Int16 PCM
        const pcm = new Int16Array(float32.length);
        for (let i = 0; i < float32.length; i++) {
          pcm[i] = Math.max(-32768, Math.min(32767, Math.round(float32[i] * 32768)));
        }
        this.ws.send(pcm.buffer);
      };

      source.connect(this.processor);
      this.processor.connect(this.audioCtx.destination);
      this.active = true;
    };

    this.ws.onclose = () => { this.stop(); };
    this.ws.onerror = () => { this.stop(); };
  },

  stop() {
    this.active = false;

    if (this.processor) {
      this.processor.disconnect();
      this.processor = null;
    }
    if (this.audioCtx) {
      this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  },
};
