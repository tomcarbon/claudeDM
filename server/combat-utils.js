const crypto = require('crypto');

// In-memory combat state, keyed per session when a sessionId exists — two
// concurrent sessions in the same campaign must never share combat state.
const combatStates = new Map();

function getContextKey(playerEmail, campaignId, sessionId) {
  if (sessionId) return `sess:${sessionId}`;
  return `${playerEmail || 'guest'}:${campaignId || 'demo'}`;
}

function startCombat(playerEmail, campaignId, sessionId, combatants) {
  const key = getContextKey(playerEmail, campaignId, sessionId);
  if (combatStates.has(key)) {
    return { error: 'Combat already in progress. Use "end" to finish current combat first.' };
  }

  // Roll initiative for each combatant
  const rolled = combatants.map(c => {
    const roll = crypto.randomInt(1, 21);
    const total = roll + (c.initiativeBonus || 0);
    return {
      id: c.id || c.name,
      name: c.name,
      initiativeRoll: roll,
      initiativeBonus: c.initiativeBonus || 0,
      initiativeTotal: total,
      hp: c.hp || null,
      maxHp: c.maxHp || c.hp || null,
      ac: c.ac || null,
      conditions: [],
      isEnemy: c.isEnemy || false,
    };
  });

  // Sort by initiative (highest first, ties broken by bonus, then random)
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
  };
  combatStates.set(key, state);

  return {
    action: 'start',
    round: 1,
    currentTurn: rolled[0]?.name || null,
    initiativeOrder: rolled.map(c => ({
      name: c.name,
      initiative: c.initiativeTotal,
      roll: c.initiativeRoll,
      bonus: c.initiativeBonus,
      hp: c.hp != null ? `${c.hp}/${c.maxHp}` : null,
      ac: c.ac,
      isEnemy: c.isEnemy,
    })),
  };
}

function nextTurn(playerEmail, campaignId, sessionId) {
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

  // Advance
  state.currentIndex++;
  if (state.currentIndex >= state.combatants.length) {
    state.currentIndex = 0;
    state.round++;
  }

  // Skip dead combatants
  let attempts = 0;
  while (state.combatants[state.currentIndex]?.hp != null && state.combatants[state.currentIndex].hp <= 0 && attempts < state.combatants.length) {
    state.currentIndex++;
    if (state.currentIndex >= state.combatants.length) {
      state.currentIndex = 0;
      state.round++;
    }
    attempts++;
  }

  const next = state.combatants[state.currentIndex];
  return {
    action: 'next',
    round: state.round,
    currentTurn: next?.name || null,
    conditions: next?.conditions || [],
    hp: next?.hp != null ? `${next.hp}/${next.maxHp}` : null,
  };
}

function applyDamage(playerEmail, campaignId, sessionId, targetName, amount) {
  const key = getContextKey(playerEmail, campaignId, sessionId);
  const state = combatStates.get(key);
  if (!state || !state.active) return { error: 'No active combat.' };

  const target = state.combatants.find(c => c.name.toLowerCase() === targetName.toLowerCase());
  if (!target) return { error: `Combatant "${targetName}" not found in combat.` };
  if (target.hp == null) return { error: `No HP tracked for "${targetName}". Set HP when starting combat.` };

  target.hp = Math.max(0, target.hp - amount);
  const dead = target.hp <= 0;

  return {
    action: 'damage',
    target: target.name,
    damage: amount,
    currentHp: target.hp,
    maxHp: target.maxHp,
    dead,
    message: dead ? `${target.name} has fallen! (0/${target.maxHp} HP)` : `${target.name} takes ${amount} damage (${target.hp}/${target.maxHp} HP).`,
  };
}

function applyHealing(playerEmail, campaignId, sessionId, targetName, amount) {
  const key = getContextKey(playerEmail, campaignId, sessionId);
  const state = combatStates.get(key);
  if (!state || !state.active) return { error: 'No active combat.' };

  const target = state.combatants.find(c => c.name.toLowerCase() === targetName.toLowerCase());
  if (!target) return { error: `Combatant "${targetName}" not found in combat.` };
  if (target.hp == null) return { error: `No HP tracked for "${targetName}".` };

  const before = target.hp;
  target.hp = Math.min(target.maxHp, target.hp + amount);

  return {
    action: 'heal',
    target: target.name,
    healed: target.hp - before,
    currentHp: target.hp,
    maxHp: target.maxHp,
  };
}

function setCondition(playerEmail, campaignId, sessionId, targetName, condition, roundsLeft, remove) {
  const key = getContextKey(playerEmail, campaignId, sessionId);
  const state = combatStates.get(key);
  if (!state || !state.active) return { error: 'No active combat.' };

  const target = state.combatants.find(c => c.name.toLowerCase() === targetName.toLowerCase());
  if (!target) return { error: `Combatant "${targetName}" not found in combat.` };

  if (remove) {
    target.conditions = target.conditions.filter(c => c.name.toLowerCase() !== condition.toLowerCase());
    return { action: 'condition', target: target.name, removed: condition, conditions: target.conditions };
  }

  // Add or refresh condition
  const existing = target.conditions.find(c => c.name.toLowerCase() === condition.toLowerCase());
  if (existing) {
    existing.roundsLeft = roundsLeft != null ? roundsLeft : existing.roundsLeft;
  } else {
    target.conditions.push({ name: condition, roundsLeft: roundsLeft != null ? roundsLeft : null });
  }

  return { action: 'condition', target: target.name, added: condition, roundsLeft, conditions: target.conditions };
}

function getCombatStatus(playerEmail, campaignId, sessionId) {
  const key = getContextKey(playerEmail, campaignId, sessionId);
  const state = combatStates.get(key);
  if (!state || !state.active) return { active: false, message: 'No active combat.' };

  return {
    active: true,
    round: state.round,
    currentTurn: state.combatants[state.currentIndex]?.name || null,
    combatants: state.combatants.map(c => ({
      name: c.name,
      initiative: c.initiativeTotal,
      hp: c.hp != null ? `${c.hp}/${c.maxHp}` : null,
      ac: c.ac,
      conditions: c.conditions,
      isEnemy: c.isEnemy,
      dead: c.hp != null && c.hp <= 0,
    })),
  };
}

function endCombat(playerEmail, campaignId, sessionId) {
  const key = getContextKey(playerEmail, campaignId, sessionId);
  const state = combatStates.get(key);
  if (!state || !state.active) return { active: false, message: 'No active combat to end.' };

  const summary = {
    action: 'end',
    totalRounds: state.round,
    survivors: state.combatants.filter(c => c.hp == null || c.hp > 0).map(c => ({
      name: c.name,
      hp: c.hp != null ? `${c.hp}/${c.maxHp}` : 'untracked',
      conditions: c.conditions,
    })),
    fallen: state.combatants.filter(c => c.hp != null && c.hp <= 0).map(c => c.name),
  };

  combatStates.delete(key);
  return summary;
}

module.exports = { startCombat, nextTurn, applyDamage, applyHealing, setCondition, getCombatStatus, endCombat };
