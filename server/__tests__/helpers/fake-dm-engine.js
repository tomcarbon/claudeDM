/**
 * A stand-in for DmEngine, for tests that drive the WebSocket handler.
 *
 * Why this exists: a real DmEngine calls the Claude Agent SDK's `query()` with
 * `cwd: PROJECT_ROOT` and `Edit` auto-allowed (server/dm-engine.js `_buildOptions`). Any test
 * that reaches `engine.run()` therefore starts a real, billable agent with write access to the
 * live `data/` directory. `attachWebSocket` accepts a `createEngine` factory so tests never
 * construct one — the same shape as the `summarize` injection `maybeCompact` already takes.
 *
 * The fake implements exactly the surface ws-handler.js uses:
 *   - `sessionId`            read and written by session resume / campaign switch
 *   - `run(text, opts)`      async iterable of turn events
 *   - `runReconcile(p, o)`   async iterable, used by the post-turn audit enforcement
 *   - `abort()`              called on disconnect and on engine cleanup
 *
 * It records every call so tests can assert on what the handler asked the DM to do, which is
 * the interesting assertion anyway — the DM's prose never was.
 */

const DEFAULT_CLAUDE_SESSION_ID = 'fake-claude-session-id';

/** Default turn: one narration and a clean completion. Enough to exercise the persist path. */
function defaultScript(userMessage) {
  return [
    { type: 'dm_response', text: `[fake DM] acknowledged: ${String(userMessage).slice(0, 120)}` },
    { type: 'dm_complete', sessionId: DEFAULT_CLAUDE_SESSION_ID },
  ];
}

class FakeDmEngine {
  constructor(dataDir, options = {}) {
    this.dataDir = dataDir;
    this.sessionId = null;
    this.aborted = 0;
    /** @type {Array<{kind: string, text: string, opts: object}>} */
    this.calls = [];
    this._script = options.script || defaultScript;
    this._reconcileScript = options.reconcileScript || (() => []);
  }

  async *run(userMessage, opts = {}) {
    this.calls.push({ kind: 'run', text: userMessage, opts });
    const events = typeof this._script === 'function'
      ? await this._script(userMessage, opts, this)
      : this._script;
    for (const event of events || []) {
      if (event && event.type === 'dm_complete' && event.sessionId) this.sessionId = event.sessionId;
      yield event;
    }
  }

  async *runReconcile(prompt, opts = {}) {
    this.calls.push({ kind: 'runReconcile', text: prompt, opts });
    const events = typeof this._reconcileScript === 'function'
      ? await this._reconcileScript(prompt, opts, this)
      : this._reconcileScript;
    for (const event of events || []) yield event;
  }

  abort() {
    this.aborted += 1;
  }
}

/**
 * Build a `createEngine` factory for `attachWebSocket(server, dataDir, { createEngine })`.
 * The returned function carries `.created` (every engine it handed out) and `.last()`.
 */
function createFakeEngineFactory(options = {}) {
  const created = [];
  const factory = (dataDir) => {
    const engine = new FakeDmEngine(dataDir, options);
    created.push(engine);
    return engine;
  };
  factory.created = created;
  factory.last = () => created[created.length - 1] || null;
  factory.reset = () => { created.length = 0; };
  return factory;
}

/**
 * A `summarize` stand-in for the compaction call in ws-handler. The real one is `summarizeArc`,
 * which is a second, independent `query()` call site — it must be injected too or a test with a
 * long enough message history would start an agent at session resume.
 */
function createFakeSummarize(options = {}) {
  const calls = [];
  const fn = async (text) => {
    calls.push(text);
    return options.blurb || '[fake arc summary]';
  };
  fn.calls = calls;
  return fn;
}

module.exports = { FakeDmEngine, createFakeEngineFactory, createFakeSummarize, DEFAULT_CLAUDE_SESSION_ID };
