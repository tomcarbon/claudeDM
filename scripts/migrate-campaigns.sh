#!/usr/bin/env bash
# One-time migration: restructure data into campaign-scoped directories
# Idempotent — safe to run multiple times
set -euo pipefail

cd "$(dirname "$0")/.."
DATA="data"

echo "=== Campaign Migration Script ==="

# --- 1. Defaults: move to data/defaults/demo/ ---
if [ -d "$DATA/defaults/characters" ] && [ ! -d "$DATA/defaults/demo" ]; then
  echo "Moving defaults → defaults/demo/"
  mkdir -p "$DATA/defaults/demo"
  mv "$DATA/defaults/characters" "$DATA/defaults/demo/characters"
  mv "$DATA/defaults/npcs" "$DATA/defaults/demo/npcs"
  [ -d "$DATA/defaults/scenarios" ] && mv "$DATA/defaults/scenarios" "$DATA/defaults/demo/scenarios"
  [ -f "$DATA/defaults/dm-settings.json" ] && mv "$DATA/defaults/dm-settings.json" "$DATA/defaults/demo/dm-settings.json"
  echo "  Done."
else
  echo "Defaults already migrated (or not found). Skipping."
fi

# --- 2. Scenarios: move to data/campaigns/demo/scenarios/ ---
if [ -d "$DATA/scenarios" ] && [ ! -d "$DATA/campaigns/demo/scenarios" ]; then
  echo "Moving scenarios → campaigns/demo/scenarios/"
  mkdir -p "$DATA/campaigns/demo/scenarios"
  for f in "$DATA/scenarios/"*.json; do
    [ -f "$f" ] && mv "$f" "$DATA/campaigns/demo/scenarios/"
  done
  echo "  Done."
else
  echo "Scenarios already migrated. Skipping."
fi

# --- 3. Campaign metadata: move the-shattered-coast.json → campaigns/demo/campaign.json ---
if [ -f "$DATA/campaigns/the-shattered-coast.json" ] && [ ! -f "$DATA/campaigns/demo/campaign.json" ]; then
  echo "Moving campaign metadata → campaigns/demo/campaign.json"
  # Update the id field to "demo"
  python3 -c "
import json, sys
with open('$DATA/campaigns/the-shattered-coast.json') as f:
    d = json.load(f)
d['id'] = 'demo'
with open('$DATA/campaigns/demo/campaign.json', 'w') as f:
    json.dump(d, f, indent=2)
print('  Written campaign.json with id=demo')
"
  rm "$DATA/campaigns/the-shattered-coast.json"
else
  echo "Campaign metadata already migrated. Skipping."
fi

# --- 4. Player data: move characters/npcs into demo/ subdir ---
if [ -d "$DATA/players" ]; then
  for playerDir in "$DATA/players"/*/; do
    slug=$(basename "$playerDir")
    # Skip hidden dirs and files
    [[ "$slug" == .* ]] && continue

    if [ -d "$playerDir/characters" ] && [ ! -d "$playerDir/demo" ]; then
      echo "Migrating player '$slug' → demo/"
      mkdir -p "$playerDir/demo"
      mv "$playerDir/characters" "$playerDir/demo/characters"
      mv "$playerDir/npcs" "$playerDir/demo/npcs"
      echo "  Done."
    else
      echo "Player '$slug' already migrated. Skipping."
    fi
  done
fi

# --- 5. Sessions: move to per-player demo/sessions/ ---
if [ -d "$DATA/sessions" ]; then
  echo "Migrating sessions to per-player campaign dirs..."
  for sessionFile in "$DATA/sessions/"*.json; do
    [ -f "$sessionFile" ] || continue
    fname=$(basename "$sessionFile")
    [ "$fname" = "noDelete.txt" ] && continue

    # Extract ownerEmail from session JSON
    ownerEmail=$(python3 -c "
import json, sys, re
try:
    with open('$sessionFile') as f:
        d = json.load(f)
    email = d.get('ownerEmail') or d.get('playerEmail') or ''
    slug = re.sub(r'[^a-z0-9]+', '-', email.strip().lower())
    print(slug)
except:
    print('')
" 2>/dev/null)

    if [ -n "$ownerEmail" ] && [ -d "$DATA/players/$ownerEmail" ]; then
      mkdir -p "$DATA/players/$ownerEmail/demo/sessions"
      mv "$sessionFile" "$DATA/players/$ownerEmail/demo/sessions/$fname"
      echo "  Moved $fname → players/$ownerEmail/demo/sessions/"
    else
      echo "  WARN: Could not find player dir for session $fname (owner: '$ownerEmail'). Left in place."
    fi
  done
fi

# --- 6. Create campaign1 directories ---
echo "Creating campaign1 (Underdark) directory structure..."
mkdir -p "$DATA/campaigns/campaign1/scenarios"
mkdir -p "$DATA/defaults/campaign1/characters"
mkdir -p "$DATA/defaults/campaign1/npcs"
echo "  Done."

echo ""
echo "=== Migration Complete ==="
echo "Directory structure:"
echo "  data/defaults/demo/{characters,npcs}"
echo "  data/defaults/campaign1/{characters,npcs}"
echo "  data/campaigns/demo/{campaign.json,scenarios/}"
echo "  data/campaigns/campaign1/{campaign.json,scenarios/}"
echo "  data/players/<slug>/demo/{characters,npcs,sessions}"
