const fs = require('fs');
const path = require('path');
const { getSessionCharactersDir, getSessionNpcsDir, getSessionFilePath } = require('./player-data');
const { requireCharacterOrNpcFile } = require('./entity-resolver');
const { writeJsonAtomic } = require('./json-recovery');

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function listJsonFiles(dir) {
  try {
    return fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  } catch {
    return [];
  }
}

// Award XP to a single character/NPC and persist the file. `preResolved`
// ({ kind, dir, file }) skips reference resolution — awardPartyXp uses it so each
// roster member updates its own already-located file instead of re-resolving by id.
function awardXp(dataDir, characterId, xpAmount, playerEmail, campaignId, sessionId, preResolved) {
  const result = preResolved || requireCharacterOrNpcFile(dataDir, characterId, playerEmail, campaignId, sessionId);

  const awardedXp = Number(xpAmount);
  if (!Number.isFinite(awardedXp)) {
    throw new Error(`Invalid XP amount: ${xpAmount}`);
  }

  const { dir, file: filename, kind } = result;
  const character = loadJson(path.join(dir, filename));
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

  writeJsonAtomic(path.join(dir, filename), character);

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

// Read every *.json in a directory as a character/NPC record, remembering where
// each one came from (so awards can write back to the exact same file).
function readRecords(dir, kind) {
  return listJsonFiles(dir)
    .map((file) => {
      const data = readJsonSafe(path.join(dir, file));
      return data ? { kind, dir, file, data } : null;
    })
    .filter(Boolean);
}

function isAlive(record) {
  return String(record.status || 'alive').toLowerCase() !== 'dead';
}

// Build the live party roster for an equal XP split: all present player characters
// plus DM-controlled NPCs. Excludes the dead, NPCs the host has marked "removed", and
// NPCs currently puppeted by a human companion player (those are handled by that player).
// Each entry is { kind, dir, file, data } — deduped by data.id.
function resolvePartyRoster(dataDir, { playerEmail, campaignId, sessionId, characterId }) {
  const cid = campaignId || 'demo';
  const seen = new Set();
  const roster = [];
  const add = (record) => {
    if (!record || !record.data.id || seen.has(record.data.id) || !isAlive(record.data)) return;
    seen.add(record.data.id);
    roster.push(record);
  };

  // Player characters
  if (sessionId && dirExists(getSessionCharactersDir(dataDir, sessionId))) {
    // Session is the live source of truth — captures the main PC and any
    // companion-replacement PCs in multiplayer.
    readRecords(getSessionCharactersDir(dataDir, sessionId), 'character').forEach(add);
  } else if (characterId) {
    const match = requireCharacterOrNpcFile(dataDir, characterId, playerEmail, campaignId, sessionId);
    add(match);
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

  for (const npc of readRecords(npcDir, 'npc')) {
    if (states[npc.data.id] === 'removed') continue;   // host removed this slot
    if (companionPlayers[npc.data.id]) continue;       // a human companion controls this NPC
    add(npc);
  }

  return roster;
}

// Award XP equally across the live party (present PCs + DM-controlled NPCs).
// Provide exactly one of { totalXp } (split equally) or { xpEach } (flat per-member amount).
// Each member's award writes back to the exact file the roster found it in — the
// session-scoped copy during play — never re-resolved by id.
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
    awardXp(dataDir, member.data.id, share, playerEmail, campaignId, sessionId, member)
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
