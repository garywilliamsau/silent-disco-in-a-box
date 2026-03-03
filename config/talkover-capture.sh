#!/bin/bash
# Silent Disco - Talkover Audio Capture
# Reads raw S16LE mono 44100Hz PCM from a named pipe
# Used by Liquidsoap input.external for voice-over-all-channels

FIFO=/tmp/disco-talkover.pcm

# Create FIFO if it doesn't exist
[ -p "$FIFO" ] || mkfifo "$FIFO"

# Read from FIFO forever — blocks when empty (Liquidsoap sees silence via mksafe)
exec cat "$FIFO"
