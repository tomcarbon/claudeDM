const fs = require('fs');
const path = require('path');
const { findCharacterOrNpcFile, describeRoster } = require('./entity-resolver');
const { writeJsonAtomic } = require('./json-recovery');
const { CATEGORIES, categoryForCampaign } = require('./game-categories');
const {
  readVitals,
  readDeathSaves,
  isDefaultDeathSaves,
  isDead,
  describeCondition,
  loadDeathRules,
  DEFAULT_DEATH_SAVES,
} = require('./vitals-utils');

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

// ---------------------------------------------------------------- spell slots

// Spell slots used to live in a module-level Map that never touched the sheet, so they were
// lost on every restart and validated against nothing (ADR 0005 §9.2). They now live on the
// sheet at /spellSlotsUsed. The maximum is not duplicated: spells.levelN.slots already holds it.

const SLOT_LEVELS = ['level1', 'level2', 'level3', 'level4', 'level5', 'level6', 'level7', 'level8', 'level9'];

function slotMaximum(sheet, levelKey) {
  const entry = sheet && sheet.spells && sheet.spells[levelKey];
  const slots = entry && Number(entry.slots);
  return Number.isFinite(slots) && slots > 0 ? Math.floor(slots) : 0;
}

function slotsUsed(sheet, levelKey) {
  const used = sheet && sheet.spellSlotsUsed && Number(sheet.spellSlotsUsed[levelKey]);
  return Number.isFinite(used) && used > 0 ? Math.floor(used) : 0;
}

function castSpell(dataDir, playerEmail, campaignId, sessionId, characterId, spellLevel) {
  const found = findCharacterFile(dataDir, characterId, playerEmail, campaignId, sessionId);
  if (!found) return notFoundError(dataDir, characterId, playerEmail, campaignId, sessionId);

  const { filePath, data } = found;
  const level = Number(spellLevel);
  if (!Number.isInteger(level) || level < 1 || level > 9) {
    return { error: `Spell slot level must be a whole number from 1 to 9, got ${JSON.stringify(spellLevel)}. Cantrips use no slot — do not call this for a cantrip.` };
  }
  const levelKey = `level${level}`;
  const max = slotMaximum(data, levelKey);
  if (max === 0) {
    return { error: `${data.name} has no level ${level} spell slots on their sheet, so none can be spent.` };
  }
  const used = slotsUsed(data, levelKey);
  if (used >= max) {
    return { error: `${data.name} has already used all ${max} of their level ${level} spell slots. They cannot cast it — narrate the spell failing to come, or have them use a lower-level slot or a cantrip.` };
  }

  data.spellSlotsUsed = { ...(data.spellSlotsUsed || {}), [levelKey]: used + 1 };
  writeJsonAtomic(filePath, data);

  return {
    action: 'cast',
    character: data.name,
    characterId: data.id || characterId,
    spellLevel: level,
    slotsUsed: used + 1,
    slotsTotal: max,
    slotsRemaining: max - (used + 1),
    message: `Used a level ${level} spell slot (${used + 1} of ${max} used; ${max - (used + 1)} left until a long rest).`,
  };
}

// ---------------------------------------------------------------- hit dice

// The campaign's own ruleset is consulted first, then every other one (WO-0040, WO-0043). Class
// names DO collide between rulesets — Sci-Fi's Scout is d8, Western's Scout is d10 — so the
// campaign decides. The fallback across rulesets is for a sheet whose campaign is unknown.
function loadClassHitDie(dataDir, className, campaignId) {
  const wanted = String(className || '').trim().toLowerCase();
  const own = campaignId ? categoryForCampaign(dataDir, campaignId) : null;
  const order = own ? [own, ...Object.values(CATEGORIES).filter(c => c.id !== own.id)] : Object.values(CATEGORIES);
  for (const category of order) {
    try {
      const classes = JSON.parse(fs.readFileSync(path.join(dataDir, category.rulesDir, 'classes.json'), 'utf-8'));
      const list = Array.isArray(classes.classes) ? classes.classes : [];
      const match = list.find(c => String(c.name || '').toLowerCase() === wanted);
      if (match && match.hit_die) return match.hit_die;
    } catch {
      // a ruleset without a readable classes.json simply has no classes to offer
    }
  }
  return null;
}

/**
 * Hit dice did not exist on any sheet (ADR 0005 §9.2). They are seeded lazily from the class's
 * hit die in data/rules/classes.json and the character's level, on the first operation that
 * needs them, and never in bulk — so no existing file is rewritten until it is actually used.
 */
function ensureHitDice(dataDir, sheet, campaignId) {
  const existing = sheet.hitDice;
  const level = Number(sheet.level) > 0 ? Math.floor(Number(sheet.level)) : 1;
  if (existing && typeof existing === 'object' && Number.isFinite(Number(existing.total))) {
    return { hitDice: { ...existing }, seeded: false };
  }
  const die = loadClassHitDie(dataDir, sheet.class, campaignId) || 'd8';
  return { hitDice: { die, total: level, remaining: level }, seeded: true };
}

function spendHitDice(dataDir, playerEmail, campaignId, sessionId, characterId, quantity) {
  const found = findCharacterFile(dataDir, characterId, playerEmail, campaignId, sessionId);
  if (!found) return notFoundError(dataDir, characterId, playerEmail, campaignId, sessionId);

  const { filePath, data } = found;
  const count = Number(quantity);
  if (!Number.isInteger(count) || count < 1) {
    return { error: `Number of hit dice to spend must be a whole number of 1 or more, got ${JSON.stringify(quantity)}.` };
  }
  if (isDead(data)) return { error: `${data.name} is dead and cannot spend hit dice.` };

  const { hitDice, seeded } = ensureHitDice(dataDir, data, campaignId);
  const remaining = Number.isFinite(Number(hitDice.remaining)) ? Math.max(0, Math.floor(Number(hitDice.remaining))) : 0;
  if (remaining < count) {
    return { error: `${data.name} has ${remaining} hit ${remaining === 1 ? 'die' : 'dice'} left and cannot spend ${count}.` };
  }

  hitDice.remaining = remaining - count;
  data.hitDice = hitDice;
  writeJsonAtomic(filePath, data);

  return {
    action: 'hitdice',
    character: data.name,
    characterId: data.id || characterId,
    die: hitDice.die,
    spent: count,
    remaining: hitDice.remaining,
    total: hitDice.total,
    seeded,
    next: `Roll ${count}${hitDice.die} with RollDice, add ${data.name}'s Constitution modifier once per die, then apply the total with ApplyVitals action "heal". The hit dice are spent whether or not the roll is good.`,
  };
}

// ---------------------------------------------------------------- rest

function processRest(dataDir, playerEmail, campaignId, sessionId, characterId, restType) {
  const found = findCharacterFile(dataDir, characterId, playerEmail, campaignId, sessionId);
  if (!found) return notFoundError(dataDir, characterId, playerEmail, campaignId, sessionId);

  const { filePath, data } = found;
  const results = { action: 'rest', type: restType, character: data.name, changes: [] };

  if (isDead(data)) {
    return { error: `${data.name} is dead. A rest does not restore a dead creature.` };
  }

  if (restType === 'long') {
    const rules = loadDeathRules(dataDir);
    const v = readVitals(data);

    // Hit points to maximum.
    if (v && v.current < v.max) {
      const healed = v.max - v.current;
      data.hitPoints = { ...data.hitPoints, current: v.max };
      results.changes.push(`HP restored to ${v.max}/${v.max} (+${healed})`);
    }

    // Death saves clear — a character who was dying is no longer dying once they are healed.
    if (!isDefaultDeathSaves(readDeathSaves(data))) {
      data.deathSaves = { ...DEFAULT_DEATH_SAVES };
      results.changes.push('Death saves cleared');
    }

    // Spell slots.
    if (data.spellSlotsUsed && Object.keys(data.spellSlotsUsed).length > 0) {
      data.spellSlotsUsed = {};
      results.changes.push('All spell slots restored');
    }

    // Hit dice: regain up to half the total, minimum 1 (data/rules/combat.json healing.long_rest).
    const { hitDice } = ensureHitDice(dataDir, data, campaignId);
    const total = Math.max(1, Math.floor(Number(hitDice.total) || 1));
    const remaining = Math.max(0, Math.floor(Number(hitDice.remaining) || 0));
    if (remaining < total) {
      const regained = Math.min(total - remaining, Math.max(1, Math.floor(total * rules.longRestHitDiceFraction)));
      hitDice.remaining = remaining + regained;
      results.changes.push(`Hit dice regained: +${regained} (${hitDice.remaining}/${total} ${hitDice.die})`);
    }
    data.hitDice = hitDice;

    results.changes.push('Long rest complete — all per-long-rest abilities refreshed');
  } else if (restType === 'short') {
    const { hitDice } = ensureHitDice(dataDir, data, campaignId);
    data.hitDice = hitDice;
    results.changes.push('Short rest complete — per-short-rest abilities refreshed');
    results.changes.push(`Hit dice available: ${hitDice.remaining}/${hitDice.total} ${hitDice.die}. Spend them with TrackResources action "hitdice", then heal with ApplyVitals.`);
  }

  writeJsonAtomic(filePath, data);
  results.condition = describeCondition(data);
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

  // Spell slot status, read from the sheet.
  const spellInfo = {};
  for (const lvl of SLOT_LEVELS) {
    const total = slotMaximum(data, lvl);
    if (total > 0) {
      const used = Math.min(total, slotsUsed(data, lvl));
      spellInfo[lvl] = { total, used, remaining: total - used };
    }
  }

  const v = readVitals(data);
  const saves = readDeathSaves(data);

  return {
    action: 'check',
    character: data.name,
    hp: v ? `${v.current}/${v.max}` : null,
    tempHp: v && v.temp > 0 ? v.temp : undefined,
    condition: describeCondition(data),
    deathSaves: isDefaultDeathSaves(saves) ? undefined : saves,
    hitDice: data.hitDice || undefined,
    resources,
    spellSlots: Object.keys(spellInfo).length > 0 ? spellInfo : null,
  };
}

module.exports = { useResource, castSpell, spendHitDice, processRest, checkResources, ensureHitDice };
