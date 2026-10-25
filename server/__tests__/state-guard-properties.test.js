// WO-0015.5. Property-based coverage of the governed-path classifier.
//
// Why this file exists, in QC's words: "the guarantee's own test file had 28 tests and not one
// varied the path form, which is how this survived." The hole was found by a person reading the
// code, widened by a person thinking of eleven inputs, closed and re-probed by a person thinking
// of twenty-two. Every one of those was somebody thinking of an input. This is the systematic
// version: generate the space and assert properties over all of it, so the next defect of this
// shape is caught by a rule rather than by whoever happens to think of the right string.
//
// Nothing here duplicates state-guard.test.js. That file states examples; this one states laws.

import { describe, it, expect } from 'vitest';
import path from 'path';

const {
  evaluateWrite,
  createPreToolUseGuard,
  isGovernedPath,
  governedChanges,
  simulateWrite,
  GOVERNED_POINTERS,
  GOVERNED_ANCESTORS,
  WRITE_TOOLS,
} = require('../state-guard');

// ───────────────────────────────────────────────────────────────── generators

/** Deterministic PRNG. A property test that is not reproducible is an anecdote. */
function mulberry32(seed) {
  return function next() {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const SEED = 20260903;

const PREFIXES = ['', '/', './', '../', '/srv/app/', 'home/tom/'];

// Tier chains: the three storage tiers ADR 0005 §3 names, plus near-misses and non-data trees.
const TIER_CHAINS = [
  'data/sessions/s1',
  'data/players/tom-example-com/demo',
  'data/defaults/demo',
  'data',
  'sessions/s1',
  'players/tom-example-com',
  'defaults/demo',
  'rules',
  'data/rules',
  'campaigns/demo',
  'x/y',
  '',
];

// The parent segment. Case variants included on purpose: see the case-sensitivity test below.
const PARENT_DIRS = ['characters', 'npcs', 'Characters', 'NPCs', 'character', 'notes', ''];

const FILE_NAMES = ['k.json', 'k.JSON', 'k.Json', 'notes.md', 'k.json.bak', '.json', 'k.json '];

// Noise inserted at chosen positions. `%2e`/`%2f` are here because a URL-encoded traversal is a
// classic bypass; on POSIX they are ordinary filename bytes and must stay ordinary.
const NOISE = ['.', '..', 'z/..', '', '%2e', 'a/b/../..'];

const TRAILERS = ['', '/', '//'];

function joinSegs(parts) {
  return parts.filter(p => p !== null && p !== undefined).join('/').replace(/\/{3,}/g, '//');
}

/** Structured product: prefix × tier × parent dir × filename × trailer. */
function structuredCorpus() {
  const out = [];
  for (const prefix of PREFIXES) {
    for (const tier of TIER_CHAINS) {
      for (const dir of PARENT_DIRS) {
        for (const file of FILE_NAMES) {
          for (const trailer of TRAILERS) {
            out.push(prefix + joinSegs([tier, dir, file]) + trailer);
          }
        }
      }
    }
  }
  return out;
}

/**
 * Noise at EVERY position, including the ancestor segment — the position QC's examples reached
 * only for the leaf and the parent.
 */
function noiseAtEveryPositionCorpus() {
  const bases = [
    '/x/data/sessions/s1/characters/kaelara.json',
    'data/sessions/s1/npcs/pip.json',
    'data/players/tom-example-com/demo/characters/k.json',
    'data/defaults/demo/npcs/pip.json',
    '/x/data/rules/combat.json',
    'data/sessions/s1/session.json',
    'x/y/characters/k.json',
  ];
  const out = [];
  for (const base of bases) {
    const abs = base.startsWith('/');
    const segs = base.split('/').filter(Boolean);
    for (let pos = 0; pos <= segs.length; pos++) {
      for (const noise of NOISE) {
        const copy = segs.slice();
        copy.splice(pos, 0, noise);
        out.push((abs ? '/' : '') + joinSegs(copy));
      }
    }
  }
  return out;
}

/** Seeded random walk, so the space is not limited to shapes I thought of. */
function randomCorpus(n) {
  const rnd = mulberry32(SEED);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length) % arr.length];
  const pool = ['data', 'sessions', 'players', 'defaults', 'rules', 'campaigns', 's1', 'demo',
    'characters', 'npcs', 'Characters', '.', '..', 'z', 'tom-example-com', '%2e', '%2f'];
  const out = [];
  for (let i = 0; i < n; i++) {
    const depth = 1 + Math.floor(rnd() * 7);
    const segs = [];
    for (let d = 0; d < depth; d++) segs.push(pick(pool));
    segs.push(pick(FILE_NAMES));
    out.push((rnd() < 0.4 ? '/' : '') + joinSegs(segs) + pick(TRAILERS));
  }
  return out;
}

const CORPUS = [...new Set([
  ...structuredCorpus(),
  ...noiseAtEveryPositionCorpus(),
  ...randomCorpus(4000),
])];

// ───────────────────────────────────────────────────────────────── oracles

/**
 * The classifier as it behaved BEFORE the WO-0015.4 QC fix: split the raw string, no
 * normalisation. Reconstructed from the defect description in state-guard.js — the original
 * text is not in the tree, because state-guard.js is new and untracked. It is used only as the
 * left-hand side of an implication, so a reconstruction that is too permissive would make the
 * property STRICTER, not weaker.
 */
function legacyIsGovernedPath(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) return false;
  if (!filePath.toLowerCase().endsWith('.json')) return false;
  const parts = filePath.split('/').filter(Boolean);
  if (parts.length < 3) return false;
  const parent = parts[parts.length - 2];
  if (parent !== 'characters' && parent !== 'npcs') return false;
  return GOVERNED_ANCESTORS.some(a => parts.slice(0, parts.length - 2).includes(a));
}

/**
 * An independent oracle written from ADR 0005 §3's specification rather than from the
 * implementation, and applied to the RESOLVED path. Differences between this and the shipped
 * classifier applied to the raw string are exactly the spelling-sensitivity defects.
 */
const ORACLE_ROOT = '/srv/app';
function specSaysGoverned(rawPath) {
  if (typeof rawPath !== 'string' || rawPath.length === 0) return false;
  let resolved;
  try { resolved = path.resolve(ORACLE_ROOT, rawPath); } catch { return false; }
  const segs = resolved.split('/').filter(Boolean);
  if (segs.length < 2) return false;
  const file = segs[segs.length - 1];
  const parent = segs[segs.length - 2];
  const ancestors = segs.slice(0, segs.length - 2);
  if (!file.toLowerCase().endsWith('.json')) return false;
  if (parent !== 'characters' && parent !== 'npcs') return false;
  return GOVERNED_ANCESTORS.some(a => ancestors.includes(a));
}

function report(failures, limit = 6) {
  return failures.slice(0, limit);
}

// ───────────────────────────────────────────────────────────────── properties

describe('classifier corpus', () => {
  it('is large, deduplicated, and contains both governed and ungoverned paths', () => {
    expect(CORPUS.length).toBeGreaterThan(5000);
    const governed = CORPUS.filter(isGovernedPath);
    expect(governed.length).toBeGreaterThan(200);
    expect(CORPUS.length - governed.length).toBeGreaterThan(200);
  });
});

describe('property: normalisation never loses a path that is really a governed file', () => {
  // QC stated the property as "normalisation may only move paths into the governed set, never
  // out of it". Generated over 5,700 paths, that statement is FALSE — and the code is right.
  //
  //   /data/../z/../characters/k.json   resolves to  /characters/k.json
  //   defaults/../characters/k.Json     resolves to  characters/k.Json
  //
  // The pre-fix classifier governed both, because it saw a literal `data`/`defaults` segment in
  // the raw string. The `..` cancels that segment: neither path is in the data tree at all.
  // Normalisation moved them out of the governed set and was correct to — it removed two false
  // positives, not two protections.
  //
  // So the sound property is conditioned on the path really being a governed file. Stated this
  // way it holds everywhere, and it is the statement that should replace the comment in
  // state-guard.js and the sentence in the QC audit.
  it('anything the pre-fix classifier governed AND that really resolves into the data tree, the current one still governs', () => {
    const failures = [];
    for (const p of CORPUS) {
      if (legacyIsGovernedPath(p) && specSaysGoverned(p) && !isGovernedPath(p)) failures.push(p);
    }
    expect(report(failures)).toEqual([]);
  });

  // The counterexamples themselves, pinned. If a future rewrite makes the unconditional version
  // true again, it has reintroduced the false positives, and this test says so.
  it('the only paths it stopped governing are ones that are not governed files', () => {
    const lost = CORPUS.filter(p => legacyIsGovernedPath(p) && !isGovernedPath(p));
    expect(lost.length).toBeGreaterThan(0);
    const wronglyLost = lost.filter(specSaysGoverned);
    expect(wronglyLost).toEqual([]);
    for (const p of lost) {
      // Each one resolves somewhere with no governed ancestor above the parent directory.
      const segs = path.resolve(ORACLE_ROOT, p).split('/').filter(Boolean);
      const ancestors = segs.slice(0, segs.length - 2);
      expect(GOVERNED_ANCESTORS.some(a => ancestors.includes(a))).toBe(false);
    }
  });

  it('and the fix genuinely widened the set — it is not a no-op', () => {
    const widened = CORPUS.filter(p => isGovernedPath(p) && !legacyIsGovernedPath(p));
    expect(widened.length).toBeGreaterThan(0);
  });
});

describe('property: a path and its normal form classify identically', () => {
  // The general form of the defect. `characters/./k.json` and `characters/k.json` name one
  // file; a classifier that disagrees about them is defeatable by whichever spelling it likes
  // less, and which spelling reaches the hook is not ours to choose.
  it('holds for every path in the corpus', () => {
    const failures = [];
    for (const p of CORPUS) {
      const n = path.normalize(p);
      if (isGovernedPath(p) !== isGovernedPath(n)) failures.push({ p, n, raw: isGovernedPath(p), norm: isGovernedPath(n) });
    }
    expect(report(failures)).toEqual([]);
  });

  it('and is idempotent — normalising twice changes nothing', () => {
    const failures = [];
    for (const p of CORPUS) {
      if (isGovernedPath(path.normalize(p)) !== isGovernedPath(path.normalize(path.normalize(p)))) failures.push(p);
    }
    expect(report(failures)).toEqual([]);
  });
});

describe('property: every spelling of the same file gets the same verdict', () => {
  // The strongest statement, and the one that actually matters: the classifier's answer is a
  // function of the FILE, not of the string. Assumes a case-sensitive filesystem, which is
  // where this deploys; see the case-sensitivity test below for the limit of that assumption.
  it('paths that resolve to one absolute path classify alike', () => {
    const groups = new Map();
    for (const p of CORPUS) {
      let key;
      try { key = path.resolve(ORACLE_ROOT, p); } catch { continue; }
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }
    const failures = [];
    for (const [resolved, members] of groups) {
      if (members.length < 2) continue;
      const first = isGovernedPath(members[0]);
      const odd = members.find(m => isGovernedPath(m) !== first);
      if (odd) failures.push({ resolved, a: members[0], aGoverned: first, b: odd, bGoverned: isGovernedPath(odd) });
    }
    expect(report(failures)).toEqual([]);
  });

  it('there really are multi-spelling groups, so the property is not vacuous', () => {
    const groups = new Map();
    for (const p of CORPUS) {
      const key = path.resolve(ORACLE_ROOT, p);
      groups.set(key, (groups.get(key) || 0) + 1);
    }
    expect([...groups.values()].filter(n => n > 1).length).toBeGreaterThan(100);
  });
});

describe('property: the classifier agrees with ADR 0005 §3 read independently', () => {
  it('matches a spec oracle applied to the resolved path, over the whole corpus', () => {
    const failures = [];
    for (const p of CORPUS) {
      const got = isGovernedPath(p);
      const want = specSaysGoverned(p);
      if (got !== want) failures.push({ p, resolved: path.resolve(ORACLE_ROOT, p), got, want });
    }
    expect(report(failures)).toEqual([]);
  });
});

describe('property: paths that resolve outside the data tree are not governed', () => {
  it('escaping above every governed ancestor yields no opinion', () => {
    const escapes = [];
    for (const depth of [1, 2, 3, 4, 5, 6]) {
      const up = Array(depth).fill('..').join('/');
      escapes.push(`data/sessions/s1/characters/${up}/elsewhere/characters/k.json`);
      escapes.push(`/x/data/sessions/s1/npcs/${up}/outside/npcs/p.json`);
    }
    const failures = [];
    for (const p of escapes) {
      const resolved = path.resolve(ORACLE_ROOT, p);
      const segs = resolved.split('/').filter(Boolean);
      const stillUnderData = segs.slice(0, segs.length - 2).some(s => GOVERNED_ANCESTORS.includes(s));
      if (isGovernedPath(p) !== stillUnderData) failures.push({ p, resolved, governed: isGovernedPath(p), stillUnderData });
    }
    expect(report(failures)).toEqual([]);
  });

  it('a traversal that lands back inside the tree stays governed', () => {
    expect(isGovernedPath('data/sessions/s1/npcs/../characters/k.json')).toBe(true);
    expect(isGovernedPath('data/sessions/s1/characters/../../s2/characters/k.json')).toBe(true);
  });
});

describe('characteristic: case sensitivity, and where it stops being safe', () => {
  // Not a property but a finding, pinned so it cannot drift unnoticed. The classifier is
  // case-INsensitive on the extension (`.toLowerCase().endsWith('.json')`) and case-SENSITIVE
  // on the directory segment. On Linux, where this deploys, that is correct: `Characters/` is a
  // different directory from `characters/`, so declining to govern it is not a hole. On a
  // case-insensitive filesystem (macOS, Windows) they are the SAME file and the asymmetry
  // becomes a bypass. Raised to the developer in the WO-0015.5 deliverable.
  it('governs .JSON but not Characters/, and that split is deliberate on a case-sensitive FS', () => {
    expect(isGovernedPath('data/sessions/s1/characters/k.JSON')).toBe(true);
    expect(isGovernedPath('data/sessions/s1/Characters/k.json')).toBe(false);
    expect(isGovernedPath('data/sessions/s1/NPCS/k.json')).toBe(false);
  });

  it('is consistent for the tier ancestors, which are matched case-sensitively too', () => {
    expect(isGovernedPath('DATA/sessions/s1/characters/k.json')).toBe(true); // 'sessions' matches
    expect(isGovernedPath('DATA/SESSIONS/S1/characters/k.json')).toBe(false); // no ancestor matches
  });
});

describe('characteristic: percent-encoding is not decoded, and must not be', () => {
  it('treats %2f and %2e as ordinary bytes, exactly as the filesystem does', () => {
    expect(isGovernedPath('data/sessions/s1/characters%2fk.json')).toBe(false);
    expect(isGovernedPath('data/sessions/s1/characters/%2e/k.json')).toBe(false);
    // The decoded spellings of those same two strings are different files, and are classified
    // on their own merits — which is the point: no decoding, no divergence from the kernel.
    expect(isGovernedPath('data/sessions/s1/characters/k.json')).toBe(true);
    expect(isGovernedPath('data/sessions/s1/characters/./k.json')).toBe(true);
  });

  it('treats a backslash as a filename byte on POSIX, not a separator', () => {
    expect(isGovernedPath('data\\sessions\\s1\\characters\\k.json')).toBe(false);
    expect(path.sep).toBe('/');
  });
});

// ───────────────────────────────────────────── properties of the decision, not the path

describe('property: the guard never returns a permissive decision, for any input', () => {
  // The ADR 0005 §5.3 / condition M7 invariant, universally quantified. state-guard.test.js
  // asserts it for the MCP tool list; this asserts it for a generated cross product including
  // shapes nobody would write by hand.
  const TOOL_NAMES = [...WRITE_TOOLS, 'Read', 'Glob', 'Bash', 'mcp__dnd-tools__ApplyVitals',
    'mcp__dnd-tools__OverrideMechanicalState', '', 'edit', 'EDIT', 'WriteFile'];
  const INPUTS = [
    null, undefined, {}, { file_path: 'data/sessions/s1/characters/k.json' },
    { file_path: 'data/sessions/s1/characters/k.json', old_string: 'x', new_string: 'y' },
    { file_path: 'data/sessions/s1/characters/k.json', content: '{}' },
    { file_path: 'data/rules/combat.json', content: 'not json' },
    { notebook_path: 'data/sessions/s1/characters/k.json' },
    { file_path: 123 }, { file_path: ['a'] }, { edits: [] },
    { file_path: 'data/sessions/s1/characters/./k.json', old_string: '"current": 5', new_string: '"current": 1' },
  ];
  const SHEET = { name: 'K', status: 'alive', hitPoints: { max: 10, current: 5 }, experience: 1 };
  const readers = [
    () => JSON.stringify(SHEET),
    () => 'not json at all',
    () => null,
    () => { throw new Error('boom'); },
  ];

  it('every (tool, input, reader) triple yields either no opinion or a refusal', () => {
    const failures = [];
    for (const toolName of TOOL_NAMES) {
      for (const toolInput of INPUTS) {
        for (const readFile of readers) {
          let v;
          try {
            v = evaluateWrite({ toolName, toolInput, readFile });
          } catch (err) {
            failures.push({ toolName, toolInput, threw: err.message });
            continue;
          }
          if (typeof v !== 'object' || v === null) { failures.push({ toolName, toolInput, v }); continue; }
          if (v.deny !== true && v.deny !== false) failures.push({ toolName, toolInput, v });
          const json = JSON.stringify(v);
          if (json.includes('"allow"') || json.includes('permissionDecision')) {
            failures.push({ toolName, toolInput, leak: json.slice(0, 120) });
          }
        }
      }
    }
    expect(report(failures)).toEqual([]);
  });

  it('the mounted hook returns {} or a deny, never anything else', async () => {
    const failures = [];
    for (const toolName of TOOL_NAMES) {
      for (const toolInput of INPUTS) {
        const guard = createPreToolUseGuard({
          readFile: () => JSON.stringify(SHEET),
          log: { warn() {} },
          getMode: () => 'block',
        });
        const out = await guard({ tool_name: toolName, tool_input: toolInput });
        if (Object.keys(out).length === 0) continue;
        const d = out.hookSpecificOutput && out.hookSpecificOutput.permissionDecision;
        if (d !== 'deny') failures.push({ toolName, toolInput, out });
      }
    }
    expect(report(failures)).toEqual([]);
  });
});

describe('property: every governed pointer is actually reachable and detected', () => {
  // Guards the list itself. Adding a pointer to GOVERNED_POINTERS that getAtPointer cannot walk
  // would silently govern nothing; this fails the moment that happens.
  const BASE = {
    name: 'K', status: 'alive',
    hitPoints: { max: 10, current: 5, temp: 0 },
    deathSaves: { successes: 0, failures: 0, stable: false },
    hitDice: { total: 2, remaining: 2 },
    spellSlotsUsed: { 1: 0 },
    experience: 300, level: 2, proficiencyBonus: 2,
  };

  function setAtPointer(obj, pointer, value) {
    const parts = pointer.split('/').filter(Boolean);
    const copy = JSON.parse(JSON.stringify(obj));
    let node = copy;
    for (let i = 0; i < parts.length - 1; i++) {
      if (typeof node[parts[i]] !== 'object' || node[parts[i]] === null) node[parts[i]] = {};
      node = node[parts[i]];
    }
    node[parts[parts.length - 1]] = value;
    return copy;
  }

  it('mutating any one pointer is detected, and only that pointer is reported', () => {
    const failures = [];
    const readPointer = (obj, pointer) => pointer.split('/').filter(Boolean)
      .reduce((n, k) => (n === null || n === undefined ? undefined : n[k]), obj);
    for (const pointer of GOVERNED_POINTERS) {
      for (const value of [0, 999, null, 'x', { changed: true }, []]) {
        // A "mutation" to the value already there is not a mutation. /hitPoints/temp starts at
        // 0, so setting it to 0 must report nothing — and does.
        if (JSON.stringify(readPointer(BASE, pointer)) === JSON.stringify(value)) continue;
        const after = setAtPointer(BASE, pointer, value);
        const changes = governedChanges(BASE, after);
        const names = changes.map(c => c.pointer);
        // Setting /hitPoints/current also changes nothing else; setting a subtree root may
        // subsume its children, which is why containment rather than equality is asserted.
        if (!names.includes(pointer)) failures.push({ pointer, value, names });
      }
    }
    expect(report(failures)).toEqual([]);
  });

  it('deleting any one pointer is detected', () => {
    const failures = [];
    for (const pointer of GOVERNED_POINTERS) {
      const parts = pointer.split('/').filter(Boolean);
      const after = JSON.parse(JSON.stringify(BASE));
      let node = after;
      for (let i = 0; i < parts.length - 1; i++) node = node[parts[i]];
      if (!node) continue;
      delete node[parts[parts.length - 1]];
      const names = governedChanges(BASE, after).map(c => c.pointer);
      if (!names.includes(pointer)) failures.push({ pointer, names });
    }
    expect(report(failures)).toEqual([]);
  });

  it('an unchanged record reports nothing, for any permutation of key order', () => {
    const reordered = {};
    for (const k of Object.keys(BASE).reverse()) reordered[k] = BASE[k];
    expect(governedChanges(BASE, reordered)).toEqual([]);
    expect(governedChanges(BASE, JSON.parse(JSON.stringify(BASE)))).toEqual([]);
  });
});

describe('property: edit simulation matches literal replacement semantics', () => {
  const rnd = mulberry32(SEED + 1);
  const ALPHABET = ['a', 'b', '{', '}', '"', ':', '5', '$', '&', '\\', '\n'];
  function randString(maxLen) {
    const n = 1 + Math.floor(rnd() * maxLen);
    let s = '';
    for (let i = 0; i < n; i++) s += ALPHABET[Math.floor(rnd() * ALPHABET.length)];
    return s;
  }

  // Note on what is NOT asserted here. "replace_all leaves no occurrence of old_string" is a
  // tempting property and it is false, for the implementation and for the real Edit tool alike:
  // replacement is simultaneous, so trimming `&"` to `&` inside `&&""` yields `&&"`, which
  // contains the needle again. Asserting it would have been asserting a bug into existence.
  // The invariants below are the ones that actually hold, and none of them restates the code.

  it('replace_all changes length by exactly (occurrences x delta), for random inputs', () => {
    const failures = [];
    for (let i = 0; i < 800; i++) {
      const oldS = randString(3);
      const newS = randString(4);
      const content = randString(40) + oldS + randString(10) + oldS + randString(5);
      const occurrences = content.split(oldS).length - 1;
      const out = simulateWrite('Edit', { old_string: oldS, new_string: newS, replace_all: true }, content);
      if (out === null) { failures.push({ oldS, content, out }); continue; }
      const expected = content.length + occurrences * (newS.length - oldS.length);
      if (out.length !== expected) failures.push({ oldS, newS, occurrences, got: out.length, expected });
    }
    expect(report(failures)).toEqual([]);
  });

  it('a single replacement rewrites the first occurrence and nothing before or after it', () => {
    const failures = [];
    for (let i = 0; i < 800; i++) {
      const oldS = randString(3);
      const newS = randString(4);
      const content = randString(20) + oldS + randString(20) + oldS + randString(20);
      const at = content.indexOf(oldS);
      const out = simulateWrite('Edit', { old_string: oldS, new_string: newS }, content);
      if (out === null) { failures.push({ oldS, content }); continue; }
      const want = content.slice(0, at) + newS + content.slice(at + oldS.length);
      if (out !== want) failures.push({ oldS, newS, at, got: out.slice(0, 60), want: want.slice(0, 60) });
      if (out.length !== content.length + (newS.length - oldS.length)) {
        failures.push({ oldS, newS, lenGot: out.length, lenWant: content.length + (newS.length - oldS.length) });
      }
    }
    expect(report(failures)).toEqual([]);
  });

  it('replace_all and single agree when there is exactly one occurrence', () => {
    const failures = [];
    for (let i = 0; i < 400; i++) {
      const oldS = 'NEEDLE' + i;
      const newS = randString(5);
      const content = randString(30) + oldS + randString(30);
      const one = simulateWrite('Edit', { old_string: oldS, new_string: newS }, content);
      const all = simulateWrite('Edit', { old_string: oldS, new_string: newS, replace_all: true }, content);
      if (one !== all) failures.push({ oldS, one: String(one).slice(0, 60), all: String(all).slice(0, 60) });
    }
    expect(report(failures)).toEqual([]);
  });

  it('replacement text is literal — $& and \\1 are not expanded', () => {
    const failures = [];
    for (const newS of ['$&', '$1', '$`', "$'", '\\1', '$$']) {
      const out = simulateWrite('Edit', { old_string: 'HP', new_string: newS }, 'x HP y');
      if (out !== `x ${newS} y`) failures.push({ newS, out });
    }
    expect(report(failures)).toEqual([]);
  });

  it('MultiEdit equals folding the same edits one at a time, and fails closed on any miss', () => {
    const content = '{"a":1,"b":2,"c":3}';
    const edits = [
      { old_string: '"a":1', new_string: '"a":9' },
      { old_string: '"b":2', new_string: '"b":8' },
    ];
    let folded = content;
    for (const e of edits) folded = simulateWrite('Edit', e, folded);
    expect(simulateWrite('MultiEdit', { edits }, content)).toBe(folded);

    for (let i = 0; i < edits.length; i++) {
      const broken = edits.map((e, j) => (j === i ? { ...e, old_string: 'NOT PRESENT' } : e));
      expect(simulateWrite('MultiEdit', { edits: broken }, content)).toBeNull();
    }
    expect(simulateWrite('MultiEdit', { edits: [] }, content)).toBeNull();
  });

  it('an empty or absent old_string never silently succeeds', () => {
    for (const bad of [{ old_string: '', new_string: 'x' }, { new_string: 'x' }, { old_string: 'x' }, {}]) {
      expect(simulateWrite('Edit', bad, 'anything')).toBeNull();
    }
  });
});

describe('property: a governed change is refused through every spelling of the file', () => {
  // End to end, over the spelling space rather than one hand-picked non-canonical path.
  const SHEET = { name: 'Kaelara', status: 'alive', hitPoints: { max: 10, current: 5 } };
  const spellings = [
    'data/sessions/s1/characters/kaelara.json',
    'data/sessions/s1/characters/./kaelara.json',
    'data/sessions/s1/characters/z/../kaelara.json',
    'data/sessions/s1/./characters/kaelara.json',
    'data/sessions/s1/npcs/../characters/kaelara.json',
    './data/sessions/s1/characters/kaelara.json',
    'data/sessions/s1/characters//kaelara.json',
    'data/sessions/s1/characters/kaelara.json/',
    '/x/data/sessions/s1/characters/../characters/kaelara.json',
    'data/sessions/s1/characters/a/b/../../kaelara.json',
  ];

  it('refuses the same hit-point edit for all of them', () => {
    const failures = [];
    for (const file_path of spellings) {
      const v = evaluateWrite({
        toolName: 'Edit',
        toolInput: { file_path, old_string: '"current": 5', new_string: '"current": 0' },
        readFile: () => JSON.stringify(SHEET, null, 2),
      });
      if (v.deny !== true) failures.push({ file_path, v });
      else if (!v.changes.some(c => c.pointer === '/hitPoints/current')) failures.push({ file_path, changes: v.changes });
    }
    expect(report(failures)).toEqual([]);
  });

  it('and leaves an equipment edit alone for all of them', () => {
    const withKit = { ...SHEET, equipment: ['Rope'] };
    const failures = [];
    for (const file_path of spellings) {
      const v = evaluateWrite({
        toolName: 'Edit',
        toolInput: { file_path, old_string: '"Rope"', new_string: '"Rope", "Torch"' },
        readFile: () => JSON.stringify(withKit, null, 2),
      });
      if (v.deny !== false) failures.push({ file_path, v });
    }
    expect(report(failures)).toEqual([]);
  });
});
