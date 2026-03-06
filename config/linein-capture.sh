#!/bin/bash
# Silent Disco - Line-In Audio Capture
# Finds the ALSA card number by matching the USB port's sysfs path.
# Usage: linein-capture.sh <channel>  (red | green | blue)
#
# This script loops forever and is self-healing:
# - If the adapter is not plugged in, it waits and retries every 2s
# - If arecord exits (adapter unplugged mid-session), it loops back and waits
#   for the adapter to be replugged, then resumes automatically
#
# Port ↔ sysfs path (specific to this Pi):
#   All 3 adapters go through a USB hub on xhci-hcd.0
#   red   → hub port 1 (1-1.1)
#   green → hub port 2 (1-1.2)
#   blue  → hub port 3 (1-1.3)

CHANNEL="${1:-red}"

case "$CHANNEL" in
  red)   PORT_MATCH="/1-1\.1/" ;;
  green) PORT_MATCH="/1-1\.2/" ;;
  blue)  PORT_MATCH="/1-1\.3/" ;;
  *)
    echo "linein-capture: unknown channel '$CHANNEL'" >&2
    sleep infinity
    ;;
esac

while true; do
  # Find the card number whose sysfs path matches this channel's USB port
  CARD=""
  for card_dir in /sys/class/sound/card*/; do
    card_path=$(readlink -f "$card_dir" 2>/dev/null) || continue
    if echo "$card_path" | grep -qE "$PORT_MATCH"; then
      CARD=$(basename "$card_dir" | sed 's/card//')
      break
    fi
  done

  if [ -z "$CARD" ]; then
    # Adapter not found — may be unplugged. Wait and retry.
    sleep 2
    continue
  fi

  echo "linein-capture: $CHANNEL → card $CARD, starting arecord (boosted 20dB)" >&2
  # Run arecord piped through ffmpeg for volume boost, then output raw PCM
  arecord -D "hw:${CARD},0" -f S16_LE -r 44100 -c 1 -t raw --quiet 2>/dev/null \
    | ffmpeg -f s16le -ar 44100 -ac 1 -i pipe:0 \
        -af "volume=20dB" \
        -f s16le -ar 44100 -ac 1 pipe:1 \
        -loglevel quiet 2>/dev/null
  sleep 1
done
