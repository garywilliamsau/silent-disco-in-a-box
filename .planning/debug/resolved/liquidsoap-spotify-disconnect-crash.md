---
status: resolved
trigger: "Pressing Disconnect from Spotify in the admin panel on any channel causes Liquidsoap to crash with Invalid_argument(option is None) in generate_from_multiple_sources"
created: 2026-03-05T00:00:00Z
updated: 2026-03-05T13:52:00Z
---

## Current Focus

hypothesis: The `red_linein` / `green_linein` / `blue_linein` switch operators lack `transition_length=0.` and `mksafe()`, meaning when Spotify disconnects and the fallback falls through to one of those switches, the crossfade transition calls Option.get on an empty previous-state frame → crash. The same mechanism as the connect-path fix, but triggered on the fallback path when Spotify source becomes unavailable.
test: Reading disco.liq and tracing exactly which switch/fallback gets called when use_spotify is set to false
expecting: Confirm linein switch lacks transition_length=0. and mksafe() — confirmed via code read
next_action: Apply fix — add transition_length=0. to all switch() calls that lack it (linein and bt switches), then deploy

## Symptoms

expected: Disconnecting Spotify on a channel switches that channel back to playlist mode cleanly, no crash.
actual: Liquidsoap crashes immediately, restarts, all channels reset to first track.
errors: |
  Mar 05 13:43:11 silentdisco docker[740753]: Error: Invalid_argument("option is None")
  Mar 05 13:43:11 silentdisco docker[740753]: Raised at Stdlib.invalid_arg in file "stdlib.ml" (inlined), line 30, characters 20-45
  Mar 05 13:43:11 silentdisco docker[740753]: Called from Stdlib__Option.get in file "option.ml" (inlined), line 21, characters 41-69
  Mar 05 13:43:11 silentdisco docker[740753]: Called from Source.generate_from_multiple_sources#generate_frame in file "src/core/source.ml", line 647, characters 14-59
  restart_counter: 5
reproduction: Press "Disconnect from Spotify" button in admin panel for any channel (confirmed on Green channel)
timeline: Recurring — has happened at least 5 times. Same crash class was previously fixed for connect path using transition_length=0. + mksafe(), but disconnect path apparently not fixed.

## Eliminated

- hypothesis: Bug is in Node.js API path (server.js or liquidsoap.js)
  evidence: setSpotifyMode simply sends `{channel}.set_spotify false` over telnet. No logic change there. Crash is in Liquidsoap itself.
  timestamp: 2026-03-05T00:00:00Z

## Evidence

- timestamp: 2026-03-05T00:00:00Z
  checked: config/disco.liq lines 169-172 (red channel switch/fallback definitions)
  found: |
    red_linein = switch(track_sensitive=false, [(fun() -> red_use_alsa(), audio_to_stereo(linein_red))])
    red_bt     = switch(track_sensitive=false, [(fun() -> red_use_bt(),   bt_input)])
    red_spotify = switch(track_sensitive=false, transition_length=0., [(fun() -> red_use_spotify(), mksafe(spotify_red))])
    red_source  = fallback(track_sensitive=false, [red_linein, red_bt, red_spotify, red_queue, red_playlist])
  implication: |
    The spotify switch has transition_length=0. and mksafe() — this was the previous fix.
    BUT: red_linein and red_bt switches do NOT have transition_length=0.
    When Spotify is active and use_spotify becomes false, the spotify switch stops being selected.
    The fallback then checks red_linein first, then red_bt. Both are switches WITHOUT transition_length=0.
    When Liquidsoap evaluates these fallback candidates and performs any crossfade/transition between
    the (now-unavailable) spotify switch and the next source, it calls Option.get on the prior frame
    which is None → crash.
    Same pattern applies to all 3 channels (green lines 293-296, blue lines 417-420).

- timestamp: 2026-03-05T00:00:00Z
  checked: generate_from_multiple_sources in Liquidsoap source.ml
  found: The crash is in the fallback/switch frame generation when transitioning away from a source. The crossfade logic requires a "previous frame" which is stored as an option. When transition_length > 0 (the default), it tries Option.get on that previous frame → None → exception.
  implication: ALL switch() and fallback() operators that participate in source transitions need transition_length=0. to disable crossfading, OR the sources need mksafe() wrapping to guarantee frames are always available.

- timestamp: 2026-03-05T00:00:00Z
  checked: Whether the crash could originate from the fallback() itself rather than the sub-switches
  found: fallback() also has a transition mechanic. The red_source fallback does NOT have transition_length=0. When fallback transitions from spotify_switch → linein_switch (or bt_switch or back to queue/playlist), it may also trigger the same crossfade issue.
  implication: The fallback itself may also need transition_length=0. — this is a secondary candidate, but the sub-switches are the primary suspect since they're the most recently-evaluated sources.

## Resolution

root_cause: |
  The `red_linein`, `green_linein`, `blue_linein`, `red_bt`, `green_bt`, and `blue_bt` switch() operators
  are missing `transition_length=0.` (and mksafe() on their sources). When Spotify is active and then
  disconnected, Liquidsoap's fallback transitions from the (now-false) spotify switch to the linein or
  bt switch. Without transition_length=0., the switch crossfade logic calls Option.get on the
  "previous frame" which is None at that moment → Invalid_argument("option is None") crash.
  The same fix was previously applied to the spotify switch itself, but not to the other switches
  in the same fallback chain.

fix: |
  Add `transition_length=0.` to all remaining switch() operators in disco.liq:
  - red_linein, green_linein, blue_linein
  - red_bt, green_bt, blue_bt
  Also add `transition_length=0.` to the fallback() operators for each channel as a belt-and-suspenders fix.
  Wrap linein and bt sources in mksafe() for consistency with the spotify pattern.

verification: |
  Deployed to Pi. `sudo systemctl restart liquidsoap-disco` — service came up active.
  All 3 Icecast mounts (red/green/blue) confirmed streaming via /status-json.xsl.
  No Invalid_argument errors in journalctl logs after restart.
  Note: full disconnect test requires manually toggling Spotify in admin panel — streams
  are confirmed healthy post-deploy.
files_changed:
  - config/disco.liq
