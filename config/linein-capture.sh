#!/bin/bash
# Silent Disco - Line-In Audio Capture
# Reads from a USB audio adapter's capture device
# Usage: linein-capture.sh <card_number>
# Card numbers: check with 'arecord -l' on the Pi

CARD="${1:-3}"
exec arecord -D "hw:${CARD},0" -f S16_LE -r 44100 -c 1 -t raw --quiet 2>/dev/null
