#!/usr/bin/env node
/**
 * Phase 1 Migration: Move sessions from player directories to neutral shared location.
 *
 * Before: data/players/<slug>/<campaign>/sessions/<id>.json
 *         data/players/<slug>/<campaign>/sessions/<id>/characters/
 *         data/players/<slug>/<campaign>/sessions/<id>/npcs/
 *
 * After:  data/sessions/<id>/session.json
 *         data/sessions/<id>/characters/
 *         data/sessions/<id>/npcs/
 *
 * Also removes empty player NPC directories (data/players/<slug>/<campaign>/npcs/).
 *
 * This script is idempotent — it skips files/dirs that already exist at the target location.
 *
 * Usage: node scripts/migrate-sessions-phase1.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const PLAYERS_DIR = path.join(DATA_DIR, 'players');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const DRY_RUN = process.argv.includes('--dry-run');

let movedFiles = 0;
let movedDirs = 0;
let skipped = 0;
let removedDirs = 0;
let errors = 0;

function log(msg) {
  console.log(`${DRY_RUN ? '[DRY RUN] ' : ''}${msg}`);
}

function copyDirRecursive(src, dst) {
  if (!fs.existsSync(src)) return;
  if (!DRY_RUN) fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src)) {
    const srcPath = path.join(src, entry);
    const dstPath = path.join(dst, entry);
    const stat = fs.statSync(srcPath);
    if (stat.isDirectory()) {
      copyDirRecursive(srcPath, dstPath);
    } else {
      if (fs.existsSync(dstPath)) {
        log(`  SKIP (exists): ${dstPath}`);
        skipped++;
      } else {
        log(`  COPY: ${srcPath} → ${dstPath}`);
        if (!DRY_RUN) fs.copyFileSync(srcPath, dstPath);
        movedFiles++;
      }
    }
  }
}

function isDirEmpty(dir) {
  try {
    return fs.readdirSync(dir).length === 0;
  } catch {
    return true;
  }
}

function main() {
  log('=== Phase 1 Migration: Move sessions to neutral shared location ===\n');

  if (!fs.existsSync(PLAYERS_DIR)) {
    log('No players directory found. Nothing to migrate.');
    return;
  }

  // Ensure target sessions directory exists
  if (!DRY_RUN) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

  const playerSlugs = fs.readdirSync(PLAYERS_DIR).filter(d => {
    try { return fs.statSync(path.join(PLAYERS_DIR, d)).isDirectory(); } catch { return false; }
  });

  for (const slug of playerSlugs) {
    const playerDir = path.join(PLAYERS_DIR, slug);
    const campaigns = fs.readdirSync(playerDir).filter(d => {
      try { return fs.statSync(path.join(playerDir, d)).isDirectory(); } catch { return false; }
    });

    for (const cid of campaigns) {
      // Skip non-campaign directories (e.g. dm-settings)
      const sessDir = path.join(playerDir, cid, 'sessions');
      if (!fs.existsSync(sessDir)) continue;

      log(`\nScanning: ${slug}/${cid}/sessions/`);

      const entries = fs.readdirSync(sessDir);
      for (const entry of entries) {
        const srcPath = path.join(sessDir, entry);
        const stat = fs.statSync(srcPath);

        if (stat.isFile() && entry.endsWith('.json')) {
          // Session JSON file: <id>.json → data/sessions/<id>/session.json
          const sessionId = path.basename(entry, '.json');
          const targetDir = path.join(SESSIONS_DIR, sessionId);
          const targetFile = path.join(targetDir, 'session.json');

          if (fs.existsSync(targetFile)) {
            log(`  SKIP (exists): ${targetFile}`);
            skipped++;
            continue;
          }

          log(`  MOVE: ${srcPath} → ${targetFile}`);
          if (!DRY_RUN) {
            fs.mkdirSync(targetDir, { recursive: true });
            fs.copyFileSync(srcPath, targetFile);
            fs.unlinkSync(srcPath);
          }
          movedFiles++;

        } else if (stat.isDirectory()) {
          // Session snapshot directory: <id>/ → data/sessions/<id>/
          const sessionId = entry;
          const targetDir = path.join(SESSIONS_DIR, sessionId);

          if (fs.existsSync(targetDir)) {
            // Target exists — merge contents (copyDirRecursive handles skip-if-exists)
            log(`  MERGE: ${srcPath} → ${targetDir}`);
          } else {
            log(`  MOVE DIR: ${srcPath} → ${targetDir}`);
          }

          try {
            copyDirRecursive(srcPath, targetDir);
            // Remove source dir after successful copy
            if (!DRY_RUN) fs.rmSync(srcPath, { recursive: true, force: true });
            movedDirs++;
          } catch (err) {
            console.error(`  ERROR moving ${srcPath}: ${err.message}`);
            errors++;
          }
        }
      }

      // Clean up empty sessions directory
      if (isDirEmpty(sessDir)) {
        log(`  RMDIR (empty): ${sessDir}`);
        if (!DRY_RUN) { try { fs.rmdirSync(sessDir); } catch { /* ignore */ } }
        removedDirs++;
      }

      // Clean up player NPC directory (no longer needed)
      const npcDir = path.join(playerDir, cid, 'npcs');
      if (fs.existsSync(npcDir)) {
        log(`  RMDIR (player npcs): ${npcDir}`);
        if (!DRY_RUN) { try { fs.rmSync(npcDir, { recursive: true, force: true }); } catch { /* ignore */ } }
        removedDirs++;
      }
    }
  }

  log('\n=== Migration Summary ===');
  log(`Files moved:      ${movedFiles}`);
  log(`Dirs moved:       ${movedDirs}`);
  log(`Dirs removed:     ${removedDirs}`);
  log(`Skipped (exists): ${skipped}`);
  log(`Errors:           ${errors}`);
  if (DRY_RUN) log('\nThis was a DRY RUN. No files were modified. Run without --dry-run to execute.');
}

main();
