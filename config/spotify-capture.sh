#!/bin/bash
# Silent Disco - Spotify Audio Capture
# Reads from ALSA loopback subdevice for a specific channel
# Usage: spotify-capture.sh <subdevice>
# Red=1, Green=2, Blue=3

SUB="${1:-1}"
exec arecord -D "hw:Loopback,1,$SUB" -f S16_LE -r 44100 -c 2 -t raw --quiet 2>/dev/null
