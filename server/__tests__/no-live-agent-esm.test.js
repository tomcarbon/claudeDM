/**
 * The ESM half of the no-live-agent guard, asserted. WO-0035.
 *
 * `no-live-agent.test.js` asserts the CommonJS half and says at `:58-65` that it deliberately
 * declines the different-loader question. This file is that question, and it answers it WITHOUT
 * importing `@anthropic-ai/claude-agent-sdk`, because an unguarded ESM import of the real SDK is
 * the exact thing that started a real agent process during WO-0033 revision 2. Three roles ran
 * that import while trying to measure this gap. The spend was $0.00 only because no credential is
 * set on this machine, which is a property of the machine and not a control.
 *
 * So the question is split into two halves that are each cheap to check and that together cover
 * it, and NEITHER half resolves or loads the vendored SDK:
 *
 *   A. Is the redirection mechanism in force? Asked with `CANARY_SPECIFIER` — a specifier in the
 *      same rule set that resolves to nothing on disk. If the alias (vitest) or the resolve hook
 *      (_harness) is in force, importing it yields the guard module; if not, it throws
 *      ERR_MODULE_NOT_FOUND. `UNGUARDED_CANARY_SPECIFIER` is the positive control: it also
 *      resolves to nothing and is deliberately NOT in the rule set, so if importing IT ever
 *      succeeded, the canary's success would be evidence of nothing.
 *   B. Is the real SDK specifier in that rule set? Asked by running the rule set over the literal
 *      strings. Pure string matching; imports nothing.
 *
 * What is therefore NOT established here by execution: that
 * `await import('@anthropic-ai/claude-agent-sdk')` returns the guard. Establishing that requires
 * importing the real SDK. It was established separately, against a fixture package in a shadow
 * node_modules whose `@anthropic-ai/claude-agent-sdk` is a harmless file that cannot spawn
 * anything — see §4 of records/reports/2026-10-02-software-developer-ceo-wo0035-esm-guard.md for
 * the script and the output. That harness is not committed, because committing something that
 * builds a node_modules shadow is a worse idea than the gap it closes.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  CANARY_SPECIFIER,
  UNGUARDED_CANARY_SPECIFIER,
  ESM_GUARD_MODULE,
  GUARDED_ESM_SPECIFIER_PATTERNS,
  matchesGuardedEsmSpecifier,
  matchesGuardedEsmUrl,
  isEsmGuardInstalled,
  esmGuardAliases,
} from './helpers/no-live-agent-esm.mjs';

const { SDK_MODULE, GUARD_MARK, isQueryGuarded } = require('./helpers/no-live-agent');

describe('ESM half: the redirection mechanism is in force (asked via a canary, not the SDK)', () => {
  it('a dynamic import of the canary specifier yields the guard module', async () => {
    const ns = await import(CANARY_SPECIFIER);
    expect(ns.__noLiveAgentEsmGuard).toBe(true);
    expect(typeof ns.query).toBe('function');
    expect(ns.query[GUARD_MARK]).toBe(true);
  });

  it('the query it yields throws the same BLOCKED message the CommonJS half throws', async () => {
    const ns = await import(CANARY_SPECIFIER);
    expect(() => ns.query({ prompt: 'x', options: {} })).toThrow(/BLOCKED/);
    expect(() => ns.query({ prompt: 'x', options: {} })).toThrow(/createEngine/);
    // Same function object as the CommonJS half installs, so there is one message and one mark
    // rather than two that can drift apart.
    expect(ns.query).toBe(require('./helpers/no-live-agent').guardedQuery);
  });

  it('POSITIVE CONTROL: a specifier not in the rule set does not resolve at all', async () => {
    // If this ever passes instead of throwing, the canary above proves nothing: it would mean
    // non-existent specifiers resolve by some other route and the import was never redirected.
    expect(matchesGuardedEsmSpecifier(UNGUARDED_CANARY_SPECIFIER)).toBe(false);
    await expect(import(UNGUARDED_CANARY_SPECIFIER)).rejects.toThrow(/Cannot find|ERR_MODULE_NOT_FOUND|Failed to load/);
  });

  it('isEsmGuardInstalled() reports true, which is what makes the suite fail closed', async () => {
    expect(await isEsmGuardInstalled()).toBe(true);
  });

  it('the guard module does not pretend to be the SDK: tool and createSdkMcpServer refuse', async () => {
    const ns = await import(CANARY_SPECIFIER);
    expect(() => ns.tool()).toThrow(/BLOCKED/);
    expect(() => ns.createSdkMcpServer()).toThrow(/use require\(\)|add a real re-export/);
  });
});

describe('ESM half: the real SDK specifier is in the rule set (pure string matching)', () => {
  // This is the test that goes red if the ESM path is reopened by narrowing the rules. Narrowing
  // them to cover only the canary would leave every test in the block above green.
  it('matches the bare package specifier', () => {
    expect(SDK_MODULE).toBe('@anthropic-ai/claude-agent-sdk');
    expect(matchesGuardedEsmSpecifier(SDK_MODULE)).toBe(true);
  });

  it('matches the package ESM entry point by bare subpath, relative path and absolute path', () => {
    expect(matchesGuardedEsmSpecifier('@anthropic-ai/claude-agent-sdk/sdk.mjs')).toBe(true);
    expect(matchesGuardedEsmSpecifier('../../node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs')).toBe(true);
    expect(matchesGuardedEsmSpecifier('/abs/path/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs')).toBe(true);
  });

  it('matches the CLI binary, which is the file that actually spawns and bills', () => {
    expect(matchesGuardedEsmSpecifier('@anthropic-ai/claude-agent-sdk/cli.js')).toBe(true);
    expect(matchesGuardedEsmSpecifier('/abs/node_modules/@anthropic-ai/claude-agent-sdk/cli.js')).toBe(true);
  });

  it('does NOT match the package.json subpath, which two contract tests legitimately read', () => {
    // sdk-permission-contract.test.js:6 and sdk-path-contract.test.js:5. They use require(), so
    // an alias could not reach them anyway, but a pattern that swallowed the subpath would be a
    // trap for whoever converts those files to ESM.
    expect(matchesGuardedEsmSpecifier('@anthropic-ai/claude-agent-sdk/package.json')).toBe(false);
  });

  it('does not match unrelated specifiers', () => {
    for (const s of ['express', 'ws', 'node:module', './helpers/no-live-agent.js', '@anthropic-ai/other-sdk', '']) {
      expect(matchesGuardedEsmSpecifier(s)).toBe(false);
    }
    expect(matchesGuardedEsmSpecifier(undefined)).toBe(false);
    expect(matchesGuardedEsmSpecifier(null)).toBe(false);
  });

  it('every pattern is anchored at both ends, because vite applies it with String.replace', () => {
    // An unanchored pattern would match the tail of an absolute path and leave the directory
    // prefix in front of the replacement, producing a path that does not exist — a silently
    // broken alias, which is the same as no alias.
    for (const re of GUARDED_ESM_SPECIFIER_PATTERNS) {
      expect(re.source.startsWith('^')).toBe(true);
      expect(re.source.endsWith('$')).toBe(true);
    }
    // And the consequence that actually matters: replacing yields exactly the guard module path.
    const abs = '/somewhere/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';
    const hit = esmGuardAliases.find((a) => a.find.test(abs));
    expect(hit).toBeTruthy();
    expect(abs.replace(hit.find, hit.replacement)).toBe(ESM_GUARD_MODULE);
  });

  it('matchesGuardedEsmUrl catches the SDK entry points by resolved URL, query string and all', () => {
    // Used by _harness/loader.mjs after nextResolve, which resolves without loading.
    expect(matchesGuardedEsmUrl('file:///x/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs')).toBe(true);
    expect(matchesGuardedEsmUrl('file:///x/node_modules/@anthropic-ai/claude-agent-sdk/cli.js?v=1')).toBe(true);
    expect(matchesGuardedEsmUrl('file:///x/node_modules/@anthropic-ai/claude-agent-sdk/package.json')).toBe(false);
    expect(matchesGuardedEsmUrl('file:///x/node_modules/express/index.js')).toBe(false);
    expect(matchesGuardedEsmUrl(undefined)).toBe(false);
  });

  it('every alias entry points at the guard module and nowhere else', () => {
    expect(esmGuardAliases.length).toBe(GUARDED_ESM_SPECIFIER_PATTERNS.length);
    for (const a of esmGuardAliases) expect(a.replacement).toBe(ESM_GUARD_MODULE);
    expect(ESM_GUARD_MODULE.endsWith('/helpers/sdk-esm-guard.mjs')).toBe(true);
  });
});

describe('the wiring is enforced by reading the files, not assumed', () => {
  // The canary tests above go green whenever the redirection is in force. They say nothing about
  // the four lines that PUT it in force, and three of those live in files no test imports. The
  // failure mode is silent — deleting `await assertEsmGuardInstalled()` from the setup file does
  // not break a single test, it just stops the suite failing closed — so these scan the source.
  // Same technique `bind-and-cors.test.js` uses on `client/vite.config.js` (WO-0034).
  const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
  const read = (p) => fs.readFileSync(path.join(PROJECT_ROOT, p), 'utf-8');

  it('vitest.config.js installs the aliases from the helper, not from a copied literal', () => {
    const src = read('vitest.config.js');
    expect(src).toMatch(/import\s*\{\s*esmGuardAliases\s*\}\s*from\s*'\.\/server\/__tests__\/helpers\/no-live-agent-esm\.mjs'/);
    expect(src).toMatch(/alias:\s*\[\s*\.\.\.esmGuardAliases\s*\]/);
    // If a specifier string ever appears in the CODE here, the config and the rule set can drift
    // apart. Comments may name it — the comments above do, and must, to explain the alias — so
    // the check is over the non-comment lines only. (The first draft of this assertion scanned
    // the whole file and went red on the config's own explanatory comment: an over-wide check in
    // the test file whose subject is over-wide claims. Left recorded rather than quietly fixed.)
    const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(code).not.toMatch(/@anthropic-ai\/claude-agent-sdk/);
  });

  it('helpers/vitest-setup.js fails the suite closed on BOTH halves', () => {
    const src = read('server/__tests__/helpers/vitest-setup.js');
    expect(src).toMatch(/assertQueryGuarded\(/);
    expect(src).toMatch(/await assertEsmGuardInstalled\(\)/);
  });

  it('_harness/run-file.mjs fails closed on both halves too', () => {
    const src = read('server/__tests__/_harness/run-file.mjs');
    expect(src).toMatch(/assertQueryGuarded\(/);
    expect(src).toMatch(/assertEsmGuardInstalled\(\)/);
  });

  it('_harness/loader.mjs redirects guarded specifiers and inspects the resolved url', () => {
    const src = read('server/__tests__/_harness/loader.mjs');
    expect(src).toMatch(/matchesGuardedEsmSpecifier\(specifier\)/);
    expect(src).toMatch(/matchesGuardedEsmUrl\(resolved\.url\)/);
  });

  it('the client test glob that made this reachable is still covered by the globs', () => {
    // WO-0037 added the client glob; WO-0035 exists because client/src/** is ESM. If the glob is
    // ever removed, the client-tree assertion stops running and nothing else notices.
    const src = read('vitest.config.js');
    expect(src).toMatch(/'client\/src\/\*\*\/__tests__\/\*\*\/\*\.test\.js'/);
    expect(fs.existsSync(path.join(PROJECT_ROOT, 'client/src/utils/__tests__/no-live-agent-esm.client.test.js'))).toBe(true);
  });
});

describe('the two halves are independent and both are still in force', () => {
  it('the CommonJS half is untouched by this work order', () => {
    // Regression guard: the ESM fix is resolution-time behaviour and must not have displaced the
    // Module._load patch, which is the half that covers server/dm-engine.js.
    const sdk = require(SDK_MODULE);
    expect(sdk.query[GUARD_MARK]).toBe(true);
    expect(isQueryGuarded(require)).toBe(true);
  });

  it('require() still sees the REAL SDK surface, which dm-engine needs at load time', () => {
    // dm-engine.js:1 destructures query, createSdkMcpServer and tool. The CommonJS half proxies
    // the real module and substitutes one export; the ESM guard module does not re-export the
    // other two. If the alias had reached require(), these would be the refusing stubs.
    const sdk = require(SDK_MODULE);
    expect(typeof sdk.tool).toBe('function');
    expect(typeof sdk.createSdkMcpServer).toBe('function');
    expect(() => sdk.tool('x', 'y', {}, async () => ({}))).not.toThrow(/BLOCKED/);
  });
});
