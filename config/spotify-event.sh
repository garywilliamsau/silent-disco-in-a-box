#!/bin/bash
# Librespot --onevent hook: auto-enable/disable Spotify source and report track metadata
# Called as: spotify-event.sh <channel>
# Env: PLAYER_EVENT=track_changed|playing|paused|stopped|...

CH="$1"
API="http://127.0.0.1:3000/api/channels/$CH"
AUTH="Authorization: Bearer disco2024"

case "$PLAYER_EVENT" in
  track_changed)
    # NAME, ARTISTS (newline-separated), ALBUM are set by librespot here
    BODY=$(python3 -c "
import json, os
artists = os.environ.get('ARTISTS', '').strip().replace(chr(10), ', ')
print(json.dumps({
  'title':  os.environ.get('NAME', ''),
  'artist': artists,
  'album':  os.environ.get('ALBUM', ''),
}))
")
    curl -s --max-time 5 -X POST "$API/spotify-meta" \
      -H "$AUTH" \
      -H "Content-Type: application/json" \
      -d "$BODY" >/dev/null 2>&1
    ;;
  playing)
    curl -s --max-time 5 -X POST "$API/spotify" \
      -H "$AUTH" \
      -H "Content-Type: application/json" \
      -d '{"enabled":true}' >/dev/null 2>&1
    ;;
  stopped|paused|unavailable|session_disconnected)
    curl -s --max-time 5 -X POST "$API/spotify" \
      -H "$AUTH" \
      -H "Content-Type: application/json" \
      -d '{"enabled":false}' >/dev/null 2>&1
    curl -s --max-time 5 -X DELETE "$API/spotify-meta" \
      -H "$AUTH" >/dev/null 2>&1
    ;;
esac
