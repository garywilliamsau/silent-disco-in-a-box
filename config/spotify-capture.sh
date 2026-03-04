#!/bin/bash
# Silent Disco - Spotify Audio Capture
# Delegates to Python for non-blocking capture with silence fallback.
# The Python script prevents Liquidsoap crashes when Spotify is idle
# by outputting silence instead of blocking on the empty ALSA loopback.
# Usage: spotify-capture.sh <subdevice>  (Red=1, Green=2, Blue=3)
exec python3 /opt/disco/config/spotify-capture.py "$@"
