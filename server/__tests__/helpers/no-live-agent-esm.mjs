/**
 * The ESM half of the no-live-agent guard: WHICH specifiers are redirected, and the fail-closed
 * check that the redirection is actually in force. WO-0035.
 *
 * Why this file exists. `helpers/no-live-agent.js` patches `Module._load`, which is Node's
 * *CommonJS* loader. A dynamic `import('@anthropic-ai/claude-agent-sdk')` from an ESM test file
 * never routes through `Module._load` and receives the genuine `query`. SDET measured both halves
 * directly (CJS `require()` -> guarded true; ESM `import()` -> false), and WO-0037's new client
 * test glob made the ESM half reachable rather than theoretical, because `client/src/**` is ESM.
 *
 * The two loaders are closed by two different mechanisms, because the two runners resolve
 * differently and neither mechanism reaches the other's path:
 *
 *   - `npm test` (vitest): `resolve.alias` in `vitest.config.js`, built from `esmGuardAliases`
 *     below so that no specifier string is written out a second time in the config.
 *   - `node server/__tests__/_harness/run-file.mjs <file>`: the `resolve` hook in
 *     `_harness/loader.mjs`, which is already registered there for the `vitest` shim.
 *
 * MEASURED on this machine (node v24.13.0, vitest 4.1.0), against a fixture specifier that does
 * not exist, so a miss could not fall through to the vendored SDK:
 *   - vitest `resolve.alias` redirects a bare `import()` from a test file (literal and variable
 *     specifier) and from a `setupFiles` file; it does NOT affect `require()`, because the
 *     `require` vitest hands a test file is a native `createRequire` (`mod.require(path)`), which
 *     is exactly why the CJS half is still needed and still does the work on that path.
 *   - the `_harness` loader hook redirects a bare `import()` and likewise leaves `require()` alone.
 * The run that produced those numbers is quoted in
 * `records/reports/2026-10-02-software-developer-ceo-wo0035-esm-guard.md` §3.
 *
 * WHAT IS AND IS NOT COVERED — read this before trusting it, and see the same list in
 * `no-live-agent.js`'s header:
 *   - COVERED: `import('@anthropic-ai/claude-agent-sdk')`, and any specifier ending in that
 *     package's `sdk.mjs` or `cli.js` (bare subpath, relative path or absolute path), from code
 *     vitest transforms (test files, setup files, project sources it inlines) or from any ESM file
 *     the `_harness` runner loads.
 *   - NOT COVERED: `import()` of some other file inside the package; an import from inside
 *     `node_modules`, which vitest externalises and does not transform; `fs.readFileSync` plus
 *     `eval`; a child process (`bot-brain-seam.test.js` spawns `node -e` subprocesses that have no
 *     guard installed at all — they load the SDK's module object but never call `query`).
 *   - This is a backstop against FORGETTING to inject a fake, not a sandbox against someone
 *     determined to reach the real `query`. Nothing here contains an adversary.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const nodeRequire = createRequire(import.meta.url);
const { SDK_MODULE, GUARD_MARK } = nodeRequire('./no-live-agent.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path of the module every guarded ESM specifier is redirected to. */
export const ESM_GUARD_MODULE = path.join(HERE, 'sdk-esm-guard.mjs');

/**
 * A specifier that resolves to NOTHING on disk and is redirected by the same rule set as the real
 * SDK. It is how `isEsmGuardInstalled()` can ask "did the redirection take?" without importing
 * the real SDK: if the rules are in force the canary yields the guard module, and if they are not
 * it throws ERR_MODULE_NOT_FOUND. Either way the vendored SDK is never resolved or loaded.
 *
 * The canary proves the MECHANISM. That the real specifier is in the rule set is proved separately
 * and without importing anything, by `matchesGuardedEsmSpecifier` over the literal string — see
 * `server/__tests__/no-live-agent-esm.test.js`. Both tests are required: narrowing the rules to
 * cover only the canary would leave the first green and turn the second red.
 */
export const CANARY_SPECIFIER = 'claudedm-no-live-agent-esm-canary';

/**
 * A second specifier that also resolves to nothing and is DELIBERATELY not in the rule set. It is
 * the positive control for the canary: if importing this one succeeded, the canary's success would
 * not be evidence of anything.
 */
export const UNGUARDED_CANARY_SPECIFIER = 'claudedm-no-live-agent-esm-canary-not-in-the-rules';

/**
 * Each pattern is anchored at BOTH ends and consumes the whole specifier. That is not cosmetic:
 * vite applies a RegExp alias as `specifier.replace(find, replacement)`, so a pattern that matched
 * only the tail of an absolute path would leave the directory prefix in front of the replacement
 * and produce a path that does not exist.
 */
export const GUARDED_ESM_SPECIFIER_PATTERNS = [
  // The bare package specifier — the import anyone would actually write.
  new RegExp(`^${SDK_MODULE.replace(/[/\\]/g, '\\$&')}$`),
  // The package's ESM entry point, by bare subpath, relative path or absolute path. The package
  // has no "exports" field, so these resolve straight to the file and skip the bare specifier.
  /^(?:.*[\\/])?@anthropic-ai[\\/]claude-agent-sdk[\\/]sdk\.mjs$/,
  // The CLI binary. Importing it does not go through query() at all; it is the file that gets
  // spawned and bills, so it is cheaper to refuse it here than to reason about it later.
  /^(?:.*[\\/])?@anthropic-ai[\\/]claude-agent-sdk[\\/]cli\.js$/,
  // The canary described above.
  new RegExp(`^${CANARY_SPECIFIER}$`),
];

/** True if an ESM import of `specifier` is redirected to the guard module. Pure; imports nothing. */
export function matchesGuardedEsmSpecifier(specifier) {
  if (typeof specifier !== 'string') return false;
  return GUARDED_ESM_SPECIFIER_PATTERNS.some((re) => re.test(specifier));
}

/**
 * True if `url` (a file: URL or path, as returned by a Node resolve hook) lands on the SDK's
 * loadable entry points. Used by `_harness/loader.mjs` AFTER calling `nextResolve`, which resolves
 * without loading, so this catches routes that reach the package by a path we did not predict.
 * There is no equivalent on the vitest path, where only the specifier is matched.
 */
export function matchesGuardedEsmUrl(url) {
  if (typeof url !== 'string') return false;
  const withoutQuery = url.split('?')[0].split('#')[0];
  return /@anthropic-ai[\\/]claude-agent-sdk[\\/](?:sdk\.mjs|cli\.js)$/.test(withoutQuery);
}

/** The `resolve.alias` entries for `vitest.config.js`. One entry per pattern, same target. */
export const esmGuardAliases = GUARDED_ESM_SPECIFIER_PATTERNS.map((find) => ({
  find,
  replacement: ESM_GUARD_MODULE,
}));

/**
 * Did the ESM redirection take? Asks via the canary, so the vendored SDK is never imported.
 * Returns false — rather than throwing — when the canary cannot be resolved, which is what
 * happens when the alias or the loader hook is missing.
 */
export async function isEsmGuardInstalled() {
  try {
    const ns = await import(CANARY_SPECIFIER);
    return !!(ns && ns.query && ns.query[GUARD_MARK]);
  } catch {
    return false;
  }
}

/** Fail closed: refuse to run a suite whose ESM redirection did not take. */
export async function assertEsmGuardInstalled() {
  if (!(await isEsmGuardInstalled())) {
    throw new Error(
      `no-live-agent: the ESM half of the guard is NOT in force over ${SDK_MODULE}. Refusing to `
      + 'run the test suite, because a dynamic import() from an ESM test file would receive the '
      + 'genuine query() and start a billable agent with Edit access to data/. The CJS half '
      + '(Module._load) does not cover that path. Restore `resolve.alias` in vitest.config.js, or '
      + 'the resolve hook in server/__tests__/_harness/loader.mjs, from '
      + 'server/__tests__/helpers/no-live-agent-esm.mjs (esmGuardAliases).'
    );
  }
}
