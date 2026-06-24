#!/usr/bin/env bash
# Deploy just the "Restart Audio Engine" button: server.js + admin.html + admin.js
set -euo pipefail
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
REPO="/Users/gary/Documents/AI Silent Disco"
PI=silentdisco@192.168.0.99
PASS=raspberry
S() { sshpass -p "$PASS" ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 "$PI" "$@"; }
CP() { sshpass -p "$PASS" scp -o StrictHostKeyChecking=no "$@"; }

echo "[1/4] Copying files to /tmp on Pi..."
CP "$REPO/server/server.js"      "$PI:/tmp/server.js"
CP "$REPO/web/admin.html"        "$PI:/tmp/admin.html"
CP "$REPO/web/js/admin.js"       "$PI:/tmp/admin.js"

echo "[2/4] Installing into place (sudo)..."
S "sudo cp /tmp/server.js /opt/disco/server/server.js && \
   sudo cp /tmp/admin.html /var/www/disco/admin.html && \
   sudo cp /tmp/admin.js /var/www/disco/js/admin.js"

echo "[3/4] Restarting disco-api (~3s)..."
S "sudo systemctl restart disco-api && sleep 3 && systemctl is-active disco-api"

echo "[4/4] Verifying the new endpoint exists (expect ok:true)..."
S "curl -s -X POST -H 'Authorization: Bearer disco2024' http://localhost:3000/api/admin/system/__probe__ ; echo"
echo "  ^ '__probe__' should return 'Unknown action' (proves the route is live & auth works)"
echo "DONE — refresh the admin page (hard refresh) to see the button."
