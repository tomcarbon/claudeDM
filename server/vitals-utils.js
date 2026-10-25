// Hit points, temporary hit points, death saves, stabilisation and death — computed in code
// and persisted to the character/NPC sheet. ADR 0005 §7.
//
// Shape follows xp-utils.js deliberately: a pure state machine (no fs, no resolution, no I/O)
// plus a thin wrapper that resolves the file, applies a transition and persists atomically.
// The split exists so the mechanics can be tested with three lines and no filesystem, no SDK
// and no agent (ADR 0005 §7.1).
//
// The numbers live in data/rules/combat.json, not here — same precedent as awardXp reading
// data/rules/leveling.json. deriveDeathRules() below reads them out of that file and falls
// back to the SRD values only when the file cannot supply one.

const fs = require('fs');
const path = require('path');
const { findCharacterOrNpcFile, describeRoster } = require('./entity-resolver');
const { writeJsonAtomic } = require('./json-recovery');

const DEFAULT_DEATH_SAVES = { successes: 0, failures: 0, stable: false };

// SRD fallbacks. Used only for a value data/rules/combat.json does not state.
const FALLBACK_RULES = {
  successDc: 10,
  successesToStabilise: 3,
  failuresToDie: 3,
  natural1Failures: 2,
  natural20HitPoints: 1,
  damageAt0Failures: 1,
  criticalAt0Failures: 2,
  instantDeathOnOverflow: true,
  longRestHitDiceFraction: 0.5,
};

const WORD_NUMBERS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };

function wordOrDigit(token, fallback) {
  if (token == null) return fallback;
  const t = String(token).trim().toLowerCase();
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  return Object.prototype.hasOwnProperty.call(WORD_NUMBERS, t) ? WORD_NUMBERS[t] : fallback;
}

function matchNumber(text, re, fallback) {
  if (typeof text !== 'string') return fallback;
  const m = text.match(re);
  if (!m) return fallback;
  return wordOrDigit(m[1], fallback);
}

/**
 * Turn the prose in data/rules/combat.json into the numbers the state machine needs.
 * Every field falls back to the SRD value if the rules file does not state it, so an
 * abridged or reworded rules file degrades to correct-by-default rather than to zero.
 */
function deriveDeathRules(combatRules) {
  const d = (combatRules && combatRules.death_saving_throws) || {};
  const healing = (combatRules && combatRules.healing) || {};
  return {
    successDc: matchNumber(d.success, /(\d+)\s+or higher/i, FALLBACK_RULES.successDc),
    successesToStabilise: matchNumber(d.success, /(\w+)\s+successes?\b/i, FALLBACK_RULES.successesToStabilise),
    failuresToDie: matchNumber(d.failure, /(\w+)\s+failures?\b/i, FALLBACK_RULES.failuresToDie),
    natural1Failures: matchNumber(d.natural_1, /counts as (\w+)\s+failures?/i, FALLBACK_RULES.natural1Failures),
    natural20HitPoints: matchNumber(d.natural_20, /regain (\w+)\s+hit point/i, FALLBACK_RULES.natural20HitPoints),
    damageAt0Failures: matchNumber(d.damage_at_0hp, /causes (\w+)\s+death save failure/i, FALLBACK_RULES.damageAt0Failures),
    criticalAt0Failures: matchNumber(d.damage_at_0hp, /critical hit causes (\w+)\s+failures?/i, FALLBACK_RULES.criticalAt0Failures),
    // Instant death is a rule that is either present or absent, not a number.
    instantDeathOnOverflow: typeof d.instant_death === 'string'
      ? /equals or exceeds/i.test(d.instant_death)
      : FALLBACK_RULES.instantDeathOnOverflow,
    longRestHitDiceFraction: typeof healing.long_rest === 'string' && /half your total hit dice/i.test(healing.long_rest)
      ? 0.5
      : FALLBACK_RULES.longRestHitDiceFraction,
  };
}

function loadCombatRules(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'rules', 'combat.json'), 'utf-8'));
  } catch {
    return null;
  }
}

function loadDeathRules(dataDir) {
  return deriveDeathRules(loadCombatRules(dataDir));
}

// ---------------------------------------------------------------- reading a sheet

function isDead(sheet) {
  return String((sheet && sheet.status) || 'alive').toLowerCase() === 'dead';
}

/** Death saves as stored, with the ADR §11 "absent means default" rule applied. */
function readDeathSaves(sheet) {
  const raw = (sheet && sheet.deathSaves) || {};
  return {
    successes: Number.isFinite(Number(raw.successes)) ? Math.max(0, Math.floor(Number(raw.successes))) : 0,
    failures: Number.isFinite(Number(raw.failures)) ? Math.max(0, Math.floor(Number(raw.failures))) : 0,
    stable: raw.stable === true,
  };
}

function isDefaultDeathSaves(saves) {
  return saves.successes === 0 && saves.failures === 0 && saves.stable === false;
}

/**
 * Normalised view of a sheet's vitals. Returns null when the sheet has no usable hitPoints
 * block — callers refuse rather than invent one, because inventing a max HP is exactly the
 * class of fabrication this module exists to remove.
 */
function readVitals(sheet) {
  const hp = sheet && sheet.hitPoints;
  if (!hp || typeof hp !== 'object' || Array.isArray(hp)) return null;
  const max = Number(hp.max);
  const current = Number(hp.current);
  if (!Number.isFinite(max) || !Number.isFinite(current) || max <= 0) return null;
  const temp = Number.isFinite(Number(hp.temp)) ? Math.max(0, Math.floor(Number(hp.temp))) : 0;
  return {
    max: Math.floor(max),
    current: Math.max(0, Math.floor(current)),
    temp,
    dead: isDead(sheet),
    deathSaves: readDeathSaves(sheet),
  };
}

/** True when the creature is at 0 HP and not dead — "down", "dying", "unconscious". */
function isDowned(sheet) {
  const v = readVitals(sheet);
  return !!v && v.current === 0 && !v.dead;
}

/** Short human phrase for a sheet's condition. Never says "dead" unless status is dead. */
function describeCondition(sheet) {
  const v = readVitals(sheet);
  if (!v) return 'unknown';
  if (v.dead) return 'dead';
  if (v.current > 0) return 'conscious';
  return v.deathSaves.stable ? 'unconscious and stable' : 'unconscious and dying';
}

// ---------------------------------------------------------------- writing a sheet

function cloneSheet(sheet) {
  return JSON.parse(JSON.stringify(sheet));
}

function writeVitals(sheet, { current, max, temp, deathSaves, status }) {
  const next = cloneSheet(sheet);
  next.hitPoints = { ...(next.hitPoints || {}) };
  if (max !== undefined) next.hitPoints.max = max;
  if (current !== undefined) next.hitPoints.current = current;
  if (temp !== undefined) {
    // Only materialise `temp` once it is non-default, so untouched sheets keep their shape
    // and no live session sees a field appear for nothing (ADR 0005 §11.1).
    if (temp > 0) next.hitPoints.temp = temp;
    else if (next.hitPoints.temp !== undefined) next.hitPoints.temp = 0;
  }
  if (deathSaves !== undefined) {
    if (isDefaultDeathSaves(deathSaves)) {
      if (next.deathSaves !== undefined) next.deathSaves = { ...DEFAULT_DEATH_SAVES };
    } else {
      next.deathSaves = { ...deathSaves };
    }
  }
  if (status !== undefined) next.status = status;
  return next;
}

const NARRATION_SUFFIX = 'Do not narrate any other outcome, and do not narrate a rescue that no tool produced.';

function narration(text) {
  return `${text} ${NARRATION_SUFFIX}`;
}

function outcomeFor(sheet, next, outcome, extra) {
  const v = readVitals(next) || readVitals(sheet) || { current: 0, max: 0, temp: 0, deathSaves: { ...DEFAULT_DEATH_SAVES } };
  return {
    outcome,
    entity: (sheet && sheet.name) || (sheet && sheet.id) || 'unknown',
    entityId: (sheet && sheet.id) || null,
    status: (next && next.status) || (sheet && sheet.status) || 'alive',
    condition: describeCondition(next || sheet),
    hitPoints: { current: v.current, max: v.max, temp: v.temp },
    deathSaves: { ...v.deathSaves },
    ...extra,
  };
}

function refusal(sheet, reason) {
  return {
    changed: false,
    sheet,
    outcome: {
      outcome: 'refused',
      entity: (sheet && sheet.name) || 'unknown',
      entityId: (sheet && sheet.id) || null,
      reason,
    },
  };
}

// ---------------------------------------------------------------- transitions

/**
 * Damage. ADR 0005 §7.4.
 *
 * The chair's case is the last branch: max 10, current 5, amount 2 → alive at 3/10.
 */
function applyDamageToSheet(sheet, { amount, isCritical } = {}, rules = FALLBACK_RULES) {
  const v = readVitals(sheet);
  if (!v) return refusal(sheet, `${(sheet && sheet.name) || 'This character'} has no usable hitPoints block (needs {"max": n, "current": n}).`);

  const dmg = Number(amount);
  if (!Number.isFinite(dmg) || dmg < 0) return refusal(sheet, `Damage must be a number of 0 or more, got ${JSON.stringify(amount)}.`);
  const damage = Math.floor(dmg);

  if (v.dead) {
    return { changed: false, sheet, outcome: outcomeFor(sheet, sheet, 'already_dead', {
      reason: `${sheet.name} is already dead; damage has no further effect.`,
      damage,
      narrationRequirement: narration(`${sheet.name} is already dead. Narrate the blow landing on a body, nothing more.`),
    }) };
  }

  // 1. Temporary hit points absorb first.
  const absorbed = Math.min(v.temp, damage);
  const temp = v.temp - absorbed;
  const remaining = damage - absorbed;

  // 2. A hit on a creature already at 0 HP is death save failures, not hit point loss.
  if (v.current === 0) {
    const added = isCritical ? rules.criticalAt0Failures : rules.damageAt0Failures;
    const failures = v.deathSaves.failures + added;
    const dies = failures >= rules.failuresToDie;
    const deathSaves = dies
      ? { successes: v.deathSaves.successes, failures, stable: false }
      : { successes: v.deathSaves.successes, failures, stable: false };
    const next = writeVitals(sheet, {
      current: 0,
      temp,
      deathSaves,
      status: dies ? 'dead' : sheet.status || 'alive',
    });
    return {
      changed: true,
      sheet: next,
      outcome: outcomeFor(sheet, next, dies ? 'death' : 'death_save_failure', {
        damage,
        absorbedByTempHp: absorbed,
        failuresAdded: added,
        reason: dies
          ? `damage taken at 0 hit points brought them to ${failures} failed death saves`
          : `damage taken at 0 hit points: ${added} death save failure${added === 1 ? '' : 's'}`,
        narrationRequirement: dies
          ? narration(`${sheet.name} has died.`)
          : narration(`${sheet.name} is unconscious and dying, now on ${failures} failed death save${failures === 1 ? '' : 's'} of ${rules.failuresToDie}. They have not died.`),
      }),
    };
  }

  // 3. Ordinary damage.
  const nextHp = v.current - remaining;

  // Instant death: reduced to 0 and the leftover damage equals or exceeds max HP.
  if (rules.instantDeathOnOverflow && nextHp <= -v.max) {
    const next = writeVitals(sheet, { current: 0, temp, deathSaves: { ...DEFAULT_DEATH_SAVES }, status: 'dead' });
    return {
      changed: true,
      sheet: next,
      outcome: outcomeFor(sheet, next, 'death', {
        damage,
        absorbedByTempHp: absorbed,
        overflow: remaining - v.current,
        reason: `instant death — ${remaining - v.current} damage past 0 met or exceeded a hit point maximum of ${v.max}`,
        narrationRequirement: narration(`${sheet.name} has died instantly from the force of the blow.`),
      }),
    };
  }

  if (nextHp <= 0) {
    const next = writeVitals(sheet, { current: 0, temp, deathSaves: { ...DEFAULT_DEATH_SAVES } });
    return {
      changed: true,
      sheet: next,
      outcome: outcomeFor(sheet, next, 'downed', {
        damage,
        absorbedByTempHp: absorbed,
        reason: 'reduced to 0 hit points',
        narrationRequirement: narration(`${sheet.name} drops to 0 hit points: unconscious and dying. They have not died — they make a death saving throw at the start of each of their turns.`),
      }),
    };
  }

  const next = writeVitals(sheet, { current: nextHp, temp });
  return {
    changed: true,
    sheet: next,
    outcome: outcomeFor(sheet, next, 'damaged', {
      damage,
      absorbedByTempHp: absorbed,
      reason: `${damage} damage`,
      narrationRequirement: narration(`${sheet.name} is at ${nextHp} of ${v.max} hit points and still standing.`),
    }),
  };
}

/** Healing. A dead creature is not healed back — that needs a spell, or the override. */
function applyHealingToSheet(sheet, { amount } = {}) {
  const v = readVitals(sheet);
  if (!v) return refusal(sheet, `${(sheet && sheet.name) || 'This character'} has no usable hitPoints block.`);

  const raw = Number(amount);
  if (!Number.isFinite(raw) || raw < 0) return refusal(sheet, `Healing must be a number of 0 or more, got ${JSON.stringify(amount)}.`);
  const heal = Math.floor(raw);

  if (v.dead) {
    return refusal(sheet, `${sheet.name} is dead. Ordinary healing does not restore a dead creature — that needs Revivify, Raise Dead or an equivalent effect, and the mechanical result of casting one is set with OverrideMechanicalState with the player's approval.`);
  }

  const wasDowned = v.current === 0;
  const nextHp = Math.min(v.max, v.current + heal);
  const deathSaves = (heal > 0 && nextHp > 0) ? { ...DEFAULT_DEATH_SAVES } : v.deathSaves;
  const next = writeVitals(sheet, { current: nextHp, deathSaves });
  return {
    changed: true,
    sheet: next,
    outcome: outcomeFor(sheet, next, 'healed', {
      healed: nextHp - v.current,
      restoredToConsciousness: wasDowned && nextHp > 0,
      reason: `healed ${nextHp - v.current}`,
      narrationRequirement: narration(
        wasDowned && nextHp > 0
          ? `${sheet.name} is conscious again at ${nextHp} of ${v.max} hit points.`
          : `${sheet.name} is at ${nextHp} of ${v.max} hit points.`
      ),
    }),
  };
}

/** Temporary hit points. 5e: they do not stack — you take the better of the two. */
function applyTempHpToSheet(sheet, { amount } = {}) {
  const v = readVitals(sheet);
  if (!v) return refusal(sheet, `${(sheet && sheet.name) || 'This character'} has no usable hitPoints block.`);
  const raw = Number(amount);
  if (!Number.isFinite(raw) || raw < 0) return refusal(sheet, `Temporary hit points must be a number of 0 or more, got ${JSON.stringify(amount)}.`);
  const temp = Math.max(v.temp, Math.floor(raw));
  const next = writeVitals(sheet, { temp });
  return {
    changed: temp !== v.temp,
    sheet: next,
    outcome: outcomeFor(sheet, next, 'temp_hp_set', {
      reason: `temporary hit points set to ${temp} (they do not stack; the higher value stands)`,
      narrationRequirement: narration(`${sheet.name} has ${temp} temporary hit points.`),
    }),
  };
}

/**
 * Why this creature cannot make a death saving throw, or null when it can.
 * Checked before the d20 is rolled so an illegal call never puts a phantom roll into the
 * player's dice stream.
 */
function refuseDeathSave(sheet) {
  const v = readVitals(sheet);
  if (!v) return `${(sheet && sheet.name) || 'This character'} has no usable hitPoints block.`;
  if (v.dead) return `${sheet.name} is dead and makes no further death saves.`;
  if (v.current > 0) return `${sheet.name} is at ${v.current} hit points and is not making death saves.`;
  if (v.deathSaves.stable) return `${sheet.name} is stable and makes no death saves while stable.`;
  return null;
}

/**
 * A death saving throw. `roll` is a natural d20 supplied by the caller, so the tool can put
 * it through the same rollDice()/diceResults path as every other roll and the player sees it
 * in their dice stream (ADR 0005 §7.4).
 */
function rollDeathSaveOnSheet(sheet, { roll } = {}, rules = FALLBACK_RULES) {
  const blocked = refuseDeathSave(sheet);
  if (blocked) return refusal(sheet, blocked);
  const v = readVitals(sheet);

  const natural = Number(roll);
  if (!Number.isInteger(natural) || natural < 1 || natural > 20) {
    return refusal(sheet, `A death save needs a natural d20 result between 1 and 20, got ${JSON.stringify(roll)}.`);
  }

  // Natural 20 — regain hit points and get up.
  if (natural === 20) {
    const next = writeVitals(sheet, { current: rules.natural20HitPoints, deathSaves: { ...DEFAULT_DEATH_SAVES } });
    return {
      changed: true,
      sheet: next,
      outcome: outcomeFor(sheet, next, 'revived', {
        roll: natural,
        reason: 'natural 20 on a death saving throw',
        narrationRequirement: narration(`${sheet.name} regains ${rules.natural20HitPoints} hit point and is conscious.`),
      }),
    };
  }

  // Natural 1 — two failures.
  if (natural === 1) {
    const failures = v.deathSaves.failures + rules.natural1Failures;
    const dies = failures >= rules.failuresToDie;
    const next = writeVitals(sheet, {
      deathSaves: { successes: v.deathSaves.successes, failures, stable: false },
      status: dies ? 'dead' : sheet.status || 'alive',
    });
    return {
      changed: true,
      sheet: next,
      outcome: outcomeFor(sheet, next, dies ? 'death' : 'death_save_failure', {
        roll: natural,
        reason: dies ? 'natural 1 on a death saving throw, reaching three failures' : 'natural 1 on a death saving throw counts as two failures',
        narrationRequirement: dies
          ? narration(`${sheet.name} has died.`)
          : narration(`${sheet.name} now has ${failures} failed death saves of ${rules.failuresToDie} and is still unconscious and dying.`),
      }),
    };
  }

  if (natural >= rules.successDc) {
    const successes = v.deathSaves.successes + 1;
    const stabilises = successes >= rules.successesToStabilise;
    const next = writeVitals(sheet, {
      deathSaves: stabilises
        ? { ...DEFAULT_DEATH_SAVES, stable: true }
        : { successes, failures: v.deathSaves.failures, stable: false },
    });
    return {
      changed: true,
      sheet: next,
      outcome: outcomeFor(sheet, next, stabilises ? 'stabilised' : 'death_save_success', {
        roll: natural,
        reason: stabilises ? 'three successful death saves' : `death save success (${successes} of ${rules.successesToStabilise})`,
        narrationRequirement: stabilises
          ? narration(`${sheet.name} is stable. They are still at 0 hit points and still unconscious, but they make no more death saves.`)
          : narration(`${sheet.name} succeeds on a death saving throw: ${successes} success${successes === 1 ? '' : 'es'}, ${v.deathSaves.failures} failure${v.deathSaves.failures === 1 ? '' : 's'}. Still unconscious and dying.`),
      }),
    };
  }

  const failures = v.deathSaves.failures + 1;
  const dies = failures >= rules.failuresToDie;
  const next = writeVitals(sheet, {
    deathSaves: { successes: v.deathSaves.successes, failures, stable: false },
    status: dies ? 'dead' : sheet.status || 'alive',
  });
  return {
    changed: true,
    sheet: next,
    outcome: outcomeFor(sheet, next, dies ? 'death' : 'death_save_failure', {
      roll: natural,
      reason: dies ? 'three failed death saves' : `death save failure (${failures} of ${rules.failuresToDie})`,
      narrationRequirement: dies
        ? narration(`${sheet.name} has died.`)
        : narration(`${sheet.name} fails a death saving throw: ${failures} failure${failures === 1 ? '' : 's'} of ${rules.failuresToDie}. Still unconscious and dying, and still alive.`),
    }),
  };
}

/** Stabilise — the consequence of a successful DC 10 Medicine check or Spare the Dying. */
function stabiliseSheet(sheet) {
  const v = readVitals(sheet);
  if (!v) return refusal(sheet, `${(sheet && sheet.name) || 'This character'} has no usable hitPoints block.`);
  if (v.dead) return refusal(sheet, `${sheet.name} is dead and cannot be stabilised.`);
  if (v.current > 0) return refusal(sheet, `${sheet.name} is at ${v.current} hit points and does not need stabilising.`);
  const next = writeVitals(sheet, { deathSaves: { ...DEFAULT_DEATH_SAVES, stable: true } });
  return {
    changed: true,
    sheet: next,
    outcome: outcomeFor(sheet, next, 'stabilised', {
      reason: 'stabilised',
      narrationRequirement: narration(`${sheet.name} is stable. They remain at 0 hit points and unconscious, and make no more death saves.`),
    }),
  };
}

/** Max HP. An increase is routine (level-up); a decrease lowers the instant-death threshold. */
function setMaxHitPointsOnSheet(sheet, { value } = {}) {
  const v = readVitals(sheet);
  if (!v) return refusal(sheet, `${(sheet && sheet.name) || 'This character'} has no usable hitPoints block.`);
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw < 1) return refusal(sheet, `Maximum hit points must be a whole number of 1 or more, got ${JSON.stringify(value)}.`);
  const max = Math.floor(raw);
  const current = Math.min(v.current, max);
  const next = writeVitals(sheet, { max, current });
  return {
    changed: max !== v.max || current !== v.current,
    sheet: next,
    outcome: outcomeFor(sheet, next, 'max_hp_changed', {
      previousMax: v.max,
      direction: max > v.max ? 'increase' : (max < v.max ? 'decrease' : 'unchanged'),
      reason: `maximum hit points ${max > v.max ? 'raised' : 'lowered'} from ${v.max} to ${max}`,
      narrationRequirement: narration(`${sheet.name}'s hit point maximum is now ${max}, and they are at ${current}.`),
    }),
  };
}

// ---------------------------------------------------------------- the override's kill guard

// Condition M2 (ETHICS.md Review 3 §M6): OverrideMechanicalState cannot kill. This is a pointer
// allow-list evaluated server-side, before any permission request is raised, because a player
// will approve a mid-combat modal by reflex and a reflex approval must not be able to end a
// character. The override exists for changes no tool can compute; death is exactly what the
// tools now do compute.
const OVERRIDABLE_POINTERS = [
  '/hitPoints/current',
  '/hitPoints/max',
  '/hitPoints/temp',
  '/deathSaves/successes',
  '/deathSaves/failures',
  '/deathSaves/stable',
  '/hitDice/remaining',
  '/spellSlotsUsed',
  '/experience',
  '/level',
  '/proficiencyBonus',
];

/**
 * Why an override must be refused, or null when it is allowed.
 * Refusing before the modal is the point: nothing is asked, so nothing can be reflex-approved.
 */
function refuseOverride(pointer, value, sheet) {
  const p = String(pointer || '');

  // Death is the one direction this tool cannot go. Bringing someone back is allowed — that is
  // the Revivify case the escape hatch exists for, and it is safe by construction: an override
  // that can only ever restore a character cannot end one.
  if (p === '/status' || p.startsWith('/status/')) {
    if (p !== '/status' || String(value).toLowerCase() !== 'alive') {
      return 'An override cannot set a character\'s status to anything but "alive". Death is computed by ApplyVitals from the rules in data/rules/combat.json — damage, death saves and instant death — so if a character should die, apply the damage and let the mechanics produce it. To restore someone who has died, set "/status" to "alive" and then give them hit points with a second override or with ApplyVitals "heal".';
    }
  }

  const allowed = p === '/status'
    || OVERRIDABLE_POINTERS.some(a => p === a || p.startsWith(`${a}/`))
    || p === '/hitPoints' || p === '/deathSaves' || p === '/hitDice';
  if (!allowed) {
    return `"${p}" is not an overridable field. Overridable: ${OVERRIDABLE_POINTERS.join(', ')}. Fields outside this list are either computed by a tool or freely editable already.`;
  }

  // Whole-subtree writes could smuggle a lethal current-HP value; only leaves are overridable.
  if (p === '/hitPoints' || p === '/deathSaves' || p === '/hitDice') {
    return `Override one field at a time — "${p}" is a group. Use a leaf pointer such as "${p}/current".`;
  }

  // Every numeric field on a sheet is a whole number, and the readers floor what they find.
  // A fractional value therefore passes a `> 0` test and lands on the sheet as something else:
  // 0.4 hit points reads back as 0, which puts a character down through a tool that is not
  // allowed to put anyone down. Found by QC against WO-0015.4. Integers only, checked once,
  // for every numeric pointer rather than only the two that had a bound.
  const NUMERIC_POINTERS = {
    '/hitPoints/current': 'Hit points',
    '/hitPoints/max': 'Maximum hit points',
    '/hitPoints/temp': 'Temporary hit points',
    '/deathSaves/successes': 'Death save successes',
    '/deathSaves/failures': 'Death save failures',
    '/hitDice/remaining': 'Hit dice remaining',
    '/experience': 'Experience',
    '/level': 'Level',
    '/proficiencyBonus': 'Proficiency bonus',
  };
  if (Object.prototype.hasOwnProperty.call(NUMERIC_POINTERS, p)) {
    const label = NUMERIC_POINTERS[p];
    // Number('') is 0 and Number(true) is 1; neither is a number a DM meant to write, so the
    // type is checked before the value.
    if (typeof value !== 'number' || !Number.isInteger(value) || Object.is(value, -0)) {
      return `${label} must be a whole number, got ${JSON.stringify(value)}. Fractional, text and boolean values are refused because the sheet stores whole numbers and everything that reads them rounds down — 0.4 hit points would read back as 0.`;
    }
    if (value < 0) return `${label} cannot be negative, got ${value}.`;
  }

  if (p === '/hitPoints/current') {
    if (value < 1) {
      return 'An override cannot set hit points to 0. Reducing a character to 0 is a mechanical outcome: apply the damage with ApplyVitals and let the rules produce it, including the death saves that follow.';
    }
    const v = sheet ? readVitals(sheet) : null;
    if (v && value > v.max) {
      return `${sheet.name}'s maximum is ${v.max}, so ${value} hit points is above it. Raise the maximum first with "/hitPoints/max" if that is what you mean.`;
    }
  }

  if (p === '/deathSaves/failures') {
    // Three failures is death. An override must not reach it.
    if (value >= FALLBACK_RULES.failuresToDie) {
      return `An override cannot set death save failures to ${value} — that is death. Roll the death save with ApplyVitals and let the die decide.`;
    }
  }

  if (p === '/hitPoints/max') {
    if (value < 1) return `Maximum hit points must be a whole number of 1 or more, got ${JSON.stringify(value)}.`;
    const v = sheet ? readVitals(sheet) : null;
    if (v && value < v.current) {
      return `Lowering the maximum to ${value} would put ${sheet.name} above their own maximum at ${v.current}. Heal or damage them with ApplyVitals first.`;
    }
  }

  if (p === '/deathSaves/stable' && typeof value !== 'boolean') {
    return `Whether a character is stable is true or false, got ${JSON.stringify(value)}.`;
  }

  return null;
}

// ---------------------------------------------------------------- pointer write (override)

function setAtPointer(sheet, pointer, value) {
  const parts = String(pointer).split('/').filter(Boolean);
  const next = cloneSheet(sheet);
  let node = next;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (node[key] === undefined || node[key] === null || typeof node[key] !== 'object') node[key] = {};
    node = node[key];
  }
  const before = node[parts[parts.length - 1]];
  node[parts[parts.length - 1]] = value;
  return { sheet: next, before };
}

function getAtPointer(obj, pointer) {
  const parts = String(pointer).split('/').filter(Boolean);
  let node = obj;
  for (const key of parts) {
    if (node === null || node === undefined || typeof node !== 'object') return undefined;
    node = node[key];
  }
  return node;
}

// Plain-English names for the pointers a player may be asked to approve. A JSON pointer means
// nothing to the person at the table (ETHICS.md Review 3 §M2.4 property 2).
const POINTER_LABELS = {
  '/hitPoints/current': 'hit points',
  '/hitPoints/max': 'maximum hit points',
  '/hitPoints/temp': 'temporary hit points',
  '/deathSaves/successes': 'successful death saves',
  '/deathSaves/failures': 'failed death saves',
  '/deathSaves/stable': 'whether they are stable',
  '/hitDice/remaining': 'hit dice remaining',
  '/experience': 'experience points',
  '/level': 'level',
  '/proficiencyBonus': 'proficiency bonus',
  '/status': 'alive-or-dead status',
};

function describePointer(pointer) {
  const p = String(pointer || '');
  if (POINTER_LABELS[p]) return POINTER_LABELS[p];
  if (p.startsWith('/spellSlotsUsed')) return 'spell slots used';
  return p.replace(/^\//, '').replace(/\//g, ' → ');
}

/** How a value reads in a sentence a player is being asked to approve. */
function describeValue(pointer, value, sheet) {
  const p = String(pointer || '');
  if (p === '/hitPoints/current' && sheet) {
    const v = readVitals(sheet);
    if (v) return `${value} of ${v.max}`;
  }
  if (value === true) return 'yes';
  if (value === false) return 'no';
  if (value === undefined) return 'not set';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

// ---------------------------------------------------------------- the file wrapper

function resolve(dataDir, characterId, ctx) {
  const match = findCharacterOrNpcFile(dataDir, characterId, ctx.playerEmail, ctx.campaignId, ctx.sessionId);
  if (!match) {
    return { error: `Character "${characterId}" not found. Known party: ${describeRoster(dataDir, ctx.playerEmail, ctx.campaignId, ctx.sessionId)}` };
  }
  return match;
}

const VITALS_ACTIONS = ['damage', 'heal', 'temphp', 'deathsave', 'stabilize', 'setmax'];

/** Read a character or NPC's current vitals without changing anything. */
function readEntityVitals(dataDir, characterId, ctx = {}) {
  const match = resolve(dataDir, characterId, ctx);
  if (match.error) return match;
  const v = readVitals(match.data);
  if (!v) return { error: `${match.data.name} has no usable hitPoints block.` };
  return { ...v, entity: match.data.name, entityId: match.data.id || null, sheet: match.data };
}

/**
 * Apply one vitals transition to a character or NPC and persist it.
 * `rollD20` is injected so the death save goes through the same dice path the player sees.
 *
 * Returns the outcome object the DM narrates from, or { error }.
 */
function applyVitals(dataDir, args = {}, ctx = {}) {
  const action = String(args.action || '').toLowerCase();
  if (!VITALS_ACTIONS.includes(action)) {
    return { error: `Unknown ApplyVitals action "${args.action}". Use one of: ${VITALS_ACTIONS.join(', ')}.` };
  }

  const match = resolve(dataDir, args.characterId, ctx);
  if (match.error) return match;

  const sheet = match.data;
  const rules = loadDeathRules(dataDir);

  let result;
  let roll = null;
  switch (action) {
    case 'damage':
      result = applyDamageToSheet(sheet, { amount: args.amount, isCritical: !!args.isCritical }, rules);
      break;
    case 'heal':
      result = applyHealingToSheet(sheet, { amount: args.amount });
      break;
    case 'temphp':
      result = applyTempHpToSheet(sheet, { amount: args.amount });
      break;
    case 'deathsave': {
      // Legality first, then the die. A refused death save must not have rolled anything.
      const blocked = refuseDeathSave(sheet);
      if (blocked) return { error: blocked };
      roll = typeof ctx.rollD20 === 'function' ? ctx.rollD20() : Number(args.roll);
      result = rollDeathSaveOnSheet(sheet, { roll }, rules);
      break;
    }
    case 'stabilize':
      result = stabiliseSheet(sheet);
      break;
    case 'setmax':
      result = setMaxHitPointsOnSheet(sheet, { value: args.value });
      break;
    default:
      return { error: `Unknown ApplyVitals action "${args.action}".` };
  }

  if (result.outcome.outcome === 'refused') {
    return { error: result.outcome.reason, outcome: result.outcome };
  }

  if (result.changed) {
    writeJsonAtomic(match.filePath, result.sheet);
  }

  return {
    ...result.outcome,
    action,
    kind: match.kind,
    file: match.file,
  };
}

/**
 * Apply an approved OverrideMechanicalState. The refusal check is run again here, not only in
 * the permission path, because this function must be safe to call from anywhere — the guarantee
 * "an override cannot kill" belongs to the operation, not to one of its callers.
 */
function applyOverride(dataDir, args = {}, ctx = {}) {
  const match = resolve(dataDir, args.characterId ?? args.entityRef, ctx);
  if (match.error) return match;

  const sheet = match.data;
  const refuse = refuseOverride(args.pointer, args.value, sheet);
  if (refuse) return { error: refuse, refused: true };

  const { sheet: next, before } = setAtPointer(sheet, args.pointer, args.value);
  writeJsonAtomic(match.filePath, next);

  return {
    outcome: 'override',
    entity: sheet.name,
    entityId: sheet.id || null,
    kind: match.kind,
    file: match.file,
    pointer: args.pointer,
    field: describePointer(args.pointer),
    previousValue: before === undefined ? null : before,
    value: args.value,
    reason: args.reason || null,
    hitPoints: (readVitals(next) || {}).current !== undefined
      ? { current: readVitals(next).current, max: readVitals(next).max }
      : null,
    narrationRequirement: narration(`${sheet.name}'s ${describePointer(args.pointer)} is now ${describeValue(args.pointer, args.value, next)} because the player approved it.`),
  };
}

/**
 * The sentence a player is asked to approve. Built here rather than in the WebSocket layer
 * because only this module can read the sheet to state the current value (condition M1).
 */
function describeOverrideRequest(dataDir, args = {}, ctx = {}) {
  const match = resolve(dataDir, args.characterId ?? args.entityRef, ctx);
  const sheet = match && !match.error ? match.data : null;
  const name = sheet ? sheet.name : String(args.characterId ?? args.entityRef ?? 'a character');
  const field = describePointer(args.pointer);
  const currentRaw = sheet ? getAtPointer(sheet, args.pointer) : undefined;
  const current = describeValue(args.pointer, currentRaw, sheet);
  const proposed = describeValue(args.pointer, args.value, sheet);
  const reason = args.reason ? String(args.reason) : null;

  const lines = [
    `The GM wants to change ${name}'s ${field} outside the rules.`,
    '',
    `${field.charAt(0).toUpperCase()}${field.slice(1)} now: ${current} → proposed: ${proposed}`,
  ];
  if (reason) {
    lines.push('', `The GM's reason: "${reason}"`);
  }
  lines.push('', 'Nothing has changed yet. If you decline, the game continues with the current numbers and the GM will narrate what the rules produced.');

  return {
    description: lines.join('\n'),
    entity: name,
    field,
    currentValue: current,
    proposedValue: proposed,
    reason,
    declineIsSafe: 'Nothing has changed yet. If you decline, the game continues with the current numbers.',
  };
}

module.exports = {
  // pure state machine
  applyDamageToSheet,
  applyHealingToSheet,
  applyTempHpToSheet,
  rollDeathSaveOnSheet,
  refuseDeathSave,
  stabiliseSheet,
  setMaxHitPointsOnSheet,
  // reading
  readVitals,
  readDeathSaves,
  isDefaultDeathSaves,
  isDowned,
  isDead,
  describeCondition,
  describePointer,
  describeValue,
  getAtPointer,
  // rules
  deriveDeathRules,
  loadDeathRules,
  DEFAULT_DEATH_SAVES,
  FALLBACK_RULES,
  // override
  refuseOverride,
  OVERRIDABLE_POINTERS,
  // file-writing wrappers
  applyVitals,
  readEntityVitals,
  applyOverride,
  describeOverrideRequest,
  VITALS_ACTIONS,
};
