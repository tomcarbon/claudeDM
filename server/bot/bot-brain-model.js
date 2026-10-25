/**
 * A model-driven player brain (WO-0033).
 *
 * It implements exactly the seam the rule brain implements:
 *
 *     Brain := async ({ recentMessages, character, scenarioName }, { signal }) => string
 *
 * and its entire output is ONE STRING of in-character intent, which the orchestrator submits
 * over the same path a human's typed turn takes. There is no structured action, no tool
 * request, no permission verdict. That is not a restriction imposed on top of the design; it
 * is what the thing is.
 *
 * ── CONSTRUCTION: copied from summarizeArc, NOT from DmEngine._streamQuery ──────────────────
 *
 * `dm-engine.js` has two `query()` sites and they are not equivalent:
 *
 *   - `DmEngine._streamQuery` runs `cwd: PROJECT_ROOT` with a 14-entry `allowedTools`
 *     including `Edit`, plus MCP tool servers. CLAUDE.md calls that array a security boundary.
 *     **This file deliberately resembles none of it.**
 *   - `summarizeArc` runs `allowedTools: []`, a denying `canUseTool`, `maxTurns: 1`, one text
 *     out, through the shared semaphore. **That is the shape copied here.**
 *
 * ── WHAT ACTUALLY STOPS A TOOL CALL — corrected at revision 1, and the correction matters ───
 *
 * Revision 0 of this header said "four independent layers, **each of which alone would make the
 * brain tool-free**". **That claim is retracted.** The Security Reviewer falsified it from the
 * SDK's own typing, which ships in this repository, and the SDET confirmed the half that can be
 * read rather than executed:
 *
 *   - `allowedTools` is an AUTO-ALLOW list, not a restriction. `sdk.d.ts:496-500` — *"List of
 *     tool names that are auto-allowed without prompting for permission… To restrict which
 *     tools are available, use the `tools` option instead."* `allowedTools: []` therefore
 *     removes nothing. It adds no auto-approvals, which is not the same thing.
 *   - `canUseTool` is NOT consulted for every request. In the vendored `cli.js`,
 *     `createCanUseTool` returns early when the CLI's own evaluation already says allow or
 *     deny, so any tool the CLI self-allows — including its read-only `Bash` set (`cat`, `head`,
 *     `find`, `jq`, …) — never reaches the callback. **This repository already recorded that
 *     short-circuit**, at `server/state-guard.js:11-18`, and revision 0 asserted the opposite
 *     two directories away.
 *   - `settingSources: []` and `cwd` are not tool controls at all.
 *
 * What the options object carries now, each named by what it actually does:
 *
 *   T1  `tools: []`           THE restriction, and the one added to answer SR-1.
 *                             `sdk.d.ts:522-530` — *"`[]` (empty array) - Disable all built-in
 *                             tools"*. It is the one layer that would survive the deletion of
 *                             every other.
 *   T2  `canUseTool` denies   A real refusal for every tool the CLI routes to it, which is all
 *                             the dangerous ones — `Edit`, `Write`, `WebFetch`, non-read-only
 *                             `Bash`. It is NOT a backstop for tools the CLI self-allows.
 *   T3  `allowedTools: []`    Adds no auto-approvals. Kept, and now labelled honestly: alone it
 *                             would make the brain tool-free only if every tool were gated on
 *                             prompting, and they are not.
 *   C1  `cwd` = an empty      Blast-radius containment, not tool refusal. Enforced at runtime by
 *       temp dir outside      a check that THROWS rather than handing the SDK a cwd inside the
 *       the repo              project — and since revision 1 that check runs on an explicitly
 *                             passed `cwd` too, not only on the default (SR-4).
 *   C2  `settingSources: []`  No `~/.claude/settings.json`, no `.claude/settings.local.json`,
 *                             no CLAUDE.md — so no settings-sourced permission rule and no
 *                             project instructions. Written out so the property survives a
 *                             change of SDK default.
 *   C3  `maxTurns: 1`         Carries more weight than revision 0 credited it with: it is what
 *                             stops a self-allowed read from returning into a second assistant
 *                             turn and out through the turn text.
 *
 * **Honest count: two tool controls, one of which (T1) is categorical; three containment
 * controls.** Redundancy is still the point — WO-0032's lesson is that a single control
 * disarmed by a two-token edit is not a control — but redundancy is not interchangeability,
 * and this header used to claim interchangeability.
 *
 * There are deliberately NO `mcpServers`, no `permissionMode`, and no hooks. `disallowedTools`
 * is deliberately NOT used, and revision 0 was wrong to present its absence as a virtue: it is
 * a name-based denylist, strictly weaker than `tools: []` and made redundant by it.
 *
 * **NOT ESTABLISHED BY EXECUTION, and it cannot be under this work order.** Every test in
 * `__tests__/bot-brain-seam.test.js` — and every mutation any reviewer has run — operates on
 * the options object. They establish that this brain **asks** the SDK for a tool-free session.
 * **Nothing here can establish that it gets one**, because the deciding experiment needs a live
 * agent behind an unapproved `spend` gate. The evidence for T1 is the vendor's typing, the
 * vendored `cli.js`, and this repo's own note — not a run.
 *
 * ── PROMPT HYGIENE ──────────────────────────────────────────────────────────────────────────
 *
 * Two layers, because the inputs are not trustworthy. `recentMessages` is DM narration, which
 * is model output; the character sheet is player-authored and DM-editable.
 *
 *   H1  an ALLOWLIST of character-sheet fields (`summarizeCharacter`). A field not named there
 *       cannot reach the prompt however it got onto the sheet.
 *   H2  `scrubForPrompt()` over every string that does reach it: email addresses and
 *       absolute filesystem paths are replaced, whitespace is collapsed, length is capped.
 *
 * What H2 does NOT promise, stated because the test only proves the former: it redacts strings
 * matching the patterns below (RFC-ish addresses, POSIX absolute paths, `~/` paths, Windows
 * drive paths). It is not a proof that no path-shaped string of any other form can survive —
 * a bare relative path such as `server/bot/x.js` is not matched and is not claimed to be.
 *
 * ── WHAT IS NOT CLAIMED ─────────────────────────────────────────────────────────────────────
 *
 * The brain's prose enters the DM's context, and the DM runs with `Edit` auto-allowed. The
 * layers above bound what the BRAIN can do; they do not bound what its text can ask the DM to
 * do. That is mitigation, not prevention, and it is an accepted risk in the same family as
 * decision 0005 — not a closed finding.
 *
 * ── COST ────────────────────────────────────────────────────────────────────────────────────
 *
 * Every call here spends real money on the chair's subscription.
 *
 * **STRUCK 2026-10-03 (SR-36-4). The paragraph that stood here was false, and it had been false
 * since 2026-10-02.** It read:
 *
 * > ~~*Resolving this brain requires TWO deliberate acts: `CLAUDEDM_BOT_BRAIN=model` in the
 * > environment AND `"brain": "model"` on a bot's record in `data/bot-config.json`.*~~
 * > … ~~*the brain still cannot be selected without the environment switch, and nothing in the
 * > repository sets it*~~
 *
 * **Both halves were falsified by WO-0036 J3**, which made this brain the default. There is no
 * second act and there is no environment requirement: with `CLAUDEDM_BOTS=1` set, every bot
 * created by `POST /api/bots/add` resolves to this brain. It is struck rather than deleted
 * because a previous reviewer named that exact sentence *"the sentence to protect in future
 * work"*, so a reader who remembers it must land on the retraction and not on a blank.
 *
 * How it survived the change that falsified it is worth one line, because it is the defect class
 * and not an accident: this file is **byte-identical** across WO-0036 revision 1, and the
 * deliverable's own byte-identity claim was simultaneously the evidence that the stale sentence
 * had survived. A file nobody edited is a file nobody re-read.
 *
 * ── WHAT IS TRUE, AS OF 2026-10-03 ──────────────────────────────────────────────────────────
 *
 *   - **One act reaches this brain:** `CLAUDEDM_BOTS=1` at server start. That is the whole gate,
 *     and it still takes a human restart (`botsAllowed()` is evaluated once, when the app is
 *     built). Decision `0019` is the authority for the spend.
 *   - **The environment can only make the bots cheaper or not at all.**
 *     `CLAUDEDM_BOT_BRAIN=rules` forces the free brain; no other value of it does anything.
 *     `CLAUDEDM_BOT_MODEL` is checked against `ALLOWED_BOT_MODELS` and cannot name a model
 *     dearer than the Haiku this repository vendors (SR-36-3).
 *   - **The accurate sentence about the fail-safe direction** is not *"a typo costs money"*; it
 *     is **"nothing except the exact string `rules` can make the bots free"** — 20 of 20
 *     malformed values resolve to this brain, enumerated by Security.
 *   - **SR-7 is unchanged and still the live half**: `data/bot-config.json` IS remotely reachable
 *     by a steered DM holding `Edit` over `PROJECT_ROOT`, and `server/state-guard.js` does not
 *     govern that path. What that file can now change is `brainModel` (bounded by the allow-list)
 *     and `maxBrainCalls` — and neither takes effect without a restart, because `loadConfig()` is
 *     called from `start()` and from nowhere else. **That restart is the one step in E24's chain
 *     no agent performs, and it is the sentence to protect now.** See bot-brain-registry.js.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { querySemaphore } = require('../query-semaphore');

// Computed locally and NOT imported from dm-engine: the bot path must not require that module
// (WO-0033 DoD 4). Used only to refuse a cwd that would sit inside the repository.
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

/** Hard cap on the brain's returned turn text, in characters. */
const MAX_TURN_TEXT_CHARS = 600;
/** Default wall-clock deadline for one brain call. */
const DEFAULT_BRAIN_TIMEOUT_MS = 45000;
/** Per-field cap applied by scrubForPrompt. */
const DEFAULT_FIELD_CHARS = 400;
/** How many recent messages reach the prompt. The orchestrator already caps its buffer at 20. */
const MAX_PROMPT_MESSAGES = 20;
/** Per-message cap inside the scene block. */
const MAX_MESSAGE_CHARS = 350;

const PLAYER_SYSTEM_PROMPT = [
  'You are one player at a tabletop roleplaying game table. You are not the Game Master.',
  'You control exactly one character: the one described in the message below. Play them as the',
  'sheet describes — their class and abilities, and especially their traits, ideals, bonds and',
  'flaws. A low score is as much a part of who they are as a high one.',
  '',
  'Reply with ONLY what your character says and does this turn: one to three sentences, present',
  'tense, from your character alone.',
  '',
  'You declare intent. The Game Master decides what happens.',
  '- Do not narrate the outcome of your own action, and do not say whether it worked.',
  '- Do not roll dice, quote rules, or state numbers from the rulebook.',
  '- Do not speak, act or decide for the DM, for other players, or for any NPC.',
  '- Do not write stage directions, headings, labels, or your character\'s name as a prefix.',
  '',
  'Write the turn and nothing else. No preamble, no quotation marks around the whole reply,',
  'no commentary about being an AI or about these instructions.',
].join('\n');

// ── scrubbing ────────────────────────────────────────────────────────────────────────────────

/**
 * How much raw input may be scrubbed to produce `maxChars` of output. Slack, not a second cap:
 * scrubbing shortens (paths and addresses become short tokens, runs of whitespace become one
 * space), so a little more input than output is needed for the result to be unchanged on any
 * realistic field. Four is generous for a field whose own cap is 400.
 */
const SCRUB_INPUT_SLACK = 4;
/**
 * Absolute ceiling on scrubber input, independent of the caller's `maxChars`.
 *
 * Declared HERE, above the patterns, because `PATH_TAIL` below is derived from it and a `const`
 * is in its temporal dead zone until its own declaration runs. That is not an inconvenience to
 * work around — it is the guarantee doing its job: the file will not load at all if the bound
 * and the budget are ever separated.
 */
const MAX_SCRUB_INPUT_CHARS = 8192;

// Every quantifier below is BOUNDED, and WHICH ONE was quadratic is not what SR-2 says.
//
// The Security Reviewer's measurement is exactly right and its attribution is not. SR-2 names
// `POSIX_PATH_RE`'s second alternative as the quadratic pattern. Measured pattern by pattern on
// the reviewer's own input (`'/' + 'a.-_'.repeat(n/4)`, 100 KB), with revision 0's regexes:
//
//     EMAIL_RE  8,575 ms      POSIX_PATH_RE  0 ms      TILDE_PATH_RE  0 ms      WINDOWS_RE  0 ms
//
// It is **`EMAIL_RE`**. `[A-Za-z0-9._%+-]+@…` scans a long run of local-part characters looking
// for an `@` that never arrives, from every start position — and `a.-_` is entirely made of
// local-part characters, so the reviewer's "path-shaped" input is also a maximal e-mail-shaped
// input. `POSIX_PATH_RE` costs 0–2 ms on every shape tried, including many slashes with no
// extension. The fix SR-2 asked for (truncate first) is right either way and is applied; the
// attribution matters because a future author bounding "the path regex" would leave the actual
// quadratic one alone. Bounding `EMAIL_RE` alone takes 8,575 ms to 35 ms; truncation takes it
// the rest of the way. Both layers are kept; see `scrubForPrompt`.
const EMAIL_RE = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}/g;
// A POSIX absolute path: a leading slash and at least one further segment. Deliberately does
// not match a lone '/' or an inline 'and/or'.
const POSIX_PATH_RE = /\/(?:[A-Za-z0-9._-]{1,64}\/){1,32}[A-Za-z0-9._-]{0,64}|\/(?:[A-Za-z0-9._-]{1,64}\/){0,32}[A-Za-z0-9._-]{1,64}\.[A-Za-z0-9]{1,8}\b/g;

// BOUNDING A REDACTION PATTERN IS NOT FREE, AND REVISION 1 PAID FOR IT WITHOUT NOTICING.
//
// Revision 1 bounded these two tails at `{0,512}`. For a home-relative or drive-relative path
// LONGER than 512 characters that redacts the first 512 and leaves the rest — including later
// path components — in the prompt, where revision 0 (unbounded `*`) removed the whole thing.
// The QC Tester found it and demonstrated it end to end through `backstory`
// (F-QCT33R1-2): `"see ~/" + "a"*600 + "/secretvault now"` came back as
// `see [path removed]aaa…aaa/secretvault now`. DoD item 3 says "no filesystem paths"; for that
// input revision 1 had one and revision 0 did not. **A denial-of-service fix had been traded
// for a redaction leak.**
//
// It survived a twelve-case equivalence test because all twelve cases are REALISTIC. Nobody
// writes a 600-character home path — which is precisely the class of input a redaction layer
// exists for. The lesson, and it generalises past this file: an equivalence test built from
// realistic inputs cannot show that a hardening change is behaviour-preserving on the
// adversarial ones, and adversarial ones are the only inputs the layer is for.
//
// The fix keeps both properties instead of trading them. The tail bound is tied to
// MAX_SCRUB_INPUT_CHARS rather than to a round number, so it is **provably unreachable**:
// `scrubForPrompt` truncates to at most MAX_SCRUB_INPUT_CHARS before any pattern runs, so no
// path the scrubber can ever see is longer than the bound, so bounding can never truncate a
// redaction. The quantifier is still bounded — which is what makes it linear — it is simply
// bounded at a value no input can reach. Measured, worst of seven on 100 KB of adversarial
// input: `{0,512}` 1 ms, `{0,8192}` 0-1 ms. The DoS fix costs nothing and the leak closes.
//
// It is built with `new RegExp` rather than written as a literal ON PURPOSE. A literal
// `{0,8192}` beside a `const MAX_SCRUB_INPUT_CHARS = 8192` is two copies of one number that a
// later edit can silently separate — the "a control stated somewhere other than where it is
// enforced" defect three reviewers have now raised against this work order. Here the coupling
// is the code. Lower MAX_SCRUB_INPUT_CHARS and the bound follows it down; raise it and the
// bound follows it up. There is no edit that reintroduces the leak without deleting this line.
const PATH_TAIL = `[^\\s'"\`]{0,${MAX_SCRUB_INPUT_CHARS}}`;
const TILDE_PATH_RE = new RegExp(`~/${PATH_TAIL}`, 'g');
const WINDOWS_PATH_RE = new RegExp(`[A-Za-z]:[\\\\/]${PATH_TAIL}`, 'g');

const REDACTED_ADDRESS = '[address removed]';
const REDACTED_PATH = '[path removed]';

/**
 * Make one untrusted string safe to place in the prompt.
 *
 * **The length cap is applied FIRST. This is the fix for SR-2 and the order is the whole
 * point.** Revision 0 ran four global regexes over the *entire* input and capped length
 * afterwards. `EMAIL_RE` was unbounded and backtracked quadratically (SR-2 says `POSIX_PATH_RE`;
 * see the measurement above the patterns — it is `EMAIL_RE`, and the difference matters to
 * whoever edits these next), and the measurement on the revision-0 file was 1 KB → 1 ms,
 * 10 KB → 84 ms, 100 KB → 8,394 ms, 400 KB → no result
 * in 120 s. The orchestrator shares a process and an event loop with the Express app and the
 * WebSocket server, so that is not a slow bot, it is a stopped server for every human at every
 * table. `PUT /api/characters/:id` writes `{...req.body, id}` with no validation under a 10 MB
 * body limit, so a megabyte `backstory` is a reachable input the moment both brain switches are
 * on. Two layers now: truncate before scrubbing (here) and bound every quantifier (above).
 *
 * Note for whoever edits this next — **rewritten at revision 2, because the revision-1 version
 * of this paragraph said three things and all three were false.** It read:
 *
 *   ~~"no mutation covers the cap's POSITION. Removing the cap entirely is mutation M16 and it
 *   dies; moving this `slice` back below the regexes does not change any assertion except the
 *   wall-clock one added at revision 1 (`scrubForPrompt is linear in its input`). If you move
 *   it, that test is the one that fails."~~
 *
 * The SDET falsified it by execution (C5) and every correction below is theirs:
 *
 *  - **"Removing the cap entirely is mutation M16."** It is not. M16 is `MAX_TURN_TEXT_CHARS`
 *    in `normalizeTurnText` — a different cap in a different function. Removing *this* cap was
 *    never a published mutation; when the SDET wrote it as one, it killed **nothing**.
 *  - **"that test is the one that fails."** Moving the cap failed *a megabyte backstory on a
 *    sheet does not stall the prompt builder*, not *scrubForPrompt is linear in its input*. The
 *    harness said so in as many words and the sentence was written without running it.
 *  - **"no mutation covers the cap's POSITION."** True when written, and the fix for it was the
 *    wrong shape: revision 1 answered with a **wall-clock** mutation (M19, a 500 ms bound), and
 *    at revision 2 the SDET showed M19 does not kill at all — the mutant runs at 339-345 ms,
 *    comfortably *inside* its own bound, six runs out of six. The row was published as a kill
 *    on a coin toss.
 *
 * **What guards the position now is not a clock.** `the cap is applied BEFORE the regexes, and
 * this is provable without a stopwatch` constructs an input whose *output* differs depending on
 * which side of the regexes the slice falls on — redaction shortens text, so a cap applied last
 * pulls tail content into the result that a cap applied first has already discarded. It fails
 * deterministically if you move this `slice`, and it fails deterministically if you delete it.
 * A timing test could only ever have answered this question by luck, and did.
 *
 * Order within the scrub still matters: emails first, because an address can contain dots that
 * the path patterns would otherwise chew into. Whitespace is collapsed so a message cannot forge
 * the prompt's line-oriented section structure — note that it can still write a
 * section-header-looking phrase inline, which is not claimed to be prevented.
 */
function scrubForPrompt(value, maxChars = DEFAULT_FIELD_CHARS) {
  if (value === null || value === undefined) return '';
  let out = typeof value === 'string' ? value : String(value);
  const cap = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : DEFAULT_FIELD_CHARS;
  const inputBudget = Math.min(cap * SCRUB_INPUT_SLACK, MAX_SCRUB_INPUT_CHARS);
  if (out.length > inputBudget) out = out.slice(0, inputBudget);
  out = out.replace(EMAIL_RE, REDACTED_ADDRESS);
  out = out.replace(WINDOWS_PATH_RE, REDACTED_PATH);
  out = out.replace(TILDE_PATH_RE, REDACTED_PATH);
  out = out.replace(POSIX_PATH_RE, REDACTED_PATH);
  out = out.replace(/\s+/g, ' ').trim();
  if (out.length > cap) out = `${out.slice(0, cap).trimEnd()}…`;
  return out;
}

// ── the prompt ───────────────────────────────────────────────────────────────────────────────

function scrubList(value, maxItems, maxChars) {
  const arr = Array.isArray(value) ? value : (value ? [value] : []);
  return arr
    .slice(0, maxItems)
    .map(item => scrubForPrompt(typeof item === 'object' && item ? (item.name || item.title || '') : item, maxChars))
    .filter(Boolean);
}

/**
 * The character-sheet ALLOWLIST (layer H1).
 *
 * Every field the model is allowed to see is named here. `detectPersonality()` is deliberately
 * NOT used: it collapses the sheet's prose into one of four keyword buckets, which exists
 * because canned phrases need a bucket to be drawn from. A model reads the prose.
 */
function summarizeCharacter(character) {
  const c = character || {};
  const lines = [];
  const name = scrubForPrompt(c.name, 80) || 'an unnamed adventurer';
  const bits = [
    scrubForPrompt(c.race, 40),
    scrubForPrompt(c.class, 40),
    c.level ? `level ${scrubForPrompt(c.level, 8)}` : '',
  ].filter(Boolean);
  lines.push(`Name: ${name}${bits.length ? ` — ${bits.join(' ')}` : ''}`);

  const alignment = scrubForPrompt(c.alignment, 40);
  if (alignment) lines.push(`Alignment: ${alignment}`);

  const hp = c.hitPoints;
  if (hp && (hp.current !== undefined || hp.max !== undefined)) {
    lines.push(`Hit points: ${scrubForPrompt(hp.current, 8)} of ${scrubForPrompt(hp.max, 8)}`);
  }
  if (c.armorClass !== undefined) lines.push(`Armour class: ${scrubForPrompt(c.armorClass, 8)}`);

  const abilities = c.abilities || {};
  const abilityBits = ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma']
    .map(k => {
      const a = abilities[k];
      if (!a || a.score === undefined) return '';
      return `${k.slice(0, 3).toUpperCase()} ${scrubForPrompt(a.score, 8)}`;
    })
    .filter(Boolean);
  if (abilityBits.length) lines.push(`Abilities: ${abilityBits.join(', ')}`);

  const p = c.personality || {};
  const traits = scrubForPrompt(p.traits, 300);
  const ideals = scrubForPrompt(p.ideals, 200);
  const bonds = scrubForPrompt(p.bonds, 200);
  const flaws = scrubForPrompt(p.flaws, 200);
  if (traits) lines.push(`Traits: ${traits}`);
  if (ideals) lines.push(`Ideals: ${ideals}`);
  if (bonds) lines.push(`Bonds: ${bonds}`);
  if (flaws) lines.push(`Flaws: ${flaws}`);

  const backstory = scrubForPrompt(c.backstory, 400);
  if (backstory) lines.push(`Backstory: ${backstory}`);

  const equipment = scrubList(c.equipment, 10, 60);
  if (equipment.length) lines.push(`Carrying: ${equipment.join(', ')}`);

  const spells = scrubList(c.spells, 12, 40);
  if (spells.length) lines.push(`Spells known: ${spells.join(', ')}`);

  return lines.join('\n');
}

function describeMessage(m) {
  if (!m || typeof m !== 'object') return '';
  if (m.type === 'dice_roll') {
    const label = scrubForPrompt(m.label, 60);
    const total = scrubForPrompt(m.total, 12);
    if (!label && !total) return '';
    return `[a die was rolled${label ? ` for ${label}` : ''}${total ? `: ${total}` : ''}]`;
  }
  const text = scrubForPrompt(m.text, MAX_MESSAGE_CHARS);
  if (!text) return '';
  if (m.type === 'dm') return `DM: ${text}`;
  if (m.type === 'player') return `A player: ${text}`;
  return `${scrubForPrompt(m.type, 20) || 'note'}: ${text}`;
}

/**
 * Assemble the user prompt. Pure — no I/O, no clock, no randomness — so the hygiene tests can
 * assert over exactly the string the brain would send.
 */
function buildBrainPrompt({ recentMessages, character, scenarioName } = {}) {
  const parts = [];
  const scenario = scrubForPrompt(scenarioName, 80);
  if (scenario) parts.push(`Adventure: ${scenario}`);

  parts.push('YOUR CHARACTER SHEET\n' + summarizeCharacter(character));

  const messages = (Array.isArray(recentMessages) ? recentMessages : [])
    .slice(-MAX_PROMPT_MESSAGES)
    .map(describeMessage)
    .filter(Boolean);

  parts.push(
    'WHAT HAS JUST HAPPENED AT THE TABLE\n'
    + (messages.length ? messages.join('\n') : '(nothing yet — the scene is only beginning)')
  );

  parts.push('It is your turn. What does your character do?');
  return parts.join('\n\n');
}

// ── the query options ────────────────────────────────────────────────────────────────────────

let cachedCwd = null;
let cleanupRegistered = false;

/**
 * The containment control (C1), hoisted to a function of its own at revision 1 so it can be
 * applied at the choke point.
 *
 * SR-4: at revision 0 this check lived *inside* `resolveBrainCwd`, so it guarded only the
 * default and an explicitly passed `cwd` — including PROJECT_ROOT itself — reached the SDK
 * unchecked. Nothing passed one, which is why mutation M3 still died and why the finding was
 * ranked low; but "the control is not at the choke point" is the same shape as SR-1 and is
 * exactly the defect this work order's own Construction section says to avoid. It throws. It
 * does not warn and continue.
 *
 * @returns {string} the canonical (realpath'd) directory that passed the check.
 */
function assertCwdOutsideProject(candidate) {
  if (typeof candidate !== 'string' || candidate === '') {
    throw new Error(`bot brain cwd must be a non-empty string, got ${typeof candidate}`);
  }
  const resolved = fs.existsSync(candidate) ? fs.realpathSync(candidate) : path.resolve(candidate);
  const root = fs.existsSync(PROJECT_ROOT) ? fs.realpathSync(PROJECT_ROOT) : PROJECT_ROOT;
  if (resolved === root || resolved.startsWith(root + path.sep)) {
    throw new Error(`bot brain cwd must be outside the project, got ${resolved}`);
  }
  return resolved;
}

/**
 * A working directory with nothing in it, outside the repository.
 *
 * Created lazily (so merely requiring this module writes nothing) and memoised per process.
 * F-QCT33-5: revision 0 leaked one empty temp directory per process because nothing removed it.
 * One `process.once('exit')` handler is registered the first time a directory is made — once,
 * not once per call, and `once` so a long-lived server accumulates no listeners either.
 *
 * **Its boundary, measured rather than assumed: an exit handler cannot run for a process that is
 * killed.** A clean exit leaves nothing (delta 0); the same script `SIGKILL`ed leaves one
 * (delta 1). In practice one full `npx vitest run` still leaves exactly one directory, because
 * the worker that runs `bot-brain-seam.test.js` is terminated by the pool rather than exiting.
 * That is a reduction from one per process, not elimination, and `os.tmpdir()` is the right
 * place for the remainder.
 *
 * **Deliberately NOT fixed with a signal handler.** Installing `process.on('SIGTERM')` or
 * `SIGINT` from a library module would change the shutdown semantics of the whole server:
 * `bot-orchestrator` already owns `SIGINT` and awaits `stop()` against a 3-second deadline, and
 * a second listener on the same signal is how a graceful shutdown quietly stops being graceful.
 * An empty directory in `/tmp` is not worth that trade.
 */
function resolveBrainCwd() {
  if (cachedCwd && fs.existsSync(cachedCwd)) return cachedCwd;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudedm-bot-brain-'));
  cachedCwd = assertCwdOutsideProject(dir);
  if (!cleanupRegistered) {
    cleanupRegistered = true;
    process.once('exit', () => {
      // Best effort on the way out. Never throw from an exit handler.
      try { if (cachedCwd) fs.rmSync(cachedCwd, { recursive: true, force: true }); } catch { /* ignore */ }
    });
  }
  return cachedCwd;
}

const DENY_MESSAGE = 'The player brain has no tools. Describe what your character does instead.';

/**
 * Build the options object handed to the SDK. Pure apart from `resolveBrainCwd()`, and
 * exported so a test can assert on the real thing rather than on a copy of it.
 */
function buildBrainQueryOptions({ cwd, model, abortController } = {}) {
  // C1 at the choke point (SR-4): every cwd that reaches the SDK has passed the check, not just
  // the one resolveBrainCwd produced. resolveBrainCwd checks its own candidate too, so the
  // default path is checked twice; that is free and it is the right way round.
  const safeCwd = assertCwdOutsideProject(cwd || resolveBrainCwd());
  const options = {
    systemPrompt: PLAYER_SYSTEM_PROMPT,
    cwd: safeCwd,
    maxTurns: 1,                                        // C3
    includePartialMessages: false,
    tools: [],                                          // T1 — the restriction (sdk.d.ts:522-530)
    allowedTools: [],                                   // T3 — adds no auto-approvals; not a restriction
    canUseTool: async () => ({ behavior: 'deny', message: DENY_MESSAGE }),  // T2
    settingSources: [],                                 // C2
  };
  if (model) options.model = model;
  if (abortController) options.abortController = abortController;
  return options;
}

// ── cancellation ─────────────────────────────────────────────────────────────────────────────

class BrainAbortError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BrainAbortError';
    this.aborted = true;
  }
}

function abortPromise(signal) {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(new BrainAbortError('brain call aborted'));
      return;
    }
    signal.addEventListener('abort', () => reject(new BrainAbortError('brain call aborted')), { once: true });
  });
}

// ── the brain ────────────────────────────────────────────────────────────────────────────────

function extractText(message) {
  const blocks = message?.message?.content || [];
  return blocks.filter(b => b && b.type === 'text').map(b => b.text).join('\n');
}

/**
 * Tidy the model's reply into a turn string.
 * Strips a wrapping pair of quotes and a leading "Name:" label, then caps the length — the
 * cap matters because this text lands in the DM's context on every turn.
 */
function normalizeTurnText(raw, characterName) {
  let out = typeof raw === 'string' ? raw : '';
  out = out.replace(/\s+/g, ' ').trim();
  if (out.length > 1 && /^["'“”].*["'“”]$/.test(out)) out = out.slice(1, -1).trim();
  const name = (characterName || '').trim();
  if (name) {
    const prefix = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[:—-]\\s*`, 'i');
    out = out.replace(prefix, '');
  }
  if (out.length > MAX_TURN_TEXT_CHARS) out = `${out.slice(0, MAX_TURN_TEXT_CHARS).trimEnd()}…`;
  return out.trim();
}

/**
 * @param {object} opts
 * @param {Function} [opts.query]        SDK `query` override, for tests. Default is resolved
 *                                       lazily per call so the suite-wide no-live-agent guard
 *                                       applies to the production path too.
 * @param {string}   [opts.cwd]          override the empty working directory.
 * @param {string}   [opts.model]        model id; omitted means the SDK default.
 * @param {number}   [opts.timeoutMs]    wall-clock deadline for one call.
 * @param {object}   [opts.semaphore]    override the shared query semaphore, for tests.
 * @returns {Function} a Brain
 */
function createModelBrain(opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
    ? opts.timeoutMs
    : DEFAULT_BRAIN_TIMEOUT_MS;
  const semaphore = opts.semaphore || querySemaphore;
  const getQuery = () => opts.query || require('@anthropic-ai/claude-agent-sdk').query;

  return async function modelBrain(input = {}, { signal } = {}) {
    const prompt = buildBrainPrompt(input);

    // One controller for this call: it is what actually reaches the SDK. An external signal
    // (the orchestrator's shutdown) and the timeout both abort it. This is why `signal` is
    // plumbed rather than accepted and ignored — `stop()` is awaited by SIGINT against a
    // 3-second deadline, and an uncancellable model call holds the terminal open (SR-5).
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) throw new BrainAbortError('brain call aborted before it started');
      signal.addEventListener('abort', onExternalAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    // Acquire the SHARED query slot. If we are aborted while queueing, give up at once but
    // still hand the slot back whenever it is granted, so a cancelled call cannot leak one.
    let released = false;
    const release = () => { if (!released) { released = true; semaphore.release(); } };
    const acquiring = semaphore.acquire();
    try {
      await Promise.race([acquiring, abortPromise(controller.signal)]);
    } catch (err) {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onExternalAbort);
      acquiring.then(release, () => {});
      throw err;
    }

    try {
      const query = getQuery();
      const options = buildBrainQueryOptions({
        cwd: opts.cwd,
        model: opts.model,
        abortController: controller,
      });
      const q = query({ prompt, options });
      let out = '';
      for await (const message of q) {
        if (controller.signal.aborted) throw new BrainAbortError('brain call aborted mid-stream');
        if (message.type === 'assistant' && !message.partial) out += extractText(message);
        if (message.type === 'result') break;
      }
      return normalizeTurnText(out, input?.character?.name);
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onExternalAbort);
      release();
    }
  };
}

module.exports = {
  createModelBrain,
  buildBrainPrompt,
  buildBrainQueryOptions,
  summarizeCharacter,
  scrubForPrompt,
  resolveBrainCwd,
  assertCwdOutsideProject,
  // Exported for the bounded-backtracking test only. The input truncation in scrubForPrompt
  // means these patterns can never see more than MAX_SCRUB_INPUT_CHARS through the normal path,
  // so their bounds are unreachable from outside — which is exactly why the mutation harness
  // reported "remove the bounds" as killing nothing, and why the test needs the patterns
  // directly. Two layers, two tests; a layer nothing can reach is a layer nothing can check.
  SCRUB_PATTERNS: { EMAIL_RE, POSIX_PATH_RE, TILDE_PATH_RE, WINDOWS_PATH_RE },
  MAX_SCRUB_INPUT_CHARS,
  SCRUB_INPUT_SLACK,
  normalizeTurnText,
  BrainAbortError,
  PLAYER_SYSTEM_PROMPT,
  PROJECT_ROOT,
  MAX_TURN_TEXT_CHARS,
  DEFAULT_BRAIN_TIMEOUT_MS,
};
