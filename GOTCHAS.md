# Silent Disco — Gotchas & Lessons Learned

Things that have bitten us. Check this list when making changes.

## Docker Volume Mounts
- **Docker creates directories for missing files.** If you add a new `-v /path/to/script.sh:/container/path.sh:ro` mount and the file doesn't exist on the host yet, Docker creates a directory at that path. Deploy the file BEFORE starting the container.
- **Fix:** Always `scp` the file to the Pi first, THEN restart the Docker container.

## Liquidsoap Syntax (v2.3.0)
- **No `begin` inside `if`.** `if x then begin ... end` causes a parse error. Use `if x then ... end` (no `begin`).
- **Inline `if` for simple returns.** `fun(_) -> if x() then "true" else "false" end` — don't wrap in `begin...end`.
- **`input.external` is deprecated** but works. `input.external.rawaudio` is preferred.
- **Mono sources need `audio_to_stereo()`** before mixing with stereo channels.
- **`add()` with `normalize=false`** for mixing talkover on top of music without volume normalisation.

## Browser Caching
- **Nginx caches JS/CSS for 7 days with `immutable`.** Every time you change a JS or CSS file, bump the `?v=N` query string in the HTML file that references it. Otherwise phones will keep the old version.
- **iOS Safari is aggressive.** Even `Cmd+Shift+R` doesn't always work. Use `?v=N` cache busting religiously.

## WebSocket
- **Two WebSocketServer instances on the same HTTP server need `noServer` mode.** Use `server.on('upgrade')` to route by URL path. The `path` option on `WebSocketServer` doesn't work reliably with multiple instances.
- **HTTPS WebSocket (`wss://`) needs long timeouts.** Set `proxy_read_timeout 3600s` and `proxy_send_timeout 3600s` in the nginx `/api/` block for BOTH the HTTP and HTTPS server blocks.
- **WebSocket data from the broadcast must include ALL mode flags.** If you add a new mode (like `alsaMode`), add it to BOTH the REST `/api/channels` endpoint AND the `broadcastNowPlaying()` function. Missing it from the broadcast means the listener portal won't see it.

## iOS / Safari
- **`getUserMedia` requires HTTPS.** Mic access (talkover) only works over `https://`. Serve the site on both HTTP and HTTPS — HTTP for normal listeners, HTTPS for admin mic access.
- **`data:` URIs don't work for MediaSession artwork on iOS.** Use real HTTP URLs (we serve `/api/channels/:id/color.png`).
- **Web Audio API analyser returns zeroes for Icecast streams on iOS.** The `createMediaElementSource` doesn't get frequency data from streaming audio. Use server-side energy analysis instead.
- **Audio streams stall on iOS.** Add reconnect handlers for `stalled`, `waiting`, and `error` events on the `<audio>` element.

## Bluetooth
- **Pi 4/5 built-in BT shares radio with WiFi.** Causes audio dropouts. Always use a USB BT dongle and disable built-in BT (`hciconfig hci0 down`).
- **`bt-agent` and `bluetoothctl agent` don't work non-interactively.** Use the Python D-Bus agent (`bt-auto-agent.py`) for auto-accept pairing.
- **PulseAudio system mode fails with BlueZ 5.82 on Trixie.** Use `bluealsa` instead for BT audio routing.
- **bluealsa-aplay outputs to ALSA playback, not capture.** Need an ALSA loopback (`snd-aloop`) to bridge BT audio to Liquidsoap.

## USB Audio Adapters
- **KT USB Audio adapters don't enumerate without a cable plugged in.** They need something connected to their input jack to be detected by the OS.
- **USB 3.0 (blue) ports don't work for USB 2.0 audio adapters.** Use USB 2.0 (black) ports. BT dongles work fine in USB 3.0 ports though.
- **Card numbers are not stable across reboots.** They depend on enumeration order. If adapters are always in the same ports, numbers stay the same.

## Raspberry Pi OS (Trixie)
- **Liquidsoap 2.3.2 Debian package segfaults on Trixie arm64.** The RPi-modified ffmpeg (`libavfilter10 +rpt1`) is incompatible. Use Docker with `savonet/liquidsoap:v2.3.0` image instead.
- **Custom Docker image needed.** The official Liquidsoap image doesn't include `alsa-utils` (no `arecord`). Build a custom image with `apt-get install alsa-utils`.
- **NetworkManager fights hostapd for wlan0.** Add `unmanaged-devices=interface-name:wlan0` to `/etc/NetworkManager/conf.d/99-disco.conf`.
- **WiFi hotspot needs rfkill + static IP before hostapd starts.** The `disco-network.service` handles this, but check it's enabled after installs.

## Talkover / Voiceover
- **FIFO blocks in Docker differently.** Open the FIFO read-write (`exec 3<>"$FIFO"; exec cat <&3`) to prevent EOF loop that burns CPU.
- **Streaming latency means duck timing matters.** Duck music 2.5s before sending voice audio, keep ducked 8s after voice ends.
- **Record-then-send is better than real-time streaming.** Buffer the entire voice message locally, then send START → delay → audio → delay → STOP for precise ducking.

## Deploy Script
- **Paths with spaces break shell scripts.** Always quote file paths. The deploy script uses functions with proper quoting.
- **SSH host keys change on new SD cards / reboots.** Run `ssh-keygen -R <ip>` before connecting to a reimaged Pi.

## Raspotify / Spotify Connect
- **Requires internet.** Spotify Connect needs internet to authenticate and stream. Everything else works offline.
- **Spotify oEmbed API for metadata.** No auth needed, but only works with internet. Fails gracefully without it.
- **Multiple instances need unique zeroconf ports.** Each raspotify instance gets its own port (4071, 4072, 4073).
- **Use librespot `--onevent` for track metadata.** Liquidsoap `on_metadata` never fires for `input.external` raw PCM — there is no embedded metadata in the pipe. Use the librespot event hook to POST track info to the Node.js API instead.
- **`blank()` in Liquidsoap output.dummy creates a new clock.** If you use `blank()` as a fallback inside an `output.dummy` switch, it creates a separate clock that conflicts with the Icecast output clock → 15-second delays between tracks and heavy stuttering. Never use `blank()` inside `output.dummy`.
- **Spotify stuttering root cause was `linein_red` crash-looping.** A wrong ALSA card number (card 3 = HDMI, no capture) caused arecord to exit immediately with code 1. Liquidsoap restarted it 40-50 times/second, generating 1.4M log entries and stalling the clock. `clock.generic: "We must catchup 38s"` during Spotify playback = fast-forward drains Spotify pipe faster than arecord can fill → buffer underrun → stutter. Fix: `linein-capture.sh` now sleeps instead of crashing when card not found. See `DEBUG_SPOTIFY.md`.

## iOS / Safari (additions)
- **Live stream `currentTime` stays at 0 on iOS.** For Icecast streams (audio/mpeg), iOS Safari does not advance `currentTime` like a file. Any watchdog that checks `currentTime` to detect a frozen stream will fire immediately and cause a reconnect loop every N seconds. Do not use `currentTime` to detect stream health on iOS.
- **Auto-sleep silently stalls streams.** Manual lock keeps audio alive; auto-sleep (screen timeout) silently pauses the stream without firing `error`, `stalled`, or `waiting` events. Fix: on `visibilitychange`, check `audioEl.paused || audioEl.ended || audioEl.readyState < 3` and reconnect.

## NetworkManager / WiFi Hotspot
- **NM soft-blocks WiFi radio when ethernet gets DHCP.** On Pi OS Trixie with NetworkManager, plugging into a router causes NM to soft-block the WiFi radio, killing the hotspot. Fix: NM dispatcher script at `/etc/NetworkManager/dispatcher.d/10-keep-wifi-up` that runs `nmcli radio wifi on` when eth0 comes up.
- **dnsmasq captive portal wildcard blocks internet DNS.** `address=/#/192.168.4.1` + `no-resolv` redirects ALL DNS queries to the Pi, breaking Spotify and everything else. Remove both; use `server=1.1.1.1` and `server=8.8.8.8` instead.
