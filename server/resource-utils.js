const { findCharacterOrNpcFile, describeRoster } = require('./entity-resolver');
const { writeJsonAtomic } = require('./json-recovery');

// In-memory spell slot tracking, keyed per session when a sessionId exists.
const spellSlotUsage = new Map(); // key -> { characterId -> { level -> used } }

function getContextKey(playerEmail, campaignId, sessionId) {
  if (sessionId) return `sess:${sessionId}`;
  return `${playerEmail || 'guest'}:${campaignId || 'demo'}`;
}

// Resolve through the canonical session-first resolver so resource edits land on
// the same file the DM and the player's UI read (the session snapshot during play).
function findCharacterFile(dataDir, characterId, playerEmail, campaignId, sessionId) {
  const match = findCharacterOrNpcFile(dataDir, characterId, playerEmail, campaignId, sessionId);
  if (!match) return null;
  return { filePath: match.filePath, data: match.data };
}

function notFoundError(dataDir, characterId, playerEmail, campaignId, sessionId) {
  return {
    error: `Character "${characterId}" not found. Known party: ` +
      describeRoster(dataDir, playerEmail, campaignId, sessionId),
  };
}

function useResource(dataDir, playerEmail, campaignId, sessionId, characterId, resource, quantity) {
  const found = findCharacterFile(dataDir, characterId, playerEmail, campaignId, sessionId);
  if (!found) return notFoundError(dataDir, characterId, playerEmail, campaignId, sessionId);

  const { filePath, data } = found;
  if (!Array.isArray(data.equipment)) return { error: `${data.name} has no equipment array.` };

  // Find the resource in equipment — match patterns like "Arrows (20)", "Rations (5)", "Torches (3)"
  const pattern = new RegExp(`^${resource.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\((\\d+)\\)`, 'i');
  const plainPattern = new RegExp(`^${resource.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');

  let idx = data.equipment.findIndex(item => pattern.test(item));
  if (idx === -1) {
    // Try plain match (no quantity)
    idx = data.equipment.findIndex(item => plainPattern.test(item));
    if (idx !== -1) {
      return { error: `${data.name}'s "${resource}" has no quantity tracked. Add a count like "${resource} (10)".` };
    }
    return { error: `${data.name} does not have "${resource}" in their equipment.` };
  }

  const match = data.equipment[idx].match(pattern);
  const currentQty = parseInt(match[1], 10);
  const newQty = Math.max(0, currentQty - quantity);

  if (newQty <= 0) {
    data.equipment.splice(idx, 1); // Remove depleted item
  } else {
    data.equipment[idx] = `${resource} (${newQty})`;
  }

  writeJsonAtomic(filePath, data);

  const result = {
    action: 'use',
    character: data.name,
    resource,
    used: quantity,
    remaining: newQty,
  };
  if (newQty <= 3 && newQty > 0) result.warning = `${data.name} is running low on ${resource}! Only ${newQty} left.`;
  if (newQty <= 0) result.warning = `${data.name} has run out of ${resource}!`;
  return result;
}

function castSpell(playerEmail, campaignId, sessionId, characterId, spellLevel) {
  const key = getContextKey(playerEmail, campaignId, sessionId);
  if (!spellSlotUsage.has(key)) spellSlotUsage.set(key, {});
  const sessionSlots = spellSlotUsage.get(key);
  if (!sessionSlots[characterId]) sessionSlots[characterId] = {};

  const levelKey = `level${spellLevel}`;
  const used = sessionSlots[characterId][levelKey] || 0;

  // We don't validate against max slots here — the DM knows the character's slots
  // This just tracks usage for the session
  sessionSlots[characterId][levelKey] = used + 1;

  return {
    action: 'cast',
    characterId,
    spellLevel,
    slotsUsed: used + 1,
    message: `Used a level ${spellLevel} spell slot (${used + 1} used this rest).`,
  };
}

function processRest(dataDir, playerEmail, campaignId, sessionId, characterId, restType) {
  const found = findCharacterFile(dataDir, characterId, playerEmail, campaignId, sessionId);
  if (!found) return notFoundError(dataDir, characterId, playerEmail, campaignId, sessionId);

  const { filePath, data } = found;
  const results = { action: 'rest', type: restType, character: data.name, changes: [] };

  if (restType === 'long') {
    // Restore HP to max
    if (data.hitPoints && data.hitPoints.current < data.hitPoints.max) {
      const healed = data.hitPoints.max - data.hitPoints.current;
      data.hitPoints.current = data.hitPoints.max;
      results.changes.push(`HP restored to ${data.hitPoints.max}/${data.hitPoints.max} (+${healed})`);
    }

    // Reset spell slot tracking for this character
    const key = getContextKey(playerEmail, campaignId, sessionId);
    if (spellSlotUsage.has(key) && spellSlotUsage.get(key)[characterId]) {
      delete spellSlotUsage.get(key)[characterId];
      results.changes.push('All spell slots restored');
    }

    results.changes.push('Long rest complete — all per-long-rest abilities refreshed');
  } else if (restType === 'short') {
    results.changes.push('Short rest complete — per-short-rest abilities refreshed');
    results.changes.push('Hit dice can be spent to heal (DM: ask player how many hit dice to spend)');
  }

  writeJsonAtomic(filePath, data);
  return results;
}

function checkResources(dataDir, playerEmail, campaignId, sessionId, characterId) {
  const found = findCharacterFile(dataDir, characterId, playerEmail, campaignId, sessionId);
  if (!found) return notFoundError(dataDir, characterId, playerEmail, campaignId, sessionId);

  const { data } = found;
  const resources = [];

  // Find quantified items in equipment
  if (Array.isArray(data.equipment)) {
    for (const item of data.equipment) {
      const match = item.match(/^(.+?)\s*\((\d+)\)$/);
      if (match) {
        const qty = parseInt(match[2], 10);
        resources.push({ item: match[1].trim(), quantity: qty, low: qty <= 3 });
      }
    }
  }

  // Spell slot status
  const key = getContextKey(playerEmail, campaignId, sessionId);
  const used = spellSlotUsage.get(key)?.[characterId] || {};
  const spellInfo = {};
  if (data.spells) {
    for (const lvl of ['level1', 'level2', 'level3', 'level4', 'level5', 'level6', 'level7', 'level8', 'level9']) {
      if (data.spells[lvl] && data.spells[lvl].slots > 0) {
        const total = data.spells[lvl].slots;
        const usedCount = used[lvl] || 0;
        spellInfo[lvl] = { total, used: usedCount, remaining: Math.max(0, total - usedCount) };
      }
    }
  }

  return {
    action: 'check',
    character: data.name,
    hp: data.hitPoints ? `${data.hitPoints.current}/${data.hitPoints.max}` : null,
    resources,
    spellSlots: Object.keys(spellInfo).length > 0 ? spellInfo : null,
  };
}

module.exports = { useResource, castSpell, processRest, checkResources };
