#!/bin/bash
# Silent Disco - Line-In Audio Capture
# Reads from a USB audio adapter's capture device
# Usage: linein-capture.sh <card_number>
# Card numbers: check with 'arecord -l' on the Pi

CARD="${1:-1}"

# If the card doesn't exist or doesn't support capture, sleep instead of
# crash-looping. A crash-loop burns CPU and causes Liquidsoap's clock to
# fall behind, triggering "catchup N seconds" which disrupts all audio.
if ! arecord -l 2>/dev/null | grep -q "^card ${CARD}:"; then
  echo "linein-capture: card ${CARD} not found, sleeping until restart" >&2
  sleep infinity
fi

exec arecord -D "hw:${CARD},0" -f S16_LE -r 44100 -c 1 -t raw --quiet 2>/dev/null
