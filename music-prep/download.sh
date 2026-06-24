#!/usr/bin/env bash
# Download one song-list into a folder of mp3s using spotdl.
# Usage:  ./download.sh <listfile.txt> <output-dir>
# Re-running is safe: spotdl skips files that already exist (resumable).
set -uo pipefail

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

LIST="${1:?usage: ./download.sh <listfile> <outdir>}"
OUT="${2:?usage: ./download.sh <listfile> <outdir>}"

mkdir -p "$OUT"

# Read non-empty, non-comment lines into an array (bash 3.2 / zsh compatible).
QUERIES=()
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    ''|\#*) continue ;;
  esac
  QUERIES+=("$line")
done < "$LIST"

echo ">>> ${#QUERIES[@]} tracks from $LIST -> $OUT"

# One spotdl process, parallel downloads, mp3 @ 320k.
# Default overwrite=skip makes re-runs resume where they left off.
spotdl download "${QUERIES[@]}" \
  --output "$OUT/{artist} - {title}.{output-ext}" \
  --format mp3 \
  --bitrate 320k \
  --threads 4

echo ">>> done: $OUT"
ls -1 "$OUT" | wc -l | xargs echo "files now in $OUT:"
