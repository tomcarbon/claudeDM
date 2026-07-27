const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('./json-recovery');

const DEFAULT_CAMPAIGN = 'demo';

function emailToSlug(email) {
  return String(email).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function getPlayerDataDir(dataDir, email) {
  return path.join(dataDir, 'players', emailToSlug(email));
}

function getPlayerCampaignDir(dataDir, email, campaignId) {
  return path.join(getPlayerDataDir(dataDir, email), campaignId || DEFAULT_CAMPAIGN);
}

function getPlayerCharactersDir(dataDir, email, campaignId) {
  return path.join(getPlayerCampaignDir(dataDir, email, campaignId), 'characters');
}

// --- Session directories (neutral, shared location) ---
// Sessions live at data/sessions/<sessionId>/ — not under any player's directory.

function getSessionDir(dataDir, sessionId) {
  return path.join(dataDir, 'sessions', sessionId);
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

function snapshotToSession(dataDir, sessionId, ownerEmail, campaignId) {
  const cid = campaignId || DEFAULT_CAMPAIGN;
  const dstChars = getSessionCharactersDir(dataDir, sessionId);
  const dstNpcs = getSessionNpcsDir(dataDir, sessionId);
  fs.mkdirSync(dstChars, { recursive: true });
  fs.mkdirSync(dstNpcs, { recursive: true });

  // NPCs: from campaign defaults only
  const defaultNpcs = path.join(dataDir, 'defaults', cid, 'npcs');
  copyFilesIfNotExist(defaultNpcs, dstNpcs);

  // Characters: campaign defaults first, then player library (player files fill gaps)
  const defaultChars = path.join(dataDir, 'defaults', cid, 'characters');
  copyFilesIfNotExist(defaultChars, dstChars);
  if (ownerEmail) {
    const playerChars = getPlayerCharactersDir(dataDir, ownerEmail, cid);
    copyFilesIfNotExist(playerChars, dstChars);
  }
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
