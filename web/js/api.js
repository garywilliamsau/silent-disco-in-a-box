'use strict';

const DiscoAPI = {
  ws: null,
  listeners: [],
  energyListeners: [],

  async getConfig() {
    const res = await fetch('/api/config');
    return res.json();
  },

  async getChannels() {
    const res = await fetch('/api/channels');
    return res.json();
  },

  onUpdate(callback) {
    this.listeners.push(callback);
  },

  onEnergy(callback) {
    this.energyListeners.push(callback);
  },

  connectWebSocket() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.ws = new WebSocket(`${protocol}//${location.host}/api/ws`);

    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'update') {
        this.listeners.forEach(cb => cb(data.channels));
      } else if (data.type === 'energy') {
        this.energyListeners.forEach(cb => cb(data.energy, data.beats || {}));
      }
    };

    this.ws.onopen = () => {
      // Re-announce channel after reconnect so server restores our listener slot
      if (this._listeningChannel) {
        this.ws.send(JSON.stringify({ type: 'listen', channel: this._listeningChannel }));
      }
    };

    this.ws.onclose = () => {
      setTimeout(() => this.connectWebSocket(), 3000);
    };

    this.ws.onerror = () => {
      this.ws.close();
    };
  },

  sendListening(channelId) {
    this._listeningChannel = channelId;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'listen', channel: channelId }));
    }
  },

  getStreamUrl(channelId) {
    return `/stream/${channelId}`;
  }
};
