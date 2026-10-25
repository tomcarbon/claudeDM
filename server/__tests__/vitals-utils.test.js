// WO-0015.4 (implementer's own coverage). The death/HP state machine had zero test coverage
// before this file existed; so did combat-utils.js and resource-utils.js. WO-0015.5 owns the
// full mechanics suite — these are the assertions the implementation was developed against and
// they are deliberately narrow.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const {
  applyDamageToSheet,
  applyHealingToSheet,
  applyTempHpToSheet,
  rollDeathSaveOnSheet,
  stabiliseSheet,
  setMaxHitPointsOnSheet,
  deriveDeathRules,
  refuseOverride,
  readVitals,
  describeCondition,
  FALLBACK_RULES,
} = require('../vitals-utils');

const REAL_COMBAT_RULES = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'rules', 'combat.json'), 'utf-8')
);
const RULES = deriveDeathRules(REAL_COMBAT_RULES);

function sheet(overrides = {}) {
  return {
    id: 'char-1',
    name: 'Kaelara Brightflame',
    status: 'alive',
    hitPoints: { max: 10, current: 10 },
    ...overrides,
  };
}

describe('the chair\'s case', () => {
  it('5 HP, 2 damage: the character is alive at 3', () => {
    const before = sheet({ hitPoints: { max: 10, current: 5 } });
    const { sheet: after, outcome } = applyDamageToSheet(before, { amount: 2 }, RULES);

    expect(after.hitPoints.current).toBe(3);
    expect(after.status).toBe('alive');
    expect(outcome.outcome).toBe('damaged');
    expect(outcome.hitPoints.current).toBe(3);
    expect(outcome.condition).toBe('conscious');
  });

  it('does not mutate the sheet it was given', () => {
    const before = sheet({ hitPoints: { max: 10, current: 5 } });
    applyDamageToSheet(before, { amount: 2 }, RULES);
    expect(before.hitPoints.current).toBe(5);
  });
});

describe('rules come from data/rules/combat.json', () => {
  it('derives the death-save numbers from the shipped rules file', () => {
    expect(RULES.successDc).toBe(10);
    expect(RULES.successesToStabilise).toBe(3);
    expect(RULES.failuresToDie).toBe(3);
    expect(RULES.natural1Failures).toBe(2);
    expect(RULES.natural20HitPoints).toBe(1);
    expect(RULES.damageAt0Failures).toBe(1);
    expect(RULES.criticalAt0Failures).toBe(2);
    expect(RULES.instantDeathOnOverflow).toBe(true);
  });

  it('falls back to the SRD values when the rules file says nothing', () => {
    expect(deriveDeathRules({})).toEqual(FALLBACK_RULES);
    expect(deriveDeathRules(null)).toEqual(FALLBACK_RULES);
  });
});

describe('damage', () => {
  it('0 HP is unconscious and dying, not dead', () => {
    const { sheet: after, outcome } = applyDamageToSheet(sheet({ hitPoints: { max: 10, current: 4 } }), { amount: 4 }, RULES);
    expect(after.hitPoints.current).toBe(0);
    expect(after.status).toBe('alive');
    expect(outcome.outcome).toBe('downed');
    expect(describeCondition(after)).toBe('unconscious and dying');
  });

  it('instant death fires when the overflow MEETS the maximum', () => {
    // 10 max, at 4 HP, 14 damage: 4 to reach 0, 10 left over, which equals max.
    const { sheet: after, outcome } = applyDamageToSheet(sheet({ hitPoints: { max: 10, current: 4 } }), { amount: 14 }, RULES);
    expect(outcome.outcome).toBe('death');
    expect(after.status).toBe('dead');
  });

  it('and NOT one point short of it', () => {
    const { sheet: after, outcome } = applyDamageToSheet(sheet({ hitPoints: { max: 10, current: 4 } }), { amount: 13 }, RULES);
    expect(outcome.outcome).toBe('downed');
    expect(after.status).toBe('alive');
    expect(after.hitPoints.current).toBe(0);
  });

  it('damage at 0 HP is a death save failure, two on a critical', () => {
    const down = sheet({ hitPoints: { max: 10, current: 0 } });
    const once = applyDamageToSheet(down, { amount: 3 }, RULES);
    expect(once.outcome.outcome).toBe('death_save_failure');
    expect(once.sheet.deathSaves.failures).toBe(1);
    expect(once.sheet.status).toBe('alive');

    const crit = applyDamageToSheet(down, { amount: 3, isCritical: true }, RULES);
    expect(crit.sheet.deathSaves.failures).toBe(2);
    expect(crit.sheet.status).toBe('alive');
  });

  it('a third failure from damage at 0 HP kills', () => {
    const dying = sheet({ hitPoints: { max: 10, current: 0 }, deathSaves: { successes: 0, failures: 2, stable: false } });
    const { sheet: after, outcome } = applyDamageToSheet(dying, { amount: 1 }, RULES);
    expect(outcome.outcome).toBe('death');
    expect(after.status).toBe('dead');
  });

  it('temporary hit points absorb first and do not reduce hit points', () => {
    const withTemp = sheet({ hitPoints: { max: 10, current: 5, temp: 4 } });
    const { sheet: after, outcome } = applyDamageToSheet(withTemp, { amount: 3 }, RULES);
    expect(after.hitPoints.current).toBe(5);
    expect(after.hitPoints.temp).toBe(1);
    expect(outcome.absorbedByTempHp).toBe(3);
  });

  it('refuses a negative or non-numeric amount rather than healing by accident', () => {
    expect(applyDamageToSheet(sheet(), { amount: -5 }, RULES).outcome.outcome).toBe('refused');
    expect(applyDamageToSheet(sheet(), { amount: 'lots' }, RULES).outcome.outcome).toBe('refused');
  });

  it('refuses a sheet with no usable hitPoints block instead of inventing one', () => {
    const result = applyDamageToSheet({ name: 'Ghost' }, { amount: 3 }, RULES);
    expect(result.outcome.outcome).toBe('refused');
    expect(result.changed).toBe(false);
  });
});

describe('death saves', () => {
  const dying = (failures = 0, successes = 0) => sheet({
    hitPoints: { max: 10, current: 0 },
    deathSaves: { successes, failures, stable: false },
  });

  it('a natural 1 at two failures kills', () => {
    const { sheet: after, outcome } = rollDeathSaveOnSheet(dying(2), { roll: 1 }, RULES);
    expect(outcome.outcome).toBe('death');
    expect(after.status).toBe('dead');
  });

  it('a natural 20 at two failures revives at 1 HP', () => {
    const { sheet: after, outcome } = rollDeathSaveOnSheet(dying(2), { roll: 20 }, RULES);
    expect(outcome.outcome).toBe('revived');
    expect(after.hitPoints.current).toBe(1);
    expect(after.status).toBe('alive');
    expect(after.deathSaves).toEqual({ successes: 0, failures: 0, stable: false });
  });

  it('a natural 1 at zero failures counts twice without killing', () => {
    const { sheet: after, outcome } = rollDeathSaveOnSheet(dying(0), { roll: 1 }, RULES);
    expect(outcome.outcome).toBe('death_save_failure');
    expect(after.deathSaves.failures).toBe(2);
    expect(after.status).toBe('alive');
  });

  it('10 succeeds and 9 fails', () => {
    expect(rollDeathSaveOnSheet(dying(), { roll: 10 }, RULES).outcome.outcome).toBe('death_save_success');
    expect(rollDeathSaveOnSheet(dying(), { roll: 9 }, RULES).outcome.outcome).toBe('death_save_failure');
  });

  it('a third success stabilises, still at 0 HP and still unconscious', () => {
    const { sheet: after, outcome } = rollDeathSaveOnSheet(dying(0, 2), { roll: 15 }, RULES);
    expect(outcome.outcome).toBe('stabilised');
    expect(after.hitPoints.current).toBe(0);
    expect(after.status).toBe('alive');
    expect(after.deathSaves.stable).toBe(true);
    expect(describeCondition(after)).toBe('unconscious and stable');
  });

  it('a third failure kills', () => {
    const { sheet: after } = rollDeathSaveOnSheet(dying(2), { roll: 5 }, RULES);
    expect(after.status).toBe('dead');
  });

  it('refuses when the creature is not at 0 HP, is stable, or is dead', () => {
    expect(rollDeathSaveOnSheet(sheet(), { roll: 12 }, RULES).outcome.outcome).toBe('refused');
    expect(rollDeathSaveOnSheet(sheet({ hitPoints: { max: 10, current: 0 }, deathSaves: { successes: 0, failures: 0, stable: true } }), { roll: 12 }, RULES).outcome.outcome).toBe('refused');
    expect(rollDeathSaveOnSheet(sheet({ status: 'dead', hitPoints: { max: 10, current: 0 } }), { roll: 12 }, RULES).outcome.outcome).toBe('refused');
  });

  it('refuses a roll that is not a natural d20 result', () => {
    expect(rollDeathSaveOnSheet(dying(), { roll: 21 }, RULES).outcome.outcome).toBe('refused');
    expect(rollDeathSaveOnSheet(dying(), { roll: 0 }, RULES).outcome.outcome).toBe('refused');
  });
});

describe('healing, stabilising and maximum hit points', () => {
  it('healing a downed character clears their death saves', () => {
    const dying = sheet({ hitPoints: { max: 10, current: 0 }, deathSaves: { successes: 1, failures: 2, stable: false } });
    const { sheet: after, outcome } = applyHealingToSheet(dying, { amount: 4 });
    expect(after.hitPoints.current).toBe(4);
    expect(after.deathSaves).toEqual({ successes: 0, failures: 0, stable: false });
    expect(outcome.restoredToConsciousness).toBe(true);
  });

  it('healing never exceeds the maximum', () => {
    expect(applyHealingToSheet(sheet({ hitPoints: { max: 10, current: 8 } }), { amount: 50 }).sheet.hitPoints.current).toBe(10);
  });

  it('refuses to heal a dead character', () => {
    const result = applyHealingToSheet(sheet({ status: 'dead', hitPoints: { max: 10, current: 0 } }), { amount: 5 });
    expect(result.outcome.outcome).toBe('refused');
    expect(result.changed).toBe(false);
  });

  it('temporary hit points take the higher value and do not stack', () => {
    const first = applyTempHpToSheet(sheet(), { amount: 5 }).sheet;
    expect(first.hitPoints.temp).toBe(5);
    expect(applyTempHpToSheet(first, { amount: 3 }).sheet.hitPoints.temp).toBe(5);
    expect(applyTempHpToSheet(first, { amount: 8 }).sheet.hitPoints.temp).toBe(8);
  });

  it('stabilising works only on a downed, living creature', () => {
    const down = sheet({ hitPoints: { max: 10, current: 0 }, deathSaves: { successes: 0, failures: 2, stable: false } });
    const { sheet: after, outcome } = stabiliseSheet(down);
    expect(outcome.outcome).toBe('stabilised');
    expect(after.deathSaves).toEqual({ successes: 0, failures: 0, stable: true });
    expect(stabiliseSheet(sheet()).outcome.outcome).toBe('refused');
    expect(stabiliseSheet(sheet({ status: 'dead', hitPoints: { max: 10, current: 0 } })).outcome.outcome).toBe('refused');
  });

  it('lowering the maximum below the current total pulls the current down with it', () => {
    const { sheet: after, outcome } = setMaxHitPointsOnSheet(sheet({ hitPoints: { max: 20, current: 18 } }), { value: 12 });
    expect(after.hitPoints.max).toBe(12);
    expect(after.hitPoints.current).toBe(12);
    expect(outcome.direction).toBe('decrease');
  });
});

describe('condition M2 — an override cannot kill', () => {
  it('refuses to set status to dead, or to anything that is not "alive"', () => {
    expect(refuseOverride('/status', 'dead', sheet())).toBeTruthy();
    expect(refuseOverride('/status', 'DEAD', sheet())).toBeTruthy();
    expect(refuseOverride('/status', 'destroyed', sheet())).toBeTruthy();
    expect(refuseOverride('/status/inner', 'alive', sheet())).toBeTruthy();
  });

  it('allows a resurrection — an override that can only restore cannot kill', () => {
    expect(refuseOverride('/status', 'alive', sheet({ status: 'dead' }))).toBeNull();
  });

  it('refuses to reduce hit points to 0 or below', () => {
    expect(refuseOverride('/hitPoints/current', 0, sheet())).toBeTruthy();
    expect(refuseOverride('/hitPoints/current', -3, sheet())).toBeTruthy();
  });

  it('refuses to set death save failures to a lethal count', () => {
    expect(refuseOverride('/deathSaves/failures', 3, sheet())).toBeTruthy();
    expect(refuseOverride('/deathSaves/failures', 9, sheet())).toBeTruthy();
    expect(refuseOverride('/deathSaves/failures', 2, sheet())).toBeNull();
  });

  it('refuses a whole-subtree write that could smuggle a lethal value', () => {
    expect(refuseOverride('/hitPoints', { max: 10, current: 0 }, sheet())).toBeTruthy();
    expect(refuseOverride('/deathSaves', { successes: 0, failures: 3 }, sheet())).toBeTruthy();
  });

  it('refuses any pointer outside the allow-list', () => {
    expect(refuseOverride('/armorClass', 25, sheet())).toBeTruthy();
    expect(refuseOverride('/name', 'Someone else', sheet())).toBeTruthy();
    expect(refuseOverride('', 1, sheet())).toBeTruthy();
  });

  it('allows the changes it exists for', () => {
    expect(refuseOverride('/hitPoints/current', 1, sheet({ hitPoints: { max: 10, current: 0 } }))).toBeNull();
    expect(refuseOverride('/hitPoints/max', 14, sheet())).toBeNull();
    expect(refuseOverride('/spellSlotsUsed/level1', 0, sheet())).toBeNull();
    expect(refuseOverride('/experience', 900, sheet())).toBeNull();
  });

  it('refuses a maximum that would leave the character above their own maximum', () => {
    expect(refuseOverride('/hitPoints/max', 3, sheet({ hitPoints: { max: 10, current: 7 } }))).toBeTruthy();
  });

  // Regression, WO-0015.4 QC audit. `n <= 0` let 0.4 through, and every reader of the sheet
  // floors what it finds — so 0.4 hit points read back as 0 and put a character down through a
  // tool that is not allowed to put anyone down. The fix is to refuse anything that is not a
  // whole number rather than to coerce it, because coercion is how it got in.
  it('refuses a fractional hit point value that would read back as 0', () => {
    for (const value of [0.4, 0.99, 0.0001, 1e-9]) {
      expect(refuseOverride('/hitPoints/current', value, sheet())).toBeTruthy();
    }
  });

  it('refuses every non-integer shape rather than coercing it', () => {
    const hostile = ['1', '0.4', '5abc', '', true, false, null, undefined, NaN, Infinity, -Infinity, [], {}, -0, 1.5];
    for (const value of hostile) {
      expect(refuseOverride('/hitPoints/current', value, sheet())).toBeTruthy();
    }
  });

  it('applies the whole-number rule to every numeric field, not only the bounded ones', () => {
    for (const pointer of [
      '/hitPoints/max', '/hitPoints/temp', '/deathSaves/successes', '/deathSaves/failures',
      '/hitDice/remaining', '/experience', '/level', '/proficiencyBonus',
    ]) {
      expect(refuseOverride(pointer, 1.5, sheet())).toBeTruthy();
      expect(refuseOverride(pointer, '2', sheet())).toBeTruthy();
      expect(refuseOverride(pointer, -1, sheet())).toBeTruthy();
    }
  });

  it('still allows the whole numbers it is meant to', () => {
    expect(refuseOverride('/hitPoints/current', 1, sheet({ hitPoints: { max: 10, current: 0 } }))).toBeNull();
    expect(refuseOverride('/hitPoints/current', 10, sheet())).toBeNull();
    expect(refuseOverride('/hitPoints/temp', 0, sheet())).toBeNull();
    expect(refuseOverride('/deathSaves/successes', 2, sheet())).toBeNull();
    expect(refuseOverride('/experience', 0, sheet())).toBeNull();
  });

  it('refuses hit points above the character\'s own maximum', () => {
    expect(refuseOverride('/hitPoints/current', 99, sheet({ hitPoints: { max: 10, current: 5 } }))).toBeTruthy();
  });

  it('requires true or false for stable', () => {
    expect(refuseOverride('/deathSaves/stable', 'yes', sheet())).toBeTruthy();
    expect(refuseOverride('/deathSaves/stable', 1, sheet())).toBeTruthy();
    expect(refuseOverride('/deathSaves/stable', true, sheet())).toBeNull();
  });
});

describe('reading vitals', () => {
  it('treats absent fields as their defaults rather than as missing', () => {
    const v = readVitals(sheet());
    expect(v.temp).toBe(0);
    expect(v.deathSaves).toEqual({ successes: 0, failures: 0, stable: false });
  });

  it('returns null for a sheet with no usable hit points', () => {
    expect(readVitals({ name: 'x' })).toBeNull();
    expect(readVitals({ name: 'x', hitPoints: { max: 0, current: 0 } })).toBeNull();
  });
});
