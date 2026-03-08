# Plan: Channel Playlists

## Overview

Add the ability to create named playlists from music stored on the Pi and assign any playlist to any channel. Currently each channel has a single, tightly-coupled music directory. This plan decouples playlists from channels so playlists become a shared, reusable resource.

---

## Architecture Changes

### Current State
```
Channel (red) ──owns──> /home/pi/music/red/ (playlist.json + playlist.m3u + mp3s)
Channel (green) ──owns──> /home/pi/music/green/
Channel (blue) ──owns──> /home/pi/music/blue/
```

### Target State
```
Playlists (shared library):
  /home/pi/music/library/       ← all uploaded music files live here
  /home/pi/music/playlists/     ← playlist definitions (JSON)

Channel (red)   ──selects──> "Party Bangers" playlist
Channel (green) ──selects──> "Chill Vibes" playlist
Channel (blue)  ──selects──> "Party Bangers" playlist  (same playlist, two channels)
```

A shared music library holds all uploaded files. Playlists are named lists of tracks from the library. Each channel selects which playlist to use. Multiple channels can use the same playlist.

---

## Implementation Steps

### Step 1: Music Library (`server/lib/library.js` — new file)

Create a shared music library module that manages all uploaded music in a single directory.

- **Storage**: `/home/pi/music/library/` (single flat directory for all music)
- **Catalog file**: `/home/pi/music/library/catalog.json` — array of `{ filename, title, artist, album, duration, uploadedAt }`
- **Functions**:
  - `getLibraryPath()` — returns library directory path
  - `scanLibrary()` — scans directory, extracts metadata, writes/updates `catalog.json`
  - `getCatalog()` — returns cached catalog (scans on first call)
  - `addFiles(files)` — moves uploaded files into library, extracts metadata, appends to catalog
  - `removeFile(filename)` — deletes file + removes from catalog + removes from any playlists that reference it
  - `getAlbumArt(filename)` — extracts embedded cover art (reuse existing logic from `playlist.js`)

### Step 2: Playlist Manager (`server/lib/playlist-manager.js` — new file)

Manage named playlists as JSON files in `/home/pi/music/playlists/`.

- **Playlist file format** (`/home/pi/music/playlists/{id}.json`):
  ```json
  {
    "id": "party-bangers",
    "name": "Party Bangers",
    "createdAt": "2026-03-08T...",
    "tracks": ["song1.mp3", "song2.mp3", "song3.mp3"]
  }
  ```
- **Functions**:
  - `listPlaylists()` — returns all playlists (id, name, track count, total duration)
  - `getPlaylist(id)` — returns full playlist with track metadata from library catalog
  - `createPlaylist(name, trackFilenames)` — creates new playlist JSON, returns it
  - `updatePlaylist(id, { name?, tracks? })` — update name or track list
  - `deletePlaylist(id)` — removes playlist file; unassigns from any channels using it
  - `generateM3U(id)` — writes an M3U file with full paths to library files (for Liquidsoap)
  - `removeTrackFromAll(filename)` — called when a library file is deleted

### Step 3: Channel-Playlist Assignment (`server/lib/channel-playlists.js` — new file)

Manage which playlist is assigned to each channel.

- **Assignment file**: `/home/pi/music/assignments.json`
  ```json
  {
    "red": "party-bangers",
    "green": "chill-vibes",
    "blue": null
  }
  ```
- **Functions**:
  - `getAssignments()` — returns current channel→playlist mapping
  - `assignPlaylist(channelId, playlistId)` — assigns playlist to channel, generates M3U, triggers Liquidsoap reload
  - `unassignPlaylist(channelId)` — removes assignment, channel plays silence/fallback
  - `getChannelPlaylist(channelId)` — returns the assigned playlist details

- **Liquidsoap integration**: When a playlist is assigned, generate an M3U at a channel-specific path (e.g., `/home/pi/music/channel-red.m3u`) that Liquidsoap watches. This keeps the Liquidsoap config changes minimal — just change the M3U paths.

### Step 4: API Endpoints (`server/index.js` — modify)

Add new REST endpoints under `/api/`:

**Library endpoints:**
- `GET /api/library` — list all tracks in library with metadata
- `POST /api/library/upload` — upload files to shared library (multipart, reuse multer config)
- `DELETE /api/library/:filename` — delete track from library (cascades to playlists)
- `GET /api/library/album-art/:filename` — serve album art

**Playlist endpoints:**
- `GET /api/playlists` — list all playlists (summary)
- `POST /api/playlists` — create playlist `{ name, tracks: [filenames] }`
- `GET /api/playlists/:id` — get playlist details with full track metadata
- `PUT /api/playlists/:id` — update playlist (rename, reorder tracks, add/remove tracks)
- `DELETE /api/playlists/:id` — delete playlist

**Channel assignment endpoints:**
- `GET /api/channels/:id/playlist` — get assigned playlist for channel
- `PUT /api/channels/:id/playlist` — assign playlist `{ playlistId }` or `{ playlistId: null }` to unassign

**Backward compatibility:**
- Keep existing `GET /api/channels/:id/tracks` working — returns tracks from the assigned playlist
- Keep existing upload/delete/move endpoints working by redirecting to library + updating the assigned playlist
- Mark old endpoints as deprecated in code comments; remove in a future release

### Step 5: Liquidsoap Config Changes (`config/disco.liq` — modify)

Minimal changes needed:

- Change M3U paths from per-channel music dirs to the new channel-specific M3U files:
  ```
  # Before:
  red_playlist = playlist(..., "/home/pi/music/red/playlist.m3u")

  # After:
  red_playlist = playlist(..., "/home/pi/music/channel-red.m3u")
  ```
- The `reload_mode="watch"` already handles M3U file changes automatically
- No other Liquidsoap changes needed — the M3U files just point to different paths now

### Step 6: Admin UI — Playlist Management (`web/admin.html` + `web/js/admin.js` — modify)

Add a new "Playlists" section to the admin panel:

**Library Tab (new):**
- Shows all uploaded music in a searchable/sortable table
- Bulk upload button (drag-drop zone)
- Delete button per track (with warning if used in playlists)
- Columns: title, artist, album, duration, used-in-playlists count

**Playlists Tab (new):**
- List of all playlists with name, track count, duration, which channels use it
- "New Playlist" button → name input + track picker (checkbox list from library)
- Click playlist → edit view:
  - Rename
  - Add/remove tracks (picker from library)
  - Drag-to-reorder tracks
  - Delete playlist button

**Channel Cards (modify existing):**
- Add a playlist selector dropdown to each channel card
- Shows currently assigned playlist name
- Dropdown lists all available playlists
- "None" option to unassign
- Changing selection immediately assigns and reloads

### Step 7: Data Migration (`server/lib/migrate.js` — new file)

One-time migration for existing installations:

1. Create `/home/pi/music/library/` directory
2. Copy all MP3s from `/home/pi/music/{red,green,blue}/` into library (skip duplicates by content hash)
3. Build `catalog.json` from migrated files
4. Create a playlist for each channel from its existing `playlist.json` order (e.g., "Red Channel (migrated)")
5. Write `assignments.json` mapping each channel to its migrated playlist
6. Generate new channel M3U files
7. Write a `.migrated` marker file to prevent re-running

Run automatically on server startup if `.migrated` doesn't exist.

---

## File Changes Summary

| File | Action | Description |
|------|--------|-------------|
| `server/lib/library.js` | **New** | Shared music library management |
| `server/lib/playlist-manager.js` | **New** | Named playlist CRUD |
| `server/lib/channel-playlists.js` | **New** | Channel ↔ playlist assignment |
| `server/lib/migrate.js` | **New** | One-time data migration |
| `server/lib/playlist.js` | **Modify** | Delegate to new modules; keep for backward compat |
| `server/index.js` | **Modify** | Add library/playlist/assignment API routes |
| `config/disco.liq` | **Modify** | Update M3U paths (3 lines) |
| `config/disco.conf` | **Modify** | Add `library_dir` and `playlists_dir` paths |
| `web/admin.html` | **Modify** | Add Library and Playlists UI sections |
| `web/js/admin.js` | **Modify** | Add library/playlist/assignment UI logic |
| `web/css/admin.css` | **Modify** | Styles for new sections |
| `deploy.sh` | **Modify** | Create new directories on deploy |

---

## Key Design Decisions

1. **Shared library, not per-playlist storage** — Avoids file duplication. A 4GB SD card matters on a Pi.
2. **JSON files, not a database** — Consistent with the existing approach (playlist.json, disco.conf). Simple, no dependencies.
3. **Channel-specific M3U files** — Keeps Liquidsoap changes minimal. The M3U is just a bridge between our playlist system and Liquidsoap.
4. **Backward-compatible API** — Existing admin panel keeps working during transition. Old endpoints delegate to new modules.
5. **Auto-migration** — Existing installations seamlessly upgrade without manual intervention.
6. **Playlists reference filenames, not paths** — All music lives in one directory, so filenames are sufficient identifiers.
