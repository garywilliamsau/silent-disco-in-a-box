# Three Remaining Features Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable `silentdisco.local` URL, confirm playlist order persists after reboots, and auto-switch channels to Spotify when a device starts playing.

**Architecture:** All three are Pi-side changes. (1) dnsmasq gets a `silentdisco.local` DNS entry so all clients on the hotspot can use a friendly URL. (2) Liquidsoap already uses `mode="normal"` + `playlist.m3u`; we verify the Pi has correct paths and that playlist.m3u is initialised by the server on first run. (3) A new shell script `spotify-event.sh` receives librespot `--onevent` callbacks and calls the existing Node.js `/api/channels/:id/spotify` endpoint to toggle the Spotify source.

**Tech Stack:** dnsmasq config, Liquidsoap 2.x `.liq`, Raspotify/librespot `--onevent`, curl, Node.js API (port 3000, auth `Bearer disco2024`), sshpass + rsync for deploy.

**Deploy details:**
- Pi: `silentdisco@192.168.0.215`, password `raspberry`
- App root: `/opt/disco/` (silentdisco user cannot write here; use `sudo cp`)
- Deploy pattern: `rsync -av --rsync-path="rsync" <local> silentdisco@192.168.0.215:/tmp/deploy-file && sshpass -p 'raspberry' ssh silentdisco@192.168.0.215 "echo raspberry | sudo -S cp /tmp/deploy-file <dest> && sudo systemctl restart <svc>"`

---

## Task 1: Add silentdisco.local DNS entry

`silentdisco.local` should resolve to `192.168.4.1` for all devices on the hotspot. dnsmasq already handles all DNS on the network and already has `address=/disco.local/192.168.4.1`. Add a second entry for `silentdisco.local`.

**No unit tests** — manual verify: connect to SilentDisco WiFi, open `http://silentdisco.local` in a browser.

**Files:**
- Modify: `config/dnsmasq.conf:17`

### Step 1: Add the DNS entry

In `config/dnsmasq.conf`, after the `address=/disco.local/192.168.4.1` line, add:

```
address=/silentdisco.local/192.168.4.1
```

Final `config/dnsmasq.conf` local hostnames section should look like:
```
# Local hostnames
address=/disco.local/192.168.4.1
address=/silentdisco.local/192.168.4.1
```

### Step 2: Deploy to Pi and restart dnsmasq

```bash
sshpass -p 'raspberry' rsync -av config/dnsmasq.conf silentdisco@192.168.0.215:/tmp/dnsmasq.conf
sshpass -p 'raspberry' ssh silentdisco@192.168.0.215 "echo raspberry | sudo -S cp /tmp/dnsmasq.conf /etc/dnsmasq.conf && sudo systemctl restart dnsmasq"
```

Expected: no errors, dnsmasq restarts cleanly.

### Step 3: Verify on Pi

```bash
sshpass -p 'raspberry' ssh silentdisco@192.168.0.215 "systemctl is-active dnsmasq"
```

Expected: `active`

Also test resolution from Pi itself (local dnsmasq listens on 127.0.0.1):
```bash
sshpass -p 'raspberry' ssh silentdisco@192.168.0.215 "dig @127.0.0.1 silentdisco.local +short"
```

Expected: `192.168.4.1`

### Step 4: Commit

```bash
git add config/dnsmasq.conf
git commit -m "feat: add silentdisco.local DNS entry to dnsmasq"
```

---

## Task 2: Verify playlist order persists after reboot

The local `config/disco.liq` already has `mode="normal"` and reads `playlist.m3u` per channel. The installer patches `/home/pi/music` → `/home/silentdisco/music` at deploy time. `server/lib/playlist.js` writes `playlist.m3u` when the API server starts. This task verifies all of this is in place on the Pi, and fixes any gaps.

**No unit tests** — manual verify: check deployed disco.liq paths, confirm playlist.m3u files exist.

**Files:**
- Read: `/etc/liquidsoap/disco.liq` on Pi (verify paths)
- Possibly deploy: `config/disco.liq` if paths are wrong on Pi

### Step 1: Check deployed disco.liq on Pi

```bash
sshpass -p 'raspberry' ssh silentdisco@192.168.0.215 "grep -E 'playlist|mode' /etc/liquidsoap/disco.liq | head -20"
```

Expected output (per channel):
```
  mode="normal",
  reload_mode="watch",
  "/home/silentdisco/music/red/playlist.m3u"
```

**If paths still say `/home/pi/music/`:** The installer's `sed` patch was not applied. Fix by deploying the corrected liq file:

```bash
sshpass -p 'raspberry' rsync -av config/disco.liq silentdisco@192.168.0.215:/tmp/disco.liq
sshpass -p 'raspberry' ssh silentdisco@192.168.0.215 "
  sed 's|/home/pi/music|/home/silentdisco/music|g' /tmp/disco.liq | sudo -S tee /etc/liquidsoap/disco.liq > /dev/null
  sudo systemctl restart liquidsoap-disco
"
```

### Step 2: Verify playlist.m3u files exist

```bash
sshpass -p 'raspberry' ssh silentdisco@192.168.0.215 "ls /home/silentdisco/music/*/playlist.m3u 2>&1"
```

Expected: three files listed (`red/playlist.m3u`, `green/playlist.m3u`, `blue/playlist.m3u`).

**If files are missing:** The API server creates them on startup. Restart it:

```bash
sshpass -p 'raspberry' ssh silentdisco@192.168.0.215 "sudo systemctl restart disco-api && sleep 3 && ls /home/silentdisco/music/*/playlist.m3u"
```

### Step 3: Confirm Liquidsoap is running cleanly

```bash
sshpass -p 'raspberry' ssh silentdisco@192.168.0.215 "systemctl is-active liquidsoap-disco"
```

Expected: `active`

### Step 4: Mark todo complete

Move the todo file from pending to done:

```bash
mv .planning/todos/pending/2026-03-03-verify-playlist-order-persists-after-reboot.md \
   .planning/todos/done/2026-03-03-verify-playlist-order-persists-after-reboot.md
```

Then update the file's frontmatter — add `resolved: <today's date>` after the `created:` line.

### Step 5: Commit

```bash
git add .planning/todos/
git commit -m "chore: mark playlist-order todo resolved — mode=normal + playlist.m3u verified on Pi"
```

---

## Task 3: Spotify auto-switch event script

When a Spotify device starts playing on a Raspotify instance, librespot fires `--onevent "/opt/disco/config/spotify-event.sh <channel>"` with env var `PLAYER_EVENT=playing`. When it stops, `PLAYER_EVENT=stopped`. The script must call the existing Node.js API to toggle the Spotify source for that channel.

**API endpoint:** `POST http://127.0.0.1:3000/api/channels/<channel>/spotify`
**Auth:** `Authorization: Bearer disco2024`
**Body:** `{"enabled": true}` or `{"enabled": false}`

**Files:**
- Create: `config/spotify-event.sh`
- Modify: `pi-setup/install.sh` (add chmod for the new script)

### Step 1: Create config/spotify-event.sh

```bash
#!/bin/bash
# Librespot --onevent hook: auto-enable/disable Spotify source on a channel
# Called as: spotify-event.sh <channel>
# Env: PLAYER_EVENT=playing|paused|stopped|...

CH="$1"
API="http://127.0.0.1:3000/api/channels/$CH/spotify"
AUTH="Authorization: Bearer disco2024"

case "$PLAYER_EVENT" in
  playing)
    curl -s -X POST "$API" \
      -H "$AUTH" \
      -H "Content-Type: application/json" \
      -d '{"enabled":true}' \
      >/dev/null 2>&1
    ;;
  stopped|paused|unavailable)
    curl -s -X POST "$API" \
      -H "$AUTH" \
      -H "Content-Type: application/json" \
      -d '{"enabled":false}' \
      >/dev/null 2>&1
    ;;
esac
```

### Step 2: Add chmod to install.sh

In `pi-setup/install.sh`, find the block where `spotify-capture.sh` is chmoded (around line 90):

```bash
chmod +x "$INSTALL_DIR/config/spotify-capture.sh" 2>/dev/null || true
```

Add immediately after:
```bash
chmod +x "$INSTALL_DIR/config/spotify-event.sh" 2>/dev/null || true
```

### Step 3: Deploy spotify-event.sh to Pi

```bash
sshpass -p 'raspberry' rsync -av config/spotify-event.sh silentdisco@192.168.0.215:/tmp/spotify-event.sh
sshpass -p 'raspberry' ssh silentdisco@192.168.0.215 "
  echo raspberry | sudo -S cp /tmp/spotify-event.sh /opt/disco/config/spotify-event.sh
  sudo chmod +x /opt/disco/config/spotify-event.sh
"
```

### Step 4: Verify script is in place and executable

```bash
sshpass -p 'raspberry' ssh silentdisco@192.168.0.215 "ls -la /opt/disco/config/spotify-event.sh"
```

Expected: `-rwxr-xr-x ... /opt/disco/config/spotify-event.sh`

### Step 5: Test the script manually

With the disco-api running, fire the script by hand:

```bash
sshpass -p 'raspberry' ssh silentdisco@192.168.0.215 "PLAYER_EVENT=playing /opt/disco/config/spotify-event.sh red"
```

Then check the API response to confirm Spotify mode toggled:

```bash
sshpass -p 'raspberry' ssh silentdisco@192.168.0.215 "curl -s http://127.0.0.1:3000/api/channels | python3 -m json.tool | grep -A2 '\"red\"'"
```

Expected: `spotifyMode: true` for red channel.

Restore state:
```bash
sshpass -p 'raspberry' ssh silentdisco@192.168.0.215 "PLAYER_EVENT=stopped /opt/disco/config/spotify-event.sh red"
```

### Step 6: Commit

```bash
git add config/spotify-event.sh pi-setup/install.sh
git commit -m "feat: Spotify auto-switch — librespot event hook calls Node.js API"
```

---

## Final: Update memory and close todos

After all three tasks:

1. Update `web/index.html` version query strings if any web files changed (none expected)
2. Close out the playlist todo (Task 2, Step 4)
3. Summarize the three features in a GOTCHAS or MEMORY update if anything surprising was found
