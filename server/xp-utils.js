const fs = require('fs');
const path = require('path');
const { getPlayerCharactersDir, getSessionCharactersDir, getSessionNpcsDir, getSessionFilePath } = require('./player-data');

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function slugify(value) {
  return normalize(value).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function listJsonFiles(dir) {
  try {
    return fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  } catch {
    return [];
  }
}

function collectMatches(dataDir, characterRef, playerEmail, campaignId, sessionId) {
  const ref = normalize(characterRef);
  const refSlug = slugify(characterRef);
  const candidateDirs = [];

  // Session-scoped directories first (source of truth during gameplay)
  if (sessionId) {
    candidateDirs.push(
      { kind: 'character', dir: getSessionCharactersDir(dataDir, sessionId) },
      { kind: 'npc', dir: getSessionNpcsDir(dataDir, sessionId) },
    );
  }

  // Player library
  if (playerEmail) {
    candidateDirs.push(
      { kind: 'character', dir: getPlayerCharactersDir(dataDir, playerEmail, campaignId) },
    );
  }

  // Campaign defaults for NPCs
  candidateDirs.push(
    { kind: 'npc', dir: path.join(dataDir, 'defaults', campaignId || 'demo', 'npcs') },
  );

  // Legacy fallback
  if (!playerEmail && !sessionId) {
    candidateDirs.push(
      { kind: 'character', dir: path.join(dataDir, 'characters') },
      { kind: 'npc', dir: path.join(dataDir, 'npcs') },
    );
  }

  const exactIdMatches = [];
  const looseMatches = [];

  for (const candidate of candidateDirs) {
    const files = listJsonFiles(candidate.dir);
    for (const file of files) {
      const fullPath = path.join(candidate.dir, file);
      const data = loadJson(fullPath);
      if (!data) continue;

      if (data.id === characterRef) {
        exactIdMatches.push({ ...candidate, file, data });
        continue;
      }

      const id = normalize(data.id);
      const name = normalize(data.name);
      const fileStem = normalize(path.basename(file, '.json'));

      if (id === ref || name === ref || fileStem === ref) {
        looseMatches.push({ ...candidate, file, data });
        continue;
      }

      const nameSlug = slugify(data.name);
      if (nameSlug && nameSlug === refSlug) {
        looseMatches.push({ ...candidate, file, data });
      }
    }
  }

  if (exactIdMatches.length > 0) return exactIdMatches;
  return looseMatches;
}

function findCharacterOrNpcFile(dataDir, characterRef, playerEmail, campaignId, sessionId) {
  const matches = collectMatches(dataDir, characterRef, playerEmail, campaignId, sessionId);
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    const options = matches.map(m => `${m.data.name} (${m.data.id})`).join(', ');
    throw new Error(`Ambiguous character reference "${characterRef}". Matches: ${options}`);
  }
  return matches[0];
}

function awardXp(dataDir, characterId, xpAmount, playerEmail, campaignId, sessionId) {
  const result = findCharacterOrNpcFile(dataDir, characterId, playerEmail, campaignId, sessionId);
  if (!result) {
    throw new Error(`Character not found: ${characterId}`);
  }

  const awardedXp = Number(xpAmount);
  if (!Number.isFinite(awardedXp)) {
    throw new Error(`Invalid XP amount: ${xpAmount}`);
  }

  const { data: character, dir, file: filename, kind } = result;
  const previousXp = Number(character.experience) || 0;
  const previousLevel = character.level || 1;
  const newXp = Math.max(0, previousXp + awardedXp);

  // Load leveling thresholds
  const leveling = loadJson(path.join(dataDir, 'rules', 'leveling.json'));
  const thresholds = Array.isArray(leveling?.xp_thresholds) ? leveling.xp_thresholds : [];
  if (thresholds.length === 0) {
    throw new Error('Could not load XP thresholds from rules/leveling.json');
  }

  // Determine new level: find highest threshold the new XP meets
  let newLevel = previousLevel;
  let newProficiencyBonus = character.proficiencyBonus || 2;
  for (const t of thresholds.sort((a, b) => a.xp_required - b.xp_required)) {
    if (newXp >= t.xp_required) {
      newLevel = t.level;
      newProficiencyBonus = t.proficiency_bonus;
    }
  }

  // Update character
  character.experience = newXp;
  character.level = newLevel;
  character.proficiencyBonus = newProficiencyBonus;

  fs.writeFileSync(
    path.join(dir, filename),
    JSON.stringify(character, null, 2)
  );

  return {
    kind,
    id: character.id,
    name: character.name,
    awardedXp,
    previousXp,
    newXp,
    previousLevel,
    newLevel,
    leveledUp: newLevel > previousLevel,
  };
}

function readJsonSafe(filePath) {
  try {
    return loadJson(filePath);
  } catch {
    return null;
  }
}

function dirExists(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

// Read every *.json in a directory as a character/NPC record (attaching _filename),
// skipping anything that fails to parse.
function readRecords(dir) {
  return listJsonFiles(dir)
    .map((file) => {
      const data = readJsonSafe(path.join(dir, file));
      if (data) data._filename = file;
      return data;
    })
    .filter(Boolean);
}

function isAlive(record) {
  return String(record.status || 'alive').toLowerCase() !== 'dead';
}

// Build the live party roster for an equal XP split: all present player characters
// plus DM-controlled NPCs. Excludes the dead, NPCs the host has marked "removed", and
// NPCs currently puppeted by a human companion player (those are handled by that player).
function resolvePartyRoster(dataDir, { playerEmail, campaignId, sessionId, characterId }) {
  const cid = campaignId || 'demo';
  const seen = new Set();
  const roster = [];
  const add = (record) => {
    if (!record || !record.id || seen.has(record.id) || !isAlive(record)) return;
    seen.add(record.id);
    roster.push(record);
  };

  // Player characters
  if (sessionId && dirExists(getSessionCharactersDir(dataDir, sessionId))) {
    // Session is the live source of truth — captures the main PC and any
    // companion-replacement PCs in multiplayer.
    readRecords(getSessionCharactersDir(dataDir, sessionId)).forEach(add);
  } else if (characterId) {
    const match = findCharacterOrNpcFile(dataDir, characterId, playerEmail, campaignId, sessionId);
    if (match) add({ ...match.data, _filename: match.file });
  }

  // DM-controlled NPCs
  const npcDir = sessionId && dirExists(getSessionNpcsDir(dataDir, sessionId))
    ? getSessionNpcsDir(dataDir, sessionId)
    : path.join(dataDir, 'defaults', cid, 'npcs');

  let states = {};
  let companionPlayers = {};
  if (sessionId) {
    const session = readJsonSafe(getSessionFilePath(dataDir, sessionId)) || {};
    states = (session.companionConfig && session.companionConfig.states) || {};
    companionPlayers = session.companionPlayers || {};
  }

  for (const npc of readRecords(npcDir)) {
    if (states[npc.id] === 'removed') continue;       // host removed this slot
    if (companionPlayers[npc.id]) continue;           // a human companion controls this NPC
    add(npc);
  }

  return roster;
}

// Award XP equally across the live party (present PCs + DM-controlled NPCs).
// Provide exactly one of { totalXp } (split equally) or { xpEach } (flat per-member amount).
// Each member is awarded via awardXp(), so XP/level/file updates target the session-scoped
// files when a sessionId is supplied.
function awardPartyXp(dataDir, { totalXp, xpEach } = {}, context = {}) {
  const { playerEmail, campaignId, sessionId, characterId } = context;

  const hasTotal = Number.isFinite(Number(totalXp));
  const hasEach = Number.isFinite(Number(xpEach));
  if (hasTotal === hasEach) {
    throw new Error('Provide exactly one of totalXp or xpEach.');
  }

  const roster = resolvePartyRoster(dataDir, { playerEmail, campaignId, sessionId, characterId });
  if (roster.length === 0) {
    throw new Error('No eligible party members found to award XP.');
  }

  const share = hasEach
    ? Math.floor(Number(xpEach))
    : Math.floor(Number(totalXp) / roster.length);
  if (share <= 0) {
    throw new Error(`Computed share is not positive (${share}). totalXp/xpEach too small for party of ${roster.length}.`);
  }

  const members = roster.map((member) =>
    awardXp(dataDir, member.id, share, playerEmail, campaignId, sessionId)
  );

  const distributed = share * roster.length;
  const remainder = hasTotal ? Math.max(0, Math.floor(Number(totalXp)) - distributed) : 0;

  return {
    partySize: roster.length,
    xpEach: share,
    distributed,
    remainder,
    members,
  };
}

module.exports = { awardXp, awardPartyXp, resolvePartyRoster };
