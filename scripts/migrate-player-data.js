#!/usr/bin/env node

/**
 * One-time migration: provision per-player data directories.
 *
 * For each registered player in data/players.json:
 *   1. Creates data/players/<slug>/characters/ and data/players/<slug>/npcs/
 *   2. Copies current data/characters/*.json and data/npcs/*.json into each
 *   3. Adds "status": "alive" to all copied files if missing
 *   4. Also updates data/defaults/ files to include "status": "alive"
 *
 * Safe to run multiple times — existing player files are NOT overwritten.
 */

const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
const playersFile = path.join(dataDir, 'players.json');

function emailToSlug(email) {
  return String(email).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function addStatusAlive(data) {
  if (!data.status) {
    data.status = 'alive';
  }
  return data;
}

function copyJsonFiles(srcDir, destDir, overwrite = false) {
  if (!fs.existsSync(srcDir)) return 0;
  const files = fs.readdirSync(srcDir).filter(f => f.endsWith('.json'));
  let copied = 0;
  for (const file of files) {
    const destPath = path.join(destDir, file);
    if (!overwrite && fs.existsSync(destPath)) continue;
    const data = JSON.parse(fs.readFileSync(path.join(srcDir, file), 'utf-8'));
    addStatusAlive(data);
    fs.writeFileSync(destPath, JSON.stringify(data, null, 2));
    copied++;
  }
  return copied;
}

// --- Main ---
if (!fs.existsSync(playersFile)) {
  console.log('No players.json found — nothing to migrate.');
  process.exit(0);
}

const players = JSON.parse(fs.readFileSync(playersFile, 'utf-8'));
const emails = Object.keys(players);

if (emails.length === 0) {
  console.log('No registered players — nothing to migrate.');
  process.exit(0);
}

const charSrc = path.join(dataDir, 'characters');
const npcSrc = path.join(dataDir, 'npcs');

console.log(`Migrating ${emails.length} player(s)...`);

for (const email of emails) {
  const slug = emailToSlug(email);
  const playerDir = path.join(dataDir, 'players', slug);
  const charDest = path.join(playerDir, 'characters');
  const npcDest = path.join(playerDir, 'npcs');

  fs.mkdirSync(charDest, { recursive: true });
  fs.mkdirSync(npcDest, { recursive: true });

  const charCount = copyJsonFiles(charSrc, charDest);
  const npcCount = copyJsonFiles(npcSrc, npcDest);

  console.log(`  ${email} (${slug}): ${charCount} characters, ${npcCount} NPCs copied`);
}

// Update defaults to include status: alive
const defaultChars = path.join(dataDir, 'defaults', 'characters');
const defaultNpcs = path.join(dataDir, 'defaults', 'npcs');
let defaultsUpdated = 0;

for (const dir of [defaultChars, defaultNpcs]) {
  if (!fs.existsSync(dir)) continue;
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
    const filePath = path.join(dir, file);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (!data.status) {
      data.status = 'alive';
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
      defaultsUpdated++;
    }
  }
}

console.log(`Updated ${defaultsUpdated} default file(s) with "status": "alive".`);
console.log('Migration complete.');
