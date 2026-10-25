import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const sdkPkg = require('@anthropic-ai/claude-agent-sdk/package.json');
const sdkDir = path.dirname(require.resolve('@anthropic-ai/claude-agent-sdk/package.json'));

/**
 * WO-0015.5, answering the open caveat carried from the QC audit into state-guard.js:
 *
 *   "Whether the SDK ever hands a hook a path in that form has NOT been observed; the defect
 *    proved is that this classifier could be defeated by one."
 *
 * It is now observed, from the shipped bundle rather than from a live turn — the same method
 * that settled the PreToolUse-deny question in WO-0015.1. The answer is that **the hook receives
 * the model's file_path string verbatim**, so normalising in the classifier is not
 * defence-in-depth; it is the only thing standing between a `.`/`..` spelling and an
 * auto-allowed Edit.
 *
 * The chain, in @anthropic-ai/claude-agent-sdk@0.2.41's cli.js:
 *
 *  1. The tool's zod schema declares `file_path: z.string().describe("The absolute path ...")`.
 *     A bare string. No `.transform()`, no `.refine()`, no resolution. "Must be an absolute
 *     path" is a *description* — prose aimed at the model. It has exactly the force that
 *     "Never fabricate stats" had, which is the failure this whole work order exists to fix.
 *  2. `X = schema.safeParse(rawInput)`; a failure returns InputValidationError to the model.
 *  3. `let j = await A.validateInput?.(X.data, Y); if (j?.result === false) return <error>` —
 *     validateInput returns a VERDICT. It cannot rewrite the input.
 *  4. `let D = [], M = X.data;` then `Q6q(A, ..., M, ...)` → `executePreToolHooks` →
 *     `{ hook_event_name: "PreToolUse", tool_name: A, tool_input: K }`.
 *
 * `M` is `X.data` and is never reassigned between the parse and the hook, except for the Bash
 * tool, which has one key removed. Nothing normalises, resolves or canonicalises a path.
 *
 * These assertions are deliberately literal against the bundle. They are a tripwire, not a
 * proof: if an upgrade starts normalising paths, or starts letting validateInput rewrite them,
 * this file goes red and the caveat is reopened rather than silently going stale.
 */

const EVIDENCE_VERSION = '0.2.41';
const cli = () => fs.readFileSync(path.join(sdkDir, 'cli.js'), 'utf-8');

describe('SDK path contract: what a PreToolUse hook is handed', () => {
  it('is the SDK version this evidence was gathered from', () => {
    expect(sdkPkg.version).toBe(EVIDENCE_VERSION);
  });

  it('declares file_path as a bare string whose absoluteness is only described, never enforced', () => {
    const src = cli();
    expect(src).toContain('file_path:b.string().describe("The absolute path to the file to modify")');
    expect(src).toContain('file_path:b.string().describe("The absolute path to the file to read")');
    // The claim that matters: no transform sits between that schema and the hook.
    const schemaSite = src.indexOf('file_path:b.string().describe("The absolute path to the file to modify")');
    expect(schemaSite).toBeGreaterThan(-1);
    const window = src.slice(schemaSite, schemaSite + 400);
    expect(window).not.toContain('.transform(');
    expect(window).not.toContain('.refine(');
  });

  it('passes the schema-parsed input straight into the PreToolUse hook payload', () => {
    const src = cli();
    // The hook payload is assembled from the tool_input argument as given.
    expect(src).toContain('hook_event_name:"PreToolUse",tool_name:A,tool_input:K');
    // ...and the argument is the parse result, bound immediately before the hook call.
    expect(src).toContain('let D=[],M=X.data;');
  });

  it('gives validateInput a veto but not a rewrite', () => {
    const src = cli();
    // `result === false` is the whole of its contract: reject, or fall through unchanged.
    expect(src).toContain('let j=await A.validateInput?.(X.data,Y);if(j?.result===!1)');
  });

  it('has no path normalisation between the parse and the hook, so the classifier must do it', () => {
    const src = cli();
    const parseAt = src.indexOf('let j=await A.validateInput?.(X.data,Y);');
    const hookAt = src.indexOf('let D=[],M=X.data;');
    expect(parseAt).toBeGreaterThan(-1);
    expect(hookAt).toBeGreaterThan(parseAt);
    const between = src.slice(parseAt, hookAt);
    // The only reassignment of the tool input in that span is the Bash tool's key removal.
    expect(between).not.toContain('normalize(');
    expect(between).not.toContain('resolve(');
    expect(between).not.toContain('realpath');
  });
});

describe('the consequence for state-guard.js', () => {
  it('the classifier still normalises before it splits', () => {
    // The line the whole guarantee rests on. If a refactor moves the split ahead of the
    // normalise again, the SDK will happily hand it the spelling that defeats it.
    const src = fs.readFileSync(path.join(__dirname, '..', 'state-guard.js'), 'utf-8');
    const normaliseAt = src.indexOf('path.normalize(filePath)');
    const splitAt = src.indexOf("normalised.split('/')");
    expect(normaliseAt).toBeGreaterThan(-1);
    expect(splitAt).toBeGreaterThan(normaliseAt);
  });
});
