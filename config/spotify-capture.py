#!/usr/bin/env python3
"""Non-blocking Spotify loopback capture with silence fallback.

When Spotify is playing, forwards real audio from ALSA loopback.
When Spotify is idle (nothing writing to hw:Loopback,0,N), outputs silence
at the correct real-time rate so Liquidsoap input.external buffer never drains.

This prevents Liquidsoap 2.3 crash (Invalid_argument "option is None") that
occurs when input.external has an empty buffer during set_spotify false transitions.

Usage: spotify-capture.py <subdevice>
  subdevice: 1=Red, 2=Green, 3=Blue
"""
import subprocess
import sys
import os
import select
import signal
import time

RATE = 44100
CHANNELS = 2
BYTES_PER_SAMPLE = 2  # S16LE
CHUNK_FRAMES = 1024
CHUNK_BYTES = CHUNK_FRAMES * CHANNELS * BYTES_PER_SAMPLE  # 4096 bytes = ~23ms
CHUNK_DURATION = CHUNK_FRAMES / RATE                      # ~0.0232 s

_current_proc = None


def _cleanup(signum, frame):
    global _current_proc
    if _current_proc is not None:
        try:
            _current_proc.kill()
        except Exception:
            pass
    sys.exit(0)


signal.signal(signal.SIGTERM, _cleanup)
signal.signal(signal.SIGINT, _cleanup)


def main():
    global _current_proc
    sub = sys.argv[1] if len(sys.argv) > 1 else "1"
    device = f"hw:Loopback,1,{sub}"
    silence = b'\x00' * CHUNK_BYTES
    out_fd = sys.stdout.fileno()

    while True:
        proc = None
        try:
            proc = subprocess.Popen(
                ['arecord', '-D', device, '-f', 'S16_LE',
                 '-r', str(RATE), '-c', str(CHANNELS),
                 '-t', 'raw', '--quiet'],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                bufsize=0,
            )
            _current_proc = proc
            fd = proc.stdout.fileno()

            while proc.poll() is None:
                ready, _, _ = select.select([fd], [], [], CHUNK_DURATION)
                if ready:
                    data = os.read(fd, CHUNK_BYTES)
                    if not data:
                        break  # EOF — arecord exited
                    os.write(out_fd, data)
                else:
                    # Timeout: Spotify not playing — emit silence to keep stream alive
                    os.write(out_fd, silence)

        except (OSError, IOError):
            pass
        finally:
            _current_proc = None
            if proc is not None:
                try:
                    proc.kill()
                    proc.wait(timeout=2)
                except Exception:
                    pass

        time.sleep(0.5)  # brief pause before reconnecting


if __name__ == '__main__':
    main()
