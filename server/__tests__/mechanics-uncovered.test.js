// WO-0015.5. The mechanics surface that WO-0015.4's own tests do not reach.
//
// Not a duplicate of mechanical-tools.test.js: that file covers ApplyVitals, TrackCombat
// damage/status/end, TrackResources cast/hitdice/rest/check and OverrideMechanicalState, and it
// has been QC-verified. This file covers what V8 coverage says is still never executed after it
// runs — measured, not guessed:
//
//   combat-utils.js     nextTurn, skipsTurns, applyHealing, setCondition   never entered
//   resource-utils.js   useResource, notFoundError                         never entered
//   vitals-utils.js     isDowned                                           never entered
//
// Reproduce the measurement with:  node server/__tests__/_harness/coverage.mjs
//
// These are not dead code. All four combat functions are live behind TrackCombat's action enum
// and useResource is live behind TrackResources — every one of them reachable by the DM on any
// turn, and two of them (applyHealing, and nextTurn's death-save prompt) touch hit points.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

const { DmEngine } = require('../dm-engine');
const { isDowned, describeCondition, readVitals, readDeathSaves } = require('../vitals-utils');

const EMAIL = 'hero@test.com';
const CAMPAIGN = 'demo';
const SESSION = 'sess-uncovered-1';

let tmpDir;
let engine;
let tools;

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function charPath(id) { return path.join(tmpDir, 'sessions', SESSION, 'characters', `${id}.json`); }
function npcPath(id) { return path.join(tmpDir, 'sessions', SESSION, 'npcs', `${id}.json`); }
function readChar(id) { return JSON.parse(fs.readFileSync(charPath(id), 'utf-8')); }

function makeSheet(overrides = {}) {
  return {
    id: 'char-kaelara',
    name: 'Kaelara Brightflame',
    status: 'alive',
    class: 'Cleric',
    level: 2,
    experience: 300,
    proficiencyBonus: 2,
    hitPoints: { max: 10, current: 5 },
    armorClass: 15,
    speed: 30,
    race: 'Human',
    background: 'Acolyte',
    abilities: {
      strength: { score: 10, modifier: 0 },
      dexterity: { score: 12, modifier: 1 },
      constitution: { score: 14, modifier: 2 },
      intelligence: { score: 10, modifier: 0 },
      wisdom: { score: 16, modifier: 3 },
      charisma: { score: 12, modifier: 1 },
    },
    equipment: ['Arrows (18)', 'Rations (4)', 'Torches', 'Rope (1)'],
    spells: { level1: { slots: 2, known: ['Cure Wounds'] } },
    ...overrides,
  };
}

async function call(name, args) {
  const entry = tools.instance._registeredTools[name];
  if (!entry) throw new Error(`tool ${name} is not registered`);
  return entry.handler(args, {});
}
function payload(res) { return JSON.parse(res.content[0].text); }

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mech-uncovered-'));
  const realRules = path.join(__dirname, '..', '..', 'data', 'rules');
  fs.mkdirSync(path.join(tmpDir, 'rules'), { recursive: true });
  for (const f of ['combat.json', 'classes.json', 'leveling.json']) {
    fs.copyFileSync(path.join(realRules, f), path.join(tmpDir, 'rules', f));
  }
  writeJson(path.join(tmpDir, 'sessions', SESSION, 'session.json'), { id: SESSION, messages: [] });
  writeJson(charPath('kaelara'), makeSheet());
  writeJson(npcPath('pip'), makeSheet({
    id: 'npc-pip', name: 'Pip', class: 'Rogue', hitPoints: { max: 8, current: 8 }, equipment: ['Darts (2)'],
  }));

  // Module-level Map in combat-utils; a leaked encounter would make these tests order-dependent.
  require('../combat-utils')._testing.combatStates.clear();

  engine = new DmEngine(tmpDir);
  tools = engine._getMcpToolServer(EMAIL, CAMPAIGN, SESSION, 'char-kaelara');
});

afterEach(() => {
  require('../combat-utils')._testing.combatStates.clear();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function startEncounter(extra = []) {
  return call('TrackCombat', {
    action: 'start',
    combatants: [
      { name: 'Kaelara Brightflame', id: 'char-kaelara', initiativeBonus: 10 },
      { name: 'Pip', id: 'npc-pip', initiativeBonus: 5 },
      ...extra,
    ],
  });
}

// ──────────────────────────────────────────────────────────── TrackCombat: next

describe('TrackCombat "next" — turn order (combat-utils.nextTurn, never executed before)', () => {
  it('errors when there is no encounter, rather than inventing one', async () => {
    const res = await call('TrackCombat', { action: 'next' });
    expect(res.isError).toBe(true);
    expect(payload(res).error).toMatch(/No active combat/i);
  });

  it('advances through the order and increments the round on wrap', async () => {
    await startEncounter();
    const seen = [];
    for (let i = 0; i < 4; i++) seen.push(payload(await call('TrackCombat', { action: 'next' })));
    // Two combatants: the round must have advanced at least once across four turns.
    expect(seen[seen.length - 1].round).toBeGreaterThan(1);
    for (const turn of seen) {
      expect(turn.action).toBe('next');
      expect(typeof turn.currentTurn).toBe('string');
    }
  });

  it('a character at 0 HP still takes its turn, and is told to roll a death save', async () => {
    // The ADR's rule in the one place it is observable: being downed is not being skipped.
    await startEncounter();
    await call('TrackCombat', { action: 'damage', target: 'Kaelara Brightflame', amount: 5 });
    expect(readChar('kaelara').hitPoints.current).toBe(0);
    expect(readChar('kaelara').status).not.toBe('dead');

    let turn = null;
    for (let i = 0; i < 4 && !(turn && turn.currentTurn === 'Kaelara Brightflame'); i++) {
      turn = payload(await call('TrackCombat', { action: 'next' }));
    }
    expect(turn.currentTurn).toBe('Kaelara Brightflame');
    expect(turn.condition).toMatch(/unconscious/i);
    expect(turn.deathSaves).toEqual({ successes: 0, failures: 0, stable: false });
    expect(turn.required).toMatch(/ApplyVitals/);
    expect(turn.required).toMatch(/deathsave/);
    // The DM is told not to decide it — the whole point of the change.
    expect(turn.required).toMatch(/Do not decide the result yourself/i);
  });

  it('a stable character is told it makes no save', async () => {
    await startEncounter();
    await call('TrackCombat', { action: 'damage', target: 'Kaelara Brightflame', amount: 5 });
    await call('ApplyVitals', { action: 'stabilize', characterId: 'char-kaelara' });

    let turn = null;
    for (let i = 0; i < 4 && !(turn && turn.currentTurn === 'Kaelara Brightflame'); i++) {
      turn = payload(await call('TrackCombat', { action: 'next' }));
    }
    expect(turn.currentTurn).toBe('Kaelara Brightflame');
    expect(turn.required).toMatch(/stable/i);
    expect(turn.required).not.toMatch(/Do not decide/i);
  });

  it('skips a dead combatant (combat-utils.skipsTurns)', async () => {
    await startEncounter();
    // Kill Kaelara outright: max HP of overflow damage from 5 is instant death.
    await call('TrackCombat', { action: 'damage', target: 'Kaelara Brightflame', amount: 99 });
    expect(readChar('kaelara').status).toBe('dead');

    const turns = [];
    for (let i = 0; i < 4; i++) turns.push(payload(await call('TrackCombat', { action: 'next' })).currentTurn);
    expect(turns).not.toContain('Kaelara Brightflame');
    expect(turns).toContain('Pip');
  });

  it('counts conditions down and drops them when they expire', async () => {
    await startEncounter();
    await call('TrackCombat', { action: 'condition', target: 'Pip', condition: 'poisoned', roundsLeft: 1 });
    let status = payload(await call('TrackCombat', { action: 'status' }));
    let pip = status.combatants.find(c => c.name === 'Pip');
    expect(pip.conditions.map(c => c.name || c)).toContain('poisoned');

    // Advance far enough that Pip's own turn has ended at least twice.
    for (let i = 0; i < 5; i++) await call('TrackCombat', { action: 'next' });
    status = payload(await call('TrackCombat', { action: 'status' }));
    pip = status.combatants.find(c => c.name === 'Pip');
    expect(pip.conditions.length).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────── TrackCombat: heal

describe('TrackCombat "heal" — the second write path into hit points (combat-utils.applyHealing)', () => {
  it('writes the sheet, through the same code as ApplyVitals', async () => {
    await startEncounter();
    await call('TrackCombat', { action: 'damage', target: 'Kaelara Brightflame', amount: 3 });
    expect(readChar('kaelara').hitPoints.current).toBe(2);

    const res = await call('TrackCombat', { action: 'heal', target: 'Kaelara Brightflame', amount: 4 });
    expect(res.isError).toBeFalsy();
    const out = payload(res);
    expect(out.currentHp).toBe(6);
    expect(readChar('kaelara').hitPoints.current).toBe(6);
    expect(out.healed).toBe(4);
  });

  it('never exceeds maximum hit points', async () => {
    await startEncounter();
    const res = await call('TrackCombat', { action: 'heal', target: 'Kaelara Brightflame', amount: 999 });
    const out = payload(res);
    expect(out.currentHp).toBe(10);
    expect(readChar('kaelara').hitPoints.current).toBe(10);
    expect(readChar('kaelara').hitPoints.current).toBeLessThanOrEqual(readChar('kaelara').hitPoints.max);
  });

  it('healing from 0 restores consciousness and clears the death saves', async () => {
    await startEncounter();
    await call('TrackCombat', { action: 'damage', target: 'Kaelara Brightflame', amount: 5 });
    expect(isDowned(readChar('kaelara'))).toBe(true);

    const out = payload(await call('TrackCombat', { action: 'heal', target: 'Kaelara Brightflame', amount: 1 }));
    expect(out.currentHp).toBe(1);
    expect(out.restoredToConsciousness).toBe(true);
    const sheet = readChar('kaelara');
    expect(isDowned(sheet)).toBe(false);
    expect(describeCondition(sheet)).toBe('conscious');
    // Asserted through readDeathSaves, not the raw key. writeVitals deliberately declines to
    // add a `deathSaves` block to a sheet that never had one when the value is the default, so
    // recovering does not leave a bookkeeping field on every character who was ever downed.
    // The semantic — no successes, no failures, not stable — is what has to hold.
    expect(readDeathSaves(sheet)).toEqual({ successes: 0, failures: 0, stable: false });
  });

  it('does not add a deathSaves block to a sheet that never had one', async () => {
    await startEncounter();
    expect(readChar('kaelara').deathSaves).toBeUndefined();
    await call('TrackCombat', { action: 'damage', target: 'Kaelara Brightflame', amount: 5 });
    await call('TrackCombat', { action: 'heal', target: 'Kaelara Brightflame', amount: 1 });
    expect(readChar('kaelara').deathSaves).toBeUndefined();
    expect(readDeathSaves(readChar('kaelara'))).toEqual({ successes: 0, failures: 0, stable: false });
  });

  it('heals a sheetless monster in memory only, writing no file', async () => {
    await startEncounter([{ name: 'Goblin', hp: 3, maxHp: 7, isEnemy: true }]);
    const before = fs.readdirSync(path.join(tmpDir, 'sessions', SESSION, 'characters'));
    const out = payload(await call('TrackCombat', { action: 'heal', target: 'Goblin', amount: 2 }));
    expect(out.currentHp).toBe(5);
    expect(out.maxHp).toBe(7);
    expect(fs.readdirSync(path.join(tmpDir, 'sessions', SESSION, 'characters'))).toEqual(before);
  });

  it('refuses a target that is neither in the encounter nor on disk', async () => {
    await startEncounter();
    const res = await call('TrackCombat', { action: 'heal', target: 'Nobody At All', amount: 2 });
    expect(res.isError).toBe(true);
    expect(payload(res).error).toMatch(/not found/i);
  });
});

// ──────────────────────────────────────────────────────── TrackCombat: condition

describe('TrackCombat "condition" (combat-utils.setCondition, never executed before)', () => {
  it('adds a condition with a duration, and reports it in status', async () => {
    await startEncounter();
    const res = await call('TrackCombat', { action: 'condition', target: 'Pip', condition: 'frightened', roundsLeft: 3 });
    expect(res.isError).toBeFalsy();
    const status = payload(await call('TrackCombat', { action: 'status' }));
    const pip = status.combatants.find(c => c.name === 'Pip');
    expect(JSON.stringify(pip.conditions)).toMatch(/frightened/);
  });

  it('removes a condition when remove is true', async () => {
    await startEncounter();
    await call('TrackCombat', { action: 'condition', target: 'Pip', condition: 'stunned' });
    await call('TrackCombat', { action: 'condition', target: 'Pip', condition: 'stunned', remove: true });
    const status = payload(await call('TrackCombat', { action: 'status' }));
    const pip = status.combatants.find(c => c.name === 'Pip');
    expect(JSON.stringify(pip.conditions)).not.toMatch(/stunned/);
  });

  it('errors for a combatant who is not in the encounter', async () => {
    await startEncounter();
    const res = await call('TrackCombat', { action: 'condition', target: 'Ghost', condition: 'poisoned' });
    expect(res.isError).toBe(true);
    expect(payload(res).error).toMatch(/not found/i);
  });

  it('errors when there is no encounter at all', async () => {
    const res = await call('TrackCombat', { action: 'condition', target: 'Pip', condition: 'poisoned' });
    expect(res.isError).toBe(true);
    expect(payload(res).error).toMatch(/No active combat/i);
  });

  it('a condition never changes hit points', async () => {
    await startEncounter();
    const before = readChar('kaelara').hitPoints.current;
    await call('TrackCombat', { action: 'condition', target: 'Kaelara Brightflame', condition: 'poisoned', roundsLeft: 2 });
    expect(readChar('kaelara').hitPoints.current).toBe(before);
  });
});

// ────────────────────────────────────────────────────────── TrackResources: use

describe('TrackResources "use" — consumables (resource-utils.useResource, never executed before)', () => {
  it('decrements a counted item and writes the sheet', async () => {
    const res = await call('TrackResources', { action: 'use', characterId: 'char-kaelara', resource: 'Arrows', quantity: 3 });
    expect(res.isError).toBeFalsy();
    const out = payload(res);
    expect(out.used).toBe(3);
    expect(out.remaining).toBe(15);
    expect(readChar('kaelara').equipment).toContain('Arrows (15)');
  });

  it('defaults to one when no quantity is given', async () => {
    const out = payload(await call('TrackResources', { action: 'use', characterId: 'char-kaelara', resource: 'Rations' }));
    expect(out.remaining).toBe(3);
  });

  it('warns when the count runs low', async () => {
    const out = payload(await call('TrackResources', { action: 'use', characterId: 'char-kaelara', resource: 'Rations', quantity: 2 }));
    expect(out.remaining).toBe(2);
    expect(out.warning).toMatch(/running low/i);
  });

  it('removes the item entirely when it is used up, and says so', async () => {
    const out = payload(await call('TrackResources', { action: 'use', characterId: 'char-kaelara', resource: 'Rope', quantity: 1 }));
    expect(out.remaining).toBe(0);
    expect(out.warning).toMatch(/run out/i);
    expect(readChar('kaelara').equipment.join('|')).not.toMatch(/Rope/);
  });

  it('never goes negative, however much is asked for', async () => {
    const out = payload(await call('TrackResources', { action: 'use', characterId: 'char-kaelara', resource: 'Arrows', quantity: 9999 }));
    expect(out.remaining).toBe(0);
    expect(out.remaining).toBeGreaterThanOrEqual(0);
  });

  it('refuses an item carried without a count, and says how to fix it', async () => {
    const res = await call('TrackResources', { action: 'use', characterId: 'char-kaelara', resource: 'Torches' });
    expect(res.isError).toBe(true);
    expect(payload(res).error).toMatch(/no quantity tracked/i);
    expect(payload(res).error).toMatch(/Torches \(10\)/);
  });

  it('refuses an item the character does not have', async () => {
    const res = await call('TrackResources', { action: 'use', characterId: 'char-kaelara', resource: 'Ballista' });
    expect(res.isError).toBe(true);
    expect(payload(res).error).toMatch(/does not have/i);
  });

  it('names the party when the character is unknown (resource-utils.notFoundError)', async () => {
    const res = await call('TrackResources', { action: 'use', characterId: 'nobody-at-all', resource: 'Arrows' });
    expect(res.isError).toBe(true);
    const err = payload(res).error;
    expect(err).toMatch(/not found/i);
    expect(err).toMatch(/Known party/i);
  });

  it('matches the resource name case-insensitively', async () => {
    const out = payload(await call('TrackResources', { action: 'use', characterId: 'char-kaelara', resource: 'arrows', quantity: 1 }));
    expect(out.remaining).toBe(17);
  });

  it('works on an NPC sheet as well as a player character', async () => {
    const out = payload(await call('TrackResources', { action: 'use', characterId: 'npc-pip', resource: 'Darts', quantity: 1 }));
    expect(out.remaining).toBe(1);
  });

  it('touches no governed field — consumables are not hit points', async () => {
    const before = readChar('kaelara');
    await call('TrackResources', { action: 'use', characterId: 'char-kaelara', resource: 'Arrows', quantity: 2 });
    const after = readChar('kaelara');
    expect(after.hitPoints).toEqual(before.hitPoints);
    expect(after.status).toBe(before.status);
    expect(after.experience).toBe(before.experience);
    expect(after.level).toBe(before.level);
  });
});

// ──────────────────────────────────────────────────────────────── vitals reading

describe('vitals-utils.isDowned (never executed before)', () => {
  it('is true at 0 HP and not dead, false everywhere else', () => {
    expect(isDowned(makeSheet({ hitPoints: { max: 10, current: 0 }, status: 'alive' }))).toBe(true);
    expect(isDowned(makeSheet({ hitPoints: { max: 10, current: 1 }, status: 'alive' }))).toBe(false);
    expect(isDowned(makeSheet({ hitPoints: { max: 10, current: 10 }, status: 'alive' }))).toBe(false);
    expect(isDowned(makeSheet({ hitPoints: { max: 10, current: 0 }, status: 'dead' }))).toBe(false);
  });

  it('says false rather than throwing for a sheet with no vitals', () => {
    expect(isDowned({})).toBe(false);
    expect(isDowned(null)).toBe(false);
    expect(isDowned({ hitPoints: {} })).toBe(false);
  });

  it('agrees with describeCondition across the whole ladder', () => {
    const ladder = [
      { hp: 10, status: 'alive', downed: false, phrase: 'conscious' },
      { hp: 1, status: 'alive', downed: false, phrase: 'conscious' },
      { hp: 0, status: 'alive', downed: true, phrase: 'unconscious and dying' },
      { hp: 0, status: 'dead', downed: false, phrase: 'dead' },
    ];
    for (const step of ladder) {
      const sheet = makeSheet({ hitPoints: { max: 10, current: step.hp }, status: step.status });
      expect(isDowned(sheet)).toBe(step.downed);
      expect(describeCondition(sheet)).toBe(step.phrase);
      expect(readVitals(sheet).current).toBe(step.hp);
    }
  });
});
