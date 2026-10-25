// The governed-field guard. ADR 0005 §3, §5.
//
// The mechanical tools (ApplyVitals, TrackResources, AwardXP, AwardPartyXP) write character and
// NPC files themselves, server-side, without passing through the agent's tool layer. So there is
// no legitimate agent Edit to a governed field in any turn, and the rule here is unconditional:
// refuse any agent write that would change one. No queue, no token, no per-turn state.
//
// ─── INVARIANT (ADR 0005 §5.3, ETHICS.md Review 3 condition M7) ────────────────────────────────
// This guard returns "no opinion" for every write it does not intend to refuse, and it speaks
// only to refuse. It must never return a permissive decision, for any tool, under any condition.
//
// Why, because the failure is invisible and the next reader will not rediscover it: the SDK's
// permission dispatcher assigns a hook's result *instead of* awaiting canUseTool, and that
// short-circuit is not specific to a refusal. A permissive hook result bypasses canUseTool
// entirely — and canUseTool is the only thing that routes a tool to onPermissionRequest, which
// is the only thing that puts the escape hatch's modal in front of the player. A guard that
// waved tools through would switch that modal off. Nothing would error, nothing would log; the
// only symptom is a question that stops being asked.
//
// Six of the seven steps in evaluateWrite end in silence. Only one speaks.
// ──────────────────────────────────────────────────────────────────────────────────────────────

const path = require('path');

// Ring 1 (ADR 0005 §3). JSON pointers into a character/NPC record. Whole-subtree entries are
// compared as subtrees, so adding `deathSaves`, or a key inside it, counts as a change.
// `/currency` is deliberately absent — gold is prose inside equipment[] and schematising it is
// a data migration sequenced to WO-0015.7.
const GOVERNED_POINTERS = [
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
];

// Which tool owns each pointer, so a refusal can name the call to make instead.
const POINTER_OWNERS = {
  '/status': 'ApplyVitals (damage, heal, deathsave, stabilize) — life and death are computed from the rules, never written by hand',
  '/hitPoints/current': 'ApplyVitals with action "damage" or "heal"',
  '/hitPoints/max': 'ApplyVitals with action "setmax"',
  '/hitPoints/temp': 'ApplyVitals with action "temphp"',
  '/deathSaves': 'ApplyVitals with action "deathsave" or "stabilize"',
  '/hitDice': 'TrackResources with action "hitdice" or "rest"',
  '/spellSlotsUsed': 'TrackResources with action "cast" or "rest"',
  '/experience': 'AwardPartyXP (or AwardXP for a single-character correction)',
  '/level': 'AwardPartyXP (or AwardXP for a single-character correction)',
  '/proficiencyBonus': 'AwardPartyXP (or AwardXP for a single-character correction)',
};

const WRITE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

const NO_OPINION = Object.freeze({ deny: false });

// A governed file lives under one of these. `data` is the shipped data directory; the other
// three are the tiers inside it (ADR 0001 §3). ADR 0005 §3 states the rule as
// `**/data/**/{characters,npcs}/*.json`; requiring a literal `data` segment alone would mean a
// deployment whose data directory is named something else silently loses the guard, so the tier
// names count too. Widening in the safe direction: the cost of a false positive is a refused
// agent Edit to a governed field on a file shaped exactly like a character sheet.
const GOVERNED_ANCESTORS = ['data', 'sessions', 'players', 'defaults'];

/**
 * Is this path a governed file? Parent directory basename is exactly `characters` or `npcs`,
 * the file is .json, and it sits under a data directory or one of its tiers.
 *
 * All three tiers are covered on purpose (ADR 0005 §3): the session snapshot, the player's
 * library and the campaign defaults. The DM is told never to write the last two and nothing
 * enforces it; classifying by shape rather than by tier closes that hole for these fields.
 */
function isGovernedPath(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) return false;
  // ── path.normalize FIRST. This line is the whole guarantee. ────────────────────────────────
  //
  // Splitting the raw string classified `characters/./kaelara.json` and
  // `characters/y/../kaelara.json` as ungoverned, because neither has `characters` as the
  // parent segment of the split — while the filesystem resolves both to the same sheet. A
  // model that wrote either form walked through the hard block with an auto-allowed Edit: no
  // modal, no approval, no log line. Found by QC against WO-0015.4.
  //
  // **This is not defence in depth. It is the only barrier.** The SDK's Edit schema is
  // `file_path: z.string().describe("The absolute path to the file to modify")` — a bare
  // string, no .transform(), no .refine() — and the "must be an absolute path" line lives in
  // the tool's *description prose*, aimed at the model. Read from the shipped bundle at
  // 0.2.41. So nothing normalises the path before this function sees it, and that sentence has
  // exactly the force "Never fabricate stats" had, which is the force this whole work order
  // exists to replace with a mechanism. Any future rewrite must keep the normalisation ahead
  // of the split.
  //
  // Whether a model ever writes such a path has NOT been observed. What was proved is that the
  // classifier could be defeated by one, and that nothing upstream would stop it.
  //
  // A trailing separator is stripped too: `path.normalize` keeps it, and a write to
  // `kaelara.json/` cannot succeed at the filesystem level anyway — but the lesson of this
  // defect is not to reason about which string forms reach us.
  //
  // **What normalising does and does not promise.** It is tempting to write "this can only
  // move paths into the governed set" — that sentence is false, and a property test over 5,712
  // generated paths found the two counterexamples (WO-0015.5):
  //
  //     /data/../z/../characters/k.json   ->  /characters/k.json
  //     defaults/../characters/k.Json     ->  characters/k.Json
  //
  // The old classifier governed both because it saw a literal `data` / `defaults` segment in
  // the raw string; the `..` cancels that segment, and neither resolved path is in the data
  // tree at all. So normalisation dropped two **false positives**, not two protections. The
  // property that does hold, and the one to keep true:
  //
  //     legacy(p) AND spec(resolve(p))  =>  current(p)
  //
  // — normalisation never loses a path that really resolves into the data tree. A comment that
  // overstates a security property is worse than none, because the next person will trust it.
  const normalised = path.normalize(filePath).split(path.sep).join('/').replace(/\/+$/, '');
  if (!normalised.toLowerCase().endsWith('.json')) return false;
  const parts = normalised.split('/').filter(Boolean);
  if (parts.length < 3) return false;
  const parent = parts[parts.length - 2];
  if (parent !== 'characters' && parent !== 'npcs') return false;
  const ancestors = parts.slice(0, parts.length - 2);
  return GOVERNED_ANCESTORS.some(a => ancestors.includes(a));
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

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every(k => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

function render(value) {
  if (value === undefined) return '(absent)';
  return typeof value === 'object' ? JSON.stringify(value) : JSON.stringify(value);
}

/**
 * Every governed pointer whose value differs between two parsed records.
 * A pointer present in one and absent from the other counts, and so does an ancestor whose
 * type changed such that the pointer's meaning changed.
 */
function governedChanges(before, after) {
  const changes = [];
  for (const pointer of GOVERNED_POINTERS) {
    const a = getAtPointer(before, pointer);
    const b = getAtPointer(after, pointer);
    if (a === undefined && b === undefined) continue;
    if (!deepEqual(a, b)) changes.push({ pointer, before: a, after: b });
  }
  return changes;
}

/**
 * Literal string replacement, matching what the Edit tool does — not String.replace, whose
 * `$&`-style patterns in the replacement would make the simulation diverge from the real write.
 * Returns null when `oldString` is not present, which is the fail-closed case.
 */
function applyStringEdit(content, oldString, newString, replaceAll) {
  if (typeof content !== 'string' || typeof oldString !== 'string' || typeof newString !== 'string') return null;
  if (oldString === '') return null;
  const first = content.indexOf(oldString);
  if (first === -1) return null;
  if (replaceAll) return content.split(oldString).join(newString);
  return content.slice(0, first) + newString + content.slice(first + oldString.length);
}

/** The would-be file content after this tool call, or null when it cannot be computed. */
function simulateWrite(toolName, toolInput, currentContent) {
  if (toolName === 'Write') {
    return typeof toolInput.content === 'string' ? toolInput.content : null;
  }
  if (toolName === 'Edit' || toolName === 'NotebookEdit') {
    return applyStringEdit(currentContent, toolInput.old_string, toolInput.new_string, toolInput.replace_all === true);
  }
  if (toolName === 'MultiEdit') {
    const edits = Array.isArray(toolInput.edits) ? toolInput.edits : null;
    if (!edits || edits.length === 0) return null;
    let content = currentContent;
    for (const edit of edits) {
      content = applyStringEdit(content, edit && edit.old_string, edit && edit.new_string, edit && edit.replace_all === true);
      if (content === null) return null;
    }
    return content;
  }
  return null;
}

/**
 * The refusal text. This is the user interface of the whole change (ADR 0005 §11.3): a session
 * that was mid-play when the server restarted has a DM that has been editing hit points by hand
 * for hours, and this string is the only channel that tells it otherwise. It names the entity,
 * the field, both values and the exact call to make instead.
 */
function buildReason(fileName, entityName, changes) {
  const lines = [
    `Refused: ${fileName} is a character/NPC sheet and this edit would change a field that is now computed by a tool, not written by hand.`,
    '',
  ];
  for (const change of changes) {
    const owner = POINTER_OWNERS[change.pointer] || 'the tool that owns this field';
    lines.push(`- ${entityName}${change.pointer}: ${render(change.before)} → ${render(change.after)}. Use ${owner}.`);
  }
  lines.push(
    '',
    'Nothing was written. The tools do the arithmetic and write the file themselves, so call the tool instead of editing — you do not need to follow it with an edit, and an edit would be refused again.',
    'Everything else in this file (equipment, weapons, spells, features, notes and all prose) is still yours to edit normally.',
  );
  return lines.join('\n');
}

/**
 * The decision procedure. Pure: `readFile(absolutePath) -> string | null` is injected, so this
 * is testable from fixtures with no SDK, no agent and no filesystem.
 *
 * Returns { deny: false } — no opinion — or { deny: true, reason, ... }.
 * It has exactly two shapes and neither of them is permissive; see the invariant at the top.
 */
function evaluateWrite({ toolName, toolInput, readFile, projectRoot } = {}) {
  // 1. Not a write tool — no opinion. Every MCP tool, including OverrideMechanicalState,
  //    leaves the guard here, untouched, which is the invariant doing its work.
  if (!WRITE_TOOLS.includes(toolName)) return NO_OPINION;
  if (!toolInput || typeof toolInput !== 'object') return NO_OPINION;

  const filePath = toolInput.file_path || toolInput.notebook_path;
  // 2. Not a governed path — not this guard's business.
  if (!isGovernedPath(filePath)) return NO_OPINION;

  const absPath = path.isAbsolute(filePath) || !projectRoot
    ? filePath
    : path.resolve(projectRoot, filePath);

  // 3. Unreadable or already-invalid JSON — no opinion. The existing PostToolUse hook owns
  //    JSON validity, and two hooks must not both own it.
  let current;
  try {
    current = typeof readFile === 'function' ? readFile(absPath) : null;
  } catch {
    return NO_OPINION;
  }
  if (typeof current !== 'string') return NO_OPINION;

  let before;
  try {
    before = JSON.parse(current);
  } catch {
    return NO_OPINION;
  }
  if (!before || typeof before !== 'object' || Array.isArray(before)) return NO_OPINION;

  const fileName = path.basename(filePath);
  const entityName = before.name || fileName;

  // 4/5. Compute the would-be content. Anything that cannot be computed fails closed —
  //      on governed paths only, and an edit whose old_string does not match would have
  //      failed anyway, so refusing it costs nothing.
  const wouldBe = simulateWrite(toolName, toolInput, current);
  if (wouldBe === null) {
    return {
      deny: true,
      failClosed: true,
      entity: entityName,
      file: fileName,
      changes: [],
      reason: `Refused: this ${toolName} to ${fileName} could not be checked against the rules for hit points, death and resources — the text to replace was not found in the file, or the tool input had an unexpected shape. Nothing was written. Read the file again before editing it, and use ApplyVitals / TrackResources / AwardPartyXP for hit points, death saves, spell slots, hit dice, experience and level.`,
    };
  }

  let after;
  try {
    after = JSON.parse(wouldBe);
  } catch (err) {
    return {
      deny: true,
      failClosed: true,
      entity: entityName,
      file: fileName,
      changes: [],
      reason: `Refused: this ${toolName} would leave ${fileName} as invalid JSON (${err.message}), so it cannot be checked against the rules for hit points, death and resources. Nothing was written. Re-read the file and fix the edit before retrying.`,
    };
  }

  // 6. No governed change — no opinion. This is the common case for a legitimate edit to
  //    equipment, notes or any other Ring 2 field.
  const changes = governedChanges(before, after);
  if (changes.length === 0) return NO_OPINION;

  // 7. The one branch that speaks.
  return {
    deny: true,
    failClosed: false,
    entity: entityName,
    file: fileName,
    changes,
    reason: buildReason(fileName, entityName, changes),
  };
}

/**
 * The PreToolUse mount. This is the only place the guard's answer is translated into the SDK's
 * vocabulary, and the translation is one-directional on purpose: a refusal becomes a refusal,
 * and everything else becomes {} — the empty object, no key, no decision, no opinion.
 *
 * `mode` is the ADR §11.4 rollout control, from MECHANICAL_GUARD: 'block' (the default, and the
 * shipped default, because the safe-for-players setting is the one you get by doing nothing) or
 * 'warn', which evaluates and logs what it would have refused without refusing it. `warn` is a
 * pre-flight, not a deployment state: a guard in warn is not a guard.
 */
function createPreToolUseGuard(options = {}) {
  const readFile = options.readFile || ((p) => require('fs').readFileSync(p, 'utf-8'));
  const projectRoot = options.projectRoot || null;
  const log = options.log || console;
  const getMode = options.getMode || (() => (process.env.MECHANICAL_GUARD === 'warn' ? 'warn' : 'block'));

  return async function preToolUseGuard(input) {
    try {
      const verdict = evaluateWrite({
        toolName: input && input.tool_name,
        toolInput: input && input.tool_input,
        readFile,
        projectRoot,
      });
      if (!verdict.deny) return {};

      const summary = verdict.changes.length > 0
        ? verdict.changes.map(c => `${c.pointer} ${render(c.before)}→${render(c.after)}`).join(' ')
        : 'uncheckable-edit';

      if (getMode() === 'warn') {
        log.warn(`[DM:GUARD] would-deny entity=${verdict.entity} file=${verdict.file} ${summary}`);
        return {};
      }

      log.warn(`[DM:GUARD] deny entity=${verdict.entity} file=${verdict.file} ${summary}`);
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: verdict.reason,
        },
      };
    } catch (err) {
      // A hook must never crash the turn. A guard that throws is a guard that is not there,
      // so this is logged loudly rather than hidden.
      log.warn(`[DM:GUARD] evaluation failed, no opinion recorded: ${err && err.message}`);
      return {};
    }
  };
}

module.exports = {
  evaluateWrite,
  createPreToolUseGuard,
  isGovernedPath,
  governedChanges,
  simulateWrite,
  GOVERNED_POINTERS,
  GOVERNED_ANCESTORS,
  POINTER_OWNERS,
  WRITE_TOOLS,
};
