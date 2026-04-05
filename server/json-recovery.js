const fs = require('fs');
const path = require('path');

/**
 * Attempt to read and parse a JSON file.
 * On parse failure, retries once after a short delay (handles race with mid-write Edit tool).
 */
function safeReadJsonFile(filePath) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw);
      return { ok: true, data };
    } catch (err) {
      if (attempt === 0) {
        // Brief pause — Edit tool may be mid-write
        const start = Date.now();
        while (Date.now() - start < 100) { /* spin */ }
        continue;
      }
      return { ok: false, error: err.message, filePath };
    }
  }
}

/**
 * Try to recover a corrupt JSON file from a list of fallback directories.
 * Searches by filename first, then by matching `id` field.
 * If a valid copy is found, overwrites the corrupt file and returns the data.
 */
function tryRecover(corruptFilePath, filename, recoveryDirs) {
  for (const dir of recoveryDirs) {
    if (!fs.existsSync(dir)) continue;

    // Try same filename first
    const candidate = path.join(dir, filename);
    if (fs.existsSync(candidate)) {
      const result = safeReadJsonFile(candidate);
      if (result.ok) {
        fs.writeFileSync(corruptFilePath, JSON.stringify(result.data, null, 2));
        console.warn(`[json-recovery] Recovered ${filename} from ${dir}`);
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
            fs.writeFileSync(corruptFilePath, JSON.stringify(fResult.data, null, 2));
            console.warn(`[json-recovery] Recovered ${filename} (id: ${targetId}) from ${path.join(dir, f)}`);
            return { recovered: true, source: dir, data: fResult.data };
          }
        }
      }
    } catch { /* recovery search failed, try next dir */ }
  }
  return { recovered: false };
}

/**
 * Read all JSON files from a directory with corruption detection and auto-recovery.
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
      continue;
    }

    // Corrupt — attempt recovery
    console.error(`[json-recovery] Corrupt file: ${filePath} — ${result.error}`);
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
  safeReadJsonFile,
  tryRecover,
  readJsonDirWithRecovery,
};
