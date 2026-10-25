import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const sdk = require('@anthropic-ai/claude-agent-sdk');
const sdkPkg = require('@anthropic-ai/claude-agent-sdk/package.json');
const sdkDir = path.dirname(require.resolve('@anthropic-ai/claude-agent-sdk/package.json'));

/**
 * Pins the one fact ADR 0005 rests on: a `PreToolUse` hook returning
 * `permissionDecision: 'deny'` blocks a *built-in* tool — `Edit` — from running, and does so
 * ahead of `canUseTool`.
 *
 * This is a contract test against the installed SDK, not a live agent turn. A live turn needs
 * real credentials and real money, which is the gate WO-0015.1 exists to hold. What these tests
 * do buy is a tripwire: if an SDK upgrade removes the hook event or changes the deny
 * short-circuit, the suite goes red instead of the hard block quietly becoming a soft one.
 *
 * Evidence gathered from @anthropic-ai/claude-agent-sdk@0.2.41:
 *   sdk.d.ts:984-987   PreToolUseHookSpecificOutput.permissionDecision?: 'allow'|'deny'|'ask'
 *   cli.js             the PreToolUse deny branch sets permissionBehavior="deny" and the
 *                      dispatcher then takes `else if (G.behavior === "deny")`, logging
 *                      "Hook denied tool use for ${name}" and assigning the hook's result
 *                      *instead of awaiting the canUseTool function*. The branch is generic
 *                      over the tool name — there is no carve-out for built-ins.
 */

const EVIDENCE_VERSION = '0.2.41';

describe('SDK permission contract (ADR 0005 hard block)', () => {
  it('is the SDK version the PreToolUse evidence was gathered from', () => {
    // If this fails, re-read the deny path in cli.js before trusting the hard block.
    expect(sdkPkg.version).toBe(EVIDENCE_VERSION);
  });

  it('exposes PreToolUse and PostToolUse as hook events at runtime', () => {
    expect(sdk.HOOK_EVENTS).toContain('PreToolUse');
    expect(sdk.HOOK_EVENTS).toContain('PostToolUse');
  });

  it('declares permissionDecision allow/deny/ask on PreToolUse hook output', () => {
    const dts = fs.readFileSync(path.join(sdkDir, 'sdk.d.ts'), 'utf-8');
    expect(dts).toContain("hookEventName: 'PreToolUse'");
    expect(dts).toContain("permissionDecision?: 'allow' | 'deny' | 'ask'");
  });

  it('short-circuits on a hook deny rather than falling through to canUseTool', () => {
    const cli = fs.readFileSync(path.join(sdkDir, 'cli.js'), 'utf-8');
    // The dispatcher's deny branch. Its presence is what makes the block a block.
    expect(cli).toContain('Hook denied tool use for ');
    // ...and the sibling allow branch, which proves the hook result is consulted before the
    // permission callback rather than after it.
    expect(cli).toContain('bypassing permission check');
  });

  it('Edit is a built-in the DM is currently allowed to use, so the block has something to bite on', () => {
    // Guards against the block being written for a tool the engine never offers.
    const engineSrc = fs.readFileSync(path.join(__dirname, '..', 'dm-engine.js'), 'utf-8');
    expect(engineSrc).toContain("'Edit'");
  });
});
