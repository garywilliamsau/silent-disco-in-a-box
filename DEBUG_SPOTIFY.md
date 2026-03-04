# Spotify Stuttering — Debug Log

## The Problem

Spotify Connect audio stutters badly. Playlist channels work perfectly.
Only the Spotify path is affected.

**Confirmed log evidence from raspotify-red:**
```
snd_pcm_writei failed with 'Broken Pipe'
ALSA underrun occurred
```

---

## The Audio Chain (Spotify Only)

```
iPhone (Spotify app)
  → Spotify Connect (wifi)
  → raspotify (librespot) on Pi
  → writes PCM to ALSA loopback hw:Loopback,0,N
  → [kernel loopback buffer]
  → arecord reads hw:Loopback,1,N
  → FIFO (/tmp/spotify-fifo-N)
  → dd (greedy drain, bs=65536)
  → stdout pipe
  → Liquidsoap input.external
  → Liquidsoap mix/switch
  → Icecast output
  → iPhone listener page (HLS stream)
```

This chain has MANY hand-off points. Playlists go direct disk → Liquidsoap → Icecast.
That's why playlists work and Spotify doesn't.

---

## What We've Tried (and Why Each Failed)

### Attempt 1: Reduce buffer from 2.0s to 0.5s
**Reasoning:** Thought the large buffer was causing the delay/stutter.
**Result:** Made stuttering worse — buffer too small, not enough headroom for the pipe jitter.
**Reverted to:** 1.5s buffer.

### Attempt 2: Conditional output.dummy with blank() fallback
**Reasoning:** Thought dual-consumer (output.dummy AND channel switch both reading
spotify_red simultaneously) was causing erratic pipe consumption.
**Implementation:**
```liquidsoap
ignore(output.dummy(..., switch(track_sensitive=false,
  [(fun() -> not use_spotify(), mksafe(spotify_src)),
   (fun() -> true, blank())])))
```
**Result:** DISASTER. `blank()` introduces a new clock. The Icecast output is on a
different clock. Clock conflict caused 15-second delays between tracks and
heavy stuttering. Much worse than before.
**Reverted.**

### Attempt 3: Conditional output.dummy WITHOUT blank() fallback
**Reasoning:** Keep the anti-dual-consumer logic but without the clock conflict.
When Spotify is active, output.dummy has no matching case and pauses (fallible=true).
**Implementation:**
```liquidsoap
red_use_spotify = ref(false)  # moved BEFORE output.dummy
ignore(output.dummy(id="dummy_spotify_red", fallible=true,
  switch(track_sensitive=false,
    [(fun() -> not red_use_spotify(), mksafe(spotify_red))])))
```
**Result:** Still stuttering. User reported "awful stuttering" — but this
turned out to partly be the audio.js watchdog timer (see below).
**Status:** Still deployed. May or may not be the right approach.

### Attempt 4 (unrelated): Audio.js watchdog timer
**Reasoning:** Added a 6-second watchdog to detect frozen streams (for iOS auto-sleep fix).
Checked if audio.currentTime was advancing.
**Result:** For live Icecast streams on iOS, currentTime stays at 0. Watchdog
detected this as "frozen" and reconnected every 6 seconds → awful stuttering.
**Fixed immediately:** Removed watchdog, kept only the visibilitychange reconnect.

---

## Current State of config/disco.liq (Spotify section)

```liquidsoap
# Per-channel Spotify toggle (declared before output.dummy)
red_use_spotify = ref(false)
green_use_spotify = ref(false)
blue_use_spotify = ref(false)

# Drain Spotify pipe only when Spotify is NOT active on that channel.
ignore(output.dummy(id="dummy_spotify_red",   fallible=true, switch(track_sensitive=false, [(fun() -> not red_use_spotify(),   mksafe(spotify_red))])))
ignore(output.dummy(id="dummy_spotify_green", fallible=true, switch(track_sensitive=false, [(fun() -> not green_use_spotify(), mksafe(spotify_green))])))
ignore(output.dummy(id="dummy_spotify_blue",  fallible=true, switch(track_sensitive=false, [(fun() -> not blue_use_spotify(),  mksafe(spotify_blue))])))
```

And in the channel sources:
```liquidsoap
red_spotify = switch(track_sensitive=false, transition_length=0.,
  [(fun() -> red_use_spotify(), mksafe(spotify_red))])
```

---

## What We Don't Know Yet

1. **Is the dual-consumer actually a problem?** The original code had a comment:
   `# Liquidsoap 2.x caches frames for shared sources so dual-consumer is safe.`
   If Liquidsoap 2.x really does cache frames for shared sources, the dual-consumer
   was NEVER the issue and we've been chasing a red herring.

2. **Is the FIFO/dd pipeline reliable?** `spotify-capture.sh` uses a FIFO with
   `timeout 0.15 dd bs=65536`. Between each 0.15s dd run, there may be timing
   gaps where the FIFO backs up → arecord stalls → loopback fills →
   raspotify gets EPIPE.

3. **Is arecord restarting mid-playback?** If arecord exits and restarts
   (for any reason), there's a gap where nothing reads from loopback,1.
   The loopback buffer fills in milliseconds. raspotify gets EPIPE.

4. **Clock mismatch?** `input.external` runs in a separate clock from the Icecast
   output. Liquidsoap bridges with a resampler buffer. Jitter in this bridge
   causes periodic glitches. `input.external.rawaudio` (preferred in LS 2.x)
   may handle this better.

---

## Root Cause Hypotheses (Best Guesses, In Order of Likelihood)

### Hypothesis 1: FIFO/dd timing gaps in spotify-capture.sh (MOST LIKELY)
The `timeout 0.15 dd bs=65536` loop has gaps between iterations. During each gap,
arecord's output isn't being forwarded. The FIFO fills slightly. If arecord blocks,
the ALSA loopback buffer fills, and raspotify gets EPIPE on the next write.

The fix would be making the capture script more robust — continuous piping without gaps.

### Hypothesis 2: arecord restart cycles
If arecord exits (even briefly), there's a gap. The `restart_on_error=true` in
Liquidsoap's input.external means Liquidsoap restarts the ENTIRE script.
During restart, the loopback fills → EPIPE.

### Hypothesis 3: input.external clock domain mismatch
`input.external` is deprecated and may have worse clock handling. Liquidsoap bridges
the external clock to the Icecast output clock via a resampler. Jitter = glitches.
Switching to `input.external.rawaudio` might fix this entirely.

### Hypothesis 4 (least likely): Dual-consumer was never the issue
The original simple `output.dummy(spotify_red)` was fine because LS 2.x caches frames.
The real problem was always elsewhere (FIFO/clock/arecord). Our fix was unnecessary.

---

## RESOLVED ✓

**Actual root cause: `linein_red` crash-loop burning CPU and stalling the Liquidsoap clock.**

`linein_red` was configured for card 3 (vc4hdmi1 — HDMI output, no capture support).
`arecord` exited immediately with code 1. Liquidsoap restarted it 40-50 times/second.
The log accumulated **1.4 million crash entries overnight**.

This burned enough CPU to cause `clock.generic: "We must catchup 38+ seconds!"` —
Liquidsoap's clock fell behind and then fast-forwarded. During catchup, Liquidsoap
drained the Spotify pipe faster than arecord could supply → buffer underrun → stutter.

**Why only linein_red?** Card numbers shifted when the vc4hdmi devices started
enumerating at cards 2 and 3, bumping the Red USB adapter from card 3 → card 1.
Green (card 4) and Blue (card 5) are on a different USB controller and were unaffected.

**Fixes applied (commits 2b76411, 89ff684):**
1. `spotify-capture.sh`: removed FIFO/dd, pipe arecord directly to stdout (simpler,
   eliminates fork/exec jitter as a contributing factor)
2. `linein-capture.sh`: sleep instead of crash when card not found — prevents
   crash-loops destroying the Liquidsoap clock if card numbers shift again
3. `disco.liq`: updated linein_red card 3 → card 1 (correct USB adapter)
4. `disco.liq`: reverted output.dummy to simple unconditional form

**After fix:** zero catchup messages, no stutter. Confirmed working.

---

## Plan for Tomorrow

### Step 1: READ THE FILES FIRST
Before touching anything:
- Read `config/spotify-capture.sh` in full — understand every line
- Read the raspotify service file(s) to check format/rate settings
- Check if raspotify and arecord use the same sample rate AND period size

### Step 2: Get log evidence
On the Pi during a Spotify stuttering episode:
```bash
sudo journalctl -u raspotify-red -f
sudo journalctl -u liquidsoap-disco -f
# Look for: arecord restarts, ALSA errors, input.external reconnects
```

Check if arecord is restarting:
```bash
watch -n 1 'ps aux | grep arecord'
```

### Step 3: Based on evidence, choose fix

**If FIFO/dd gaps are the issue:**
Rewrite spotify-capture.sh to use continuous piping without dd/timeout loop:
```bash
arecord -D hw:Loopback,1,N -f S16_LE -r 44100 -c 2 | cat
```
Simple and continuous. No FIFO, no dd, no gaps. Let the OS pipe buffer handle it.

**If arecord restarting is the issue:**
Wrap arecord in a tight restart loop inside the script (rather than relying on
Liquidsoap's restart_on_error which has more overhead):
```bash
while true; do
  arecord -D hw:Loopback,1,N -f S16_LE -r 44100 -c 2
  sleep 0.1
done | cat
```

**If clock domain is the issue:**
Switch from `input.external` to `input.external.rawaudio` in disco.liq.
This is the preferred API in Liquidsoap 2.x and may handle clock sync better.

**If dual-consumer was never the issue:**
Revert to the simple `output.dummy(spotify_red)` (original code) and focus
on FIFO/arecord fixes instead.

### Step 4: Test one change at a time
Do NOT make multiple changes simultaneously. Each change must be tested
independently with a full Spotify playback session (minimum 5 minutes,
include track changes).

---

## Things That Work Fine (Don't Break These)

- Playlist channels — always smooth
- Bluetooth input — works
- Line-In input — works
- Talkover — works
- Track metadata showing in admin + listener page — fixed this session
- iOS auto-sleep reconnect — fixed this session (visibilitychange handler)
- WiFi hotspot stays up with ethernet — fixed this session
- NAT for Spotify via ethernet — fixed this session

---

## Recent Commits (This Session)

```
038822e  fix: eliminate Spotify dual-consumer stuttering
572e132  fix: reconnect stream after iOS auto-sleep
520e41f  fix: remove watchdog timer that caused reconnect loop on iOS
a42ee77  feat: add CPU temp to admin dashboard header
cada0f7  feat: Spotify track metadata via librespot --onevent hook
db9b7d7  fix: use in-memory spotifyMeta for WebSocket broadcast
ad6daf1  fix: reduce Spotify input.external buffer to 1.5s
ddb2fa6  fix: remove captive portal DNS wildcard, add real upstream DNS
07f84ed  feat: NAT masquerade so hotspot clients get internet via ethernet
571a6fd  feat: keep WiFi hotspot up when ethernet connects
```
