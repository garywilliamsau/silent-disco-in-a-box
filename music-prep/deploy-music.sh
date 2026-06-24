#!/usr/bin/env bash
# Push downloaded tracks + the 3 new playlists to the Pi.
# Does NOT reassign live channels — that stays a manual confirm step.
set -euo pipefail
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$(dirname "$0")"

PI_IP="${1:-192.168.0.99}"
PI_USER="${2:-silentdisco}"
PI_PASS="${3:-raspberry}"
TOKEN="disco2024"
LIBDIR="/home/$PI_USER/music/library"
PLDIR="/home/$PI_USER/music/playlists"

S() { sshpass -p "$PI_PASS" ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 "$PI_USER@$PI_IP" "$@"; }

# 1. Stage upload files (hard-link, flat) from out/upload-list.txt
echo "[1/5] Staging files to upload..."
rm -rf out/upload && mkdir -p out/upload
n=0
while IFS= read -r p; do
  [ -z "$p" ] && continue
  ln -f "$p" "out/upload/$(basename "$p")" 2>/dev/null || cp "$p" "out/upload/$(basename "$p")"
  n=$((n+1))
done < out/upload-list.txt
echo "      staged $n files"

# 2. scp into the library (reliable across macOS openrsync quirks)
echo "[2/5] Uploading audio to $LIBDIR (this is the big step)..."
sshpass -p "$PI_PASS" scp -o StrictHostKeyChecking=no -q \
  out/upload/*.mp3 "$PI_USER@$PI_IP:$LIBDIR/"

# 3. Copy the 3 playlist JSONs
echo "[3/5] Uploading playlists to $PLDIR..."
sshpass -p "$PI_PASS" scp -o StrictHostKeyChecking=no \
  out/christmas-in-july.json out/dancefloor-hits.json out/retro-dance-bangers.json \
  "$PI_USER@$PI_IP:$PLDIR/"

# 4. Force a full library catalog rebuild
echo "[4/5] Rebuilding library catalog + restarting API..."
S "rm -f $LIBDIR/catalog.json && sudo systemctl restart disco-api && sleep 4 && \
   curl -s -H 'Authorization: Bearer $TOKEN' http://localhost:3000/api/library | \
   python3 -c 'import json,sys; print(\"      library now has\", len(json.load(sys.stdin)), \"tracks\")'"

# 5. Show playlists the API can see
echo "[5/5] Verifying playlists visible to API..."
S "curl -s -H 'Authorization: Bearer $TOKEN' http://localhost:3000/api/playlists | \
   python3 -c 'import json,sys; [print(\"      -\", p[\"name\"], \"(\"+str(p[\"trackCount\"])+\" tracks, id=\"+p[\"id\"]+\")\") for p in json.load(sys.stdin)]'"

echo ""
echo "DONE. New playlists are on the Pi but NOT yet assigned to channels."
