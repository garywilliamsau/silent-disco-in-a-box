'use strict';

const DiscoAPI = {
  ws: null,
  listeners: [],

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

  connectWebSocket() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.ws = new WebSocket(`${protocol}//${location.host}/api/ws`);

    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'update') {
        this.listeners.forEach(cb => cb(data.channels));
      }
    };

    this.ws.onclose = () => {
      setTimeout(() => this.connectWebSocket(), 3000);
    };

    this.ws.onerror = () => {
      this.ws.close();
    };
  },

  getStreamUrl(channelId) {
    return `/stream/${channelId}`;
  }
};
