---
status: resolved
trigger: "Liquidsoap crashes on Spotify disconnect — new crash path in Muxer.muxer#generate_frame via fold_left"
created: 2026-03-05T00:00:00Z
updated: 2026-03-05T00:10:00Z
---

## Current Focus

hypothesis: RESOLVED
test: COMPLETE
expecting: VERIFIED
next_action: DONE — fix deployed, Spotify connect/disconnect tested on all 3 channels, no crash

## Symptoms

expected: Spotify disconnect switches channel back to playlist with no crash.
actual: Liquidsoap crashes on disconnect, restarts, all channels reset to track 1.
errors: |
  Mar 05 13:56:59: Error: Invalid_argument("option is None")
  Mar 05 13:56:59: Raised at Stdlib.invalid_arg
  Mar 05 13:56:59: Called from Stdlib__Option.get
  Mar 05 13:56:59: Called from Muxer.muxer#generate_frame.(fun) in file "src/core/operators/muxer.ml", line 136
  Mar 05 13:56:59: Called from Stdlib__List.fold_left in file "list.ml", line 121
  Mar 05 13:56:59: Called from Muxer.muxer#generate_frame in file "src/core/operators/muxer.ml", line 134
  Mar 05 13:56:59: Called from Source.operator#instrumented_generate_frame
  Mar 05 13:56:59: Called from Source.operator#before_streaming_cycle.(fun)
  Mar 05 13:56:59: Called from Source.operator#peek_frame
  Mar 05 13:56:59: Called from Source.operator#get_partial_frame
  Mar 05 13:56:59: Called from Output.output#generate_frame
reproduction: Press "Disconnect from Spotify" on any channel in the admin panel.
started: After Spotify connect feature was implemented. Previous fix addressed switch()/fallback() path but not add() path.

## Eliminated

- hypothesis: The crash is in switch()/fallback() generate_from_multiple_sources (previously fixed by transition_length=0.)
  evidence: transition_length=0. is deployed but the crash still happens. The problem is NOT that transition_length=0. wasn't applied — it WAS applied. The problem is that transition_length=0. does NOT prevent generate_from_multiple_sources from calling Option.get on the previous source's frame at line 647 when the source just became unavailable.
  timestamp: 2026-03-05

- hypothesis: The crash is in add()/Muxer itself (not in a source it calls)
  evidence: Full stack trace shows the actual Option.get crash is in Source.generate_from_multiple_sources at source.ml:647, not in muxer.ml. The Muxer and add() operators appear in the stack because they called get_partial_frame which recursively reached the failing switch/fallback.
  timestamp: 2026-03-05

- hypothesis: amplify() itself returns None frames
  evidence: The crash is in generate_from_multiple_sources (switch/fallback), not in amplify(). amplify() is not in the crash call path.
  timestamp: 2026-03-05

## Evidence

- timestamp: 2026-03-05
  checked: Full journalctl output showing complete stack trace
  found: The ACTUAL crash is at Source.generate_from_multiple_sources#generate_frame source.ml:647 (Option.get). The full call chain is Output → add()/Muxer → get_partial_frame on amplify(duck_volume, red_safe) → mksafe(red_source) [which IS a fallback!] → red_source fallback → one of the switches (red_spotify/red_linein/red_bt) → generate_from_multiple_sources:647 crashes.
  implication: THREE levels of generate_from_multiple_sources: (1) mksafe=fallback([red_source,blank]), (2) red_source=fallback([switches,queue,playlist]), (3) one of the switch() operators crashing at line 647 when it has NO active source and generate_from_multiple_sources tries Option.get on its frame.

- timestamp: 2026-03-05
  checked: The behavior of mksafe() in Liquidsoap
  found: mksafe() is implemented as fallback([source, blank()]) — it IS itself a generate_from_multiple_sources operator. This is why there are 3 levels of generate_from_multiple_sources in the stack (mksafe + red_source fallback + the switch).
  implication: When red_spotify switch becomes empty (use_spotify=false), the fallback (red_source) tries to transition and calls get_partial_frame on the now-empty red_spotify switch. The switch has no frame for its "previous source" and returns None. Option.get(None) = crash.

- timestamp: 2026-03-05
  checked: Why transition_length=0. does NOT prevent the crash
  found: transition_length=0. reduces crossfade time to zero but the code at source.ml:649 still calls get_partial_frame on the previous source as part of the transition detection logic — BEFORE checking if the transition is needed. The Option.get at line 647 is called unconditionally on the previous source frame regardless of transition_length.
  implication: The fix must make the switches' output always be valid (non-None) so that when they become "unavailable", they still return a valid (silent) frame. This means wrapping the switch outputs with mksafe() BEFORE passing them to the fallback.

- timestamp: 2026-03-05
  checked: Current switch definitions (deployed on Pi, confirmed identical to local)
  found: red_spotify = switch(track_sensitive=false, transition_length=0., [(fun() -> red_use_spotify(), mksafe(spotify_red))])  — the switch's INNER source is mksafe'd but the SWITCH ITSELF is not wrapped in mksafe() before being used in the fallback.
  implication: ROOT CAUSE CONFIRMED. The switches are fallible (they have no default case). When they become inactive, they return None. The fallback transitioning away from them tries to get their frame via Option.get and crashes.

## Resolution

root_cause: The triple-switch + fallback pattern (separate switch per input mode + outer fallback) causes generate_from_multiple_sources at source.ml:649 to call get_partial_frame on the outgoing switch when transitioning. Even with transition_length=0., the code still calls get_partial_frame before knowing whether a crossfade is needed. The switch (e.g. red_spotify) just lost its active source and has no frame, so Option.get(None) at line 647 crashes. transition_length=0. reduces crossfade TIME but does NOT prevent the unconditional get_partial_frame call on the previous source during transition detection.
fix: Replaced the triple-switch + outer-fallback architecture with a single switch() per channel. The single switch has all three input modes as cases plus a fun()->true default case pointing to a queue/playlist fallback. Because a fun()->true case always matches, the switch is NEVER in a "no active source" state, so generate_from_multiple_sources never calls Option.get on a None frame. red_queue_playlist/green_queue_playlist/blue_queue_playlist fallbacks handle the queue→playlist fallthrough.
verification: Tested Spotify set_spotify true then false (the previous crash trigger) on all three channels via telnet. Service remained running with no crash. Confirmed streaming (now_playing returned correct metadata) after each disconnect. No errors in journalctl for 2+ minutes post-restart.
files_changed: [config/disco.liq, GOTCHAS.md]
