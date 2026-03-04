#!/usr/bin/env python3
"""Non-blocking Spotify loopback capture with silence fallback.

When Spotify is playing, forwards real audio from ALSA loopback.
When Spotify is idle (nothing writing to hw:Loopback,0,N), outputs silence
at the correct real-time rate so Liquidsoap input.external buffer never drains.

Key design: arecord's stdout pipe is drained GREEDILY (all available bytes at
once) so the pipe never backs up. If the pipe backs up, arecord blocks on
write(), stops reading ALSA, the loopback kernel buffer overflows, and
Raspotify gets ALSA EIO (errno 5) — which is what causes "immediately paused".

Prevents both:
  - Liquidsoap 2.3 crash (Invalid_argument "option is None") from empty buffer
  - Raspotify ALSA EIO from loopback buffer overflow

Usage: spotify-capture.py <subdevice>  (Red=1, Green=2, Blue=3)
"""
import subprocess
import sys
import os
import select
import signal
import time

RATE = 44100
CHANNELS = 2
CHUNK_FRAMES = 1024
CHUNK_BYTES = CHUNK_FRAMES * CHANNELS * 2  # 4096 bytes ≈ 23ms — silence pacing
CHUNK_DURATION = CHUNK_FRAMES / RATE        # ~0.0232 s

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
                    # Greedily drain ALL data available in the pipe right now.
                    # Without this, the pipe backs up → arecord blocks on write()
                    # → arecord stops reading ALSA → loopback overflows → EIO.
                    data = os.read(fd, 65536)
                    if not data:
                        break
                    os.write(out_fd, data)
                    # Keep draining while more data is immediately available
                    while True:
                        more, _, _ = select.select([fd], [], [], 0)
                        if not more:
                            break
                        chunk = os.read(fd, 65536)
                        if not chunk:
                            break
                        os.write(out_fd, chunk)
                else:
                    # No data in timeout window — Spotify not playing
                    # Emit silence to keep Liquidsoap input.external buffer alive
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

        time.sleep(0.5)


if __name__ == '__main__':
    main()
