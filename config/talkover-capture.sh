#!/bin/bash
# Silent Disco - Talkover Audio Capture
# Reads raw S16LE mono 44100Hz PCM from a named pipe
# Opens FIFO read-write so cat blocks instead of getting EOF

FIFO=/tmp/disco-talkover.pcm
[ -p "$FIFO" ] || mkfifo "$FIFO"

# Open read-write (prevents EOF when no writer connected)
exec 3<>"$FIFO"
exec cat <&3
