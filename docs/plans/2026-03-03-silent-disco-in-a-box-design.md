# Silent Disco in a Box - Design Document

**Date:** 2026-03-03
**Status:** Approved

## Overview

A portable, self-contained silent disco system built on a Raspberry Pi 4. No power grid or internet required. Attendees connect to the Pi's WiFi, open a web portal on their phone, and listen to one of three color-coded music channels through their headphones.

## Requirements

| Requirement | Detail |
|-------------|--------|
| Portability | Battery-powered (USB power bank), no internet needed |
| Channels | 3 simultaneous channels (Red, Green, Blue) |
| Music source | Pre-loaded MP3 files per channel + USB audio line-in for live DJ |
| Listeners | Up to 20 concurrent |
| User experience | Full party experience - animated UI, visualizer, now-playing info, album art |
| Admin controls | Password-protected admin panel for playlist/playback management |
| Hardware | Raspberry Pi 4 (4GB+), USB power bank, USB audio adapter (for line-in) |

## Architecture

```
RASPBERRY PI 4 (Raspberry Pi OS Lite 64-bit)
├── hostapd          → WiFi Access Point ("Silent Disco")
├── dnsmasq          → DHCP (192.168.4.10-200) + DNS (captive portal redirect)
├── Nginx            → Web portal (port 80) + reverse proxy to Icecast & API
├── Icecast2         → Audio streaming server (port 8000)
│   ├── /red         → Channel Red (128kbps MP3)
│   ├── /green       → Channel Green (128kbps MP3)
│   └── /blue        → Channel Blue (128kbps MP3)
├── Liquidsoap       → Audio engine - reads MP3s, manages playlists, pushes to Icecast
│   ├── Channel Red  → reads from /home/pi/music/red/
│   ├── Channel Green→ reads from /home/pi/music/green/
│   ├── Channel Blue → reads from /home/pi/music/blue/
│   └── Line-in      → captures USB audio input (for DJ)
└── Node.js          → Admin API backend (Express.js)
    ├── Playlist management (via Liquidsoap telnet API)
    ├── Now-playing info
    └── Listener stats (via Icecast stats API)
```

## Data Flow

### Listener Flow
1. Pi boots → hostapd broadcasts SSID "Silent Disco"
2. Phone connects to WiFi → gets IP via DHCP from dnsmasq
3. Captive portal redirect → phone auto-opens `http://192.168.4.1`
4. Nginx serves the web portal (static HTML/CSS/JS)
5. User sees 3 color-coded channel cards with now-playing info
6. User taps a channel → browser plays Icecast MP3 stream via `<audio>` tag
7. Stream URL example: `http://192.168.4.1/stream/red` (Nginx proxies to Icecast :8000/red)

### Audio Flow
1. Liquidsoap reads MP3 files from channel folders
2. Encodes to 128kbps MP3 stream
3. Pushes to Icecast on respective mount point
4. Icecast serves to all connected listeners on that mount point

### Admin Flow
1. Admin navigates to `http://192.168.4.1/admin`
2. Enters password
3. Node.js backend communicates with Liquidsoap via telnet API
4. Admin can: skip tracks, reorder playlists, switch channel to line-in, view stats

## Listener Web Portal

### Landing Page
- Full-screen dark background with subtle animated gradient/particles
- Event title (configurable)
- Three large channel cards, color-coded (Red, Green, Blue)
- Each card shows: channel color/name, current track title + artist, album art, live listener count
- Tap card → transition to player view

### Player View
- Full-screen in channel's color theme
- Large album art or animated audio visualizer (Web Audio API)
- Track title + artist
- Channel switch buttons at bottom (colored dots)
- Volume control
- Listener count

### UX Requirements
- No login/signup - tap and listen
- Single page app - no page reloads switching channels
- Works portrait and landscape
- Audio continues in background (Media Session API for iOS/Android lock screen)
- Captive portal auto-opens on WiFi connect

## Admin Panel

### Dashboard
- Overview of all 3 channels: current track, next track, listener count, stream status
- Total listeners across all channels

### Per-Channel Controls
- Playlist queue: view, reorder (drag), remove tracks
- Playback: play/pause, skip, previous
- Source toggle: Playlist mode ↔ Line-in mode
- Music library browser: browse all MP3s, add to any channel's playlist

### System
- WiFi status + connected client count
- CPU/memory/storage stats
- Shutdown/restart Pi buttons

### Security
- Password-protected (password in config file)
- Same Node.js backend, separate SPA route

## Network Configuration

| Setting | Value |
|---------|-------|
| SSID | "Silent Disco" (configurable) |
| WiFi Security | WPA2 (optional, configurable) |
| Pi IP | 192.168.4.1 |
| DHCP Range | 192.168.4.10 - 192.168.4.200 |
| DNS | All queries → 192.168.4.1 (captive portal) |
| Icecast | Port 8000 (proxied via Nginx on 80) |
| Node.js API | Port 3000 (proxied via Nginx on 80 at /api) |

## Streaming Specifications

| Spec | Value |
|------|-------|
| Codec | MP3 |
| Bitrate | 128kbps per channel |
| Channels per stream | Stereo |
| Total bandwidth per listener | 128kbps (listens to 1 channel at a time) |
| Max bandwidth (20 listeners) | 2.56 Mbps |
| Listener sync | ~0.5-1 second variance (acceptable for dancing) |

## Music Storage

```
/home/pi/music/
  red/        ← MP3 files for Channel Red
  green/      ← MP3 files for Channel Green
  blue/       ← MP3 files for Channel Blue
```

Music loaded via USB stick, SCP, or SFTP before the event. MP3 ID3 tags used for track title, artist, and album art display.

## Hardware Requirements

| Item | Purpose | Approx. Cost |
|------|---------|-------------|
| Raspberry Pi 4 (4GB) | Main unit | ~$55 |
| MicroSD card (32GB+) | OS + music storage | ~$10 |
| USB-C power bank (20,000mAh) | Battery power (~6-8 hrs) | ~$25 |
| USB audio adapter (e.g. Sabrent) | Line-in for DJ | ~$10 |
| 3.5mm aux cable | Connect DJ phone to USB adapter | ~$5 |
| **Total** | | **~$105** |

## What We Build (Code Deliverables)

1. **Setup scripts** — Bash scripts to install and configure all services on a fresh Pi
2. **Liquidsoap configuration** — Channel definitions, playlist management, Icecast output, line-in capture
3. **Node.js admin backend** — Express.js app: playlist API, now-playing, listener stats, Liquidsoap telnet interface
4. **Listener web portal** — HTML/CSS/JS SPA: animated landing page, player view, visualizer, channel switching
5. **Admin panel frontend** — HTML/CSS/JS SPA: dashboard, playlist management, playback controls, system info
6. **Systemd service files** — Auto-start all services on boot
7. **Configuration file** — Single config for event name, SSID, WiFi password, admin password, stream settings
8. **Documentation** — Setup guide, troubleshooting, how to load music

## Technical Decisions

- **Icecast over HLS:** Native browser `<audio>` playback, no JavaScript library needed, lower latency
- **Liquidsoap over MPD:** Purpose-built for radio/streaming, has built-in Icecast output, supports line-in, telnet API for remote control
- **Nginx over direct Icecast access:** Single port 80 entry point, cleaner URLs, serves static files efficiently, handles captive portal
- **Node.js for backend:** Lightweight, good for real-time updates (WebSocket for live now-playing), easy to develop
- **No database:** Playlist state managed by Liquidsoap, config in JSON file, no persistence needed beyond file system
- **128kbps MP3:** Good quality for phone speakers/earbuds, low bandwidth, universal browser support

## Spotify Note

Spotify's Terms of Service explicitly prohibit rebroadcasting to multiple listeners. This system uses locally stored MP3 files as the primary music source. The line-in option allows a DJ to play from any source (Spotify, Apple Music, etc.) on their personal phone, with audio routed through the Pi — this is functionally equivalent to plugging into a speaker system.
