import { defineConfig } from 'vitest/config';
import { esmGuardAliases } from './server/__tests__/helpers/no-live-agent-esm.mjs';

export default defineConfig({
  // The ESM half of the no-live-agent guard. WO-0035.
  //
  // `helpers/no-live-agent.js` patches `Module._load`, which is Node's CommonJS loader, so it
  // covers `require()` and nothing else: a dynamic `import('@anthropic-ai/claude-agent-sdk')`
  // receives the genuine `query` and starts a billable agent. These aliases redirect that import
  // to `helpers/sdk-esm-guard.mjs`, whose `query` throws.
  //
  // The patterns are NOT written out here. They come from `esmGuardAliases` so that the rule set
  // lives in one file next to the assertion that checks it, and the config cannot drift from it.
  // Read `helpers/no-live-agent-esm.mjs` for which specifiers are covered and which are not;
  // measured facts only, and the limits are listed as plainly as the coverage.
  //
  // This is resolution-time behaviour, so it does not reach `require()` — the `require` vitest
  // hands a test file is a native `createRequire`. That is intended: the two halves cover one
  // loader each, and `setupFiles` below refuses to start the suite if either is missing.
  resolve: {
    alias: [...esmGuardAliases],
  },
  test: {
    globals: true,
    include: [
      'server/__tests__/**/*.test.js',
      // WO-0037. The client had NO tests and no runner that looked for any: this glob is the
      // whole of the change, and it is what makes `npm test` cover the campaign-palette
      // arithmetic (client/src/utils/__tests__/). Without it the §4.3 convexity property test
      // exists as a file nothing runs, which is the same as not having written it.
      //
      // These files are deliberately pure — colour arithmetic and an injected-clock controller —
      // so no jsdom environment is needed.
      //
      // The guard below reaches this tree, and until 2026-10-02 this comment claimed it did so
      // "unchanged", which was true only of the CommonJS path. `client/src/**` is ESM, so adding
      // this glob is what turned the ESM gap from latent into reachable (SDET's S-1). Both halves
      // now cover it, and `client/src/utils/__tests__/no-live-agent-esm.client.test.js` asserts
      // the ESM half from inside this tree rather than by analogy with the server tree.
      'client/src/**/__tests__/**/*.test.js',
    ],
    // Blocks the Claude Agent SDK's query() for the whole suite, on BOTH loaders, and refuses to
    // start if either block failed to install. Without it a test that forgets to inject a fake DM
    // engine starts a real, billable agent with Edit access to data/.
    setupFiles: ['./server/__tests__/helpers/vitest-setup.js'],
  },
});
