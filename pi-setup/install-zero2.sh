#!/bin/bash
# Silent Disco in a Box - Pi Zero 2 W Installation Script
# Lightweight variant: native Liquidsoap (no Docker), no energy analyser
# Run on a fresh Raspberry Pi OS Lite (64-bit) - Bookworm
# Usage: sudo bash install-zero2.sh
#
# Key differences from install.sh (Pi 4/5):
#   - No Docker — Liquidsoap 2.3 runs natively from pre-built .deb
#   - Energy analyser disabled (saves 150MB RAM / 3x ffmpeg processes)
#   - GPU memory reduced to 16MB
#   - Optimised for 512MB RAM

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
INSTALL_DIR="/opt/disco"
WEB_DIR="/var/www/disco"

PI_USER="${SUDO_USER:-$(logname 2>/dev/null || echo pi)}"
PI_HOME="$(eval echo ~"$PI_USER")"
MUSIC_DIR="$PI_HOME/music"

LIQUIDSOAP_VERSION="2.3.3"
LIQUIDSOAP_DEB_URL="https://github.com/savonet/liquidsoap-release-assets/releases/download/v${LIQUIDSOAP_VERSION}/liquidsoap_${LIQUIDSOAP_VERSION}-debian-bookworm-ocaml4.14.2-1_arm64.deb"

STEPS=13

echo "============================================="
echo "  Silent Disco in a Box - Pi Zero 2 W"
echo "  (Lightweight install — no Docker)"
echo "============================================="

if [ "$EUID" -ne 0 ]; then
  echo "Please run as root: sudo bash install-zero2.sh"
  exit 1
fi

# Check we're on arm64
if [ "$(uname -m)" != "aarch64" ]; then
  echo "ERROR: This script requires 64-bit Raspberry Pi OS (arm64/aarch64)"
  echo "Current arch: $(uname -m)"
  exit 1
fi

echo ""
echo "[1/$STEPS] Reducing GPU memory to 16MB..."
# Pi Zero 2 has 512MB shared with GPU — minimise GPU allocation
CONFIG_TXT=""
for f in /boot/firmware/config.txt /boot/config.txt; do
  [ -f "$f" ] && CONFIG_TXT="$f" && break
done
if [ -n "$CONFIG_TXT" ]; then
  if grep -q "^gpu_mem=" "$CONFIG_TXT"; then
    sed -i 's/^gpu_mem=.*/gpu_mem=16/' "$CONFIG_TXT"
  else
    echo "gpu_mem=16" >> "$CONFIG_TXT"
  fi
  echo "  Set gpu_mem=16 in $CONFIG_TXT (takes effect after reboot)"
else
  echo "  WARNING: Could not find config.txt"
fi

echo ""
echo "[2/$STEPS] Updating system packages..."
apt-get update -qq
apt-get upgrade -y -qq

echo "[3/$STEPS] Installing core packages..."
apt-get install -y -qq \
  hostapd \
  dnsmasq \
  icecast2 \
  nginx \
  git \
  bluez \
  rfkill \
  ffmpeg \
  alsa-utils \
  bluez-alsa-utils \
  python3-dbus \
  python3-gi \
  bluez-tools \
  openssl \
  wget

# Install Node.js 22 (LTS)
if ! command -v node &>/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]; then
  echo "  Installing Node.js 22..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi

echo "[4/$STEPS] Installing Liquidsoap ${LIQUIDSOAP_VERSION} (native — no Docker)..."
if ! command -v liquidsoap &>/dev/null || ! liquidsoap --version 2>/dev/null | grep -q "$LIQUIDSOAP_VERSION"; then
  echo "  Downloading pre-built arm64 .deb..."
  wget -q "$LIQUIDSOAP_DEB_URL" -O /tmp/liquidsoap.deb

  # Install — may fail first time due to missing deps
  dpkg -i /tmp/liquidsoap.deb 2>/dev/null || true
  apt-get install -f -y -qq
  rm -f /tmp/liquidsoap.deb

  # Verify
  if liquidsoap --version 2>/dev/null; then
    echo "  Liquidsoap installed successfully"
  else
    echo "  WARNING: Liquidsoap may have FFmpeg ABI issues (RPi OS vs Debian)"
    echo "  If it segfaults, see docs/pi-zero2-ffmpeg-fix.md"
  fi
else
  echo "  Liquidsoap ${LIQUIDSOAP_VERSION} already installed"
fi

# Pre-cache liquidsoap script to reduce startup memory spike
echo "  Pre-caching Liquidsoap scripts..."
liquidsoap --cache-only /dev/null 2>/dev/null || true

echo "[5/$STEPS] Installing Raspotify (Spotify Connect)..."
if ! command -v librespot &>/dev/null; then
  curl -sL https://dtcooper.github.io/raspotify/install.sh | sh
  systemctl stop raspotify 2>/dev/null || true
  systemctl disable raspotify 2>/dev/null || true
fi

echo "[6/$STEPS] Creating directories..."
mkdir -p "$INSTALL_DIR"
mkdir -p "$WEB_DIR"
mkdir -p "$MUSIC_DIR/red" "$MUSIC_DIR/green" "$MUSIC_DIR/blue"
mkdir -p /var/log/liquidsoap
mkdir -p /etc/liquidsoap
mkdir -p /etc/nginx/ssl

chown -R "$PI_USER:$PI_USER" "$MUSIC_DIR"
chmod o+rx "$PI_HOME"
chmod -R o+rX "$MUSIC_DIR"
chmod 777 /var/log/liquidsoap

echo "[7/$STEPS] Copying project files..."
cp -r "$PROJECT_DIR/config" "$INSTALL_DIR/"
cp -r "$PROJECT_DIR/server" "$INSTALL_DIR/"
cp -r "$PROJECT_DIR/web/"* "$WEB_DIR/"
[ -d "$PROJECT_DIR/systemd" ] && cp -r "$PROJECT_DIR/systemd" "$INSTALL_DIR/"

# Make scripts executable
chmod +x "$INSTALL_DIR/config/bt-capture.sh" 2>/dev/null || true
chmod +x "$INSTALL_DIR/config/bt-auto-agent.py" 2>/dev/null || true
chmod +x "$INSTALL_DIR/config/talkover-capture.sh" 2>/dev/null || true
chmod +x "$INSTALL_DIR/config/spotify-capture.sh" 2>/dev/null || true
chmod +x "$INSTALL_DIR/config/spotify-event.sh" 2>/dev/null || true
chmod +x "$INSTALL_DIR/config/linein-capture.sh" 2>/dev/null || true

echo "[8/$STEPS] Installing Node.js dependencies..."
cd "$INSTALL_DIR/server"
npm install --production --silent

echo "[9/$STEPS] Deploying configuration..."

# Icecast
cp "$INSTALL_DIR/config/icecast.xml" /etc/icecast2/icecast.xml
chown icecast2:icecast /etc/icecast2/icecast.xml 2>/dev/null || true

# Liquidsoap config
cp "$INSTALL_DIR/config/disco.liq" /etc/liquidsoap/disco.liq
sed -i "s|/home/pi/music|$MUSIC_DIR|g" /etc/liquidsoap/disco.liq

# Patch disco.conf: music paths + disable energy analyser for Zero 2
sed -i "s|/home/pi/music|$MUSIC_DIR|g" "$INSTALL_DIR/config/disco.conf"
# Disable energy analyser to save ~150MB RAM (3x ffmpeg processes)
if command -v python3 &>/dev/null; then
  python3 -c "
import json
with open('$INSTALL_DIR/config/disco.conf') as f:
    c = json.load(f)
c['energy_analyser'] = {'enabled': False}
with open('$INSTALL_DIR/config/disco.conf', 'w') as f:
    json.dump(c, f, indent=2)
"
fi

# hostapd
cp "$INSTALL_DIR/config/hostapd.conf" /etc/hostapd/hostapd.conf
sed -i 's|^#\?DAEMON_CONF=.*|DAEMON_CONF="/etc/hostapd/hostapd.conf"|' /etc/default/hostapd

# dnsmasq
cp "$INSTALL_DIR/config/dnsmasq.conf" /etc/dnsmasq.conf

# Nginx
cp "$INSTALL_DIR/config/nginx-disco.conf" /etc/nginx/sites-available/disco
ln -sf /etc/nginx/sites-available/disco /etc/nginx/sites-enabled/disco
rm -f /etc/nginx/sites-enabled/default

# Self-signed SSL cert (for HTTPS mic access)
if [ ! -f /etc/nginx/ssl/disco.crt ]; then
  echo "  Generating SSL certificate..."
  openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
    -keyout /etc/nginx/ssl/disco.key \
    -out /etc/nginx/ssl/disco.crt \
    -subj "/CN=SilentDisco/O=SilentDisco" \
    -addext "subjectAltName=IP:192.168.4.1,DNS:silentdisco.local" 2>/dev/null
fi

# disco-api service
cat > /etc/systemd/system/disco-api.service << SVCEOF
[Unit]
Description=Silent Disco API Server
After=network.target icecast2.service

[Service]
Type=simple
User=$PI_USER
WorkingDirectory=$INSTALL_DIR/server
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
Environment=DISCO_CONFIG=$INSTALL_DIR/config/disco.conf

[Install]
WantedBy=multi-user.target
SVCEOF

# Liquidsoap native service (no Docker!)
cat > /etc/systemd/system/liquidsoap-disco.service << 'SVCEOF'
[Unit]
Description=Liquidsoap - Silent Disco streaming (native)
After=icecast2.service sound.target
Wants=icecast2.service

[Service]
Type=simple
ExecStartPre=/bin/chmod 777 /var/log/liquidsoap
ExecStartPre=/bin/bash -c '[ -p /tmp/disco-talkover.pcm ] || mkfifo /tmp/disco-talkover.pcm; chmod 666 /tmp/disco-talkover.pcm'
ExecStart=/usr/bin/liquidsoap /etc/liquidsoap/disco.liq
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SVCEOF

# Talkover FIFO
[ -p /tmp/disco-talkover.pcm ] || mkfifo /tmp/disco-talkover.pcm
chmod 666 /tmp/disco-talkover.pcm

echo "[10/$STEPS] Configuring network..."
if command -v nmcli &>/dev/null; then
  echo "  Detected NetworkManager, configuring static IP..."
  # Pi Zero 2 has only wlan0 (built-in) — use it for AP unless USB WiFi present
  # Detect which interface to use: prefer wlan1 (USB) if it exists
  if ip link show wlan1 &>/dev/null; then
    AP_IFACE="wlan1"
    echo "  USB WiFi adapter detected — using wlan1 for AP"
  else
    AP_IFACE="wlan0"
    echo "  Using built-in WiFi (wlan0) for AP"
  fi

  nmcli device set "$AP_IFACE" managed no 2>/dev/null || true
  mkdir -p /etc/NetworkManager/conf.d
  cat > /etc/NetworkManager/conf.d/99-disco.conf << NMCONFEOF
[keyfile]
unmanaged-devices=interface-name:${AP_IFACE}
NMCONFEOF

  # Update hostapd and dnsmasq to use the detected interface
  sed -i "s|^interface=.*|interface=${AP_IFACE}|" /etc/hostapd/hostapd.conf
  sed -i "s|^interface=.*|interface=${AP_IFACE}|" /etc/dnsmasq.conf

  cat > /etc/systemd/system/disco-network.service << SVCEOF
[Unit]
Description=Silent Disco - Configure ${AP_IFACE} static IP
Before=hostapd.service dnsmasq.service
After=network-pre.target NetworkManager.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/bin/nmcli radio wifi on
ExecStart=/sbin/ip link set ${AP_IFACE} up
ExecStart=/sbin/ip addr flush dev ${AP_IFACE}
ExecStart=/sbin/ip addr add 192.168.4.1/24 dev ${AP_IFACE}

[Install]
WantedBy=multi-user.target
SVCEOF
  systemctl daemon-reload
  systemctl enable disco-network

  # Keep WiFi hotspot up even when ethernet connects
  mkdir -p /etc/NetworkManager/dispatcher.d
  cp "$INSTALL_DIR/config/nm-dispatcher-keep-wifi-up.sh" /etc/NetworkManager/dispatcher.d/10-keep-wifi-up
  chmod 755 /etc/NetworkManager/dispatcher.d/10-keep-wifi-up

  # NAT: hotspot clients get internet via ethernet (for Spotify Connect etc.)
  echo 'net.ipv4.ip_forward=1' > /etc/sysctl.d/99-disco-forward.conf
  sysctl -w net.ipv4.ip_forward=1

elif [ -f /etc/dhcpcd.conf ]; then
  echo "  Detected dhcpcd, configuring static IP..."
  if ! grep -q "# Silent Disco hotspot" /etc/dhcpcd.conf; then
    cat >> /etc/dhcpcd.conf << 'EOF'

# Silent Disco hotspot
interface wlan0
    static ip_address=192.168.4.1/24
    nohook wpa_supplicant
EOF
  fi
fi

echo "[11/$STEPS] Configuring Bluetooth..."

# ALSA loopback on boot
echo "snd-aloop" > /etc/modules-load.d/snd-aloop.conf
modprobe snd-aloop 2>/dev/null || true

# BlueZ config
cat > /etc/bluetooth/main.conf << 'BTEOF'
[General]
Name = SilentDisco
Class = 0x200414
DiscoverableTimeout = 0
PairableTimeout = 0
AlwaysPairable = true

[Policy]
AutoEnable=true
BTEOF

# bt-setup.sh is already in $INSTALL_DIR/config/ from step 7
chmod +x /opt/disco/config/bt-setup.sh

# Bluetooth setup service
cat > /etc/systemd/system/disco-bt-setup.service << 'SVCEOF'
[Unit]
Description=Silent Disco - Disable built-in BT and configure USB dongle
After=bluetooth.service
Requires=bluetooth.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/opt/disco/config/bt-setup.sh

[Install]
WantedBy=multi-user.target
SVCEOF

# bluealsa-aplay → ALSA loopback
cat > /etc/systemd/system/disco-bt-audio.service << 'SVCEOF'
[Unit]
Description=Silent Disco Bluetooth Audio Bridge
After=bluealsa.service bluetooth.service
Requires=bluealsa.service

[Service]
Type=simple
ExecStartPre=/sbin/modprobe snd-aloop
ExecStart=/usr/bin/bluealsa-aplay --pcm=hw:Loopback,0,0
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
SVCEOF

# BT auto-accept pairing agent
cat > /etc/systemd/system/disco-bt-agent.service << 'SVCEOF'
[Unit]
Description=Silent Disco Bluetooth Auto-Accept Agent
After=bluetooth.service
Requires=bluetooth.service

[Service]
Type=simple
ExecStart=/usr/bin/python3 /opt/disco/config/bt-auto-agent.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SVCEOF

rfkill unblock bluetooth 2>/dev/null || true

echo "[12/$STEPS] Configuring Raspotify (Spotify Connect)..."

# Create 3 raspotify instances — one per channel
for ch in red green blue; do
  case $ch in
    red)   sub=1; name="SilentDisco Red";;
    green) sub=2; name="SilentDisco Green";;
    blue)  sub=3; name="SilentDisco Blue";;
  esac

  cat > /etc/raspotify/conf-$ch << CONF
LIBRESPOT_NAME="$name"
LIBRESPOT_BACKEND="alsa"
LIBRESPOT_DEVICE="hw:Loopback,0,$sub"
LIBRESPOT_BITRATE="160"
LIBRESPOT_FORMAT="S16"
LIBRESPOT_INITIAL_VOLUME="100"
LIBRESPOT_QUIET=true
CONF

  cat > /etc/systemd/system/raspotify-$ch.service << SVC
[Unit]
Description=Raspotify - $name
After=network-online.target sound.target
Wants=network-online.target sound.target

[Service]
Type=simple
EnvironmentFile=/etc/raspotify/conf-$ch
ExecStart=/usr/bin/librespot \
  --name "$name" \
  --backend alsa \
  --device "hw:Loopback,0,$sub" \
  --bitrate 160 \
  --format S16 \
  --initial-volume 100 \
  --disable-audio-cache \
  --zeroconf-port $((4070 + sub)) \
  --onevent "/opt/disco/config/spotify-event.sh $ch"
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SVC
done

echo "[13/$STEPS] Enabling and starting services..."
nginx -t

systemctl unmask hostapd 2>/dev/null || true
systemctl daemon-reload
systemctl enable \
  hostapd dnsmasq icecast2 disco-api nginx \
  liquidsoap-disco \
  bluetooth bluealsa disco-bt-audio disco-bt-agent disco-bt-setup \
  raspotify-red raspotify-green raspotify-blue

systemctl start icecast2
systemctl start liquidsoap-disco
systemctl start disco-api
systemctl start nginx
systemctl start bluetooth bluealsa disco-bt-audio disco-bt-agent
systemctl start raspotify-red raspotify-green raspotify-blue

echo ""
echo "============================================="
echo "  Installation complete! (Pi Zero 2 W)"
echo "============================================="
echo ""
echo "  WiFi SSID:     SilentDisco"
echo "  WiFi Password: letsdance"
echo "  Web Portal:    http://192.168.4.1"
echo "  Admin Panel:   http://192.168.4.1/admin.html"
echo "  Admin Pass:    disco2024"
echo "  HTTPS (mic):   https://192.168.4.1/admin.html"
echo ""
echo "  Music folders:"
echo "    $MUSIC_DIR/red/"
echo "    $MUSIC_DIR/green/"
echo "    $MUSIC_DIR/blue/"
echo ""
echo "  Bluetooth:     SilentDisco (USB dongle)"
echo "  Spotify:       SilentDisco Red/Green/Blue"
echo ""
echo "  Optimisations applied:"
echo "    - GPU memory: 16MB (reboot needed)"
echo "    - Energy analyser: disabled (saves ~150MB)"
echo "    - Liquidsoap: native (no Docker overhead)"
echo ""
echo "  If Liquidsoap segfaults on startup, you may need"
echo "  to fix the RPi OS FFmpeg ABI mismatch — see SETUP.md"
echo ""
echo "  Reboot to activate all services:"
echo "    sudo reboot"
echo ""
echo "============================================="
