#!/bin/bash
# Silent Disco in a Box - Master Installation Script
# Run on a fresh Raspberry Pi OS Lite (64-bit)
# Usage: sudo bash install.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
INSTALL_DIR="/opt/disco"
WEB_DIR="/var/www/disco"

# Detect the actual user (the one who ran sudo, not root)
PI_USER="${SUDO_USER:-$(logname 2>/dev/null || echo pi)}"
PI_HOME="$(eval echo ~"$PI_USER")"
MUSIC_DIR="$PI_HOME/music"

echo "============================================="
echo "  Silent Disco in a Box - Installer"
echo "============================================="

if [ "$EUID" -ne 0 ]; then
  echo "Please run as root: sudo bash install.sh"
  exit 1
fi

echo ""
echo "[1/10] Updating system packages..."
apt-get update -qq
apt-get upgrade -y -qq

echo "[2/10] Installing dependencies..."
apt-get install -y -qq \
  hostapd \
  dnsmasq \
  icecast2 \
  nginx \
  git \
  bluez \
  rfkill

# Install Liquidsoap from OPAM or package manager
echo "  Installing Liquidsoap..."
apt-get install -y -qq liquidsoap || {
  echo "  WARNING: liquidsoap not in apt repos. You may need to install from OPAM."
  echo "  See: https://www.liquidsoap.info/doc-dev/install.html"
}

# Install Node.js 18+ via NodeSource
if ! command -v node &>/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 18 ]; then
  echo "  Installing Node.js 18..."
  curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
  apt-get install -y -qq nodejs
fi

echo "[3/10] Creating service users..."
id -u liquidsoap &>/dev/null || useradd -r -s /bin/false -G audio liquidsoap

echo "[4/10] Creating directories..."
mkdir -p "$INSTALL_DIR"
mkdir -p "$WEB_DIR"
mkdir -p "$MUSIC_DIR/red" "$MUSIC_DIR/green" "$MUSIC_DIR/blue"
mkdir -p /var/log/liquidsoap
mkdir -p /etc/liquidsoap

chown -R "$PI_USER:$PI_USER" "$MUSIC_DIR"
chmod o+rx "$PI_HOME"
chmod -R o+rX "$MUSIC_DIR"
chown liquidsoap:liquidsoap /var/log/liquidsoap

echo "[5/10] Copying project files..."
cp -r "$PROJECT_DIR/config" "$INSTALL_DIR/"
cp -r "$PROJECT_DIR/server" "$INSTALL_DIR/"
cp -r "$PROJECT_DIR/web/"* "$WEB_DIR/"
cp -r "$PROJECT_DIR/systemd" "$INSTALL_DIR/"

echo "[6/10] Installing Node.js dependencies..."
cd "$INSTALL_DIR/server"
npm install --production --silent

echo "[7/10] Deploying configuration..."

# Icecast
cp "$INSTALL_DIR/config/icecast.xml" /etc/icecast2/icecast.xml
chown icecast2:icecast /etc/icecast2/icecast.xml 2>/dev/null || true

# Liquidsoap
cp "$INSTALL_DIR/config/disco.liq" /etc/liquidsoap/disco.liq
chown liquidsoap:liquidsoap /etc/liquidsoap/disco.liq

# hostapd
cp "$INSTALL_DIR/config/hostapd.conf" /etc/hostapd/hostapd.conf
sed -i 's|^#\?DAEMON_CONF=.*|DAEMON_CONF="/etc/hostapd/hostapd.conf"|' /etc/default/hostapd

# dnsmasq
cp "$INSTALL_DIR/config/dnsmasq.conf" /etc/dnsmasq.conf

# Nginx
cp "$INSTALL_DIR/config/nginx-disco.conf" /etc/nginx/sites-available/disco
ln -sf /etc/nginx/sites-available/disco /etc/nginx/sites-enabled/disco
rm -f /etc/nginx/sites-enabled/default

# systemd services (patch username)
cp "$INSTALL_DIR/systemd/liquidsoap-disco.service" /etc/systemd/system/
cp "$INSTALL_DIR/systemd/disco-api.service" /etc/systemd/system/
sed -i "s|User=pi|User=$PI_USER|" /etc/systemd/system/disco-api.service

# Patch Liquidsoap music paths to match actual user home
sed -i "s|/home/pi/music|$MUSIC_DIR|g" /etc/liquidsoap/disco.liq

# Patch disco.conf music paths
sed -i "s|/home/pi/music|$MUSIC_DIR|g" "$INSTALL_DIR/config/disco.conf"

echo "[8/10] Configuring network..."
# Raspberry Pi OS Trixie uses NetworkManager; older versions use dhcpcd
if command -v nmcli &>/dev/null; then
  echo "  Detected NetworkManager, configuring static IP..."
  # Permanently stop NetworkManager from managing wlan0 (hostapd will manage it)
  nmcli device set wlan0 managed no 2>/dev/null || true
  mkdir -p /etc/NetworkManager/conf.d
  cat > /etc/NetworkManager/conf.d/99-disco.conf << 'NMCONFEOF'
[keyfile]
unmanaged-devices=interface-name:wlan0
NMCONFEOF
  # Set static IP on wlan0
  ip addr flush dev wlan0 2>/dev/null || true
  ip addr add 192.168.4.1/24 dev wlan0 2>/dev/null || true

  # Create a script to set IP on boot (before hostapd starts)
  cat > /etc/NetworkManager/dispatcher.d/99-disco-hotspot << 'NMEOF'
#!/bin/bash
# Ensure wlan0 has static IP for Silent Disco hotspot
if [ "$1" = "wlan0" ]; then
  ip addr flush dev wlan0 2>/dev/null
  ip addr add 192.168.4.1/24 dev wlan0 2>/dev/null
fi
NMEOF
  chmod +x /etc/NetworkManager/dispatcher.d/99-disco-hotspot

  # Also create a systemd service to set the IP before hostapd starts
  cat > /etc/systemd/system/disco-network.service << 'SVCEOF'
[Unit]
Description=Silent Disco - Configure wlan0 static IP
Before=hostapd.service dnsmasq.service
After=network-pre.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/rfkill unblock wifi
ExecStart=/sbin/ip link set wlan0 up
ExecStart=/sbin/ip addr flush dev wlan0
ExecStart=/sbin/ip addr add 192.168.4.1/24 dev wlan0

[Install]
WantedBy=multi-user.target
SVCEOF
  systemctl daemon-reload
  systemctl enable disco-network

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

echo "[9/11] Installing Bluetooth audio packages..."
apt-get install -y -qq \
  bluez-alsa-utils \
  python3-dbus \
  python3-gi \
  bluez-tools

echo "[10/11] Configuring Bluetooth audio..."
chmod +x "$INSTALL_DIR/config/bt-capture.sh"

# ALSA loopback module on boot (BT audio → Liquidsoap bridge)
echo "snd-aloop" > /etc/modules-load.d/snd-aloop.conf
modprobe snd-aloop 2>/dev/null || true

# Configure BlueZ for auto-pairing
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

# Disable built-in BT on boot (shares radio with WiFi — causes interference)
# Only the USB dongle should be used for Bluetooth
cat > /etc/systemd/system/disco-bt-setup.service << 'SVCEOF'
[Unit]
Description=Silent Disco - Disable built-in BT and configure USB dongle
After=bluetooth.service
Requires=bluetooth.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/bash -c "sleep 2 && hciconfig hci0 down 2>/dev/null; true"

[Install]
WantedBy=multi-user.target
SVCEOF

# bluealsa-aplay service: routes BT audio to ALSA loopback
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

# Python auto-accept pairing agent service
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

echo "[11/11] Enabling services..."
systemctl unmask hostapd 2>/dev/null || true
systemctl daemon-reload
systemctl enable hostapd dnsmasq icecast2 liquidsoap-disco disco-api nginx \
  bluetooth bluealsa disco-bt-audio disco-bt-agent disco-bt-setup

echo "[11/11] Testing Nginx configuration..."
nginx -t

echo ""
echo "============================================="
echo "  Installation complete!"
echo "============================================="
echo ""
echo "  WiFi SSID:     SilentDisco"
echo "  WiFi Password: letsdance"
echo "  Web Portal:    http://192.168.4.1"
echo "  Admin Panel:   http://192.168.4.1/admin.html"
echo "  Admin Pass:    disco2024"
echo ""
echo "  Music folders:"
echo "    $MUSIC_DIR/red/"
echo "    $MUSIC_DIR/green/"
echo "    $MUSIC_DIR/blue/"
echo ""
echo "  Bluetooth:"
echo "    Device name: SilentDisco"
echo "    Phones can pair and stream audio"
echo "    Auto-assigns to Blue > Green > Red"
echo ""
echo "  Copy MP3 files to the music folders, then reboot:"
echo "    sudo reboot"
echo ""
echo "============================================="
