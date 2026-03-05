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
#   red   → xhci-hcd.0        (USB controller 0)
#   green → xhci-hcd.1, 3-1/  (USB controller 1, port 1)
#   blue  → xhci-hcd.1, 3-2/  (USB controller 1, port 2)

CHANNEL="${1:-red}"

case "$CHANNEL" in
  red)   PORT_MATCH="xhci-hcd\.0" ;;
  green) PORT_MATCH="xhci-hcd\.1.*3-1/" ;;
  blue)  PORT_MATCH="xhci-hcd\.1.*3-2/" ;;
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

  echo "linein-capture: $CHANNEL → card $CARD, starting arecord" >&2
  # Run arecord; when it exits (device unplugged or error), loop back and retry
  arecord -D "hw:${CARD},0" -f S16_LE -r 44100 -c 1 -t raw --quiet 2>/dev/null
  sleep 1
done
