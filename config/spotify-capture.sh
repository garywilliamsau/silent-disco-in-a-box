#!/bin/bash
# spotify-capture.sh — ALSA loopback capture, direct pipe to stdout
#
# Previous approach (FIFO + dd count=1) caused stuttering:
# The fork/exec overhead between dd calls (~5-20ms each) allowed Docker
# scheduling jitter to create gaps >100ms where nothing read the FIFO.
# arecord blocked on FIFO write → stopped reading ALSA → loopback capture
# buffer filled to 14678 frames (332ms) → playback avail dropped to 176
# frames (4ms from EPIPE) → raspotify snd_pcm_writei "Broken Pipe" → stutter.
#
# Fix: arecord writes directly to stdout. No FIFO, no dd, no fork overhead.
# The ALSA loopback outputs silence when nothing is playing to it, so no
# silence injection is needed.

SUB="${1:-1}"
DEVICE="hw:Loopback,1,$SUB"

while true; do
    arecord -D "$DEVICE" -f S16_LE -r 44100 -c 2 -t raw --quiet
    sleep 0.1
done
