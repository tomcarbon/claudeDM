/**
 * Fallback test runner: executes ONE of this project's vitest test files on plain Node.
 *
 * Usage:  node server/__tests__/_harness/run-file.mjs server/__tests__/sessions.test.js
 *
 * See _harness/README.md. Vitest is the canonical runner; this exists because the checkout's
 * node_modules has no dev dependencies and `npm install` was out of scope for WO-0015.1.
 *
 * Safety: it installs BOTH halves of the no-live-agent guard before loading any test file, and
 * refuses to run if either did not take — the CommonJS half from helpers/no-live-agent.js at
 * step 1 below, and the ESM half (loader.mjs's resolve hook, rule set in
 * helpers/no-live-agent-esm.mjs) at step 3a. WO-0035; before it, this runner checked the
 * CommonJS half only, and a dynamic `import()` of the SDK from a test file it loaded received
 * the genuine `query`.
 */
import { createRequire } from 'node:module';
import module from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const target = process.argv[2];
if (!target) {
  console.error('usage: node run-file.mjs <path-to-test-file>');
  process.exit(2);
}
const abs = path.resolve(process.cwd(), target);

// 1. Block the Claude Agent SDK before anything can load server/dm-engine.js.
const harnessRequire = createRequire(import.meta.url);
const guard = harnessRequire('../helpers/no-live-agent.js');
guard.installQueryGuard();
guard.assertQueryGuarded(harnessRequire);

// 2. The project's test files mix ESM `import` with CommonJS `require`. Vitest provides
//    `require` in its module context; on plain Node an ESM module has no `require` binding, so
//    it resolves through globalThis. One createRequire rooted at the test file is correct for
//    every file, since they all live in the same directory.
globalThis.require = createRequire(abs);
//    Same reasoning for the CommonJS path globals vitest injects.
globalThis.__filename = abs;
globalThis.__dirname = path.dirname(abs);

// 3. Map the `vitest` specifier to the shim — and, in the same hook, redirect every ESM
//    specifier that would reach the Claude Agent SDK.
module.register('./loader.mjs', import.meta.url);

// 3a. The hook is registered; now refuse to continue unless it actually took. This asks via a
//     canary specifier that resolves to nothing on disk, so neither the check nor its failure
//     path imports the real SDK. It must come AFTER module.register above.
const esmGuard = await import('../helpers/no-live-agent-esm.mjs');
await esmGuard.assertEsmGuardInstalled();

const shim = await import('./vitest-shim.mjs');
// `globals: true` in vitest.config.js — mirror it.
for (const name of ['describe', 'it', 'test', 'expect', 'beforeEach', 'afterEach', 'beforeAll', 'afterAll', 'vi']) {
  globalThis[name] = shim[name];
}

const DEFAULT_TIMEOUT_MS = Number(process.env.HARNESS_TIMEOUT_MS || 20000);

const unhandled = [];
process.on('unhandledRejection', (reason) => { unhandled.push(reason); });

function chain(suite) {
  const out = [];
  for (let s = suite; s; s = s.parent) out.unshift(s);
  return out;
}

async function withTimeout(fn, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${label}`)), ms);
  });
  try {
    return await Promise.race([Promise.resolve().then(fn), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const results = { passed: 0, failed: 0, skipped: 0, failures: [] };

async function runSuite(suite, ancestorsSkipped) {
  const skipped = ancestorsSkipped || suite.skip;
  for (const t of suite.tests) {
    const fullName = [...chain(suite).map(s => s.name).filter(Boolean), t.name].join(' › ');
    if (skipped || t.skip || !t.fn) {
      results.skipped += 1;
      console.log(`  - SKIP  ${fullName}`);
      continue;
    }
    const path_ = chain(suite);
    const befores = path_.flatMap(s => s.beforeEach);
    const afters = path_.flatMap(s => s.afterEach).reverse();
    let error = null;
    try {
      for (const b of befores) await withTimeout(b, t.timeout || DEFAULT_TIMEOUT_MS, `beforeEach for ${fullName}`);
      await withTimeout(() => t.fn(), t.timeout || DEFAULT_TIMEOUT_MS, fullName);
    } catch (e) {
      error = e;
    }
    for (const a of afters) {
      try { await withTimeout(a, t.timeout || DEFAULT_TIMEOUT_MS, `afterEach for ${fullName}`); }
      catch (e) { if (!error) error = e; }
    }
    if (error) {
      results.failed += 1;
      results.failures.push({ name: fullName, error });
      console.log(`  ✗ FAIL  ${fullName}\n          ${String(error && error.message).split('\n').join('\n          ')}`);
    } else {
      results.passed += 1;
      console.log(`  ✓ pass  ${fullName}`);
    }
  }
  for (const child of suite.children) await runSuite(child, skipped);
}

console.log(`\n=== ${path.relative(process.cwd(), abs)} ===`);
let loadError = null;
try {
  await import(pathToFileURL(abs).href);
} catch (e) {
  loadError = e;
}

if (loadError) {
  console.log(`  ✗ FAIL  <file failed to load>\n          ${loadError && loadError.stack}`);
  results.failed += 1;
  results.failures.push({ name: '<file failed to load>', error: loadError });
} else {
  await runSuite(shim._getRoot(), false);
}

// Give lingering handles (sockets, timers) a moment, then report.
await new Promise(r => setTimeout(r, 50));

if (unhandled.length) {
  console.log(`  ! ${unhandled.length} unhandled rejection(s) during this file:`);
  for (const u of unhandled.slice(0, 5)) console.log(`      ${String(u && u.message || u).split('\n')[0]}`);
}

console.log(`SUMMARY ${path.relative(process.cwd(), abs)} passed=${results.passed} failed=${results.failed} skipped=${results.skipped} unhandled=${unhandled.length}`);
process.exit(results.failed > 0 ? 1 : 0);
