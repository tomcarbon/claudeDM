/**
 * The ESM half of the no-live-agent guard, asserted FROM THE CLIENT TREE. WO-0035.
 *
 * This file is here rather than only in `server/__tests__/` for one reason: `client/src/**` is
 * ESM, and WO-0037's `client/src/**​/__tests__/**​/*.test.js` glob in `vitest.config.js` is what
 * turned the ESM gap from latent into reachable (SDET's S-1 on that work order: "your glob is
 * what makes it reachable"). Asserting the guard only in the server tree would be assuming the
 * client tree behaves the same way, and the whole subject of this file is a claim that was true
 * of one loader and asserted of all of them.
 *
 * It asks the question the same way its server-tree sibling does — through a canary specifier
 * that resolves to nothing on disk — so it never imports `@anthropic-ai/claude-agent-sdk`. See
 * `server/__tests__/no-live-agent-esm.test.js` for the full reasoning, the positive control over
 * the rule set, and what is deliberately NOT established by execution.
 *
 * It is not testing client code and does not belong to the palette work next to it. If the client
 * ever gets a test directory of its own for infrastructure, move it there.
 */
import { describe, it, expect } from 'vitest';
import {
  CANARY_SPECIFIER,
  UNGUARDED_CANARY_SPECIFIER,
  matchesGuardedEsmSpecifier,
  isEsmGuardInstalled,
} from '../../../../server/__tests__/helpers/no-live-agent-esm.mjs';

const SDK_MODULE = '@anthropic-ai/claude-agent-sdk';

describe('no-live-agent ESM guard, from inside the client tree', () => {
  it('a dynamic import() in this tree is redirected to the guard module', async () => {
    const ns = await import(CANARY_SPECIFIER);
    expect(ns.__noLiveAgentEsmGuard).toBe(true);
    expect(typeof ns.query).toBe('function');
  });

  it('the query it yields throws instead of spawning', async () => {
    const ns = await import(CANARY_SPECIFIER);
    expect(() => ns.query({ prompt: 'x', options: {} })).toThrow(/BLOCKED/);
  });

  it('POSITIVE CONTROL: a specifier outside the rule set does not resolve in this tree either', async () => {
    await expect(import(UNGUARDED_CANARY_SPECIFIER)).rejects.toThrow(/Cannot find|ERR_MODULE_NOT_FOUND|Failed to load/);
  });

  it('isEsmGuardInstalled() is true here, so this tree fails closed too', async () => {
    expect(await isEsmGuardInstalled()).toBe(true);
  });

  it('the real SDK specifier is in the rule set that redirected the canary', () => {
    expect(matchesGuardedEsmSpecifier(SDK_MODULE)).toBe(true);
  });
});
