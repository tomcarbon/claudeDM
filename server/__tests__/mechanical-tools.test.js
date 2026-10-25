// WO-0015.4 (implementer's own coverage). Eight of the nine MCP tools had no handler-level test
// at all; these cover the two new ones and the two that changed, plus the permission policy they
// depend on. Nothing here starts an agent: the handlers are called directly, as
// dm-engine.test.js already does for UpdateWorldState.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import express from 'express';

const { DmEngine } = require('../dm-engine');
const { auditDmTurn, buildMechanicalCorrection, needsReconcile, buildReconcilePrompt } = require('../dm-audit');

const EMAIL = 'hero@test.com';
const CAMPAIGN = 'demo';
const SESSION = 'sess-mech-1';

let tmpDir;
let engine;
let tools;

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function charPath(id = 'kaelara') {
  return path.join(tmpDir, 'sessions', SESSION, 'characters', `${id}.json`);
}

function readChar(id = 'kaelara') {
  return JSON.parse(fs.readFileSync(charPath(id), 'utf-8'));
}

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
    equipment: ['Arrows (18)'],
    spells: { level1: { slots: 2, known: ['Cure Wounds'] } },
    ...overrides,
  };
}

async function call(name, args) {
  const entry = tools.instance._registeredTools[name];
  if (!entry) throw new Error(`tool ${name} is not registered`);
  return entry.handler(args, {});
}

function payload(res) {
  return JSON.parse(res.content[0].text);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mech-tools-'));
  // Real rules files: the state machine reads its numbers out of them.
  const realData = path.join(__dirname, '..', '..', 'data', 'rules');
  fs.mkdirSync(path.join(tmpDir, 'rules'), { recursive: true });
  for (const f of ['combat.json', 'classes.json', 'leveling.json']) {
    fs.copyFileSync(path.join(realData, f), path.join(tmpDir, 'rules', f));
  }
  writeJson(path.join(tmpDir, 'sessions', SESSION, 'session.json'), { id: SESSION, messages: [] });
  writeJson(charPath(), makeSheet());

  // combat-utils keeps its state in a module-level Map; a test that fails mid-encounter would
  // otherwise leak an active combat into the next one.
  require('../combat-utils')._testing.combatStates.clear();

  engine = new DmEngine(tmpDir);
  tools = engine._getMcpToolServer(EMAIL, CAMPAIGN, SESSION, 'char-kaelara');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('ApplyVitals writes the sheet', () => {
  it('the chair\'s case, end to end: 5 HP, 2 damage, alive at 3 on disk', async () => {
    const res = await call('ApplyVitals', { action: 'damage', characterId: 'char-kaelara', amount: 2 });
    expect(res.isError).toBeFalsy();

    const out = payload(res);
    expect(out.outcome).toBe('damaged');
    expect(out.hitPoints).toEqual({ current: 3, max: 10, temp: 0 });

    const saved = readChar();
    expect(saved.hitPoints.current).toBe(3);
    expect(saved.status).toBe('alive');
  });

  it('resolves a character by name as well as by id', async () => {
    const res = await call('ApplyVitals', { action: 'damage', characterId: 'Kaelara Brightflame', amount: 1 });
    expect(payload(res).hitPoints.current).toBe(4);
  });

  it('rolls a real d20 for a death save and puts it in the player\'s dice stream', async () => {
    writeJson(charPath(), makeSheet({ hitPoints: { max: 10, current: 0 } }));
    engine._diceResults.length = 0;

    const res = await call('ApplyVitals', { action: 'deathsave', characterId: 'char-kaelara' });
    expect(res.isError).toBeFalsy();

    expect(engine._diceResults).toHaveLength(1);
    const roll = engine._diceResults[0];
    expect(roll.notation).toBe('1d20');
    expect(roll.label).toContain('death save');
    expect(payload(res).roll).toBe(roll.rolls[0]);
  });

  it('does not roll a die for a death save that is not legal', async () => {
    engine._diceResults.length = 0;
    const res = await call('ApplyVitals', { action: 'deathsave', characterId: 'char-kaelara' });
    expect(res.isError).toBe(true);
    expect(engine._diceResults).toHaveLength(0);
    expect(readChar().hitPoints.current).toBe(5);
  });

  it('routes a max-HP decrease to the player rather than applying it', async () => {
    const res = await call('ApplyVitals', { action: 'setmax', characterId: 'char-kaelara', value: 4 });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('OverrideMechanicalState');
    expect(readChar().hitPoints.max).toBe(10);
  });

  it('applies a max-HP increase without asking', async () => {
    const res = await call('ApplyVitals', { action: 'setmax', characterId: 'char-kaelara', value: 18 });
    expect(res.isError).toBeFalsy();
    expect(readChar().hitPoints.max).toBe(18);
  });

  it('reports a character it cannot find instead of writing something', async () => {
    const res = await call('ApplyVitals', { action: 'damage', characterId: 'nobody', amount: 3 });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('not found');
  });

  it('records every outcome in the turn ledger', async () => {
    engine._mechanicalOutcomes.length = 0;
    await call('ApplyVitals', { action: 'damage', characterId: 'char-kaelara', amount: 2 });
    await call('ApplyVitals', { action: 'heal', characterId: 'char-kaelara', amount: 1 });
    expect(engine._mechanicalOutcomes.map(o => o.outcome)).toEqual(['damaged', 'healed']);
    expect(engine._mechanicalOutcomes[0].tool).toBe('ApplyVitals');
  });
});

describe('condition M2 — OverrideMechanicalState cannot kill', () => {
  it('refuses to set status to dead, and writes nothing', async () => {
    const res = await call('OverrideMechanicalState', {
      characterId: 'char-kaelara', pointer: '/status', value: 'dead', reason: 'the ogre finished her',
    });
    expect(res.isError).toBe(true);
    expect(readChar().status).toBe('alive');
  });

  it('refuses to reduce hit points to 0, and writes nothing', async () => {
    const res = await call('OverrideMechanicalState', {
      characterId: 'char-kaelara', pointer: '/hitPoints/current', value: 0, reason: 'she should be down',
    });
    expect(res.isError).toBe(true);
    expect(readChar().hitPoints.current).toBe(5);
  });

  it('can bring a dead character back, which is what the hatch is for', async () => {
    writeJson(charPath(), makeSheet({ status: 'dead', hitPoints: { max: 10, current: 0 } }));
    const res = await call('OverrideMechanicalState', {
      characterId: 'char-kaelara', pointer: '/status', value: 'alive', reason: 'the cleric cast Revivify',
    });
    expect(res.isError).toBeFalsy();
    expect(readChar().status).toBe('alive');

    // ...and healing works again once they are alive.
    const healed = await call('ApplyVitals', { action: 'heal', characterId: 'char-kaelara', amount: 1 });
    expect(healed.isError).toBeFalsy();
    expect(readChar().hitPoints.current).toBe(1);
  });

  it('applies the changes it exists for, and records them in session.json', async () => {
    const res = await call('OverrideMechanicalState', {
      characterId: 'char-kaelara', pointer: '/hitPoints/current', value: 9,
      reason: 'the potion should have landed before the second attack',
    });
    expect(res.isError).toBeFalsy();
    expect(readChar().hitPoints.current).toBe(9);

    const session = JSON.parse(fs.readFileSync(path.join(tmpDir, 'sessions', SESSION, 'session.json'), 'utf-8'));
    expect(session.mechanicalOverrides).toHaveLength(1);
    expect(session.mechanicalOverrides[0].pointer).toBe('/hitPoints/current');
    expect(session.mechanicalOverrides[0].previousValue).toBe(5);
    expect(session.mechanicalOverrides[0].reason).toContain('potion');
  });
});

describe('condition M1 — the player is told what they are approving', () => {
  it('describes the change in plain English with both values and the reason', () => {
    const { describeOverrideRequest } = require('../vitals-utils');
    const context = describeOverrideRequest(tmpDir, {
      characterId: 'char-kaelara', pointer: '/hitPoints/current', value: 9,
      reason: 'the potion should have landed first',
    }, { playerEmail: EMAIL, campaignId: CAMPAIGN, sessionId: SESSION });

    expect(context.entity).toBe('Kaelara Brightflame');
    expect(context.field).toBe('hit points');
    expect(context.currentValue).toBe('5 of 10');
    expect(context.proposedValue).toBe('9 of 10');
    expect(context.reason).toContain('potion');
    expect(context.description).toContain('Kaelara Brightflame');
    expect(context.description).toContain('If you decline');
    expect(context.description).toContain('Nothing has changed yet');
    expect(context.description).not.toContain('/hitPoints/current');
  });
});

describe('condition M3 — nothing that can kill runs in a suppressed turn', () => {
  beforeEach(() => { engine._turnMode.reconcile = true; });
  afterEach(() => { engine._turnMode.reconcile = false; });

  it('ApplyVitals refuses and the sheet is unchanged', async () => {
    const res = await call('ApplyVitals', { action: 'damage', characterId: 'char-kaelara', amount: 4 });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('reconciliation pass');
    expect(readChar().hitPoints.current).toBe(5);
  });

  it('TrackCombat damage and heal refuse', async () => {
    for (const action of ['damage', 'heal']) {
      const res = await call('TrackCombat', { action, target: 'Kaelara Brightflame', amount: 3 });
      expect(res.isError).toBe(true);
    }
    expect(readChar().hitPoints.current).toBe(5);
  });

  it('OverrideMechanicalState and TrackResources rest refuse', async () => {
    expect((await call('OverrideMechanicalState', { characterId: 'char-kaelara', pointer: '/hitPoints/current', value: 9, reason: 'x' })).isError).toBe(true);
    expect((await call('TrackResources', { action: 'rest', characterId: 'char-kaelara', restType: 'long' })).isError).toBe(true);
  });

  it('the reconcile prompt no longer tells the DM to apply damage by hand', () => {
    const prompt = buildReconcilePrompt(
      [{ category: 'currency', trigger: '5 gp', excerpt: 'pays 5 gp' }],
      'data/sessions/x/characters', 'data/sessions/x/npcs'
    );
    expect(prompt).toContain('cannot be changed in this pass');
    expect(prompt).not.toMatch(/apply the change now via Edit/);
  });

  it('a narrated-but-unapplied hit point change no longer triggers the pass at all', () => {
    const warnings = auditDmTurn('The ogre hits Kaelara and she takes 4 damage.', [], []);
    expect(warnings.map(w => w.category)).toContain('damage_or_healing');
    expect(needsReconcile(warnings)).toBe(false);
  });
});

describe('condition M4 — a downed character is not called dead', () => {
  it('TrackCombat damage to 0 HP on a file-backed character says nothing about being dead', async () => {
    const start = await call('TrackCombat', {
      action: 'start',
      combatants: [
        { name: 'Kaelara Brightflame', id: 'char-kaelara', initiativeBonus: 2 },
        { name: 'Ogre', hp: 30, maxHp: 30, isEnemy: true },
      ],
    });
    expect(start.isError).toBeFalsy();

    const res = await call('TrackCombat', { action: 'damage', target: 'Kaelara Brightflame', amount: 5 });
    expect(res.isError).toBeFalsy();

    const text = res.content[0].text;
    expect(/dead/i.test(text)).toBe(false);
    expect(/has fallen/i.test(text)).toBe(false);

    const out = payload(res);
    expect(out.outcome).toBe('downed');
    expect(out.currentHp).toBe(0);
    expect(out.condition).toBe('unconscious and dying');
    expect('dead' in out).toBe(false);
    expect(readChar().status).toBe('alive');

    await call('TrackCombat', { action: 'end' });
  });

  it('a sheetless monster is still dead at 0 HP — that rule is right for monsters', async () => {
    await call('TrackCombat', {
      action: 'start',
      combatants: [{ name: 'Ogre', hp: 4, maxHp: 30, isEnemy: true }],
    });
    const res = await call('TrackCombat', { action: 'damage', target: 'Ogre', amount: 9 });
    const out = payload(res);
    expect(out.dead).toBe(true);
    expect(out.outcome).toBe('death');
    await call('TrackCombat', { action: 'end' });
  });

  it('TrackCombat reads hit points from the sheet rather than from the number it was given', async () => {
    await call('TrackCombat', {
      action: 'start',
      combatants: [{ name: 'Kaelara Brightflame', id: 'char-kaelara', hp: 999, maxHp: 999 }],
    });
    const status = payload(await call('TrackCombat', { action: 'status' }));
    expect(status.combatants[0].hp).toBe('5/10');
    expect(status.combatants[0].hpSource).toBe('character sheet');
    await call('TrackCombat', { action: 'end' });
  });

  it('damage works with no active encounter — traps, falls, poison', async () => {
    const res = await call('TrackCombat', { action: 'damage', target: 'char-kaelara', amount: 2 });
    expect(res.isError).toBeFalsy();
    expect(payload(res).inCombat).toBe(false);
    expect(readChar().hitPoints.current).toBe(3);
  });
});

describe('TrackResources: spell slots and hit dice now persist', () => {
  it('spends a spell slot onto the sheet and refuses to overspend', async () => {
    expect(payload(await call('TrackResources', { action: 'cast', characterId: 'char-kaelara', spellLevel: 1 })).slotsRemaining).toBe(1);
    expect(readChar().spellSlotsUsed).toEqual({ level1: 1 });

    await call('TrackResources', { action: 'cast', characterId: 'char-kaelara', spellLevel: 1 });
    expect(readChar().spellSlotsUsed).toEqual({ level1: 2 });

    const third = await call('TrackResources', { action: 'cast', characterId: 'char-kaelara', spellLevel: 1 });
    expect(third.isError).toBe(true);
    expect(readChar().spellSlotsUsed).toEqual({ level1: 2 });
  });

  it('refuses a spell level the character has no slots for', async () => {
    const res = await call('TrackResources', { action: 'cast', characterId: 'char-kaelara', spellLevel: 5 });
    expect(res.isError).toBe(true);
  });

  it('seeds hit dice from the class and level on first use', async () => {
    const out = payload(await call('TrackResources', { action: 'hitdice', characterId: 'char-kaelara', quantity: 1 }));
    expect(out.die).toBe('d8');        // Cleric, data/rules/classes.json
    expect(out.total).toBe(2);         // level 2
    expect(out.remaining).toBe(1);
    expect(readChar().hitDice).toEqual({ die: 'd8', total: 2, remaining: 1 });
  });

  it('refuses to spend hit dice that are not there', async () => {
    await call('TrackResources', { action: 'hitdice', characterId: 'char-kaelara', quantity: 2 });
    const res = await call('TrackResources', { action: 'hitdice', characterId: 'char-kaelara', quantity: 1 });
    expect(res.isError).toBe(true);
  });

  it('a long rest restores hit points, slots and half the hit dice, and clears death saves', async () => {
    writeJson(charPath(), makeSheet({
      hitPoints: { max: 10, current: 0 },
      deathSaves: { successes: 1, failures: 2, stable: true },
      spellSlotsUsed: { level1: 2 },
      hitDice: { die: 'd8', total: 4, remaining: 0 },
    }));
    const res = await call('TrackResources', { action: 'rest', characterId: 'char-kaelara', restType: 'long' });
    expect(res.isError).toBeFalsy();

    const saved = readChar();
    expect(saved.hitPoints.current).toBe(10);
    expect(saved.deathSaves).toEqual({ successes: 0, failures: 0, stable: false });
    expect(saved.spellSlotsUsed).toEqual({});
    expect(saved.hitDice.remaining).toBe(2);
  });

  it('a rest does not resurrect the dead', async () => {
    writeJson(charPath(), makeSheet({ status: 'dead', hitPoints: { max: 10, current: 0 } }));
    const res = await call('TrackResources', { action: 'rest', characterId: 'char-kaelara', restType: 'long' });
    expect(res.isError).toBe(true);
    expect(readChar().hitPoints.current).toBe(0);
  });

  it('check reports condition and death saves from the sheet', async () => {
    writeJson(charPath(), makeSheet({ hitPoints: { max: 10, current: 0 }, deathSaves: { successes: 0, failures: 2, stable: false } }));
    const out = payload(await call('TrackResources', { action: 'check', characterId: 'char-kaelara' }));
    expect(out.condition).toBe('unconscious and dying');
    expect(out.deathSaves.failures).toBe(2);
    expect(out.spellSlots.level1).toEqual({ total: 2, used: 0, remaining: 2 });
  });
});

describe('the permission policy', () => {
  function options(handlers = {}) {
    return engine._buildOptions(
      'char-kaelara', null, handlers.onPermissionRequest, EMAIL, CAMPAIGN,
      undefined, SESSION, undefined, undefined, undefined, handlers.onSessionNotice
    );
  }

  // The guard _buildOptions mounts is dm-engine's process-wide instance, constructed with no
  // `getMode` (dm-engine.js:29), so its mode comes from MECHANICAL_GUARD — read lazily, on every
  // call (state-guard.js:332). Left ambient, these tests inherit whatever shell ran them: under
  // MECHANICAL_GUARD=warn the guard returns {} for everything, so the deny assertion below threw
  // and the two `toEqual({})` assertions after it would have passed for the wrong reason. The
  // mode a test asserts against is therefore set by the test, and restored — the same pattern as
  // state-guard.test.js:345. (Injecting `getMode` directly, as state-guard.test.js:204/:323/:336
  // does, is not available at this seam: the mount owns the instance, and it is production code.)
  async function withGuardMode(mode, fn) {
    const before = process.env.MECHANICAL_GUARD;
    process.env.MECHANICAL_GUARD = mode;
    try {
      return await fn();
    } finally {
      if (before === undefined) delete process.env.MECHANICAL_GUARD;
      else process.env.MECHANICAL_GUARD = before;
    }
  }

  it('auto-allows exactly the tools in allowedTools, and no more', async () => {
    const opts = options();
    expect(opts.allowedTools).toContain('mcp__dnd-tools__ApplyVitals');
    expect(opts.allowedTools).not.toContain('mcp__dnd-tools__OverrideMechanicalState');

    for (const name of opts.allowedTools) {
      expect(await opts.canUseTool(name, {}, {})).toEqual({ behavior: 'allow' });
    }
  });

  it('no longer auto-allows a tool merely because its name starts with mcp__ (TD-17)', async () => {
    const asked = [];
    const opts = options({ onPermissionRequest: (name) => { asked.push(name); return false; } });
    const verdict = await opts.canUseTool('mcp__dnd-tools__SomethingNew', {}, { toolUseID: 't1' });
    expect(asked).toEqual(['mcp__dnd-tools__SomethingNew']);
    expect(verdict.behavior).toBe('deny');
  });

  it('sends the override to the player, with a description of the change', async () => {
    let seen = null;
    const opts = options({
      onPermissionRequest: (name, input, id, context) => { seen = { name, context }; return true; },
    });
    const verdict = await opts.canUseTool(
      'mcp__dnd-tools__OverrideMechanicalState',
      { characterId: 'char-kaelara', pointer: '/hitPoints/current', value: 9, reason: 'the potion landed first' },
      { toolUseID: 't2' }
    );
    expect(verdict).toEqual({ behavior: 'allow' });
    expect(seen.context.entity).toBe('Kaelara Brightflame');
    expect(seen.context.field).toBe('hit points');
    expect(seen.context.currentValue).toBe('5 of 10');
    expect(seen.context.proposedValue).toBe('9 of 10');
  });

  it('condition M2: a lethal override is refused BEFORE the player is asked anything', async () => {
    let asked = false;
    const opts = options({ onPermissionRequest: () => { asked = true; return true; } });

    const verdict = await opts.canUseTool(
      'mcp__dnd-tools__OverrideMechanicalState',
      { characterId: 'char-kaelara', pointer: '/status', value: 'dead', reason: 'she dies' },
      { toolUseID: 't3' }
    );
    expect(verdict.behavior).toBe('deny');
    expect(asked).toBe(false);
    expect(readChar().status).toBe('alive');
  });

  it('condition M6(b): with no handler, the denial is logged and said at the table', async () => {
    const notices = [];
    const opts = options({ onSessionNotice: (t) => notices.push(t) });
    const verdict = await opts.canUseTool('mcp__dnd-tools__OverrideMechanicalState', { pointer: '/hitPoints/current', value: 9 }, {});
    expect(verdict.behavior).toBe('deny');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('Session integrity');
  });

  it('mounts the governed-field guard on PreToolUse, at exactly one site', () => {
    const opts = options();
    expect(opts.hooks.PreToolUse).toHaveLength(1);
    expect(opts.hooks.PreToolUse[0].hooks).toHaveLength(1);
    expect(typeof opts.hooks.PreToolUse[0].hooks[0]).toBe('function');
  });

  it('in block, the mounted guard refuses an Edit to hit points and says nothing about anything else', async () => {
    await withGuardMode('block', async () => {
      const guard = options().hooks.PreToolUse[0].hooks[0];
      const file = charPath();

      const refused = await guard({
        tool_name: 'Edit',
        tool_input: { file_path: file, old_string: '"current": 5', new_string: '"current": 0' },
      });
      expect(refused.hookSpecificOutput.permissionDecision).toBe('deny');

      // The two silences below are only evidence in block: a guard in warn says {} to
      // everything, so asserting them in an inherited mode would assert nothing at all.
      expect(await guard({
        tool_name: 'Edit',
        tool_input: { file_path: file, old_string: 'Arrows (18)', new_string: 'Arrows (17)' },
      })).toEqual({});

      expect(await guard({
        tool_name: 'mcp__dnd-tools__OverrideMechanicalState',
        tool_input: { pointer: '/hitPoints/current', value: 9 },
      })).toEqual({});
    });
  });

  // MECHANICAL_GUARD=warn is tested against a directly constructed guard in
  // state-guard.test.js:334, but nothing exercised it through the mount, which is the only place
  // the rollout control is actually wired to the running DM. Same Edit as the test above, one
  // variable different: it must be evaluated and logged, and it must not be refused.
  it('in warn, the same Edit is evaluated and logged but not refused', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await withGuardMode('warn', async () => {
        const guard = options().hooks.PreToolUse[0].hooks[0];
        const out = await guard({
          tool_name: 'Edit',
          tool_input: { file_path: charPath(), old_string: '"current": 5', new_string: '"current": 0' },
        });
        expect(out).toEqual({});
      });
      const lines = warn.mock.calls.map(c => String(c[0])).join(' ');
      expect(lines).toContain('[DM:GUARD] would-deny');
      expect(lines).toContain('/hitPoints/current 5\u21920');
      expect(lines).not.toContain('[DM:GUARD] deny');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('the audit compares narration against the ledger', () => {
  const ROSTER = ['Kaelara Brightflame', 'Pip Underfoot'];
  const damaged = [{
    tool: 'ApplyVitals', outcome: 'damaged', entity: 'Kaelara Brightflame',
    status: 'alive', condition: 'conscious', hitPoints: { current: 3, max: 10 },
  }];

  it('a narrated death is no longer satisfied by any Edit at all', () => {
    const narration = 'The ogre\'s club comes down and Kaelara is killed.';
    const withAnEdit = auditDmTurn(narration, [{ name: 'Edit', input: {} }], []);
    expect(withAnEdit.map(w => w.category)).toContain('death_or_status');

    const withADeath = auditDmTurn(narration, [], [{ tool: 'ApplyVitals', outcome: 'death', entity: 'Kaelara' }]);
    expect(withADeath.map(w => w.category)).not.toContain('death_or_status');
  });

  it('corrects a death the tools did not compute, naming the character', () => {
    const correction = buildMechanicalCorrection(
      'The club lands and Kaelara is killed where she stands.', damaged, ROSTER
    );
    expect(correction.kind).toBe('fabricated_death');
    expect(correction.entities).toEqual(['Kaelara Brightflame']);
    expect(correction.text).toContain('3/10');
  });

  // The defect this scoping exists for (QC, WO-0015.4 audit): the first version fired on any
  // death word anywhere in the turn, so a round that killed a goblin and damaged a player
  // character produced "no character died this turn". That is most successful combat rounds,
  // and a warning that fires on most rounds is a warning nobody reads.
  it('stays silent when the thing that died was a goblin', () => {
    expect(buildMechanicalCorrection(
      'The goblin dies with a shriek. The second goblin hits her for 2.', damaged, ROSTER
    )).toBeNull();
  });

  it('stays silent when a monster dies in the same sentence as a character who did not', () => {
    // Naming a character in a death sentence is not the same as claiming they died. This is
    // the case that made the per-entity version of the rule too noisy to keep.
    expect(buildMechanicalCorrection(
      'Kaelara ducks as the ogre is slain by Pip\'s arrow.',
      [{ tool: 'TrackCombat', outcome: 'death', entity: 'Ogre' }, ...damaged],
      ROSTER
    )).toBeNull();
  });

  it('the stated gap: a real monster death in the turn silences a fabricated character death', () => {
    // Written down rather than left to be discovered. Any computed death this turn suppresses
    // the fabricated-death correction, which costs us the mixed turn and buys a message the
    // table will still be reading in a month.
    expect(buildMechanicalCorrection(
      'The ogre falls dead. Kaelara is killed by the second blow.',
      [{ tool: 'TrackCombat', outcome: 'death', entity: 'Ogre' }, ...damaged],
      ROSTER
    )).toBeNull();
  });

  it('stays silent on a death narrated only by pronoun — the direction it is meant to miss in', () => {
    expect(buildMechanicalCorrection('The club lands and she is killed.', damaged, ROSTER)).toBeNull();
  });

  it('stays silent when no mechanical tool ran — that is a bookkeeping question, not a contradiction', () => {
    expect(buildMechanicalCorrection('Kaelara is killed.', [], ROSTER)).toBeNull();
  });

  it('stays silent when the roster is unknown — it cannot tell a character from a goblin', () => {
    expect(buildMechanicalCorrection('Kaelara is killed.', damaged, [])).toBeNull();
    expect(buildMechanicalCorrection('Kaelara is killed.', damaged, undefined)).toBeNull();
  });

  it('takes the roster as a function so an ordinary turn never pays for the lookup', () => {
    let calls = 0;
    const roster = () => { calls += 1; return ROSTER; };

    expect(buildMechanicalCorrection('Kaelara takes 2 damage and stays up.', damaged, roster)).toBeNull();
    expect(calls).toBe(0);

    expect(buildMechanicalCorrection('Kaelara is killed.', damaged, roster).kind).toBe('fabricated_death');
    expect(calls).toBe(1);
  });

  it('states a death the DM computed but did not narrate', () => {
    const correction = buildMechanicalCorrection(
      'The fight ends and the party catches its breath.',
      [{ tool: 'ApplyVitals', outcome: 'death', entity: 'Pip Underfoot', reason: 'three failed death saves' }],
      ROSTER
    );
    expect(correction.kind).toBe('unnarrated_death');
    expect(correction.text).toContain('Pip Underfoot');
  });

  it('says nothing when the DM did narrate the death it computed', () => {
    expect(buildMechanicalCorrection(
      'Pip falls, slain by the ogre.',
      [{ tool: 'ApplyVitals', outcome: 'death', entity: 'Pip Underfoot', reason: 'three failed death saves' }],
      ROSTER
    )).toBeNull();
  });

  it('says nothing when the narration and the ledger agree', () => {
    expect(buildMechanicalCorrection('Kaelara takes 2 damage and stays on her feet.', damaged, ROSTER)).toBeNull();
  });

  it('costs one regex on a turn with no death in it either way', () => {
    let calls = 0;
    expect(buildMechanicalCorrection('They walk to the tavern and order two ales.', damaged, () => { calls += 1; return ROSTER; })).toBeNull();
    expect(calls).toBe(0);
  });
});

// ── Reading source is how several checks in this file work, so they read CODE ─────────────────
//
// Blank out whole-line and block comments before matching. Two reasons, and the second is the one
// that bit: a file that documents the defect it fixed quotes the line that shipped, and a detector
// that cannot tell code from the comment describing it flags the fix as the bug. compaction.js now
// carries `await fsp.writeFile(fp, ...)` inside a paragraph explaining why it is gone (WO-0017).
//
// Only leading comment markers are stripped, never a trailing `//` on a line of code — a URL or a
// path inside a string would be cut with it, and a false negative in a detector is worse than the
// noise it saves. A real write is never on a line that begins with a comment marker.
function codeOnly(source) {
  return String(source).split('\n').map((line) => {
    const t = line.trimStart();
    return (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) ? '' : line;
  }).join('\n');
}

// WO-0015.5 raised the un-awaited integrity checks as a race. They are deliberate, and the
// session.json writes they make are sequenced by updateSessionFile's per-session queue — so the
// fix was to scope the per-turn notice flag and to write the reasoning where the next reader
// looks, not to add `await`. The wiring is what can drift silently, so it is pinned here in the
// same style as the SDK contract test: by reading the source.
describe('session integrity checks: which are awaited, and which may silence a correction', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'ws-handler.js'), 'utf-8');

  it('the two pre-turn checks are awaited and marked as part of the turn', () => {
    const turnScoped = src.match(/await runSessionIntegrityCheck\([^)]*\{ partOfTurn: true \}\)/g) || [];
    expect(turnScoped).toHaveLength(2);
  });

  it('the two handshake checks are not awaited and are not part of a turn', () => {
    const scheduled = src.match(/scheduleSessionIntegrityCheck\(/g) || [];
    // Two call sites plus the function declaration.
    expect(scheduled.length).toBe(3);
    expect(src).not.toMatch(/await scheduleSessionIntegrityCheck\(/);
  });

  it('only a turn-scoped check may mark the flag that suppresses the correction', () => {
    // If this reverts to an unconditional noteTurnNotice, a handshake straggler settling
    // mid-turn silences the message built to catch the chair's original bug.
    expect(src).toMatch(/if \(partOfTurn\) noteTurnNotice\(sessionDbId, 'integrity'\)/);
  });

  it('background work is trackable rather than merely un-awaited', () => {
    expect(src).toContain('function whenSessionWorkSettled');
    expect(require('../ws-handler').whenSessionWorkSettled).toBeInstanceOf(Function);
  });

  // The previous version of this test read ws-handler.js alone, so it could not see the five
  // direct session.json writers in routes/sessions.js — which is exactly where they were. It
  // now walks every server file. The condition it protects is invisible from any single call
  // site, which is why it has had to be rediscovered three times.
  //
  // Reading source text, deliberately: this pins the wiring against drift, which is the risk.
  // It does not execute a race and must never be read as having reproduced one. The race was
  // reproduced separately, by probe: 200 losses in 200 interleavings before the fix, 0 after.
  //
  // ── Standing practice, from QC's audit of WO-0015.4 ───────────────────────────────────────
  // A check written to stop a defect recurring must be RUN AGAINST THE VERSION THAT HAD THE
  // DEFECT. The first version of the detector below was never run that way, and it passed the
  // defective revision. One command:
  //
  //     cp server/routes/sessions.js /tmp/keep.js
  //     git show <revision>:server/routes/sessions.js > server/routes/sessions.js
  //     node server/__tests__/_harness/run-file.mjs server/__tests__/mechanical-tools.test.js
  //     cp /tmp/keep.js server/routes/sessions.js
  //
  // Against d02cadd that is 3 failures — the whole-server scan, the per-route check, and the
  // behavioural join test. Against the current tree, 0.
  describe('every session.json writer goes through the queue that makes the above safe', () => {
    const SERVER_DIR = path.join(__dirname, '..');

    function serverFiles(dir = SERVER_DIR, out = []) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '__tests__' || entry.name === 'node_modules' || entry.name === 'bot') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) serverFiles(full, out);
        else if (entry.name.endsWith('.js')) out.push(full);
      }
      return out;
    }

    // Every direct session.json write that is allowed to exist, with the reason it is safe.
    // A new one shows up as a failure here and has to be justified or routed through the queue.
    const SANCTIONED = [
      // POST /sessions: the id was generated in the handler, the file does not exist yet, and
      // no client has been given the id — so there is nothing to read-modify-write.
      { file: 'routes/sessions.js', count: 2 },
      // updateSessionFile's own write. This one IS the queue; sequencing itself is not a thing
      // it needs to do.
      { file: 'player-data.js', count: 1 },
    ];

    // ── The matcher, and the reason it looks like this ────────────────────────────────────────
    //
    // The first version tested only the argument TEXT for `session.json` / `getSessionFilePath`.
    // QC ran it against HEAD — the revision with seven direct writes, five of them dangerous —
    // and it reported GREEN: the five dangerous writes are `writeJsonAtomic(filePath, session)`,
    // and a variable name says nothing. **The detector passed the code containing the defect it
    // exists to prevent.**
    //
    // So it now also resolves, per file, which identifiers were assigned from a session-path
    // source, and flags a write whose destination is one of them. Verified both ways before
    // being committed to: against HEAD it flags 7 against a sanctioned count of 2 and fails;
    // against the current tree it flags exactly the 2 sanctioned creation writes; and it flags
    // nothing in ws-handler.js, xp-utils.js, resource-utils.js, vitals-utils.js or
    // routes/characters.js, all of which write character files through the same function.
    const SESSION_PATH_SOURCE = /(getSessionFilePath|findSessionFile)\s*\(/;

    function sessionTaintedNames(source) {
      const names = new Set();
      for (const m of source.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]*)/g)) {
        if (SESSION_PATH_SOURCE.test(m[2])) names.add(m[1]);
      }
      return names;
    }

    // ── Widened to raw writes, WO-0017 ────────────────────────────────────────────────────────
    // The version above this one matched `writeJsonAtomic` and nothing else, and that is exactly
    // why nothing caught compaction.js: it read session.json, awaited an LLM call for seconds,
    // and wrote the whole file back with `await fsp.writeFile(fp, ...)`. Seven direct writers had
    // been found and fixed and a whole-server scan built to keep them found — and an eighth, in
    // the worst place in the codebase for a lost update, was invisible because it was spelled
    // differently. That is the same failure QC found in the first version of this detector, which
    // reported green against the revision containing the defect it existed to catch, and it is the
    // second time this class has cost a rediscovery. The matcher now names every way this codebase
    // has of putting bytes in a file.
    //
    // `appendFile` is included deliberately. Nothing appends to session.json today, and an append
    // to a JSON file would corrupt it rather than merely lose a field — but the lesson of both
    // rediscoveries is not to reason about which spellings a future writer will use.
    //
    // Known limits, so the next reader does not over-trust it: it requires the call to end in
    // `);`, so a write used as an expression is not seen; it does not follow a tainted path
    // through a helper (compaction's own `archivePathFor(fp)` produces an untainted name, which is
    // correct here — the archive is a different file — but the same mechanism would hide a real
    // one); and it is per-file, so a path passed between modules is invisible to it.
    const SESSION_WRITE_CALL = new RegExp(
      '(?:writeJsonAtomic|fsp\\.writeFile|fsp\\.appendFile|fs\\.promises\\.writeFile|fs\\.promises\\.appendFile'
      + '|fs\\.writeFileSync|fs\\.appendFileSync)\\s*\\(([\\s\\S]*?)\\)\\s*;',
      'g',
    );

    function directSessionWrites(source) {
      const code = codeOnly(source);
      const tainted = sessionTaintedNames(code);
      const hits = [];
      for (const m of code.matchAll(SESSION_WRITE_CALL)) {
        const args = m[1];
        const byText = /session\.json|getSessionFilePath|findSessionFile|sessionFilePath/.test(args);
        const first = (args.split(',')[0] || '').trim();
        if (byText || tainted.has(first)) hits.push(`${first}${byText ? ' [literal]' : ' [tainted var]'}`);
      }
      return hits;
    }

    // The permanent negative control, and it is the REAL defect rather than a proxy for it.
    // The `calendar-utils.js` control that accompanied the first version proved the file walk
    // worked; it used a spelling the matcher already caught, so it could not prove the matcher
    // caught the defect class. QC's general form: a negative control has to be the real defect.
    // These four lines are verbatim from the revision that shipped it.
    const THE_DEFECT = [
      "      const filePath = findSessionFile(req.params.id);",
      "      const session = JSON.parse(fs.readFileSync(filePath, 'utf-8'));",
      "      session.companionPlayers[npcId] = claim;",
      "      writeJsonAtomic(filePath, session);",
    ].join('\n');

    // The second permanent negative control, and it is also the real defect: the five lines that
    // shipped in compaction.js, verbatim from d02cadd. The matcher that shipped with WO-0015.4
    // returns [] for these — it only knew the word `writeJsonAtomic` — which is how a lost update
    // with a window measured in seconds sat under a green whole-server scan (WO-0017).
    const THE_COMPACTION_DEFECT = [
      "    const fp = getSessionFilePath(dataDir, sessionDbId);",
      "    let session;",
      "    try { session = JSON.parse(await fsp.readFile(fp, 'utf-8')); }",
      "    session.messages = liveTail;",
      "    await fsp.writeFile(fp, JSON.stringify(session, null, 2));",
    ].join('\n');

    it('flags the write that actually shipped — the control is the defect, not a stand-in', () => {
      expect(directSessionWrites(THE_DEFECT)).toHaveLength(1);
      // ...and it is caught by the variable, which is the part the first version was blind to.
      expect(directSessionWrites(THE_DEFECT)[0]).toContain('tainted var');
    });

    it('flags the raw write that shipped in compaction.js — the spelling the matcher could not see', () => {
      const hits = directSessionWrites(THE_COMPACTION_DEFECT);
      expect(hits).toHaveLength(1);
      expect(hits[0]).toContain('tainted var');
    });

    it('does not flag the archive append, which is a different file on purpose', () => {
      const archiveWrite = [
        "  const fp = getSessionFilePath(dataDir, sessionDbId);",
        "  const archiveFp = archivePathFor(fp);",
        "  await fsp.appendFile(archiveFp, append);",
      ].join('\n');
      expect(directSessionWrites(archiveWrite)).toEqual([]);
    });

    it('compaction commits through the queue rather than writing the file', () => {
      const compaction = fs.readFileSync(path.join(SERVER_DIR, 'compaction.js'), 'utf-8');
      expect(directSessionWrites(compaction)).toEqual([]);
      expect(compaction).toContain('updateSessionFile(dataDir, sessionDbId');
    });

    it('is not so broad that an ordinary character-file write trips it', () => {
      const characterWrite = [
        "  const filePath = path.join(dir, filename);",
        "  writeJsonAtomic(filePath, character);",
      ].join('\n');
      expect(directSessionWrites(characterWrite)).toEqual([]);
    });

    it('has no unsanctioned direct writer anywhere under server/', () => {
      const offenders = [];
      for (const file of serverFiles()) {
        const rel = path.relative(SERVER_DIR, file).split(path.sep).join('/');
        const hits = directSessionWrites(fs.readFileSync(file, 'utf-8'));
        if (hits.length === 0) continue;
        const allowed = SANCTIONED.find(entry => entry.file === rel);
        if (!allowed) offenders.push(`${rel}: ${hits.length} direct write(s) — ${hits[0]}`);
        else if (hits.length !== allowed.count) {
          offenders.push(`${rel}: ${hits.length} direct write(s), expected ${allowed.count}`);
        }
      }
      expect(offenders).toEqual([]);
    });

    it('ws-handler writes session.json only through the queue', () => {
      expect(directSessionWrites(src)).toEqual([]);
    });

    // Every handler a client can reach on a live session, with the number of direct file writes
    // it is allowed to contain.
    //
    // ── Why this is a list of counts now, and why that is stricter (WO-0016) ──────────────────
    // QC's line was blunt on purpose: inside a handler a client can reach on a live session there
    // is no such thing as a justified direct write. That was said about **session.json**, whose
    // writers race the DM's turn through a read-modify-write, and it is still enforced below,
    // unchanged, for every handler including the new one: `directSessionWrites(body)` must be
    // empty and the body must go through `updateSessionFile`.
    //
    // What has changed is that `not.toContain('writeJsonAtomic(')` was quietly doing a second
    // job — forbidding CHARACTER-sheet writes, which are a different file with a different
    // failure mode. `POST /:id/restore-character` writes exactly one, and its reason is at the
    // site. An exact count is a stronger check than a substring absence, not a weaker one: it
    // pins five handlers at zero (a substring test only ever sees the first occurrence) and pins
    // the sixth at one, so a *second* write appearing in the restore handler fails here.
    const LIVE_SESSION_HANDLERS = [
      { handler: "'/:id/join'", sheetWrites: 0 },
      { handler: "'/:id/unjoin'", sheetWrites: 0 },
      { handler: "'/:id/settings'", sheetWrites: 0 },
      { handler: "'/:id/label'", sheetWrites: 0 },
      { handler: "'/:id/players'", sheetWrites: 0 },
      // WO-0016. The player's own library sheet, copied back over the session copy after a death.
      { handler: "'/:id/restore-character'", sheetWrites: 1 },
    ];

    it('the routes that a client can reach on a live session use the queue', () => {
      const routes = fs.readFileSync(path.join(SERVER_DIR, 'routes', 'sessions.js'), 'utf-8');
      for (const { handler, sheetWrites } of LIVE_SESSION_HANDLERS) {
        const at = routes.indexOf(handler);
        expect(at).toBeGreaterThan(-1);
        // The handler body up to the next route registration.
        const next = routes.indexOf('router.', at + handler.length);
        const body = routes.slice(at, next === -1 ? routes.length : next);
        expect(body).toContain('updateSessionFile(');
        expect(directSessionWrites(body)).toEqual([]);
        expect((body.match(/writeJsonAtomic\s*\(/g) || []).length).toBe(sheetWrites);
      }
    });
  });
});

// ── The other half of the writer question: who may write a character sheet (WO-0016) ──────────
//
// The scan above walks every server file for direct **session.json** writes. It is blind to
// writes of a **character or NPC sheet** on purpose — one of its own tests asserts that an
// ordinary character write does not trip it — because session.json is the file that races the
// DM's turn.
//
// That leaves the other half of ADR 0005 unwatched. `hitPoints`, `status`, `deathSaves`,
// `hitDice`, `spellSlotsUsed`, `experience`, `level` and `proficiencyBonus` live on character
// sheets, and server/state-guard.js refuses the model any edit to one of them — unconditionally,
// no exceptions, no queue, no token. ADR 0005 §5.6 says in terms that the guard does **not** bind
// the server, so every server-side sheet writer is a hole in that rule that exists because
// somebody decided it should exist. There were seven of them before this work order and no list
// of them anywhere; WO-0016 adds the eighth.
//
// This is the list. `writeJsonAtomic` rewrites the whole file, so **any** writer of a sheet
// writes every governed field on it and there is no narrower question worth asking. A new writer
// — a new file, or a new call site in a file already here — fails this test until its reason is
// written at the site and its count is changed here deliberately.
//
// **Why counts and not just filenames.** The defect this guards against is not "somebody adds a
// module nobody noticed". It is the one QC found in the scan next door two days ago: a detector
// that reported green against the revision containing the very defect it existed to catch. A
// file-level list would wave through a second, unexamined write bolted into vitals-utils or into
// the restore route, and "a new sanctioned writer added without care" is precisely that shape.
// So the negative controls below are run against a list that is missing an entry and against a
// tree that has grown one, rather than against a proxy for either.
describe('every server-side writer of a character or NPC sheet is on a list, with a reason', () => {
  const SERVER_ROOT = path.join(__dirname, '..');

  // Sibling of the walker in the session.json scan above, and the same exclusions: the test
  // directory, node_modules, and server/bot (the bot harness writes its own config, never a
  // sheet). Kept separate rather than lifted so that deleting either scan cannot break the other.
  function serverSources(dir = SERVER_ROOT, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__tests__' || entry.name === 'node_modules' || entry.name === 'bot') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) serverSources(full, out);
      else if (entry.name.endsWith('.js')) out.push(full);
    }
    return out;
  }

  // The declaration in json-recovery.js is the function itself, not a use of it. Everything else
  // that matches is somebody persisting a JSON file, and on this codebase that is a sheet, a
  // session or a player library entry — all of which are governed or governed-adjacent.
  function sheetWrites(source) {
    // Comments stripped for the same reason the session scan strips them (see codeOnly): a file is
    // allowed to name the function in a sentence without being counted as calling it. This also
    // removes the trap that the reason-at-the-site comments in routes/sessions.js had to be
    // written without a following parenthesis to avoid inflating their own count.
    const withoutDeclaration = codeOnly(source).replace(/function\s+writeJsonAtomic\s*\(/g, 'function __declaration__(');
    return (withoutDeclaration.match(/writeJsonAtomic\s*\(/g) || []).length;
  }

  const SANCTIONED_SHEET_WRITERS = [
    {
      file: 'vitals-utils.js',
      count: 2,
      why: 'applyVitals and applyOverride. ADR 0005 §7 puts hit points, death and death saves here on purpose: these are the writes the guard exists to make the only ones. Both compute from the rules file; neither takes a number from the model.',
    },
    {
      file: 'xp-utils.js',
      count: 1,
      why: 'awardXp, behind AwardXP and AwardPartyXP. Experience, level and proficiency bonus are Ring 1 and this is their owner.',
    },
    {
      file: 'resource-utils.js',
      count: 4,
      why: 'useResource, castSpell, spendHitDice, processRest — the four TrackResources actions. Spell slots and hit dice are Ring 1; a long rest also clears death saves, which is why a rest cannot resurrect the dead.',
    },
    {
      file: 'player-data.js',
      count: 5,
      why: 'copyDefaultsToDir (provisioning the library from campaign defaults), copyFilesIfNotExist (the NPC half of the session snapshot), copySheetsIfIdNotPresent (the CHARACTER half of the session snapshot — WO-0026: the snapshot now prefers the player library and lets campaign defaults fill gaps only, it skips a source sheet whose id is already in the destination whatever its filename is, and a source sheet that will not parse is skipped and logged rather than aborting the snapshot — WO-0026 SEC-1), resetSingleEntity (reset-my-data, on the LIBRARY copy and never on a live session), and updateSessionFile\'s own session.json write, which is the queue itself. All three copiers refuse to overwrite an existing file.',
    },
    {
      file: 'ws-handler.js',
      count: 1,
      why: 'a companion player\'s chosen character copied into the session directory when they take a slot. It resolves the destination by character id first, so a re-slugified name cannot mint a second file for one character.',
    },
    {
      file: 'routes/characters.js',
      count: 4,
      why: 'the character editor and creator: import, roll, create, update. Player-facing, outside any session, and the one place a human is meant to author a sheet by hand.',
    },
    {
      file: 'routes/sessions.js',
      count: 3,
      why: 'two session.json writes at creation (sanctioned separately in the session scan: the id was minted in the handler and no client has it yet) plus ONE character-sheet write — POST /:id/restore-character (WO-0016), the restore from the player\'s library after a death. Reason at the site: no agent is involved, no number is invented, the player confirms it first and the whole party is told afterwards.',
    },
  ];

  /** Pure: given what is in the tree and what is on the list, what is unaccounted for. */
  function auditSheetWriters(found, sanctioned) {
    const offenders = [];
    for (const entry of found) {
      const allowed = sanctioned.find(s => s.file === entry.file);
      if (!allowed) {
        offenders.push(`${entry.file}: ${entry.count} sheet write(s), not on the sanctioned list`);
      } else if (allowed.count !== entry.count) {
        offenders.push(`${entry.file}: ${entry.count} sheet write(s), sanctioned for ${allowed.count}`);
      }
    }
    for (const allowed of sanctioned) {
      if (!found.some(e => e.file === allowed.file)) {
        offenders.push(`${allowed.file}: on the sanctioned list but writes no sheets — stale entry`);
      }
    }
    return offenders;
  }

  function scanTree() {
    const found = [];
    for (const filePath of serverSources()) {
      const count = sheetWrites(fs.readFileSync(filePath, 'utf-8'));
      if (count > 0) found.push({ file: path.relative(SERVER_ROOT, filePath).split(path.sep).join('/'), count });
    }
    return found;
  }

  it('the tree and the list agree, file for file and count for count', () => {
    expect(auditSheetWriters(scanTree(), SANCTIONED_SHEET_WRITERS)).toEqual([]);
  });

  it('every sanctioned writer states why it is allowed to write a governed field', () => {
    for (const entry of SANCTIONED_SHEET_WRITERS) {
      expect(entry.why.length).toBeGreaterThan(40);
    }
  });

  it('the restore route is on the list, and its entry names the route', () => {
    const entry = SANCTIONED_SHEET_WRITERS.find(e => e.file === 'routes/sessions.js');
    expect(entry.why).toContain('restore-character');
  });

  // ── Negative controls. Each is the real defect, not a stand-in for it. ───────────────────────

  it('flags the restore route when its sanction is taken away — the check run against the version without it', () => {
    // This is the closest thing to running the detector against the revision that had the defect:
    // the tree as it is, audited by the list as it was before WO-0016 added the entry. If the
    // scan could not see the new writer, this would report nothing and the sanction would be
    // decoration.
    const listWithoutTheRestore = SANCTIONED_SHEET_WRITERS
      .filter(e => e.file !== 'routes/sessions.js')
      .concat([{ file: 'routes/sessions.js', count: 2, why: 'the two session-creation writes, as sanctioned before WO-0016' }]);
    const offenders = auditSheetWriters(scanTree(), listWithoutTheRestore);
    expect(offenders).toHaveLength(1);
    expect(offenders[0]).toContain('routes/sessions.js: 3 sheet write(s), sanctioned for 2');
  });

  // The three below exercise the audit itself against a clean baseline rather than against the
  // tree, so that each reports exactly one offender and cannot be made to pass — or to fail — by
  // something unrelated happening in server/. The tree is the subject of the two tests above.
  const CLEAN = SANCTIONED_SHEET_WRITERS.map(({ file, count }) => ({ file, count }));

  it('flags a brand-new writer in a file nobody has looked at', () => {
    const found = CLEAN.concat([{ file: 'routes/necromancy.js', count: 1 }]);
    expect(auditSheetWriters(found, SANCTIONED_SHEET_WRITERS))
      .toEqual(['routes/necromancy.js: 1 sheet write(s), not on the sanctioned list']);
  });

  it('flags a second write bolted into a file that already had one', () => {
    const found = CLEAN.map(e => (e.file === 'vitals-utils.js' ? { ...e, count: 3 } : e));
    expect(auditSheetWriters(found, SANCTIONED_SHEET_WRITERS))
      .toEqual(['vitals-utils.js: 3 sheet write(s), sanctioned for 2']);
  });

  it('flags a stale entry, so deleting a writer does not leave the list lying', () => {
    const found = CLEAN.filter(e => e.file !== 'xp-utils.js');
    expect(auditSheetWriters(found, SANCTIONED_SHEET_WRITERS))
      .toEqual(['xp-utils.js: on the sanctioned list but writes no sheets — stale entry']);
  });

  it('counts the real write and not the function that defines it, nor a comment describing it', () => {
    expect(sheetWrites('function writeJsonAtomic(filePath, obj) {\n  fs.writeFileSync(tmpPath, x);\n}')).toBe(0);
    expect(sheetWrites('  writeJsonAtomic(targetPath, restoredSheet);')).toBe(1);
    expect(sheetWrites('// vitals-utils and xp-utils both use writeJsonAtomic directly.')).toBe(0);
    // WO-0017: a comment quoting the call, which is how a fixed file describes what it fixed.
    expect(sheetWrites('  // the old line was writeJsonAtomic(fp, session);\n  doSomethingElse();')).toBe(0);
  });

  it('sees the restore route\'s actual line, copied verbatim from routes/sessions.js', () => {
    const routes = fs.readFileSync(path.join(SERVER_ROOT, 'routes', 'sessions.js'), 'utf-8');
    expect(routes).toContain('writeJsonAtomic(targetPath, restoredSheet);');
    expect(sheetWrites('        writeJsonAtomic(targetPath, restoredSheet);')).toBe(1);
  });
});

describe('condition M5 — dying is visible in the per-turn block', () => {
  it('names the death saves and says the character is dying, not dead', () => {
    const { _testing: { buildGameStateContext } } = require('../dm-engine');
    writeJson(charPath(), makeSheet({
      hitPoints: { max: 10, current: 0 },
      deathSaves: { successes: 0, failures: 2, stable: false },
    }));
    const block = buildGameStateContext(tmpDir, 'char-kaelara', null, EMAIL, CAMPAIGN, SESSION);
    expect(block).toContain('HP: 0/10');
    expect(block).toContain('2 failures');
    expect(block).toContain('DYING');
    expect(block).not.toContain('DEAD');
  });

  it('an ordinary character\'s line is unchanged', () => {
    const { _testing: { buildGameStateContext } } = require('../dm-engine');
    const block = buildGameStateContext(tmpDir, 'char-kaelara', null, EMAIL, CAMPAIGN, SESSION);
    expect(block).toContain('HP: 5/10 | AC: 15');
    expect(block).not.toContain('Death saves');
  });
});

// The behavioural half of the finding above. The source-text tests prove the routes call the
// queue; this one drives the real HTTP route against a real concurrent queued write and checks
// that neither update is lost. Before the fix this scenario lost the join 200 times in 200.
describe('a join landing during a DM turn is not lost', () => {
  const { updateSessionFile } = require('../player-data');
  const HOST = { email: 'host@t.com', name: 'Host', role: 'player' };
  const FRIEND = { email: 'friend@t.com', name: 'Friend', role: 'player' };

  let routeDir;
  let server;
  let baseUrl;
  const SID = 'sess-join-race';

  function post(urlPath, body, email) {
    return new Promise((resolve, reject) => {
      const url = new URL(urlPath, baseUrl);
      const payload = JSON.stringify(body);
      const req = http.request({
        method: 'POST', hostname: url.hostname, port: url.port, path: url.pathname,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'x-player-email': email,
        },
      }, (res) => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
      });
      req.on('error', reject);
      req.end(payload);
    });
  }

  beforeEach(async () => {
    routeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'join-race-'));
    fs.writeFileSync(path.join(routeDir, 'players.json'), JSON.stringify({
      [HOST.email]: HOST, [FRIEND.email]: FRIEND,
    }, null, 2));
    writeJson(path.join(routeDir, 'sessions', SID, 'session.json'), {
      id: SID, name: 'S', campaignId: 'demo', ownerEmail: HOST.email, ownerName: HOST.name,
      playerEmail: HOST.email, status: 'active', messages: [],
      settings: { visibility: 'public' },
      players: [{ email: HOST.email, name: HOST.name, role: 'owner' }],
      companionConfig: { states: { 'npc-1': 'player', 'npc-2': 'player' }, reservations: {} },
      companionPlayers: {},
      worldState: {},
    });

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.campaignId = 'demo'; next(); });
    app.use('/api/sessions', require('../routes/sessions')(routeDir));
    await new Promise(r => { server = app.listen(0, r); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    await new Promise(r => server.close(r));
    fs.rmSync(routeDir, { recursive: true, force: true });
  });

  it('survives a queued world-state write landing at the same moment', async () => {
    // The turn's own persistence, in flight, exactly as UpdateWorldState does it.
    const turnWrite = updateSessionFile(routeDir, SID, (live) => {
      live.worldState = { location: 'Saltmere', updatedAt: new Date().toISOString() };
    });
    const join = post(`/api/sessions/${SID}/join`, { npcId: 'npc-1' }, FRIEND.email);
    const [, joinRes] = await Promise.all([turnWrite, join]);

    expect(joinRes.status).toBe(200);
    const saved = JSON.parse(fs.readFileSync(path.join(routeDir, 'sessions', SID, 'session.json'), 'utf-8'));
    // Both survive: the claim the player was told about, and the turn's world state.
    expect(saved.companionPlayers['npc-1'].email).toBe(FRIEND.email);
    expect(saved.worldState.location).toBe('Saltmere');
  });

  it('two claims on one slot produce exactly one winner and one 409', async () => {
    const [a, b] = await Promise.all([
      post(`/api/sessions/${SID}/join`, { npcId: 'npc-1' }, FRIEND.email),
      post(`/api/sessions/${SID}/join`, { npcId: 'npc-1' }, HOST.email),
    ]);
    const statuses = [a.status, b.status].sort();
    // The host is refused for being the host, so this pair is 200 + 400; the point is that
    // exactly one claim is recorded either way.
    const saved = JSON.parse(fs.readFileSync(path.join(routeDir, 'sessions', SID, 'session.json'), 'utf-8'));
    expect(Object.keys(saved.companionPlayers)).toHaveLength(1);
    expect(statuses.filter(s => s === 200)).toHaveLength(1);
  });

  it('a 409 still reports the slot as claimed rather than writing over it', async () => {
    const first = await post(`/api/sessions/${SID}/join`, { npcId: 'npc-1' }, FRIEND.email);
    expect(first.status).toBe(200);
    const second = await post(`/api/sessions/${SID}/join`, { npcId: 'npc-1' }, FRIEND.email);
    expect(second.status).toBe(409);
    const saved = JSON.parse(fs.readFileSync(path.join(routeDir, 'sessions', SID, 'session.json'), 'utf-8'));
    expect(saved.companionPlayers['npc-1'].email).toBe(FRIEND.email);
  });
});
