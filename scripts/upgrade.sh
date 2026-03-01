#!/usr/bin/env bash
# ============================================================
# claudeDM upgrade script — run on the webserver after git pull
# Tested on Ubuntu 24.04
#
# Usage:
#   cd /path/to/claudeDM
#   bash scripts/upgrade.sh
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "=== claudeDM upgrade ==="
echo "Project directory: $PROJECT_DIR"
echo ""

cd "$PROJECT_DIR"

# --------------------------------------------------
# 1. Install / update dependencies
# --------------------------------------------------
echo "--- Installing dependencies ---"
npm install
echo ""

# --------------------------------------------------
# 2. Build the client
# --------------------------------------------------
echo "--- Building client ---"
npm run build
echo ""

# --------------------------------------------------
# 3. Ensure required data directories exist
# --------------------------------------------------
echo "--- Ensuring data directories ---"
mkdir -p data/players
mkdir -p data/defaults/characters
mkdir -p data/defaults/npcs
mkdir -p data/sessions
mkdir -p data/campaigns
mkdir -p data/chat
mkdir -p data/dm-settings
echo "  OK"
echo ""

# --------------------------------------------------
# 4. Run the player data migration (safe to re-run)
#    Copies data/characters/ and data/npcs/ into
#    per-player directories under data/players/<slug>/
# --------------------------------------------------
if [ -f scripts/migrate-player-data.js ]; then
  echo "--- Running player data migration ---"
  node scripts/migrate-player-data.js
  echo ""
else
  echo "--- No migration script found, skipping ---"
  echo ""
fi

# --------------------------------------------------
# 5. Restart the server (systemd or pm2)
# --------------------------------------------------
echo "--- Restarting server ---"
if systemctl is-active --quiet claudedm 2>/dev/null; then
  sudo systemctl restart claudedm
  echo "  Restarted via systemd (claudedm.service)"
elif command -v pm2 &>/dev/null && pm2 describe claudedm &>/dev/null 2>&1; then
  pm2 restart claudedm
  echo "  Restarted via pm2"
else
  echo "  No systemd service or pm2 process found."
  echo "  Start the server manually: npm run server"
fi
echo ""

echo "=== Upgrade complete ==="
