/**
 * Vitest setup file — runs before every test file (see vitest.config.js `setupFiles`).
 *
 * Installs both halves of the no-live-agent guard, then refuses to run if either did not take.
 * The suite failing to start is an acceptable outcome; the suite starting a billable Edit-enabled
 * agent against the live data/ directory is not.
 *
 *   - CommonJS (`require`): installed here by `installQueryGuard()`, checked by
 *     `assertQueryGuarded()`. Reasoning in `helpers/no-live-agent.js`; asserted by
 *     `server/__tests__/no-live-agent.test.js`.
 *   - ESM (`import()`): installed by `resolve.alias` in `vitest.config.js`, checked here by
 *     `assertEsmGuardInstalled()`. Reasoning in `helpers/no-live-agent-esm.mjs`; asserted by
 *     `server/__tests__/no-live-agent-esm.test.js` and the client-tree copy next to the palette
 *     tests. WO-0035; before it, this file checked the CommonJS half only.
 *
 * `assertEsmGuardInstalled()` asks the question through a canary specifier that resolves to
 * nothing on disk, so neither the check nor its failure path imports the real SDK.
 */
import { createRequire } from 'node:module';
import { assertEsmGuardInstalled } from './no-live-agent-esm.mjs';

const nodeRequire = createRequire(import.meta.url);
const { installQueryGuard, assertQueryGuarded } = nodeRequire('./no-live-agent.js');

installQueryGuard();
assertQueryGuarded(nodeRequire);
await assertEsmGuardInstalled();
