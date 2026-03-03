# Silent Disco in a Box — Setup Guide

## What You Need

### Hardware
- **Raspberry Pi 4** (4GB+ recommended)
- **MicroSD card** (16GB+) with Raspberry Pi OS Lite (64-bit)
- **USB Bluetooth dongle** (e.g. Broadcom BCM20702A0) — required for BT audio without WiFi interference
- **USB power bank** or power supply
- **Optional:** Up to 3x USB audio adapters (UGREEN) for line-in from DJ mixers/phones

### Network
- Pi runs its own WiFi hotspot — no external router needed
- SSID: `SilentDisco` / Password: `letsdance`
- Up to 20 listeners on Pi 4 built-in WiFi

---

## Fresh Pi Install (One Command)

```bash
# 1. Flash Raspberry Pi OS Lite (64-bit) to SD card
# 2. Enable SSH (add empty 'ssh' file to boot partition)
# 3. Set username/password during first boot
# 4. SSH in and run:

git clone <your-repo-url> /tmp/silent-disco
cd /tmp/silent-disco
sudo bash pi-setup/install.sh
sudo reboot
```

The install script handles everything:
- System packages (hostapd, dnsmasq, icecast2, nginx, liquidsoap, node.js)
- Bluetooth packages (bluez, pulseaudio, bluealsa, python3-dbus)
- WiFi hotspot configuration
- All service configs deployed and enabled
- Music directories created
- Bluetooth auto-pairing agent
- ALSA loopback for BT audio routing

---

## Post-Install: Bluetooth Setup

After reboot, Bluetooth needs the auto-accept agent running:

```bash
# Start the auto-pairing agent
sudo nohup python3 /opt/disco/config/bt-auto-agent.py &

# Disable built-in BT (uses same chip as WiFi — causes interference)
sudo hciconfig hci0 down

# USB dongle should be discoverable as "SilentDisco"
sudo bluetoothctl select <USB_DONGLE_MAC>
sudo bluetoothctl discoverable on
sudo bluetoothctl pairable on
```

Phones can then pair and stream audio via Bluetooth to any channel.

---

## Architecture

```
Phone (Spotify/Music) --BT A2DP--> USB Dongle
                                        |
                                    bluealsa
                                        |
                                  ALSA Loopback
                                        |
Phone (DJ line-in) --USB Audio--> Liquidsoap --Icecast--> Nginx --> Listeners
                                        |
                    MP3 Playlists -------+
```

### Audio Chain per Channel
Priority (highest first):
1. **Bluetooth** — when BT toggle is on and a phone is streaming
2. **Request Queue** — "previous track" pushes here
3. **Playlist** — randomized MP3s from `/home/<user>/music/<channel>/`

### Services
| Service | Purpose |
|---------|---------|
| `hostapd` | WiFi hotspot |
| `dnsmasq` | DHCP + DNS (captive portal) |
| `icecast2` | Audio streaming server (3 mounts) |
| `liquidsoap-disco` | Audio engine (playlists + BT + queues) |
| `disco-api` | Node.js admin API + WebSocket |
| `nginx` | Reverse proxy + static files |
| `bluealsa` | Bluetooth ALSA bridge |
| `disco-bt-audio` | Routes BT audio to ALSA loopback |
| `bluetooth` | BlueZ daemon |

---

## Admin Panel

Access at `http://192.168.4.1/admin.html` (password: `disco2024`)

Features:
- **Now playing** with track title/artist per channel
- **Skip / Previous** track controls
- **Line-In toggle** per channel (when USB audio adapters connected)
- **Bluetooth toggle** per channel (mutually exclusive)
- **Upload MP3s** via drag & drop or file picker
- **Track list** per channel with delete
- **Bluetooth device panel** with channel assignment
- **System restart/shutdown**

---

## Listener Portal

Access at `http://192.168.4.1/` (or any URL — captive portal redirects)

- Start screen with "Join the Disco" button
- Channel selection (Red/Green/Blue) with live track info
- Player screen: full channel colour background
- Lock screen: solid colour artwork + track info
- Channel switching via dots at bottom

---

## File Structure

```
config/
  disco.conf          # Main config (channels, network, passwords)
  disco.liq           # Liquidsoap audio engine config
  icecast.xml         # Icecast streaming server config
  hostapd.conf        # WiFi hotspot config
  dnsmasq.conf        # DHCP/DNS config
  nginx-disco.conf    # Nginx reverse proxy config
  bt-capture.sh       # BT audio capture for Liquidsoap
  bt-auto-agent.py    # Python auto-accept pairing agent

server/
  server.js           # Express API + WebSocket + upload/BT endpoints
  package.json
  lib/
    liquidsoap.js     # Telnet client for Liquidsoap control
    icecast.js        # Icecast stats fetcher
    metadata.js       # MP3 metadata reader + cache
    bluetooth.js      # BT device monitoring + channel assignment
    config.js         # Config file loader

web/
  index.html          # Listener portal
  admin.html          # Admin panel
  js/
    app.js            # Listener app logic
    api.js            # API + WebSocket client
    audio.js          # Audio playback + Web Audio API
    visualizer.js     # Canvas visualizer
    mediasession.js   # Lock screen media controls
    admin.js          # Admin panel logic
  css/
    main.css          # Listener styles
    admin.css         # Admin styles
  assets/
    default-art.png   # Fallback artwork

systemd/
  liquidsoap-disco.service
  disco-api.service

pi-setup/
  install.sh          # Master installer
  bluetooth-setup.sh  # Standalone BT setup
```

---

## Deploying Updates

From your development machine:

```bash
# Copy updated files to Pi
scp web/* pi@192.168.0.200:/var/www/disco/
scp server/* pi@192.168.0.200:/opt/disco/server/

# On Pi: restart affected services
sudo systemctl restart disco-api          # API changes
sudo systemctl restart liquidsoap-disco   # Liquidsoap config changes (~90s)
sudo systemctl reload nginx               # Nginx config changes
```

---

## Troubleshooting

- **No WiFi?** Check `rfkill list` — Bluetooth setup may have blocked WiFi. Run `sudo rfkill unblock all`
- **No sound?** Check `systemctl status liquidsoap-disco` and `/var/log/liquidsoap/disco.log`
- **BT pairing fails?** Ensure `bt-auto-agent.py` is running and USB dongle is discoverable
- **BT audio cuts out?** Make sure using USB dongle (hci1), not built-in (hci0). Run `sudo hciconfig hci0 down`
- **Upload fails?** Check Nginx `client_max_body_size` in `/etc/nginx/sites-available/disco`
- **Cached old JS/CSS?** Bump `?v=N` query strings in HTML files
