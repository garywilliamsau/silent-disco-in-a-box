#!/usr/bin/env bash
set -uo pipefail
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$(dirname "$0")"

retry() {
  local out="$1"; shift
  for q in "$@"; do
    echo "=== RETRY: $q ==="
    spotdl download "$q" --output "$out/{artist} - {title}.{output-ext}" \
      --format mp3 --bitrate 320k || echo "STILL FAILED: $q"
  done
}

retry downloads/christmas \
  "Jona Lewie - Stop the Cavalry" \
  "The Crystals - Santa Claus Is Coming to Town" \
  "Gene Autry - Rudolph the Red-Nosed Reindeer" \
  "Leona Lewis - One More Sleep" \
  "Destiny's Child - 8 Days of Christmas" \
  "Gwen Stefani - You Make It Feel Like Christmas" \
  "Frank Sinatra - Santa Claus Is Comin' to Town" \
  "Ella Fitzgerald - Sleigh Ride" \
  "Idina Menzel Michael Buble - Baby It's Cold Outside"

retry downloads/hot \
  "Pharrell Williams - Happy" \
  "Justin Timberlake - Can't Stop the Feeling" \
  "Black Eyed Peas - I Gotta Feeling"

retry downloads/retro \
  "Groove Armada - Superstylin" \
  "David Guetta Kelly Rowland - When Love Takes Over"

echo "RETRY COMPLETE"
