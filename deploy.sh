#!/bin/bash
# Silent Disco - Deploy to Pi
# Usage: bash deploy.sh [pi-ip] [user] [password]

PI_IP="${1:-192.168.0.200}"
PI_USER="${2:-silentdisco}"
PI_PASS="${3:-raspberry}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

run_ssh() {
  sshpass -p "$PI_PASS" ssh -o StrictHostKeyChecking=no "$PI_USER@$PI_IP" "$@"
}

run_scp() {
  sshpass -p "$PI_PASS" scp -o StrictHostKeyChecking=no "$@"
}

echo "Deploying to $PI_USER@$PI_IP..."

# Ensure temp dirs exist
run_ssh "mkdir -p /tmp/disco-js /tmp/disco-css /tmp/disco-lib"

# Ensure music library and playlists directories exist
run_ssh "mkdir -p /home/$PI_USER/music/library /home/$PI_USER/music/playlists"

# Web files
echo "[1/4] Web files..."
run_scp "$SCRIPT_DIR/web/index.html" "$SCRIPT_DIR/web/admin.html" "$PI_USER@$PI_IP:/tmp/"
run_scp "$SCRIPT_DIR/web/js/"*.js "$PI_USER@$PI_IP:/tmp/disco-js/"
run_scp "$SCRIPT_DIR/web/css/"*.css "$PI_USER@$PI_IP:/tmp/disco-css/"
run_ssh "sudo cp /tmp/index.html /tmp/admin.html /var/www/disco/ && sudo cp /tmp/disco-js/*.js /var/www/disco/js/ && sudo cp /tmp/disco-css/*.css /var/www/disco/css/"

# Server files
echo "[2/4] Server files..."
run_scp "$SCRIPT_DIR/server/server.js" "$SCRIPT_DIR/server/package.json" "$PI_USER@$PI_IP:/tmp/"
run_scp "$SCRIPT_DIR/server/lib/"*.js "$PI_USER@$PI_IP:/tmp/disco-lib/"
run_ssh "sudo cp /tmp/server.js /tmp/package.json /opt/disco/server/ && sudo cp /tmp/disco-lib/*.js /opt/disco/server/lib/ && cd /opt/disco/server && sudo npm install --production --silent 2>&1 | tail -1"

# Config files
echo "[3/4] Config files..."
run_scp "$SCRIPT_DIR/config/disco.liq" "$SCRIPT_DIR/config/nginx-disco.conf" "$SCRIPT_DIR/config/bt-capture.sh" "$SCRIPT_DIR/config/bt-auto-agent.py" "$SCRIPT_DIR/config/bt-setup.sh" "$SCRIPT_DIR/config/linein-capture.sh" "$SCRIPT_DIR/config/spotify-capture.sh" "$PI_USER@$PI_IP:/tmp/"
run_ssh "sudo cp /tmp/nginx-disco.conf /etc/nginx/sites-available/disco && sudo cp /tmp/bt-capture.sh /tmp/bt-auto-agent.py /tmp/bt-setup.sh /tmp/linein-capture.sh /tmp/spotify-capture.sh /opt/disco/config/ && sudo chmod +x /opt/disco/config/bt-capture.sh /opt/disco/config/bt-setup.sh /opt/disco/config/linein-capture.sh /opt/disco/config/spotify-capture.sh"

# Restart services
echo "[4/4] Restarting services..."
NEED_LIQUIDSOAP=false
if run_ssh "diff -q /tmp/disco.liq /etc/liquidsoap/disco.liq" > /dev/null 2>&1; then
  echo "  Liquidsoap config unchanged, skipping restart"
else
  NEED_LIQUIDSOAP=true
  run_ssh "sudo cp /tmp/disco.liq /etc/liquidsoap/disco.liq && sudo sed -i 's|/home/pi/music|/home/$PI_USER/music|g' /etc/liquidsoap/disco.liq"
fi

run_ssh "sudo nginx -t 2>&1 && sudo systemctl reload nginx && sudo systemctl restart disco-api"
echo "  API restarted, Nginx reloaded"

if [ "$NEED_LIQUIDSOAP" = true ]; then
  echo "  Restarting Liquidsoap (takes ~90s)..."
  run_ssh "sudo systemctl restart liquidsoap-disco"
fi

# Cleanup
run_ssh "rm -rf /tmp/disco-js /tmp/disco-css /tmp/disco-lib /tmp/index.html /tmp/admin.html /tmp/server.js /tmp/package.json /tmp/disco.liq /tmp/nginx-disco.conf /tmp/bt-capture.sh /tmp/bt-auto-agent.py /tmp/bt-setup.sh /tmp/linein-capture.sh /tmp/spotify-capture.sh 2>/dev/null"

echo ""
echo "Deploy complete!"
