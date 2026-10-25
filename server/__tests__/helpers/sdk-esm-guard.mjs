/**
 * The module every guarded ESM specifier is redirected to. WO-0035.
 *
 * It is NOT a stand-in for the SDK. It exports the same `query` thrower the CommonJS half
 * installs — the identical function object, so it carries the identical GUARD_MARK and the
 * identical BLOCKED message — and refusals for the two other exports `server/dm-engine.js`
 * uses. Everything else the SDK exports is simply absent here.
 *
 * That is deliberate and it is safe only because of a fact that must be rechecked if it changes:
 * no file in this project imports the SDK with `import`. Checked by execution on 2026-10-02 with
 *
 *   grep -rn "@anthropic-ai/claude-agent-sdk" --include=*.js --include=*.mjs --include=*.jsx \
 *     server client/src shared | grep -v "^server/__tests__/helpers/"
 *
 * which returns nine lines: two prose comments, and seven `require()` / `require.resolve()` calls
 * at `server/dm-engine.js:1`, `server/bot/bot-brain-model.js:562`,
 * `server/__tests__/sdk-permission-contract.test.js:5-7` and
 * `server/__tests__/sdk-path-contract.test.js:5-6`. `require()` is handled by the CommonJS half,
 * which wraps the REAL module in a Proxy and leaves its whole surface intact, so nothing in the
 * suite today reaches this file. If some future test genuinely needs an SDK export over the ESM
 * path, add it here as a real re-export rather than widening the alias.
 *
 * See `helpers/no-live-agent-esm.mjs` for the rule set and the coverage limits, and
 * `helpers/no-live-agent.js` for the CommonJS half.
 */
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const { guardedQuery, SDK_MODULE } = nodeRequire('./no-live-agent.js');

/** The same thrower, and the same marked function object, as the CommonJS half installs. */
export const query = guardedQuery;

/** Lets a reader of a stack trace see which file they landed in. */
export const __noLiveAgentEsmGuard = true;

function refuse(exportName) {
  return function refused() {
    throw new Error(
      `BLOCKED: a test reached ${SDK_MODULE}.${exportName}() through an ESM import, which the `
      + 'no-live-agent guard redirects to server/__tests__/helpers/sdk-esm-guard.mjs. That file '
      + `does not re-export ${exportName}, because nothing in this project imports the SDK — every `
      + 'call site uses require(), which keeps the real SDK surface. Use require() here too, or '
      + 'add a real re-export to sdk-esm-guard.mjs.'
    );
  };
}

export const tool = refuse('tool');
export const createSdkMcpServer = refuse('createSdkMcpServer');

export default { query, tool, createSdkMcpServer, __noLiveAgentEsmGuard };
