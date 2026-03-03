#!/bin/bash
# Silent Disco in a Box - Master Installation Script
# Run on a fresh Raspberry Pi OS Lite (64-bit)
# Usage: sudo bash install.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
INSTALL_DIR="/opt/disco"
WEB_DIR="/var/www/disco"
MUSIC_DIR="/home/pi/music"

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
  git

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

chown -R pi:pi "$MUSIC_DIR"
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

# systemd services
cp "$INSTALL_DIR/systemd/liquidsoap-disco.service" /etc/systemd/system/
cp "$INSTALL_DIR/systemd/disco-api.service" /etc/systemd/system/

echo "[8/10] Configuring network..."
if ! grep -q "# Silent Disco hotspot" /etc/dhcpcd.conf 2>/dev/null; then
  cat >> /etc/dhcpcd.conf << 'EOF'

# Silent Disco hotspot
interface wlan0
    static ip_address=192.168.4.1/24
    nohook wpa_supplicant
EOF
fi

echo "[9/10] Enabling services..."
systemctl unmask hostapd 2>/dev/null || true
systemctl daemon-reload
systemctl enable hostapd dnsmasq icecast2 liquidsoap-disco disco-api nginx

echo "[10/10] Testing Nginx configuration..."
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
echo "  Copy MP3 files to these folders, then reboot:"
echo "    sudo reboot"
echo ""
echo "============================================="
