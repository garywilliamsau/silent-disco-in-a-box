'use strict';

const MediaSessionManager = {
  isSupported: 'mediaSession' in navigator,

  setMetadata({ title, artist, artworkUrl }) {
    if (!this.isSupported) return;

    navigator.mediaSession.metadata = new MediaMetadata({
      title: title || 'Silent Disco',
      artist: artist || 'Live',
      artwork: artworkUrl ? [
        { src: artworkUrl, sizes: '96x96', type: 'image/jpeg' },
        { src: artworkUrl, sizes: '512x512', type: 'image/jpeg' },
      ] : [],
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
