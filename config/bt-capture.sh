#!/bin/bash
# Silent Disco - Bluetooth Audio Capture
# Reads BT audio from ALSA loopback where bluealsa-aplay writes it.
# Flow: iPhone A2DP → bluealsa → bluealsa-aplay → hw:Loopback,0,0 → hw:Loopback,1,0 → here
# Streams raw S16LE stereo 44100Hz PCM to stdout for Liquidsoap input.external.

exec arecord -D hw:Loopback,1,0 -f S16_LE -r 44100 -c 2 -t raw --quiet
