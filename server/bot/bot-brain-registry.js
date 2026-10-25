/**
 * Which brain a bot gets, and which model it thinks with (WO-0033, WO-0036).
 *
 * ── WHAT CHANGED ON 2026-10-02, AND WHY IT NEEDS A SECURITY REVIEW ──────────────────────────
 *
 * **The default is now the MODEL brain, and the environment switch is gone from the spend
 * path.** This is WO-0036 judgement call **J3**, made by the CEO on the human chair's explicit
 * delegation (*"We can remove the canned dumb bots entirely, I don't want to see them any more,
 * they can be axed. I'll trust your judgement with the decisions tonight."*), with the spend
 * question already answered for this stream by decision `0019`.
 *
 * **This is the trigger of Ethics condition B2 and of decision `0006`'s binding review
 * obligation on brain selection, which decision `0020` amendment 1 reassigned to
 * `security-reviewer`.** It has not been reviewed at the time of writing. Read the next
 * paragraph before you read anything else in this file, because it is the honest statement of
 * what got narrower.
 *
 * ── WHAT GOT NARROWER, STATED PLAINLY ───────────────────────────────────────────────────────
 *
 * Until now, selecting the spending brain took TWO independent acts: `CLAUDEDM_BOT_BRAIN=model`
 * in the server environment, AND `"brain": "model"` on that bot's record in
 * `data/bot-config.json`. A steered DM can write the second (it holds `Edit` over PROJECT_ROOT —
 * `dm-engine.js:1313` — and `state-guard.js` does not govern that path) but not the first, so
 * the gate rested on the environment switch alone, and nothing in the tree set it.
 *
 * That defence is **withdrawn, deliberately**, and replaced by three others:
 *
 *   1. **The mount gate is unchanged and is now the whole of the switch story.**
 *      `botsAllowed()` (`server/index.js:180`) still requires `CLAUDEDM_BOTS=1` and still
 *      refuses in production. With it closed, `/api/bots` is not mounted, no orchestrator is
 *      constructed and no brain of any kind exists. A human still has to start the server on
 *      purpose, and it still takes a restart.
 *   2. **The shape is clamped in code** (WO-0036 DoD 1): one host, at most six companions, one
 *      concurrent game, one session per bot. The blast radius of an unwanted `POST
 *      /api/bots/add` is bounded by arithmetic rather than by a switch.
 *   3. **Two ceilings refuse and count** (WO-0036 DoD 4 / item 10): a farm-wide bot-brain-call
 *      ceiling and a one-hour wall-clock ceiling per session, both stated, both visible, both
 *      enforced rather than remembered.
 *
 * What is newly reachable, and a reviewer should weigh exactly this: with `CLAUDEDM_BOTS=1` set,
 * `POST /api/bots/add` now creates bots that spend money, behind a `requireAdmin` that trusts
 * the spoofable `X-Player-Email` header (accepted risk, decision `0005`). It is bounded by (2)
 * and (3) above and by the fact that a steered DM has neither `Bash` nor `WebFetch` and so
 * cannot call the route at all. The config-file half of E24's chain is unchanged: writing
 * `data/bot-config.json` still cannot *start* a bot without the human restart.
 *
 * ── THE ENVIRONMENT CAN NOW ONLY EVER MAKE THE BOTS CHEAPER ─────────────────────────────────
 *
 * `CLAUDEDM_BOT_BRAIN` survives with its direction **inverted**. The only value it honours is
 * `rules`, and that value forces every bot onto the free brain.
 *
 * **CORRECTION, 2026-10-03 (SR-36-3, measured).** This block used to continue: *"~~No value of
 * it, and no value of anything else in the environment, can increase spend.~~"* **That was false
 * in the one direction the whole J3 argument rests on.** The Security Reviewer ran it:
 * `CLAUDEDM_BOT_MODEL='claude-opus-4-6'` resolved straight through to `options.model`, and
 * `resolveBotModel` accepted literally any string, including `'  ../../etc/passwd  '`. The
 * channel does not change *which* brain is built — that part of the old claim was true — it
 * changes **what that brain costs**, and the one quantitative ceiling is denominated in *calls*,
 * so the ceiling's protection scaled with a number the ceiling cannot see. The struck sentence is
 * left visible because a reader who remembers it needs to land on the retraction.
 *
 * **What is true now, and both halves are enforced in this file rather than asserted:**
 *
 *   - `CLAUDEDM_BOT_BRAIN` can only make the bots **free**: `rules` is the sole honoured value.
 *   - `CLAUDEDM_BOT_MODEL` and `brainModel` can only name a model on `ALLOWED_BOT_MODELS`, which
 *     holds the four provider spellings of the ONE Haiku release this repository vendors and
 *     nothing dearer. Anything else is refused loudly and the default is used.
 *
 * So no environment value can select a more expensive brain **or a more expensive model**, and
 * that is what makes the call-denominated ceiling honest: a hundred calls is now a hundred calls
 * of a known model. The allow-list is a spend control, not a typo-catcher, and it is the reason
 * this module does not need the second switch Security explicitly did not ask for.
 *
 * ── THE ACCURATE SENTENCE ABOUT TYPOS, WHICH IS NOT THE COMFORTABLE ONE ─────────────────────
 *
 * The fail-safe direction is **inverted** and a reader deserves it in one line. It is not *"a
 * typo costs money"*. It is: **nothing except the exact string `rules` can make the bots free.**
 * Security enumerated it — **20 of 20** malformed values resolve to the spending brain: every
 * typo of `rules`, `Rules`, `RULES`, leading and trailing space, the empty string, `null`, `0`,
 * `1`, `{}`, `[]`, and the four prototype keys. That direction was chosen on purpose, because a
 * bot that silently stayed free was the defect that cost the chair an evening. It is stated here
 * because it is the sentence that governs a morning, and
 * `__tests__/bot-brain-seam.test.js` holds both halves by enumeration in
 * `no environment value can select a brain that spends money` and
 * `no environment value can select a model that spends MORE than Haiku`.
 *
 * ── THE RULE BRAIN IS A TEST DOUBLE, NOT A PRODUCT FEATURE (J1) ─────────────────────────────
 *
 * The chair will not see it again: it is unreachable in play, because nothing in the product
 * writes `brain` anywhere — `POST /api/bots/add` still refuses to accept one. It is kept, not
 * deleted, because it is the suite's only way to exercise the whole bot path without spending
 * money, and deleting it would undo five rounds of no-live-agent work across WO-0019, WO-0033
 * and WO-0035. A fixture the chair never sees is not a canned bot. Reaching it takes either an
 * explicit `"brain": "rules"` hand-written into `data/bot-config.json`, the environment
 * kill-switch above, or — the way every test does it — the `createBrain` injection point on the
 * orchestrator's constructor.
 *
 * ── THERE IS NO CANNED FALLBACK ANY MORE (J2) ───────────────────────────────────────────────
 *
 * A model brain that cannot think no longer falls back to the rule brain. It **skips the turn**,
 * logs it, and the skip is visible in `GET /api/bots/status`. See `_brainTurn` in
 * `bot-orchestrator.js`. The chair must never read a sentence they did not ask for.
 */

const { generateTurnText } = require('./bot-brain');

/**
 * The product default (J3). A bot with nothing said about it thinks with a model.
 */
const DEFAULT_BRAIN = 'model';

/**
 * The test double (J1). Reachable only by naming it explicitly — never by absence, never over
 * HTTP, and never by a typo, since resolution is exact-match.
 */
const TEST_BRAIN = 'rules';

/**
 * The kill switch. `CLAUDEDM_BOT_BRAIN=rules` forces every bot onto the free brain; every other
 * value, including `model`, is ignored. One direction only, and that direction is cheaper.
 */
const BRAIN_ENV = 'CLAUDEDM_BOT_BRAIN';

/**
 * The model the player brains think with (WO-0036 J4, DoD 2).
 *
 * **Verified against the SDK this repository actually vendors**, rather than copied from a work
 * order: `@anthropic-ai/claude-agent-sdk@0.2.41`'s own alias table in `cli.js` reads
 * `{opus:"claude-opus-4-6", sonnet:"claude-sonnet-4-5-20250929", haiku:"claude-haiku-4-5-20251001"}`,
 * and the same id appears in its Bedrock/Vertex/Foundry mapping. Checked 2026-10-02 against
 * `cli.js` sha256 988f031f…14e0db.
 *
 * **It is passed to the BRAIN ONLY, never to the process environment.** The DM
 * (`dm-engine.js`) sets no model at all, so it takes the account default — which is what the
 * chair asked for: *"the selected AI DM but with Haiku powered players."* Both the DM and the
 * brain spawn the same CLI from the same process, so setting `ANTHROPIC_MODEL` would move the
 * DM too. The test `the DM is not moved onto the player model` holds that by walking the tree.
 */
const DEFAULT_BOT_MODEL = 'claude-haiku-4-5-20251001';

/** Optional override for the id above. A model id, not a brain name — it cannot select a brain. */
const BOT_MODEL_ENV = 'CLAUDEDM_BOT_MODEL';

/**
 * Every model id a bot brain is allowed to think with (SR-36-3, S-5).
 *
 * **These are the four provider spellings of the one Haiku release this repository vendors**,
 * taken from the SDK's own per-provider table in `cli.js`:
 * `{firstParty:"claude-haiku-4-5-20251001", bedrock:"us.anthropic.claude-haiku-4-5-20251001-v1:0",
 * vertex:"claude-haiku-4-5@20251001", foundry:"claude-haiku-4-5"}`. The seam test re-derives this
 * list from that table rather than trusting this array, so an SDK bump that moves the ids fails
 * by name here instead of silently narrowing the list to nothing.
 *
 * **Why an allow-list and not a warning.** Before this list, `CLAUDEDM_BOT_MODEL` was an
 * unbounded spend multiplier: one line in a `package.json` script put the chair's six players on
 * Opus, and the suite stayed green (`sdet` mutation V50 killed 0 of 114). The only quantitative
 * control in this subsystem counts **calls**, so the ceiling could not see the change. A warning
 * would have been read after the bill. The list is what makes "a hundred bot-brain calls" a
 * statement about money.
 *
 * **What it costs, stated so nobody is surprised.** Putting the bots on Sonnet or Opus is now a
 * code change to this array with a reviewer attached, not an environment variable. That is the
 * intended trade: this subsystem is six self-playing agents on the chair's own machine, Haiku was
 * the chair's own request (*"Haiku powered players"*), and the cheap shape is the safe shape. The
 * override still works for its real purpose — naming the Bedrock, Vertex or Foundry spelling when
 * the SDK is pointed at one of those providers.
 *
 * **What it does NOT do.** It does not touch the DM. `dm-engine.js` sets its own `options.model`
 * from `loadDmSettings()` per call, and nothing here is in that path; the chair's *"selected AI
 * DM"* is unaffected by this array in either direction.
 */
const ALLOWED_BOT_MODELS = Object.freeze([
  'claude-haiku-4-5-20251001',                      // first party — DEFAULT_BOT_MODEL
  'us.anthropic.claude-haiku-4-5-20251001-v1:0',    // Bedrock
  'claude-haiku-4-5@20251001',                      // Vertex
  'claude-haiku-4-5',                               // Foundry / bare alias
]);

/**
 * The rule brain as a Brain: `async ({recentMessages, character, scenarioName}, {signal})`.
 * It ignores `signal` — it is synchronous work with nothing to cancel — and it ignores `model`,
 * because it does not think.
 */
function createRuleBrain() {
  return async function ruleBrain(input = {}) {
    return generateTurnText(input);
  };
}

const FACTORIES = {
  rules: createRuleBrain,
  model: (opts) => require('./bot-brain-model').createModelBrain(opts),
};

/**
 * True when the environment has NOT forced the free brain.
 *
 * The name is kept from WO-0033 so a reader grepping for it lands here, but **its meaning is
 * inverted** and that matters: it used to mean "the operator opted in to spending" and now means
 * "the operator has not opted out". It is true by default.
 */
function modelBrainAllowed(env = process.env) {
  return (env || {})[BRAIN_ENV] !== TEST_BRAIN;
}

/**
 * Normalise any value from a config file into a brain name.
 *
 * Precedence, most specific first:
 *
 *   1. `CLAUDEDM_BOT_BRAIN=rules` in the environment — the kill switch, and the only thing the
 *      environment is allowed to say.
 *   2. An **exact** match on a known brain name in `requested`. Exact: `'model '`, `' model'`
 *      and `'Model'` are not `'model'`, and `'Rules'` is not `'rules'`. Nothing is trimmed or
 *      lower-cased, for the same reason `botsAllowed()` accepts `'1'` and nothing else — a
 *      forgiving parser on a path that selects behaviour is a way to be surprised.
 *   3. Otherwise the product default. Absent, null, a number, an object, a prototype key and a
 *      hand-edited typo all land here, and since 2026-10-02 that means the **model** brain.
 *
 * Note what (3) now implies and did not before: a *typo* in `data/bot-config.json` resolves to
 * the spending brain rather than to the free one. That is the direction J3 chose on purpose — a
 * bot that silently stays free was the defect that cost the chair an evening — and it is one of
 * the things a Security review should weigh rather than something this comment can settle.
 */
function resolveBrainName(requested, env = process.env) {
  if (!modelBrainAllowed(env)) return TEST_BRAIN;
  if (typeof requested === 'string'
      && Object.prototype.hasOwnProperty.call(FACTORIES, requested)) {
    return requested;
  }
  return DEFAULT_BRAIN;
}

/**
 * Which model id the player brains should think with.
 *
 * Precedence is unchanged — `brainModel` in `data/bot-config.json`, then `CLAUDEDM_BOT_MODEL`,
 * then the default. **What is new is that the answer must be on `ALLOWED_BOT_MODELS`** (SR-36-3).
 * An id that is not on the list is **refused**, logged at `error` naming both the refused value
 * and the list, and the default is used — fail-closed toward the cheap model, which is the
 * opposite direction from `resolveBrainName`'s deliberate fail-open toward the spending brain,
 * and for the same reason in both cases: the direction that cannot surprise the payer.
 *
 * An override that IS allowed logs at `warn`, so "which model are the bots on" never has to be
 * inferred from a config file. The panel displays `brainModel` as well.
 *
 * @param {*} configured   `brainModel` from `data/bot-config.json`, if anything.
 * @param {object} [env]
 * @param {object} [log]   injectable for tests that assert the refusal is loud.
 * @returns {string} a model id on `ALLOWED_BOT_MODELS` — never empty, never a brain name.
 */
function resolveBotModel(configured, env = process.env, log = console) {
  const candidates = [
    { value: configured, source: '"brainModel" in data/bot-config.json' },
    { value: (env || {})[BOT_MODEL_ENV], source: `${BOT_MODEL_ENV} in the environment` },
  ];
  for (const { value, source } of candidates) {
    if (typeof value !== 'string' || value.trim() === '') continue;
    const id = value.trim();
    if (!ALLOWED_BOT_MODELS.includes(id)) {
      log.error(
        `[BotBrain] REFUSED model id ${JSON.stringify(id)} from ${source} — not on the bot `
        + `allow-list. The bots will think with ${DEFAULT_BOT_MODEL}. Allowed: `
        + `${ALLOWED_BOT_MODELS.join(', ')}. Putting the bots on a dearer model is a reviewed `
        + 'code change to ALLOWED_BOT_MODELS in bot-brain-registry.js, not an override, because '
        + 'the only spend ceiling here counts calls and cannot see the price of one.'
      );
      return DEFAULT_BOT_MODEL;
    }
    if (id !== DEFAULT_BOT_MODEL) {
      log.warn(`[BotBrain] model override in force: ${id} (from ${source}).`);
    }
    return id;
  }
  return DEFAULT_BOT_MODEL;
}

/**
 * Resolve a name to a constructed brain.
 * @returns {{ name: string, brain: Function }} the name actually used — which may differ from
 *          the one requested — and the brain. Callers should record `name`, not the request.
 */
function createBrain(requested, opts = {}, env = process.env) {
  const name = resolveBrainName(requested, env);
  return { name, brain: FACTORIES[name](opts) };
}

module.exports = {
  createBrain,
  createRuleBrain,
  resolveBrainName,
  resolveBotModel,
  modelBrainAllowed,
  DEFAULT_BRAIN,
  TEST_BRAIN,
  BRAIN_ENV,
  DEFAULT_BOT_MODEL,
  BOT_MODEL_ENV,
  ALLOWED_BOT_MODELS,
  BRAIN_NAMES: Object.keys(FACTORIES),
};
