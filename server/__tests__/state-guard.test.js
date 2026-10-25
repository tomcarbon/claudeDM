// WO-0015.4 (implementer's own coverage). The Edit path into character JSON had zero coverage
// and, before ADR 0005, no rule to test: the only hook on it checked JSON validity and nothing
// about values. The evaluator is a pure function with injected I/O precisely so it can be
// tested here, independently of where it is mounted.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const {
  evaluateWrite,
  createPreToolUseGuard,
  isGovernedPath,
  governedChanges,
  simulateWrite,
  GOVERNED_POINTERS,
} = require('../state-guard');

const SHEET = {
  id: 'char-1',
  name: 'Kaelara Brightflame',
  status: 'alive',
  hitPoints: { max: 10, current: 5 },
  experience: 300,
  level: 2,
  proficiencyBonus: 2,
  armorClass: 15,
  equipment: ['Arrows (18)', 'A belt pouch containing 15 gp'],
};

const FILE = 'data/sessions/abc/characters/kaelara.json';
const content = () => JSON.stringify(SHEET, null, 2);
const readFile = () => content();

function edit(oldString, newString, extra = {}) {
  return evaluateWrite({
    toolName: 'Edit',
    toolInput: { file_path: FILE, old_string: oldString, new_string: newString, ...extra },
    readFile,
  });
}

describe('which files are governed', () => {
  it('governs character and NPC sheets in every tier', () => {
    expect(isGovernedPath('data/sessions/abc/characters/k.json')).toBe(true);
    expect(isGovernedPath('data/sessions/abc/npcs/pip.json')).toBe(true);
    expect(isGovernedPath('data/players/tom-example-com/demo/characters/k.json')).toBe(true);
    expect(isGovernedPath('/abs/path/data/defaults/demo/npcs/pip.json')).toBe(true);
  });

  // Regression, WO-0015.4 QC audit. The classifier used to split the raw string, so a path
  // that names the same file by a different route — `characters/./k.json`,
  // `characters/y/../k.json` — did not have `characters` as its parent segment and was
  // classified as ungoverned, while the filesystem resolved it to the sheet.
  //
  // These assert the CLASSIFIER, deliberately. It has not been observed that the SDK ever hands
  // a hook a path in either form, and no exploit was demonstrated end to end; what was
  // demonstrated is that the classifier could be defeated by one. Normalising is correct either
  // way, and this is the assertion that keeps it correct.
  describe('paths are normalised before they are classified', () => {
    const canonical = '/x/data/sessions/s1/characters/kaelara.json';

    it('governs the same file named through a "." segment', () => {
      expect(isGovernedPath('/x/data/sessions/s1/characters/./kaelara.json')).toBe(true);
      expect(isGovernedPath('/x/data/sessions/s1/./characters/kaelara.json')).toBe(true);
      expect(path.normalize('/x/data/sessions/s1/characters/./kaelara.json')).toBe(canonical);
    });

    it('governs the same file named through a ".." segment', () => {
      expect(isGovernedPath('/x/data/sessions/s1/characters/y/../kaelara.json')).toBe(true);
      expect(isGovernedPath('/x/data/sessions/s1/npcs/../characters/kaelara.json')).toBe(true);
      expect(path.normalize('/x/data/sessions/s1/characters/y/../kaelara.json')).toBe(canonical);
    });

    it('governs the canonical form it always did, and doubled separators too', () => {
      expect(isGovernedPath(canonical)).toBe(true);
      expect(isGovernedPath('/x/data/sessions/s1/characters//kaelara.json')).toBe(true);
    });

    it('governs nothing it did not govern before, for anything in the data tree', () => {
      for (const p of [
        'data/rules/combat.json',
        'data/sessions/abc/session.json',
        'data/campaigns/demo/campaign.json',
        'data/sessions/abc/characters/notes.md',
        'data/sessions/./abc/session.json',
        'data/rules/../rules/combat.json',
      ]) {
        expect(isGovernedPath(p)).toBe(false);
      }
    });

    // My first version of this block claimed normalisation could "only ever move paths INTO
    // the governed set, never out of it". That is false, and WO-0015.5's property test over a
    // generated corpus found the two counterexamples. They are pinned here as the correction:
    // the old classifier governed them only because it saw a literal `data` / `defaults`
    // segment that the `..` cancels, and neither resolved path is in the data tree at all — so
    // normalisation dropped two FALSE POSITIVES, not two protections.
    it('drops the two paths it should never have governed', () => {
      for (const p of ['/data/../z/../characters/k.json', 'defaults/../characters/k.Json']) {
        expect(isGovernedPath(p)).toBe(false);
        // ...and they really do resolve outside the data tree, which is why that is correct.
        expect(path.normalize(p).includes('/data/')).toBe(false);
      }
    });

    // The property that does hold: legacy(p) AND spec(resolve(p)) => current(p).
    // "Normalisation never loses a path that really resolves into the data tree."
    it('never loses a path that resolves into the data tree', () => {
      const roots = ['data/sessions/s1', 'data/players/p/demo', 'data/defaults/demo', '/srv/app/data/sessions/s1'];
      const dirs = ['characters', 'npcs'];
      const spellings = [
        (d, f) => `${d}/${f}`,
        (d, f) => `${d}/./${f}`,
        (d, f) => `${d}/x/../${f}`,
        (d, f) => `${d}//${f}`,
        (d, f) => `${d}/./x/../${f}`,
      ];
      for (const root of roots) {
        for (const dir of dirs) {
          for (const spell of spellings) {
            const p = spell(`${root}/${dir}`, 'k.json');
            // Precondition: it really does resolve to a governed-shaped path in the data tree.
            const resolved = path.normalize(p);
            expect(resolved.endsWith(`${dir}/k.json`)).toBe(true);
            expect(resolved.includes('data/')).toBe(true);
            // Therefore the classifier must govern it, however it was spelled.
            expect(isGovernedPath(p)).toBe(true);
          }
        }
      }
    });

    it('refuses a governed change through a non-canonical path, end to end', () => {
      const verdict = evaluateWrite({
        toolName: 'Edit',
        toolInput: {
          file_path: 'data/sessions/abc/characters/./kaelara.json',
          old_string: '"current": 5',
          new_string: '"current": 0',
        },
        readFile,
      });
      expect(verdict.deny).toBe(true);
      expect(verdict.changes[0].pointer).toBe('/hitPoints/current');
    });
  });

  it('governs nothing else', () => {
    expect(isGovernedPath('data/rules/combat.json')).toBe(false);
    expect(isGovernedPath('data/sessions/abc/session.json')).toBe(false);
    expect(isGovernedPath('data/campaigns/demo/campaign.json')).toBe(false);
    expect(isGovernedPath('data/sessions/abc/characters/notes.md')).toBe(false);
    expect(isGovernedPath('characters/k.json')).toBe(false);
    expect(isGovernedPath('')).toBe(false);
    expect(isGovernedPath(null)).toBe(false);
  });
});

describe('the invariant: the guard speaks only to refuse (ADR 0005 §5.3, condition M7)', () => {
  it('returns no opinion, with no permissionDecision key, for every MCP tool', () => {
    for (const name of [
      'mcp__dnd-tools__OverrideMechanicalState',
      'mcp__dnd-tools__ApplyVitals',
      'mcp__dnd-tools__TrackCombat',
      'mcp__dnd-tools__TrackResources',
      'mcp__dnd-tools__RollDice',
      'mcp__dnd-tools__AwardPartyXP',
      'mcp__dnd-tools__AwardXP',
      'mcp__dnd-tools__TrackCalendar',
      'mcp__dnd-tools__LookupMonster',
      'mcp__dnd-tools__UpdateWorldState',
      'mcp__dnd-tools__ShowSceneImage',
      'Read', 'Glob', 'Grep', 'Bash',
    ]) {
      const result = evaluateWrite({ toolName: name, toolInput: { pointer: '/status', value: 'dead' }, readFile });
      expect(result.deny).toBe(false);
      expect('permissionDecision' in result).toBe(false);
    }
  });

  it('returns no opinion for a non-governed write', () => {
    const result = evaluateWrite({
      toolName: 'Edit',
      toolInput: { file_path: 'data/rules/combat.json', old_string: 'a', new_string: 'b' },
      readFile,
    });
    expect(result).toEqual({ deny: false });
    expect('permissionDecision' in result).toBe(false);
  });

  it('never states a permissive decision anywhere in its own source', () => {
    // The failure this protects against is silent: a hook result of any polarity is assigned by
    // the SDK instead of awaiting canUseTool, so a permissive answer here switches off the
    // player's consent modal with no error and no log line.
    const src = fs.readFileSync(path.join(__dirname, '..', 'state-guard.js'), 'utf-8');
    expect(src).not.toContain("permissionDecision: 'allow'");
    expect(src).not.toContain('permissionDecision: "allow"');
    expect(src.includes("'allow'")).toBe(false);
    expect(src.includes('"allow"')).toBe(false);
  });

  it('the hook wrapper returns a bare {} when there is nothing to refuse', async () => {
    const guard = createPreToolUseGuard({ readFile, getMode: () => 'block', log: { warn() {} } });
    const out = await guard({ tool_name: 'Read', tool_input: { file_path: FILE } });
    expect(out).toEqual({});
    expect(Object.keys(out)).toEqual([]);
  });
});

describe('governed changes are refused', () => {
  it('refuses an edit that lowers hit points', () => {
    const verdict = edit('"current": 5', '"current": 0');
    expect(verdict.deny).toBe(true);
    expect(verdict.changes).toEqual([{ pointer: '/hitPoints/current', before: 5, after: 0 }]);
  });

  it('refuses an edit that sets status to dead', () => {
    const verdict = edit('"status": "alive"', '"status": "dead"');
    expect(verdict.deny).toBe(true);
    expect(verdict.changes[0].pointer).toBe('/status');
  });

  it('refuses an edit that adds a governed field that was not there', () => {
    const verdict = edit('"status": "alive"', '"status": "alive",\n  "deathSaves": { "successes": 0, "failures": 3, "stable": false }');
    expect(verdict.deny).toBe(true);
    expect(verdict.changes[0].pointer).toBe('/deathSaves');
  });

  it('refuses hand-written XP and level, which had a tool but no enforcement', () => {
    expect(edit('"experience": 300', '"experience": 9000').deny).toBe(true);
    expect(edit('"level": 2', '"level": 9').deny).toBe(true);
    expect(edit('"proficiencyBonus": 2', '"proficiencyBonus": 6').deny).toBe(true);
  });

  it('names the entity, both values and the tool to call instead', () => {
    const verdict = edit('"current": 5', '"current": 0');
    expect(verdict.reason).toContain('Kaelara Brightflame');
    expect(verdict.reason).toContain('/hitPoints/current');
    expect(verdict.reason).toContain('5');
    expect(verdict.reason).toContain('ApplyVitals');
    expect(verdict.reason).toContain('Nothing was written');
  });
});

describe('legitimate writes are left alone', () => {
  it('allows an equipment edit on the same file', () => {
    expect(edit('Arrows (18)', 'Arrows (17)')).toEqual({ deny: false });
  });

  it('allows an armour class edit — not arithmetic, and no tool computes it', () => {
    expect(edit('"armorClass": 15', '"armorClass": 16')).toEqual({ deny: false });
  });

  it('allows an edit that rewrites a governed field to the same value', () => {
    expect(edit('"current": 5', '"current":  5')).toEqual({ deny: false });
  });
});

describe('failing closed', () => {
  it('refuses when the text to replace is not in the file', () => {
    const verdict = edit('"current": 999', '"current": 1');
    expect(verdict.deny).toBe(true);
    expect(verdict.failClosed).toBe(true);
  });

  it('refuses when the result would not parse', () => {
    const verdict = edit('"current": 5', '"current": 5,,,');
    expect(verdict.deny).toBe(true);
    expect(verdict.failClosed).toBe(true);
  });

  it('says nothing when the file itself is unreadable or already invalid', () => {
    expect(evaluateWrite({
      toolName: 'Edit',
      toolInput: { file_path: FILE, old_string: 'a', new_string: 'b' },
      readFile: () => { throw new Error('ENOENT'); },
    })).toEqual({ deny: false });

    expect(evaluateWrite({
      toolName: 'Edit',
      toolInput: { file_path: FILE, old_string: 'a', new_string: 'b' },
      readFile: () => '{ not json',
    })).toEqual({ deny: false });
  });
});

describe('edit simulation', () => {
  it('replaces the first occurrence, or all of them with replace_all', () => {
    expect(simulateWrite('Edit', { old_string: 'a', new_string: 'X' }, 'banana')).toBe('bXnana');
    expect(simulateWrite('Edit', { old_string: 'a', new_string: 'X', replace_all: true }, 'banana')).toBe('bXnXnX');
  });

  it('replaces literally, not with String.replace pattern semantics', () => {
    // '$&' in a replacement would expand to the matched text under String.prototype.replace.
    expect(simulateWrite('Edit', { old_string: 'a', new_string: '$&' }, 'cat')).toBe('c$&t');
  });

  it('applies MultiEdit in sequence and fails closed on any miss', () => {
    expect(simulateWrite('MultiEdit', {
      edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'b', new_string: 'c' }],
    }, 'a')).toBe('c');
    expect(simulateWrite('MultiEdit', {
      edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'zzz', new_string: 'c' }],
    }, 'a')).toBeNull();
  });

  it('catches a governed change made by a Write of whole file content', () => {
    const dead = JSON.stringify({ ...SHEET, status: 'dead' }, null, 2);
    const verdict = evaluateWrite({
      toolName: 'Write',
      toolInput: { file_path: FILE, content: dead },
      readFile,
    });
    expect(verdict.deny).toBe(true);
    expect(verdict.changes[0].pointer).toBe('/status');
  });
});

describe('the PreToolUse mount', () => {
  it('refuses in the SDK\'s own shape', async () => {
    const logged = [];
    const guard = createPreToolUseGuard({ readFile, getMode: () => 'block', log: { warn: (m) => logged.push(m) } });
    const out = await guard({
      tool_name: 'Edit',
      tool_input: { file_path: FILE, old_string: '"current": 5', new_string: '"current": 0' },
    });
    expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('ApplyVitals');
    expect(logged.join(' ')).toContain('[DM:GUARD] deny');
  });

  it('MECHANICAL_GUARD=warn evaluates, logs what it would have refused, and allows it through', async () => {
    const logged = [];
    const guard = createPreToolUseGuard({ readFile, getMode: () => 'warn', log: { warn: (m) => logged.push(m) } });
    const out = await guard({
      tool_name: 'Edit',
      tool_input: { file_path: FILE, old_string: '"current": 5', new_string: '"current": 0' },
    });
    expect(out).toEqual({});
    expect(logged.join(' ')).toContain('[DM:GUARD] would-deny');
  });

  it('block is the default when MECHANICAL_GUARD is unset', async () => {
    const before = process.env.MECHANICAL_GUARD;
    delete process.env.MECHANICAL_GUARD;
    try {
      const guard = createPreToolUseGuard({ readFile, log: { warn() {} } });
      const out = await guard({
        tool_name: 'Edit',
        tool_input: { file_path: FILE, old_string: '"current": 5', new_string: '"current": 0' },
      });
      expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    } finally {
      if (before === undefined) delete process.env.MECHANICAL_GUARD;
      else process.env.MECHANICAL_GUARD = before;
    }
  });

  it('never throws, and says nothing when it cannot evaluate', async () => {
    const logged = [];
    const guard = createPreToolUseGuard({
      readFile: () => { throw new Error('boom'); },
      log: { warn: (m) => logged.push(m) },
    });
    const out = await guard({ tool_name: 'Edit', tool_input: { file_path: FILE, old_string: 'a', new_string: 'b' } });
    expect(out).toEqual({});
  });
});

describe('the governed pointer list', () => {
  it('is the eleven-minus-currency list ADR 0005 §3 specifies', () => {
    expect(GOVERNED_POINTERS).toEqual([
      '/status',
      '/hitPoints/current',
      '/hitPoints/max',
      '/hitPoints/temp',
      '/deathSaves',
      '/hitDice',
      '/spellSlotsUsed',
      '/experience',
      '/level',
      '/proficiencyBonus',
    ]);
  });

  it('does not govern currency — that is sequenced to WO-0015.7', () => {
    expect(GOVERNED_POINTERS).not.toContain('/currency');
    expect(governedChanges(SHEET, { ...SHEET, currency: { gp: 500 } })).toEqual([]);
  });

  it('compares whole subtrees, so a key added inside one counts', () => {
    const changes = governedChanges(
      { deathSaves: { successes: 0, failures: 0, stable: false } },
      { deathSaves: { successes: 0, failures: 1, stable: false } }
    );
    expect(changes).toHaveLength(1);
    expect(changes[0].pointer).toBe('/deathSaves');
  });
});
