#!/bin/bash
# Silent Disco - Bluetooth Audio Capture
# Finds a Bluetooth A2DP source in PulseAudio and streams raw PCM to stdout
# Used by Liquidsoap input.external
# Exits with error if no BT source found (Liquidsoap will restart the process)

export PULSE_SERVER=unix:/run/pulse/native

SRC=$(pactl list short sources 2>/dev/null | grep -i 'bluez_source' | head -1 | awk '{print $2}')

if [ -z "$SRC" ]; then
  sleep 2
  exit 1
fi

exec parecord --server=unix:/run/pulse/native \
  --device="$SRC" \
  --format=s16le \
  --rate=44100 \
  --channels=2 \
  --raw 2>/dev/null
