---
created: 2026-03-03T23:41:19.342Z
resolved: 2026-03-04
title: Verify playlist order persists after reboot
area: general
files: []
---

## Problem

When a DJ manually sorts a channel's playlist into a specific order before a venue, that order needs to survive a Pi reboot. If Liquidsoap re-reads the playlist from disk and randomises or alphabetically sorts it on startup, the carefully prepared set order is lost.

Currently playlists are stored as MP3 files in `/home/<user>/music/{channel}/`. The order in which Liquidsoap picks them up depends on how the playlist source is configured (mode: `randomize`, `normal`, or `loop`).

## Solution

1. Check the current Liquidsoap `playlist()` mode for each channel — if `randomize`, it will never respect order.
2. If the user has manually reordered tracks in the admin panel, that order should be persisted (e.g. as a `.m3u` file or ordered filelist) so Liquidsoap can replay it in the same sequence after a reboot.
3. Consider saving an ordered `playlist.m3u` per channel whenever the user reorders tracks, and pointing Liquidsoap at that file instead of the directory.
4. Test: reorder tracks → reboot Pi → confirm playback resumes in the same order.
