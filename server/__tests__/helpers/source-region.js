/**
 * Reading production source as a test subject, safely.
 *
 * Several tests in this subsystem assert properties of the *source* rather than of behaviour —
 * "only `host` reaches `_createSession`", "the orchestrator has exactly two text emitters",
 * "nothing in the tree sets `ANTHROPIC_MODEL`". That technique is load-bearing here, because
 * some of the properties the chair cares about are about what the code *cannot* do, and the set
 * of things a function does not call is not observable by running it once.
 *
 * It also has two failure modes that make a test green while proving nothing, and both have
 * already happened in this repository. This module exists so neither can happen again by hand.
 *
 * ── 1. COMMENTS ────────────────────────────────────────────────────────────────────────────
 *
 * The files in this subsystem DISCUSS the things these tests grep for, at length.
 * `bot-orchestrator.js` explains in prose why fifteen canned chat replies were deleted and why
 * two WS emitters were removed; a grep that cannot tell prose from code reports those
 * explanations and gets ignored from then on. `readCode` strips comments first.
 *
 * It is deliberately crude — it would also cut `//` inside a string literal. That direction is
 * safe: cutting too much can only hide an offender inside a string, and none of the properties
 * asserted with it could be established from a string literal alone.
 *
 * ── 2. `indexOf` RETURNING -1 IS A SILENTLY VALID ARGUMENT TO `slice` ──────────────────────
 *
 * This is the one worth reading. The obvious way to pin a region is
 *
 *     code.slice(code.indexOf('async _playTurn('), code.indexOf('async _joinSession('))
 *
 * and if either method is ever **renamed**, `indexOf` returns `-1` and `slice` accepts it
 * cheerfully. `slice(start, -1)` is "everything up to the last character" — a plausible-looking
 * region that usually still contains whatever the test was looking for, so the test goes on
 * passing while asserting something else entirely. `slice(-1, n)` is worse: an empty string, so
 * an "it must not appear here" assertion passes vacuously for ever.
 *
 * `sdet` named this *"the most reusable thing in the delivery"* when it was three hand-written
 * assertions in one file, and asked for it as a helper. The fix is that **a missing needle is an
 * exception that names the needle**, not a region. A renamed method then fails with
 * *"region start not found: async _playTurn("* — which tells the next person what to do.
 *
 * The defect this generalises was found by the owner's own test and fixed in three places in
 * WO-0036 revision 1 (`expect(findStart).toBeGreaterThan(-1)` and friends). A helper makes the
 * fourth place safe for free, which is the whole argument for a helper over a convention.
 */

const fs = require('fs');
const path = require('path');

/** Read a source file with comments stripped. Arguments are joined as a path. */
function readCode(...parts) {
  const raw = fs.readFileSync(path.join(...parts), 'utf-8');
  return raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * The source between two needles, or an exception naming the one that was not found.
 *
 * Both needles should be **code**, not comments — a region bounded by a comment is a region a
 * later editor can move without noticing. Both are asserted found, and the end must come after
 * the start, so a reordering is an error rather than an empty string.
 *
 * @param {string} code         source, ideally from `readCode`
 * @param {string} startNeedle  first occurrence begins the region (inclusive)
 * @param {string} endNeedle    first occurrence AFTER the start ends it (exclusive)
 * @param {object} [opts]
 * @param {number} [opts.minLength=1] a region shorter than this is an error. A region that
 *        exists but is a few characters long is the other way this technique goes quiet.
 * @returns {string} the region
 */
function region(code, startNeedle, endNeedle, { minLength = 1 } = {}) {
  if (typeof code !== 'string') throw new TypeError('region(): code must be a string');
  const a = code.indexOf(startNeedle);
  if (a < 0) throw new Error(`region start not found: ${startNeedle}`);
  const b = code.indexOf(endNeedle, a + startNeedle.length);
  if (b < 0) throw new Error(`region end not found after start: ${endNeedle}`);
  const out = code.slice(a, b);
  if (out.length < minLength) {
    throw new Error(
      `region ${startNeedle} … ${endNeedle} is ${out.length} characters, below the ${minLength} `
      + 'this assertion needs to mean anything'
    );
  }
  return out;
}

/**
 * Every distinct method name called on any of the given receivers inside `code`.
 *
 * Used to pin a CLOSED SET of calls — "these are the only ways this function can emit text" —
 * which is the shape of assertion that catches an emitter nobody anticipated. Returns a sorted
 * array of unique names so the caller can `toEqual` it.
 *
 * @param {string} code
 * @param {string[]} receivers e.g. `['slot.ws', 'bot.chatWs']`
 */
function methodsCalledOn(code, receivers) {
  const found = new Set();
  for (const recv of receivers) {
    const re = new RegExp(`${recv.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\s*\\(`, 'g');
    for (const m of code.matchAll(re)) found.add(m[1]);
  }
  return [...found].sort();
}

module.exports = { readCode, region, methodsCalledOn };
