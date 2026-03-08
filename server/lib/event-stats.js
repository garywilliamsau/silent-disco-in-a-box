'use strict';

const fs = require('fs');
const path = require('path');

const STATS_DIR = path.join(__dirname, '..', '..', 'data');
const STATS_FILE = path.join(STATS_DIR, 'event-stats.jsonl');
const TRACKS_FILE = path.join(STATS_DIR, 'event-tracks.json');
const SAMPLE_INTERVAL_MS = 30000; // 30 seconds

class EventStats {
  constructor(channels) {
    this.channels = channels;
    this._timer = null;
    this._getListeners = null;
    this._trackLog = this._loadTrackLog();
    this._lastTrack = {};  // { channelId: { title, artist } }
    fs.mkdirSync(STATS_DIR, { recursive: true });
  }

  // Set a callback that returns { channelId: listenerCount }
  setListenerSource(fn) {
    this._getListeners = fn;
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._sample(), SAMPLE_INTERVAL_MS);
    console.log('[event-stats] collector started');
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  _sample() {
    if (!this._getListeners) return;
    const listeners = this._getListeners();
    const entry = { ts: Date.now() };
    for (const ch of this.channels) {
      entry[ch] = listeners[ch] || 0;
    }
    try {
      fs.appendFileSync(STATS_FILE, JSON.stringify(entry) + '\n');
    } catch (e) {
      console.warn('[event-stats] write error:', e.message);
    }
  }

  // Call when a track changes on a channel
  recordTrackChange(channelId, nowPlaying) {
    if (!nowPlaying || !nowPlaying.title) return;

    const key = `${channelId}:${nowPlaying.title}:${nowPlaying.artist || ''}`;
    const last = this._lastTrack[channelId];
    const lastKey = last ? `${channelId}:${last.title}:${last.artist || ''}` : null;

    if (key === lastKey) return; // same track, no change

    this._lastTrack[channelId] = { title: nowPlaying.title, artist: nowPlaying.artist || '' };

    const trackKey = `${nowPlaying.title}\t${nowPlaying.artist || ''}`;
    if (!this._trackLog[trackKey]) {
      this._trackLog[trackKey] = { title: nowPlaying.title, artist: nowPlaying.artist || '', plays: 0, lastPlayed: 0 };
    }
    this._trackLog[trackKey].plays++;
    this._trackLog[trackKey].lastPlayed = Date.now();

    this._saveTrackLog();
  }

  _loadTrackLog() {
    try {
      const raw = fs.readFileSync(TRACKS_FILE, 'utf8');
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  _saveTrackLog() {
    try {
      fs.writeFileSync(TRACKS_FILE, JSON.stringify(this._trackLog, null, 2));
    } catch (e) {
      console.warn('[event-stats] track log write error:', e.message);
    }
  }

  // Generate summary from stored data
  getSummary() {
    // Read listener samples
    let samples = [];
    try {
      const raw = fs.readFileSync(STATS_FILE, 'utf8');
      samples = raw.trim().split('\n').filter(Boolean).map(line => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);
    } catch {
      // No data yet
    }

    if (samples.length === 0) {
      return {
        totalSamples: 0,
        duration: 0,
        peakListeners: 0,
        peakTime: null,
        peakChannel: null,
        channelStats: {},
        listenerMinutes: 0,
        timeline: [],
        topTracks: [],
      };
    }

    const intervalMinutes = SAMPLE_INTERVAL_MS / 60000;
    let peakListeners = 0;
    let peakTime = null;
    const channelTotals = {};
    const channelPeaks = {};

    for (const ch of this.channels) {
      channelTotals[ch] = 0;
      channelPeaks[ch] = 0;
    }

    for (const s of samples) {
      let total = 0;
      for (const ch of this.channels) {
        const count = s[ch] || 0;
        total += count;
        channelTotals[ch] += count;
        if (count > channelPeaks[ch]) channelPeaks[ch] = count;
      }
      if (total > peakListeners) {
        peakListeners = total;
        peakTime = s.ts;
      }
    }

    // Most popular channel by listener-minutes
    let peakChannel = null;
    let peakChannelMinutes = 0;
    const channelStats = {};
    for (const ch of this.channels) {
      const minutes = Math.round(channelTotals[ch] * intervalMinutes);
      channelStats[ch] = { listenerMinutes: minutes, peakListeners: channelPeaks[ch] };
      if (minutes > peakChannelMinutes) {
        peakChannelMinutes = minutes;
        peakChannel = ch;
      }
    }

    // Total listener-minutes (sum all channels)
    let totalListenerMinutes = 0;
    for (const ch of this.channels) {
      totalListenerMinutes += channelStats[ch].listenerMinutes;
    }

    // Timeline: downsample to ~60 points max for the chart
    const maxPoints = 60;
    const step = Math.max(1, Math.floor(samples.length / maxPoints));
    const timeline = [];
    for (let i = 0; i < samples.length; i += step) {
      const s = samples[i];
      let total = 0;
      const perChannel = {};
      for (const ch of this.channels) {
        const count = s[ch] || 0;
        perChannel[ch] = count;
        total += count;
      }
      timeline.push({ ts: s.ts, total, ...perChannel });
    }

    // Top tracks
    const trackLog = this._loadTrackLog();
    const topTracks = Object.values(trackLog)
      .sort((a, b) => b.plays - a.plays)
      .slice(0, 10);

    const firstTs = samples[0].ts;
    const lastTs = samples[samples.length - 1].ts;
    const durationMinutes = Math.round((lastTs - firstTs) / 60000);

    return {
      totalSamples: samples.length,
      duration: durationMinutes,
      peakListeners,
      peakTime,
      peakChannel,
      channelStats,
      listenerMinutes: totalListenerMinutes,
      listenerHours: +(totalListenerMinutes / 60).toFixed(1),
      timeline,
      topTracks,
    };
  }

  // Reset stats for a new event
  reset() {
    try { fs.unlinkSync(STATS_FILE); } catch { /* ok */ }
    try { fs.unlinkSync(TRACKS_FILE); } catch { /* ok */ }
    this._trackLog = {};
    this._lastTrack = {};
  }
}

module.exports = EventStats;
