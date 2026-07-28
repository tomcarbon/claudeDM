const fs = require('fs');
const path = require('path');

// Throttle repeated "Corrupt file" logs. A persistently-corrupt file is re-read
// on every client poll (per player, every few seconds), which otherwise floods
// the log with an identical line forever. We log the first occurrence in full,
// then at most one summary per file every CORRUPT_LOG_SUMMARY_MS, and clear the
// record once the file reads cleanly again.
const CORRUPT_LOG_SUMMARY_MS = 5 * 60 * 1000; // 5 minutes
const corruptLogState = new Map(); // key: `${filePath}|${error}` -> { firstAt, lastSummaryAt, count }

function noteCorruptRead(filePath, error) {
  const key = `${filePath}|${error}`;
  const now = Date.now();
  const existing = corruptLogState.get(key);
  if (!existing) {
    corruptLogState.set(key, { firstAt: now, lastSummaryAt: now, count: 1 });
    console.error(`[json-recovery] Corrupt file: ${filePath} — ${error}`);
    return;
  }
  existing.count += 1;
  if (now - existing.lastSummaryAt >= CORRUPT_LOG_SUMMARY_MS) {
    const mins = Math.round((now - existing.firstAt) / 60000);
    console.error(`[json-recovery] Corrupt file (still corrupt after ${existing.count} reads over ~${mins} min): ${filePath} — ${error}`);
    existing.lastSummaryAt = now;
  }
}

function clearCorruptRead(filePath) {
  if (corruptLogState.size === 0) return;
  const prefix = `${filePath}|`;
  for (const key of corruptLogState.keys()) {
    if (key.startsWith(prefix)) corruptLogState.delete(key);
  }
}

/**
 * Write JSON atomically: write to a temp file in the same directory, then rename.
 * Readers can never observe a partially-written file.
 */
function writeJsonAtomic(filePath, obj) {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(tmpPath, JSON.stringify(obj, null, 2));
  fs.renameSync(tmpPath, filePath);
}

/**
 * Attempt to read and parse a JSON file.
 * On parse failure, retries once immediately (a non-atomic writer — e.g. the SDK
 * Edit tool — may have been mid-write on the first read).
 */
function safeReadJsonFile(filePath) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw);
      return { ok: true, data };
    } catch (err) {
      if (attempt === 0) continue;
      return { ok: false, error: err.message, filePath };
    }
  }
}

/**
 * Try to find a readable copy of a corrupt JSON file in a list of fallback
 * directories. Searches by filename first, then by matching `id` field.
 *
 * READ-ONLY: returns the fallback data for the caller's response but never
 * overwrites the file on disk — the "corrupt" read may be a transient race, and
 * the fallback copy (player library / campaign defaults) is usually an older
 * tier whose data must not clobber live session state.
 */
function tryRecover(corruptFilePath, filename, recoveryDirs) {
  for (const dir of recoveryDirs) {
    if (!fs.existsSync(dir)) continue;

    // Try same filename first
    const candidate = path.join(dir, filename);
    if (fs.existsSync(candidate)) {
      const result = safeReadJsonFile(candidate);
      if (result.ok) {
        console.warn(`[json-recovery] Read fallback for ${filename} from ${dir} (original left untouched)`);
        return { recovered: true, source: dir, data: result.data };
      }
    }

    // Fallback: search all files in dir for matching id
    try {
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
      // We need the corrupt file's id to match against — try to extract it from the raw text
      const corruptRaw = fs.readFileSync(corruptFilePath, 'utf-8');
      const idMatch = corruptRaw.match(/"id"\s*:\s*"([^"]+)"/);
      if (idMatch) {
        const targetId = idMatch[1];
        for (const f of files) {
          if (f === filename) continue; // already tried
          const fResult = safeReadJsonFile(path.join(dir, f));
          if (fResult.ok && fResult.data.id === targetId) {
            console.warn(`[json-recovery] Read fallback for ${filename} (id: ${targetId}) from ${path.join(dir, f)} (original left untouched)`);
            return { recovered: true, source: dir, data: fResult.data };
          }
        }
      }
    } catch { /* recovery search failed, try next dir */ }
  }
  return { recovered: false };
}

/**
 * Read all JSON files from a directory with corruption detection and read-fallback.
 *
 * @param {string} dir - Directory to read JSON files from
 * @param {string[]} recoveryDirs - Ordered list of fallback directories for recovery
 * @returns {{ items: object[], warnings: object[] }}
 */
function readJsonDirWithRecovery(dir, recoveryDirs = []) {
  if (!fs.existsSync(dir)) return { items: [], warnings: [] };

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  // Sort by modification time (newest last)
  files.sort((a, b) => {
    try {
      return fs.statSync(path.join(dir, a)).mtimeMs - fs.statSync(path.join(dir, b)).mtimeMs;
    } catch { return 0; }
  });

  const items = [];
  const warnings = [];

  for (const f of files) {
    const filePath = path.join(dir, f);
    const result = safeReadJsonFile(filePath);

    if (result.ok) {
      result.data._filename = f;
      items.push(result.data);
      clearCorruptRead(filePath); // file is healthy again — reset throttle so a future corruption re-logs immediately
      continue;
    }

    // Corrupt — attempt read-fallback (throttled logging: full line once, then a summary every 5 min)
    noteCorruptRead(filePath, result.error);
    const recovery = tryRecover(filePath, f, recoveryDirs);

    if (recovery.recovered) {
      recovery.data._filename = f;
      items.push(recovery.data);
      warnings.push({
        filename: f,
        name: recovery.data.name || f,
        error: result.error,
        recovered: true,
        source: path.basename(recovery.source),
      });
    } else {
      // Extract name from raw text if possible for the warning message
      let name = f;
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const nameMatch = raw.match(/"name"\s*:\s*"([^"]+)"/);
        if (nameMatch) name = nameMatch[1];
      } catch { /* ignore */ }
      warnings.push({
        filename: f,
        name,
        error: result.error,
        recovered: false,
        source: null,
      });
    }
  }

  return { items, warnings };
}

module.exports = {
  writeJsonAtomic,
  safeReadJsonFile,
  tryRecover,
  readJsonDirWithRecovery,
};
