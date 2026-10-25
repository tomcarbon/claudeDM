const fs = require('fs');
const path = require('path');
const { writeJsonAtomic, safeReadJsonFile } = require('./json-recovery');

const DEFAULT_CAMPAIGN = 'demo';

// Campaign and session ids become path segments in the helpers below, and they arrive from
// headers, request bodies and WebSocket messages. The helpers refuse anything that is not a plain
// id, so an entrance that forgets to check cannot turn one into a path (WO-0041: the header was
// gated in campaign-context.js; a session body field and a WebSocket field were found to bypass
// it). campaign-context.js uses these same patterns.
const SAFE_CAMPAIGN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

function assertSafeId(value, pattern, what) {
  if (!pattern.test(String(value))) throw new Error(`Invalid ${what}`);
  return value;
}

function emailToSlug(email) {
  return String(email).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function getPlayerDataDir(dataDir, email) {
  return path.join(dataDir, 'players', emailToSlug(email));
}

function getPlayerCampaignDir(dataDir, email, campaignId) {
  return path.join(getPlayerDataDir(dataDir, email), assertSafeId(campaignId || DEFAULT_CAMPAIGN, SAFE_CAMPAIGN_ID, 'campaign id'));
}

function getPlayerCharactersDir(dataDir, email, campaignId) {
  return path.join(getPlayerCampaignDir(dataDir, email, campaignId), 'characters');
}

// --- Session directories (neutral, shared location) ---
// Sessions live at data/sessions/<sessionId>/ — not under any player's directory.

function getSessionDir(dataDir, sessionId) {
  return path.join(dataDir, 'sessions', assertSafeId(sessionId, SAFE_SESSION_ID, 'session id'));
}

function getSessionFilePath(dataDir, sessionId) {
  return path.join(getSessionDir(dataDir, sessionId), 'session.json');
}

function getSessionCharactersDir(dataDir, sessionId) {
  return path.join(getSessionDir(dataDir, sessionId), 'characters');
}

function getSessionNpcsDir(dataDir, sessionId) {
  return path.join(getSessionDir(dataDir, sessionId), 'npcs');
}

function ensurePlayerDataExists(dataDir, email, campaignId) {
  const charDir = getPlayerCharactersDir(dataDir, email, campaignId);
  fs.mkdirSync(charDir, { recursive: true, mode: 0o755 });
}

function addStatusAlive(data) {
  if (!data.status) {
    data.status = 'alive';
  }
  return data;
}

function copyDefaultsToDir(sourceDir, targetDir) {
  if (!fs.existsSync(sourceDir)) return;
  const files = fs.readdirSync(sourceDir).filter(f => f.endsWith('.json'));
  for (const file of files) {
    const targetFile = path.join(targetDir, file);
    if (fs.existsSync(targetFile)) continue; // don't overwrite existing player data
    const data = JSON.parse(fs.readFileSync(path.join(sourceDir, file), 'utf-8'));
    addStatusAlive(data);
    writeJsonAtomic(targetFile, data);
  }
}

function getAvailableCampaigns(dataDir) {
  const campaignsDir = path.join(dataDir, 'campaigns');
  if (!fs.existsSync(campaignsDir)) return [DEFAULT_CAMPAIGN];
  return fs.readdirSync(campaignsDir).filter(d => {
    const stat = fs.statSync(path.join(campaignsDir, d));
    return stat.isDirectory();
  });
}

function provisionPlayerDefaults(dataDir, email, campaignId) {
  const cid = campaignId || DEFAULT_CAMPAIGN;
  ensurePlayerDataExists(dataDir, email, cid);
  const charDir = getPlayerCharactersDir(dataDir, email, cid);
  const defaultChars = path.join(dataDir, 'defaults', cid, 'characters');
  copyDefaultsToDir(defaultChars, charDir);
}

function provisionAllCampaignDefaults(dataDir, email) {
  const campaigns = getAvailableCampaigns(dataDir);
  for (const cid of campaigns) {
    provisionPlayerDefaults(dataDir, email, cid);
  }
}

function resetPlayerData(dataDir, email, scope, campaignId) {
  const cid = campaignId || DEFAULT_CAMPAIGN;
  const charDir = getPlayerCharactersDir(dataDir, email, cid);
  const defaultChars = path.join(dataDir, 'defaults', cid, 'characters');

  if (scope === 'all' || scope === 'characters') {
    if (fs.existsSync(charDir)) {
      for (const f of fs.readdirSync(charDir).filter(f => f.endsWith('.json'))) {
        fs.unlinkSync(path.join(charDir, f));
      }
    }
    ensurePlayerDataExists(dataDir, email, cid);
    copyDefaultsToDir(defaultChars, charDir);
  }
}

// --- Session-scoped data snapshotting ---
// Each session gets its own copy of character/NPC files so sessions have independent state.

function copyFilesIfNotExist(srcDir, dstDir) {
  if (!fs.existsSync(srcDir)) return;
  const files = fs.readdirSync(srcDir).filter(f => f.endsWith('.json'));
  for (const file of files) {
    const dstFile = path.join(dstDir, file);
    if (fs.existsSync(dstFile)) continue;
    // Atomic write (not copyFileSync) — the DM/UI may read the session dir mid-snapshot.
    const data = JSON.parse(fs.readFileSync(path.join(srcDir, file), 'utf-8'));
    writeJsonAtomic(dstFile, data);
  }
}

// Sheet directories (characters) are keyed on the sheet's `id`, not on its filename.
// Filenames are slugified names (routes/characters.js:131-132), so a character renamed in the
// player library has a different filename from the campaign default it came from — and a
// filename-keyed skip would let BOTH land, giving one id two files and tripping the
// entity-resolver's within-tier duplicate rule. This is the same id-first resolution the
// companion-seat writer in ws-handler.js uses when it copies a character into a session.
// A destination file is still never overwritten: the filename check below is kept as well, so
// an already-snapshotted session keeps its own progress on a re-snapshot.
function copySheetsIfIdNotPresent(srcDir, dstDir) {
  if (!fs.existsSync(srcDir)) return;

  const filesPresent = new Set();
  const idsPresent = new Set();
  if (fs.existsSync(dstDir)) {
    for (const file of fs.readdirSync(dstDir).filter(f => f.endsWith('.json'))) {
      filesPresent.add(file);
      try {
        const existing = JSON.parse(fs.readFileSync(path.join(dstDir, file), 'utf-8'));
        if (existing && existing.id) idsPresent.add(existing.id);
      } catch {
        // Unreadable destination file: it cannot be indexed by id, but its filename still
        // blocks an overwrite. Same posture as ws-handler.js's id scan.
      }
    }
  }

  for (const file of fs.readdirSync(srcDir).filter(f => f.endsWith('.json'))) {
    if (filesPresent.has(file)) continue;
    // An unreadable SOURCE sheet costs that one character and nothing else. It must not throw.
    // This copier runs library-first, so a throw here aborts the snapshot before any campaign
    // default has landed and the session gets NO characters at all — and because
    // snapshotToSession runs on every turn fire, it gets none again on every later turn
    // (WO-0026 SEC-1). Skipping instead leaves the id unclaimed, so the campaign-defaults pass
    // that follows fills the gap with the pristine sheet; a library-only character is simply
    // absent. Both are strictly better than an empty party, and the skip is logged rather than
    // silent. safeReadJsonFile re-reads once before giving up, because the DM's Edit tool writes
    // these files non-atomically and a first-read failure is often that race, not corruption.
    const read = safeReadJsonFile(path.join(srcDir, file));
    if (!read.ok) {
      console.error(`[snapshot] Skipping unreadable character sheet ${path.join(srcDir, file)} — ${read.error}. That character is not in this session; a campaign default for the same id, if there is one, is used instead.`);
      continue;
    }
    const data = read.data;
    if (data && data.id && idsPresent.has(data.id)) continue;
    // Atomic write (not copyFileSync) — the DM/UI may read the session dir mid-snapshot.
    writeJsonAtomic(path.join(dstDir, file), data);
    // The id index is load-bearing: two source sheets sharing one id must not both land.
    // The filename index cannot change the outcome from inside this loop (a directory listing
    // has no duplicate names) — it is kept so the two indexes stay consistent for any future
    // caller that copies more than one source directory in a single pass.
    filesPresent.add(file);
    if (data && data.id) idsPresent.add(data.id);
  }
}

function snapshotToSession(dataDir, sessionId, ownerEmail, campaignId) {
  const cid = campaignId || DEFAULT_CAMPAIGN;
  const dstChars = getSessionCharactersDir(dataDir, sessionId);
  const dstNpcs = getSessionNpcsDir(dataDir, sessionId);
  fs.mkdirSync(dstChars, { recursive: true });
  fs.mkdirSync(dstNpcs, { recursive: true });

  // NPCs: from campaign defaults only
  const defaultNpcs = path.join(dataDir, 'defaults', cid, 'npcs');
  copyFilesIfNotExist(defaultNpcs, dstNpcs);

  // Characters: the PLAYER LIBRARY first, then campaign defaults (defaults fill gaps only).
  // The order is load-bearing and it used to be the other way round. provisionPlayerDefaults
  // seeds the library from these same defaults under the same slugified filenames, so with
  // defaults first the pristine template was copied and the player's progressed sheet was then
  // skipped — a level-5 character entered a new session as the level-1 template it grew from.
  // Library first means the session forks from what the player actually has; a default is only
  // used for a character the library does not already hold (by id).
  const defaultChars = path.join(dataDir, 'defaults', cid, 'characters');
  if (ownerEmail) {
    const playerChars = getPlayerCharactersDir(dataDir, ownerEmail, cid);
    copySheetsIfIdNotPresent(playerChars, dstChars);
  }
  copySheetsIfIdNotPresent(defaultChars, dstChars);
}

// --- Serialized session.json updates ---
// Several writers touch session.json concurrently mid-turn (world-state tool,
// message persistence, counters). All server-side read-modify-writes go through
// this per-session queue so none of them clobbers another's fields.

const sessionUpdateQueues = new Map(); // sessionId -> tail Promise

/**
 * Read-modify-write session.json under a per-session async lock.
 * `mutatorFn(session)` edits the object in place; return false to skip the write.
 * Resolves to the (possibly updated) session object.
 */
function updateSessionFile(dataDir, sessionId, mutatorFn) {
  const prev = sessionUpdateQueues.get(sessionId) || Promise.resolve();
  const run = prev.then(async () => {
    const filePath = getSessionFilePath(dataDir, sessionId);
    const session = JSON.parse(await fs.promises.readFile(filePath, 'utf-8'));
    const result = await mutatorFn(session);
    if (result !== false) {
      session.updatedAt = new Date().toISOString();
      writeJsonAtomic(filePath, session);
    }
    return session;
  });
  const tail = run.catch(() => {}); // keep the queue alive after a failed update
  sessionUpdateQueues.set(sessionId, tail);
  tail.then(() => {
    if (sessionUpdateQueues.get(sessionId) === tail) sessionUpdateQueues.delete(sessionId);
  });
  return run;
}

function resetSingleEntity(dataDir, email, entityType, entityId, campaignId) {
  if (entityType !== 'character') {
    throw new Error(`Reset is only supported for characters, not "${entityType}".`);
  }
  const cid = campaignId || DEFAULT_CAMPAIGN;
  const playerDir = getPlayerCharactersDir(dataDir, email, cid);
  const defaultDir = path.join(dataDir, 'defaults', cid, 'characters');

  if (!fs.existsSync(defaultDir)) {
    throw new Error(`Default ${entityType} directory not found`);
  }

  const defaultFiles = fs.readdirSync(defaultDir).filter(f => f.endsWith('.json'));
  let matchedFile = null;
  for (const file of defaultFiles) {
    const data = JSON.parse(fs.readFileSync(path.join(defaultDir, file), 'utf-8'));
    if (data.id === entityId) {
      matchedFile = file;
      break;
    }
  }

  if (!matchedFile) {
    throw new Error(`No default found for ${entityType} with id ${entityId}`);
  }

  ensurePlayerDataExists(dataDir, email, cid);
  const playerFiles = fs.readdirSync(playerDir).filter(f => f.endsWith('.json'));
  for (const file of playerFiles) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(playerDir, file), 'utf-8'));
      if (data.id === entityId) {
        fs.unlinkSync(path.join(playerDir, file));
        break;
      }
    } catch {
      // skip malformed files
    }
  }

  const data = JSON.parse(fs.readFileSync(path.join(defaultDir, matchedFile), 'utf-8'));
  addStatusAlive(data);
  writeJsonAtomic(path.join(playerDir, matchedFile), data);
}

module.exports = {
  DEFAULT_CAMPAIGN,
  SAFE_CAMPAIGN_ID,
  SAFE_SESSION_ID,
  emailToSlug,
  getPlayerDataDir,
  getPlayerCampaignDir,
  getPlayerCharactersDir,
  getSessionDir,
  getSessionFilePath,
  getSessionCharactersDir,
  getSessionNpcsDir,
  snapshotToSession,
  ensurePlayerDataExists,
  getAvailableCampaigns,
  provisionPlayerDefaults,
  provisionAllCampaignDefaults,
  resetPlayerData,
  resetSingleEntity,
  updateSessionFile,
};
