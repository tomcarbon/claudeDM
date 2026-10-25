/**
 * Test-suite guard: make it impossible for `npm test` to start a live Claude agent.
 *
 * Background (WO-0001.5 / WO-0015.1). `server/dm-engine.js` has exactly two `query()` call
 * sites — `DmEngine._streamQuery` (line ~1208) and `summarizeArc` (line ~1074). Both run with
 * `cwd: PROJECT_ROOT`, and the DM's `canUseTool` auto-allows `Read`, `Glob`, `Grep`, `Edit` and
 * every `mcp__` tool. A test that reaches either one starts a real, billable agent that can
 * write to the chair's live `data/` directory. That is why the suite was quarantined.
 *
 * The primary fix is injection: `attachWebSocket` takes `createEngine` and `summarize`, and
 * `ws-turns.test.js` passes fakes, so no test constructs a real engine. This file is the second
 * layer — it swaps `query` for a thrower at module-load time, so a *future* test that forgets
 * to inject fails loudly instead of spending money.
 *
 * WHICH LOADER THIS FILE COVERS, and which it does not.
 *
 * This file covers ONE loader: Node's CommonJS loader, via `Module._load`. `server/dm-engine.js`
 * is CommonJS and is loaded with `require()` by every test that touches it, so the interception
 * applies on that path, and `assertQueryGuarded()` proves it did — over that loader, which is
 * also the only loader `assertQueryGuarded`'s default argument can see (see the comment at its
 * definition below).
 *
 * It does NOT cover a dynamic ESM `import('@anthropic-ai/claude-agent-sdk')`. Such an import does
 * not route through `Module._load` at all and receives the genuine `query`. That is not a theory:
 * SDET measured it (CJS `require()` -> guarded true; ESM `import()` -> false), and during WO-0033
 * revision 2 an ESM import under `strace` produced a successful `execve` of the SDK's `cli.js`
 * with `--permission-mode default`. The ESM half is closed by a separate mechanism in
 * `helpers/no-live-agent-esm.mjs` plus `resolve.alias` in `vitest.config.js` and the resolve hook
 * in `_harness/loader.mjs`; `helpers/vitest-setup.js` and `_harness/run-file.mjs` call
 * `assertEsmGuardInstalled()` so that a suite whose ESM half is missing refuses to start.
 *
 * `no-live-agent.test.js` asserts the CommonJS half, over this file's own `require`, and says at
 * `:58-65` that it does so deliberately. It does not and never did assert anything about a
 * different loader. (This header claimed the opposite until 2026-10-02 — WO-0035, condition B7:
 * the false sentence was "no-live-agent.test.js turns that into a checked assertion rather than a
 * hope", in the one file a reader consults to learn whether the suite can spend money, and it is
 * the most plausible reason the gap sat three rounds as "untested". It is struck rather than
 * supplemented, because an over-wide claim left beside a correct one is still an over-wide
 * claim.) The ESM half is asserted by `no-live-agent-esm.test.js` and
 * `client/src/utils/__tests__/no-live-agent-esm.client.test.js`.
 */

const Module = require('node:module');

const SDK_MODULE = '@anthropic-ai/claude-agent-sdk';
const GUARD_MARK = Symbol.for('claudedm.test.no-live-agent');

const BLOCKED_MESSAGE = [
  'BLOCKED: a test tried to start a live Claude agent via',
  `${SDK_MODULE}.query().`,
  'The test suite must never do this: the DM engine runs with cwd = the project root and',
  'auto-allows the Edit tool, so a live agent can rewrite files under data/ and it bills the',
  'chair\'s subscription.',
  '',
  'Fix the test, not this guard. Inject a fake engine:',
  '  const { createFakeEngineFactory } = require("./helpers/fake-dm-engine");',
  '  attachWebSocket(server, tmpDir, { createEngine: createFakeEngineFactory() });',
].join('\n');

function guardedQuery() {
  throw new Error(BLOCKED_MESSAGE);
}
guardedQuery[GUARD_MARK] = true;

function wrap(realModule) {
  if (!realModule || (typeof realModule !== 'object' && typeof realModule !== 'function')) return realModule;
  if (realModule.query && realModule.query[GUARD_MARK]) return realModule;
  // The SDK is an ES module, so `require()` hands back a namespace exotic object whose
  // properties are non-configurable. A Proxy is the only way to substitute one export; the
  // `writable: true` on namespace properties is what keeps the get trap legal here.
  return new Proxy(realModule, {
    get(target, prop, receiver) {
      if (prop === 'query') return guardedQuery;
      return Reflect.get(target, prop, receiver);
    },
    has(target, prop) { return prop === 'query' || Reflect.has(target, prop); },
  });
}

let installed = false;

/** Idempotent. Must run before anything requires server/dm-engine.js. */
function installQueryGuard() {
  if (installed) return;
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    const loaded = originalLoad.apply(this, arguments);
    if (request === SDK_MODULE) return wrap(loaded);
    return loaded;
  };
  installed = true;
}

/**
 * True if requiring the SDK from `fromRequire` yields the guarded `query`.
 *
 * `fromRequire` DEFAULTS TO A `require`, so this answers the question for the CommonJS loader and
 * for no other. It is silent about a dynamic ESM `import()`, which is a separate loader this file
 * does not patch — use `isEsmGuardInstalled()` from `helpers/no-live-agent-esm.mjs` for that one.
 * Stated here because "the suite refuses to start unless the guard took" is true over one loader
 * of two, and because `CLAUDE.md` describes this guard as fail-closed without the qualifier
 * (WO-0035 drafts a correction; that file is the chair's to edit).
 */
function isQueryGuarded(fromRequire = require) {
  try {
    const sdk = fromRequire(SDK_MODULE);
    return !!(sdk && sdk.query && sdk.query[GUARD_MARK]);
  } catch {
    return false;
  }
}

/**
 * Fail closed: refuse to run a suite whose guard did not take — OVER THE COMMONJS LOADER ONLY,
 * for the reason given on `isQueryGuarded` above. Both installers pair this with
 * `assertEsmGuardInstalled()` from `helpers/no-live-agent-esm.mjs`; this function passing is half
 * of "the suite cannot start a live agent", not the whole of it.
 */
function assertQueryGuarded(fromRequire = require) {
  if (!isQueryGuarded(fromRequire)) {
    throw new Error(
      `no-live-agent guard failed to install over ${SDK_MODULE}. Refusing to run the test suite, `
      + 'because an un-injected DM engine would start a billable agent with Edit access to data/. '
      + 'See server/__tests__/helpers/no-live-agent.js.'
    );
  }
}

module.exports = {
  SDK_MODULE,
  GUARD_MARK,
  BLOCKED_MESSAGE,
  guardedQuery,
  installQueryGuard,
  isQueryGuarded,
  assertQueryGuarded,
};
