#!/bin/bash
# Provision campaign1 data for all existing players
# This copies data/defaults/campaign1/{characters,npcs} into each player's campaign1 directory

set -e

DATA_DIR="$(dirname "$0")/../data"
DEFAULTS_DIR="$DATA_DIR/defaults/campaign1"
PLAYERS_DIR="$DATA_DIR/players"

if [ ! -d "$DEFAULTS_DIR/characters" ] || [ -z "$(ls -A "$DEFAULTS_DIR/characters" 2>/dev/null)" ]; then
  echo "No campaign1 default characters found. Skipping."
  exit 0
fi

echo "Provisioning campaign1 data for existing players..."

for player_dir in "$PLAYERS_DIR"/*/; do
  player=$(basename "$player_dir")
  if [ "$player" = "noDelete.txt" ]; then continue; fi

  c1_dir="$player_dir/campaign1"
  chars_dir="$c1_dir/characters"
  npcs_dir="$c1_dir/npcs"
  sessions_dir="$c1_dir/sessions"

  mkdir -p "$chars_dir" "$npcs_dir" "$sessions_dir"

  # Copy character defaults (don't overwrite existing)
  if [ -d "$DEFAULTS_DIR/characters" ]; then
    for f in "$DEFAULTS_DIR/characters"/*.json; do
      [ -f "$f" ] || continue
      dest="$chars_dir/$(basename "$f")"
      if [ ! -f "$dest" ]; then
        cp "$f" "$dest"
        echo "  $player: copied $(basename "$f") to characters/"
      fi
    done
  fi

  # Copy NPC defaults (don't overwrite existing)
  if [ -d "$DEFAULTS_DIR/npcs" ]; then
    for f in "$DEFAULTS_DIR/npcs"/*.json; do
      [ -f "$f" ] || continue
      dest="$npcs_dir/$(basename "$f")"
      if [ ! -f "$dest" ]; then
        cp "$f" "$dest"
        echo "  $player: copied $(basename "$f") to npcs/"
      fi
    done
  fi
done

echo "Done!"
