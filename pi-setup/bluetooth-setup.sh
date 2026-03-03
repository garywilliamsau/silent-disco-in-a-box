#!/bin/bash
# Silent Disco - Bluetooth Audio Setup
# Configures the Pi as a Bluetooth A2DP audio sink
# Phones can pair and stream music to the Pi
# Run with: sudo bash bluetooth-setup.sh

set -euo pipefail

if [ "$EUID" -ne 0 ]; then
  echo "Please run as root: sudo bash bluetooth-setup.sh"
  exit 1
fi

PI_USER="${SUDO_USER:-$(logname 2>/dev/null || echo pi)}"

echo "============================================="
echo "  Silent Disco - Bluetooth Setup"
echo "============================================="

echo ""
echo "[1/5] Installing Bluetooth packages..."
apt-get update -qq
apt-get install -y -qq \
  bluez \
  pulseaudio \
  pulseaudio-module-bluetooth

echo "[2/5] Configuring PulseAudio system mode..."
# PulseAudio in system mode so liquidsoap (any user) can access BT audio
cat > /etc/pulse/system.pa << 'PAEOF'
# PulseAudio system mode for Silent Disco Bluetooth audio
load-module module-native-protocol-unix auth-anonymous=1 socket=/run/pulse/native
load-module module-bluetooth-policy
load-module module-bluetooth-discover
load-module module-always-sink
load-module module-position-event-sounds
PAEOF

# Create systemd service for PulseAudio in system mode
cat > /etc/systemd/system/pulseaudio-system.service << 'SVCEOF'
[Unit]
Description=PulseAudio System Mode (Bluetooth Audio)
After=bluetooth.service
Requires=bluetooth.service

[Service]
Type=notify
ExecStart=/usr/bin/pulseaudio --system --disallow-exit --disallow-module-loading=0
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
SVCEOF

# Create runtime directory for PulseAudio socket
mkdir -p /run/pulse
chmod 755 /run/pulse

# Create tmpfiles.d entry so the directory persists across reboots
cat > /etc/tmpfiles.d/pulse.conf << 'TMPEOF'
d /run/pulse 0755 pulse pulse -
TMPEOF

# Add liquidsoap and pi user to pulse-access group
usermod -aG pulse-access liquidsoap 2>/dev/null || true
usermod -aG pulse-access "$PI_USER" 2>/dev/null || true

echo "[3/5] Configuring Bluetooth..."
# Enable Bluetooth adapter
rfkill unblock bluetooth 2>/dev/null || true

# Configure BlueZ for auto-pairing and A2DP
cat > /etc/bluetooth/main.conf << 'BTEOF'
[General]
Name = SilentDisco
Class = 0x200414
DiscoverableTimeout = 0
PairableTimeout = 0
Discoverable = true
Pairable = true

[Policy]
AutoEnable=true
BTEOF

# Create a simple auto-accept pairing agent
cat > /opt/disco/config/bt-agent.sh << 'AGENTEOF'
#!/bin/bash
# Silent Disco - Bluetooth Auto-Accept Agent
# Accepts all pairing requests and sets devices as trusted
# Uses bluetoothctl in agent mode

# Register as default agent
bluetoothctl << EOF
power on
discoverable on
pairable on
agent NoInputNoOutput
default-agent
EOF

# Keep running and auto-trust connected devices
while true; do
  # Find newly connected devices and trust them
  bluetoothctl devices Connected 2>/dev/null | while read -r _ MAC _; do
    bluetoothctl trust "$MAC" 2>/dev/null
  done
  sleep 5
done
AGENTEOF
chmod +x /opt/disco/config/bt-agent.sh

# Create systemd service for the BT agent
cat > /etc/systemd/system/disco-bt-agent.service << 'SVCEOF'
[Unit]
Description=Silent Disco Bluetooth Agent
After=bluetooth.service
Requires=bluetooth.service

[Service]
Type=simple
ExecStart=/opt/disco/config/bt-agent.sh
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SVCEOF

echo "[4/5] Enabling services..."
systemctl daemon-reload
systemctl enable bluetooth pulseaudio-system disco-bt-agent
systemctl start bluetooth

echo "[5/5] Making Bluetooth discoverable..."
bluetoothctl power on 2>/dev/null || true
bluetoothctl discoverable on 2>/dev/null || true
bluetoothctl pairable on 2>/dev/null || true

echo ""
echo "============================================="
echo "  Bluetooth setup complete!"
echo "============================================="
echo ""
echo "  Device name: SilentDisco"
echo "  Phones can find and pair via Bluetooth"
echo "  Audio will be available as an input source"
echo ""
echo "  Reboot to activate all services:"
echo "    sudo reboot"
echo ""
echo "============================================="
