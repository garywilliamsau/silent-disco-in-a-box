#!/bin/bash
# Silent Disco - Set up a brand new Pi
# Run from your Mac after imaging a fresh Pi OS and connecting via ethernet
#
# Usage: bash setup-new-pi.sh [pi-ip] [user] [password]
#
# Prerequisites:
#   1. Flash Raspberry Pi OS Lite (64-bit) with Pi Imager
#   2. Set username, password, enable SSH in imager settings
#   3. Plug in ethernet and boot the Pi
#   4. Find the Pi's IP (check your router or scan with: arp -a | grep -i "d8:3a:dd\|dc:a6:32")
#   5. Run this script

PI_IP="${1:-192.168.0.215}"
PI_USER="${2:-silentdisco}"
PI_PASS="${3:-raspberry}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

if ! command -v sshpass &>/dev/null; then
  echo "Installing sshpass..."
  brew install hudochenkov/sshpass/sshpass 2>/dev/null || brew install sshpass
fi

echo "============================================="
echo "  Silent Disco - New Pi Setup"
echo "============================================="
echo "  Pi: $PI_USER@$PI_IP"
echo ""

# Clear old SSH key
ssh-keygen -R "$PI_IP" 2>/dev/null

# Test connection
echo "Testing connection..."
if ! sshpass -p "$PI_PASS" ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no "$PI_USER@$PI_IP" "echo 'Connected to $(hostname)'" 2>/dev/null; then
  echo "ERROR: Cannot connect to $PI_USER@$PI_IP"
  echo "Check the Pi is powered on and the IP is correct."
  exit 1
fi

# Copy project files
echo "Copying project files to Pi..."
sshpass -p "$PI_PASS" ssh -o StrictHostKeyChecking=no "$PI_USER@$PI_IP" "mkdir -p /tmp/silent-disco"
sshpass -p "$PI_PASS" scp -o StrictHostKeyChecking=no -r \
  "$PROJECT_DIR/config" \
  "$PROJECT_DIR/server" \
  "$PROJECT_DIR/web" \
  "$PROJECT_DIR/systemd" \
  "$PROJECT_DIR/pi-setup" \
  "$PI_USER@$PI_IP:/tmp/silent-disco/"

# Run installer
echo ""
echo "Running installer on Pi (this takes 5-10 minutes)..."
echo ""
sshpass -p "$PI_PASS" ssh -o StrictHostKeyChecking=no "$PI_USER@$PI_IP" \
  "sudo bash /tmp/silent-disco/pi-setup/install.sh 2>&1"

echo ""
echo "Setup complete! Rebooting Pi..."
sshpass -p "$PI_PASS" ssh -o StrictHostKeyChecking=no "$PI_USER@$PI_IP" "sudo reboot" 2>/dev/null || true

echo ""
echo "The Pi will reboot and be ready in ~2 minutes."
echo "Connect to WiFi 'SilentDisco' (password: letsdance)"
echo "Open http://192.168.4.1 on your phone"
echo ""
