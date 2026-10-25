const crypto = require('crypto');
const { findCharacterOrNpcFile } = require('./entity-resolver');
const { applyVitals, readVitals, describeCondition, isDefaultDeathSaves } = require('./vitals-utils');

// In-memory combat state, keyed per session when a sessionId exists — two
// concurrent sessions in the same campaign must never share combat state.
//
// ADR 0005 §8: this Map no longer holds hit points for anything that has a character or NPC
// file. It holds initiative order, round number, conditions, and the hit points of sheetless
// creatures (a monster conjured from LookupMonster). Everything file-backed is read from the
// sheet at call time, so there is one hit point number with one writer and nothing to
// reconcile. The rest of the Map is still lost on a restart, deliberately (TD-23): losing an
// initiative order is an annoyance a DM rebuilds from the transcript; losing a hit point total
// was the incident.
const combatStates = new Map();

function getContextKey(playerEmail, campaignId, sessionId) {
  if (sessionId) return `sess:${sessionId}`;
  return `${playerEmail || 'guest'}:${campaignId || 'demo'}`;
}

function resolveSheet(dataDir, ref, playerEmail, campaignId, sessionId) {
  if (!dataDir || !ref) return null;
  try {
    return findCharacterOrNpcFile(dataDir, ref, playerEmail, campaignId, sessionId);
  } catch {
    return null;
  }
}

/**
 * Live vitals for one combatant. File-backed combatants are read from the sheet every time;
 * sheetless ones use the number in the Map.
 *
 * `dead` follows the sheet's status, never the hit point total. A player character at 0 hit
 * points is unconscious and dying, not dead (data/rules/combat.json death_saving_throws, and
 * ETHICS.md Review 3 condition M4) — the old `hp <= 0` test was the monster rule applied to
 * player characters. Sheetless creatures keep that rule, because for them it is the right one.
 */
function combatantVitals(dataDir, state, combatant) {
  if (combatant.fileBacked) {
    const match = resolveSheet(dataDir, combatant.ref, state.playerEmail, state.campaignId, state.sessionId);
    const v = match ? readVitals(match.data) : null;
    if (!v) {
      return { hp: null, maxHp: null, dead: false, downed: false, condition: 'unknown', missing: true };
    }
    return {
      hp: v.current,
      maxHp: v.max,
      temp: v.temp,
      dead: v.dead,
      downed: v.current === 0 && !v.dead,
      deathSaves: isDefaultDeathSaves(v.deathSaves) ? null : v.deathSaves,
      condition: describeCondition(match.data),
      fileBacked: true,
    };
  }
  const dead = combatant.hp != null && combatant.hp <= 0;
  return {
    hp: combatant.hp,
    maxHp: combatant.maxHp,
    dead,
    downed: false,
    condition: combatant.hp == null ? 'untracked' : (dead ? 'dead' : 'conscious'),
    fileBacked: false,
  };
}

function hpText(v) {
  return v.hp != null ? `${v.hp}/${v.maxHp}` : null;
}

/** Out of the fight for turn-order purposes: dead. A dying creature still takes its turn — that
 *  is when it makes its death saving throw. */
function skipsTurns(v) {
  return v.dead === true;
}

function startCombat(dataDir, playerEmail, campaignId, sessionId, combatants) {
  const key = getContextKey(playerEmail, campaignId, sessionId);
  if (combatStates.has(key)) {
    return { error: 'Combat already in progress. Use "end" to finish current combat first.' };
  }

  const rolled = combatants.map(c => {
    const roll = crypto.randomInt(1, 21);
    const total = roll + (c.initiativeBonus || 0);
    const match = resolveSheet(dataDir, c.id || c.name, playerEmail, campaignId, sessionId);
    const fileBacked = !!(match && readVitals(match.data));
    return {
      id: c.id || c.name,
      name: c.name,
      // A file-backed combatant carries a reference, not a copy. The hp/maxHp the model passed
      // in for it is deliberately discarded: the sheet is the number.
      fileBacked,
      ref: fileBacked ? (match.data.id || c.id || c.name) : null,
      initiativeRoll: roll,
      initiativeBonus: c.initiativeBonus || 0,
      initiativeTotal: total,
      hp: fileBacked ? null : (c.hp || null),
      maxHp: fileBacked ? null : (c.maxHp || c.hp || null),
      ac: c.ac || null,
      conditions: [],
      isEnemy: c.isEnemy || false,
    };
  });

  rolled.sort((a, b) => {
    if (b.initiativeTotal !== a.initiativeTotal) return b.initiativeTotal - a.initiativeTotal;
    if (b.initiativeBonus !== a.initiativeBonus) return b.initiativeBonus - a.initiativeBonus;
    return crypto.randomInt(0, 2) === 0 ? -1 : 1;
  });

  const state = {
    combatants: rolled,
    currentIndex: 0,
    round: 1,
    active: true,
    playerEmail,
    campaignId,
    sessionId,
  };
  combatStates.set(key, state);

  return {
    action: 'start',
    round: 1,
    currentTurn: rolled[0]?.name || null,
    initiativeOrder: rolled.map(c => {
      const v = combatantVitals(dataDir, state, c);
      return {
        name: c.name,
        initiative: c.initiativeTotal,
        roll: c.initiativeRoll,
        bonus: c.initiativeBonus,
        hp: hpText(v),
        hpSource: c.fileBacked ? 'character sheet' : 'combat tracker',
        ac: c.ac,
        isEnemy: c.isEnemy,
      };
    }),
  };
}

function nextTurn(dataDir, playerEmail, campaignId, sessionId) {
  const key = getContextKey(playerEmail, campaignId, sessionId);
  const state = combatStates.get(key);
  if (!state || !state.active) return { error: 'No active combat.' };

  // Decrement condition durations for the combatant whose turn just ended
  const current = state.combatants[state.currentIndex];
  if (current) {
    current.conditions = current.conditions
      .map(c => c.roundsLeft != null ? { ...c, roundsLeft: c.roundsLeft - 1 } : c)
      .filter(c => c.roundsLeft == null || c.roundsLeft > 0);
  }

  state.currentIndex++;
  if (state.currentIndex >= state.combatants.length) {
    state.currentIndex = 0;
    state.round++;
  }

  // Skip the dead. A creature at 0 hit points that is not dead is still in the order —
  // its turn is when its death saving throw happens.
  let attempts = 0;
  while (attempts < state.combatants.length) {
    const candidate = state.combatants[state.currentIndex];
    if (!candidate || !skipsTurns(combatantVitals(dataDir, state, candidate))) break;
    state.currentIndex++;
    if (state.currentIndex >= state.combatants.length) {
      state.currentIndex = 0;
      state.round++;
    }
    attempts++;
  }

  const next = state.combatants[state.currentIndex];
  const v = next ? combatantVitals(dataDir, state, next) : null;
  const result = {
    action: 'next',
    round: state.round,
    currentTurn: next?.name || null,
    conditions: next?.conditions || [],
    hp: v ? hpText(v) : null,
  };
  if (v && v.downed) {
    result.condition = v.condition;
    result.deathSaves = v.deathSaves || { successes: 0, failures: 0, stable: false };
    result.required = v.deathSaves && v.deathSaves.stable
      ? `${next.name} is stable and makes no death saving throw.`
      : `${next.name} starts their turn at 0 hit points: call ApplyVitals with action "deathsave" and characterId "${next.ref}". Do not decide the result yourself.`;
  }
  return result;
}

function findCombatant(state, targetName) {
  if (!state) return null;
  const wanted = String(targetName || '').toLowerCase();
  return state.combatants.find(c => c.name.toLowerCase() === wanted)
    || state.combatants.find(c => String(c.id || '').toLowerCase() === wanted)
    || null;
}

/**
 * Damage. For anything with a character or NPC file this is a thin delegate to vitals-utils,
 * which does the arithmetic, applies the death rules and writes the sheet. Damage also happens
 * outside combat — traps, falling, poison — so a target that resolves to a file is handled even
 * with no active encounter.
 */
function applyDamage(dataDir, playerEmail, campaignId, sessionId, targetName, amount, opts = {}) {
  const key = getContextKey(playerEmail, campaignId, sessionId);
  const state = combatStates.get(key);
  const combatant = state && state.active ? findCombatant(state, targetName) : null;

  const ref = combatant && combatant.fileBacked ? combatant.ref : targetName;
  const match = resolveSheet(dataDir, ref, playerEmail, campaignId, sessionId);

  if (match && readVitals(match.data)) {
    const outcome = applyVitals(dataDir, {
      action: 'damage',
      characterId: ref,
      amount,
      isCritical: !!opts.isCritical,
    }, { playerEmail, campaignId, sessionId, rollD20: opts.rollD20 });
    if (outcome.error) return { error: outcome.error };
    return {
      action: 'damage',
      target: outcome.entity,
      damage: outcome.damage,
      currentHp: outcome.hitPoints.current,
      maxHp: outcome.hitPoints.max,
      // `dead` is present only when the sheet says so. A creature at 0 hit points that has not
      // died is reported by its condition, never by this flag (condition M4).
      ...(outcome.status === 'dead' ? { dead: true } : {}),
      outcome: outcome.outcome,
      condition: outcome.condition,
      deathSaves: outcome.deathSaves,
      inCombat: !!combatant,
      message: outcome.narrationRequirement,
      narrationRequirement: outcome.narrationRequirement,
    };
  }

  // Sheetless creature — the in-memory number, and the monster rule, which for a monster is the
  // right rule.
  if (!state || !state.active) return { error: 'No active combat.' };
  if (!combatant) return { error: `Combatant "${targetName}" not found in combat, and no character or NPC file matches that name.` };
  if (combatant.hp == null) return { error: `No HP tracked for "${targetName}". Set HP when starting combat.` };

  combatant.hp = Math.max(0, combatant.hp - amount);
  const dead = combatant.hp <= 0;
  return {
    action: 'damage',
    target: combatant.name,
    damage: amount,
    currentHp: combatant.hp,
    maxHp: combatant.maxHp,
    dead,
    outcome: dead ? 'death' : 'damaged',
    inCombat: true,
    message: dead
      ? `${combatant.name} has fallen! (0/${combatant.maxHp} HP)`
      : `${combatant.name} takes ${amount} damage (${combatant.hp}/${combatant.maxHp} HP).`,
  };
}

function applyHealing(dataDir, playerEmail, campaignId, sessionId, targetName, amount) {
  const key = getContextKey(playerEmail, campaignId, sessionId);
  const state = combatStates.get(key);
  const combatant = state && state.active ? findCombatant(state, targetName) : null;

  const ref = combatant && combatant.fileBacked ? combatant.ref : targetName;
  const match = resolveSheet(dataDir, ref, playerEmail, campaignId, sessionId);

  if (match && readVitals(match.data)) {
    const outcome = applyVitals(dataDir, { action: 'heal', characterId: ref, amount }, { playerEmail, campaignId, sessionId });
    if (outcome.error) return { error: outcome.error };
    return {
      action: 'heal',
      target: outcome.entity,
      healed: outcome.healed,
      currentHp: outcome.hitPoints.current,
      maxHp: outcome.hitPoints.max,
      condition: outcome.condition,
      restoredToConsciousness: !!outcome.restoredToConsciousness,
      inCombat: !!combatant,
      narrationRequirement: outcome.narrationRequirement,
    };
  }

  if (!state || !state.active) return { error: 'No active combat.' };
  if (!combatant) return { error: `Combatant "${targetName}" not found in combat.` };
  if (combatant.hp == null) return { error: `No HP tracked for "${targetName}".` };

  const before = combatant.hp;
  combatant.hp = Math.min(combatant.maxHp, combatant.hp + amount);
  return {
    action: 'heal',
    target: combatant.name,
    healed: combatant.hp - before,
    currentHp: combatant.hp,
    maxHp: combatant.maxHp,
    inCombat: true,
  };
}

function setCondition(dataDir, playerEmail, campaignId, sessionId, targetName, condition, roundsLeft, remove) {
  const key = getContextKey(playerEmail, campaignId, sessionId);
  const state = combatStates.get(key);
  if (!state || !state.active) return { error: 'No active combat.' };

  const target = findCombatant(state, targetName);
  if (!target) return { error: `Combatant "${targetName}" not found in combat.` };

  if (remove) {
    target.conditions = target.conditions.filter(c => c.name.toLowerCase() !== condition.toLowerCase());
    return { action: 'condition', target: target.name, removed: condition, conditions: target.conditions };
  }

  const existing = target.conditions.find(c => c.name.toLowerCase() === condition.toLowerCase());
  if (existing) {
    existing.roundsLeft = roundsLeft != null ? roundsLeft : existing.roundsLeft;
  } else {
    target.conditions.push({ name: condition, roundsLeft: roundsLeft != null ? roundsLeft : null });
  }

  return { action: 'condition', target: target.name, added: condition, roundsLeft, conditions: target.conditions };
}

function getCombatStatus(dataDir, playerEmail, campaignId, sessionId) {
  const key = getContextKey(playerEmail, campaignId, sessionId);
  const state = combatStates.get(key);
  if (!state || !state.active) return { active: false, message: 'No active combat.' };

  return {
    active: true,
    round: state.round,
    currentTurn: state.combatants[state.currentIndex]?.name || null,
    combatants: state.combatants.map(c => {
      const v = combatantVitals(dataDir, state, c);
      return {
        name: c.name,
        initiative: c.initiativeTotal,
        hp: hpText(v),
        hpSource: c.fileBacked ? 'character sheet' : 'combat tracker',
        ac: c.ac,
        conditions: c.conditions,
        isEnemy: c.isEnemy,
        condition: v.condition,
        ...(v.deathSaves ? { deathSaves: v.deathSaves } : {}),
        ...(v.dead ? { dead: true } : {}),
      };
    }),
  };
}

function endCombat(dataDir, playerEmail, campaignId, sessionId) {
  const key = getContextKey(playerEmail, campaignId, sessionId);
  const state = combatStates.get(key);
  if (!state || !state.active) return { active: false, message: 'No active combat to end.' };

  const withVitals = state.combatants.map(c => ({ c, v: combatantVitals(dataDir, state, c) }));

  const summary = {
    action: 'end',
    totalRounds: state.round,
    survivors: withVitals.filter(({ v }) => !v.dead && !v.downed).map(({ c, v }) => ({
      name: c.name,
      hp: hpText(v) || 'untracked',
      conditions: c.conditions,
    })),
    // Unconscious and dying is not dead, and is reported separately so nothing downstream
    // reads a downed player character as a corpse.
    unconscious: withVitals.filter(({ v }) => v.downed).map(({ c, v }) => ({
      name: c.name,
      hp: hpText(v),
      condition: v.condition,
      deathSaves: v.deathSaves || { successes: 0, failures: 0, stable: false },
    })),
    fallen: withVitals.filter(({ v }) => v.dead).map(({ c }) => c.name),
  };

  combatStates.delete(key);
  return summary;
}

module.exports = {
  startCombat,
  nextTurn,
  applyDamage,
  applyHealing,
  setCondition,
  getCombatStatus,
  endCombat,
  _testing: { combatStates, combatantVitals },
};
