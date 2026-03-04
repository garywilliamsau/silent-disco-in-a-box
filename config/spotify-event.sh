#!/bin/bash
# Librespot --onevent hook: auto-enable/disable Spotify source on a channel
# Called as: spotify-event.sh <channel>
# Env: PLAYER_EVENT=playing|paused|stopped|unavailable|...

CH="$1"
API="http://127.0.0.1:3000/api/channels/$CH/spotify"
AUTH="Authorization: Bearer disco2024"

case "$PLAYER_EVENT" in
  playing)
    curl -s --max-time 5 -X POST "$API" \
      -H "$AUTH" \
      -H "Content-Type: application/json" \
      -d '{"enabled":true}' \
      >/dev/null 2>&1
    ;;
  stopped|paused|unavailable|session_disconnected)
    curl -s --max-time 5 -X POST "$API" \
      -H "$AUTH" \
      -H "Content-Type: application/json" \
      -d '{"enabled":false}' \
      >/dev/null 2>&1
    ;;
esac
