'use strict';

const MediaSessionManager = {
  isSupported: 'mediaSession' in navigator,

  setMetadata({ title, artist, channelId }) {
    if (!this.isSupported) return;

    const artwork = channelId
      ? [{ src: `/api/channels/${channelId}/color.png`, sizes: '64x64', type: 'image/png' }]
      : [];

    navigator.mediaSession.metadata = new MediaMetadata({
      title: title || 'Silent Disco',
      artist: artist || 'Live',
      artwork,
    });
  },

  setupActions({ onPrevious, onNext }) {
    if (!this.isSupported) return;

    const trySet = (action, handler) => {
      try { navigator.mediaSession.setActionHandler(action, handler); }
      catch (e) { /* unsupported */ }
    };

    trySet('play', async () => {
      const audioEl = document.getElementById('audioPlayer');
      await audioEl.play();
      navigator.mediaSession.playbackState = 'playing';
    });

    trySet('pause', () => {
      document.getElementById('audioPlayer').pause();
      navigator.mediaSession.playbackState = 'paused';
    });

    trySet('previoustrack', onPrevious);
    trySet('nexttrack', onNext);
  },

  updatePlaybackState(playing) {
    if (!this.isSupported) return;
    navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  }
};
