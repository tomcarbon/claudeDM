/**
 * The enforced shape, the visible refusals, and the session cleanup (WO-0036 DoD 1, DoD 5, J5).
 *
 * ZERO MODEL CALLS AND ZERO AGENT PROCESSES. Every orchestrator here is built with an injected
 * `createBrain` returning the rule brain — J1's test double, which is the only reason this file
 * can exercise the bot path at all without spending money — or with no bot ever started. The
 * suite-wide no-live-agent guard covers both loaders underneath (WO-0035) and is the backstop.
 *
 * NOTHING UNDER `data/`. Every test owns a `mkdtemp`. That matters more here than anywhere else
 * in the suite, because this file tests a function whose job is to call `fs.rmSync` on session
 * directories: the throwaway tree is the test subject, and `projects/claudeDM/data/` is never
 * named, read or passed in.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const {
  BotOrchestrator,
  BotShapeError,
  MAX_HOST_BOTS,
  MAX_COMPANION_BOTS,
  MAX_CONCURRENT_GAMES,
  MAX_SESSIONS_PER_BOT,
} = require('../bot/bot-orchestrator');
const registry = require('../bot/bot-brain-registry');
const { startTestServer } = require('./helpers/test-server');

const SERVER_DIR = path.resolve(__dirname, '..');

/** An orchestrator that never builds a model brain and never opens a socket of its own. */
function makeOrchestrator(dataDir) {
  const o = new BotOrchestrator(dataDir, 3999, {
    createBrain: () => ({ name: 'rules', brain: registry.createRuleBrain() }),
  });
  o._startBot = () => {};       // no accounts, no sockets, no network
  o.saveConfig = () => {};
  return o;
}

/** Write a session record into a throwaway tree, in the real layout. */
function writeSession(dataDir, id, record) {
  const dir = path.join(dataDir, 'sessions', id);
  fs.mkdirSync(path.join(dir, 'characters'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ id, ...record }, null, 2));
  fs.writeFileSync(path.join(dir, 'characters', 'someone.json'), '{"name":"Someone"}');
  return dir;
}

/**
 * Write `players.json` into a throwaway tree.
 *
 * ── S-1: WHY `isBot` IS A PARAMETER AND NOT DERIVED FROM THE ADDRESS ───────────────────────
 *
 * This function used to read `isBot: email.endsWith('@bot.local')`, and **that one line is why
 * 900 green tests certified a false statement to the chair.** Production does not derive `isBot`
 * — `listBotAccounts` reads the *flag* (`bot-accounts.js:22`) — so the fixture and production
 * agreed in every test, and the single case where they disagree was unrepresentable:
 *
 *   **an owning account that is GONE. Which is the definition of an orphan.**
 *
 * So the test named *"cleanup() deletes the orphans"* registered the owning bot in
 * `players.json` first and was therefore not a test of an orphan at all. Both reviewers
 * reproduced the real behaviour on replicas of the chair's exact state — three human accounts,
 * no `isBot` anywhere — and measured **both orphans KEPT**, by condition 3.
 *
 * `sdet`: *"the fixture's `isBot` derivation should be a parameter, so a test can write the
 * disagreement that production cares about."* It now is.
 *
 * @param {string} dataDir
 * @param {Array<string|{email: string, isBot?: boolean, role?: string}>} entries
 *        A bare string keeps the old behaviour — `isBot` derived from the address — so every
 *        existing caller is unchanged. An object states `isBot` explicitly, **including the two
 *        disagreements production can actually see**: a `@bot.local` address with no `isBot`
 *        flag, and a human-looking address flagged as a bot.
 */
function writePlayers(dataDir, entries) {
  const players = {};
  for (const entry of entries) {
    const e = typeof entry === 'string' ? { email: entry } : entry;
    players[e.email] = {
      email: e.email,
      name: e.email.split('@')[0],
      isBot: Object.prototype.hasOwnProperty.call(e, 'isBot') ? e.isBot : e.email.endsWith('@bot.local'),
      ...(e.role ? { role: e.role } : {}),
    };
  }
  fs.writeFileSync(path.join(dataDir, 'players.json'), JSON.stringify(players, null, 2));
}

// ── 1. the shape (DoD 1) ───────────────────────────────────────────────────────────────────────

describe('the shape is enforced in code (WO-0036 DoD 1)', () => {
  let tmpDir;
  let o;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-shape-'));
    fs.writeFileSync(path.join(tmpDir, 'players.json'), '{}');
    o = makeOrchestrator(tmpDir);
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('the limits are the numbers the chair said: one host, six companions, one game', () => {
    // Decision 0019: *"up to six players in a game run by one host who is allowed to run one
    // game."* Asserted as constants so a later edit to any of them fails here, by name, rather
    // than being discovered in a bill.
    expect(MAX_HOST_BOTS).toBe(1);
    expect(MAX_COMPANION_BOTS).toBe(6);
    expect(MAX_CONCURRENT_GAMES).toBe(1);
    expect(MAX_SESSIONS_PER_BOT).toBe(1);
  });

  it('six companions fit and the seventh is refused by name and number', async () => {
    await o.addBots({ role: 'companion', count: 6 });
    expect(o.config.bots.length).toBe(6);

    // The refusal has to be SPECIFIC. `"Failed to add bots: Not Found"` is what sent the chair
    // to the CEO twice, so the message names the count, the limit and the remedy.
    let err = null;
    try { await o.addBots({ role: 'companion', count: 1 }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(BotShapeError);
    expect(err.statusCode).toBe(400);
    expect(err.message).toMatch(/already 6 companion bot\(s\)/);
    expect(err.message).toMatch(/limit is 6/);
    expect(o.config.bots.length, 'a refused request must create nothing').toBe(6);
  });

  it('asking for more than will fit is an error, not a silent truncation', async () => {
    // Truncating would tell the chair they got six when they asked for ten, which is the class
    // of defect this work order exists to remove.
    await o.addBots({ role: 'companion', count: 4 });
    let err = null;
    try { await o.addBots({ role: 'companion', count: 5 }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(BotShapeError);
    expect(err.message).toMatch(/Asked for 5 companion bot\(s\) but only 2 more will fit/);
    expect(o.config.bots.length, 'nothing is created when the batch cannot fit').toBe(4);
  });

  it('a second host is refused, and the message says why one host', async () => {
    await o.addBots({ role: 'host', count: 1 });
    let err = null;
    try { await o.addBots({ role: 'host', count: 1 }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(BotShapeError);
    expect(err.message).toMatch(/one host runs one game/);
    expect(o.config.bots.filter(b => b.role === 'host').length).toBe(1);
  });

  it('count was UNCLAMPED before: a single request could create any number. Now it cannot', async () => {
    // `routes/bots.js` destructured `count` and nothing checked it
    // (`bot-orchestrator.js:648-649` clamped `turnDelayMs` and `maxSessionsPerBot` and nothing
    // else), so one POST could create a hundred accounts. Asserted with the number that used to
    // work.
    let err = null;
    try { await o.addBots({ role: 'companion', count: 100 }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(BotShapeError);
    expect(o.config.bots.length).toBe(0);
  });

  it('a non-numeric or negative count is refused rather than coerced', async () => {
    for (const bad of ['lots', null, -1, NaN, {}, [], 1.5e308]) {
      let err = null;
      try { await o.addBots({ role: 'companion', count: bad }); } catch (e) { err = e; }
      expect(err, `count=${String(bad)}`).toBeInstanceOf(BotShapeError);
    }
    // 1.5 floors to 1 rather than erroring — a fractional count is a UI artefact, not an attack
    await o.addBots({ role: 'companion', count: 1.5 });
    expect(o.config.bots.length).toBe(1);
  });

  it('maxSessionsPerBot can no longer be 5 — the clamp that multiplied the farm by five', async () => {
    await o.addBots({ role: 'companion', count: 1, maxSessionsPerBot: 5 });
    expect(o.config.bots[0].maxSessionsPerBot).toBe(1);
  });

  it('turnDelayMs is still clamped to the old band', async () => {
    await o.addBots({ role: 'companion', count: 1, turnDelayMs: 1 });
    expect(o.config.bots[0].turnDelayMs).toBe(30000);
    o.config.bots = [];
    await o.addBots({ role: 'companion', count: 1, turnDelayMs: 99999999 });
    expect(o.config.bots[0].turnDelayMs).toBe(3600000);
  });
});

// ── 2. companions are companions (DoD 5) ──────────────────────────────────────────────────────

describe('the player agents are companions, not hosts (WO-0036 DoD 5)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-role-'));
    fs.writeFileSync(path.join(tmpDir, 'players.json'), '{}');
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('"either" is refused at the HTTP boundary, and the message says what it would cost', async () => {
    // DoD 5: *"a test should hold it, so a later change to `role` handling cannot quietly turn
    // six companions into six hosts."* The batching property is the whole economic argument —
    // six companions in one hosted game is roughly one extra DM turn per round; six hosts is six
    // separate games, which is where the ~$45/hour estimate came from.
    const o = makeOrchestrator(tmpDir);
    // `undefined` is deliberately absent from this list: it triggers the default parameter,
    // which is `'companion'` — the role that cannot create a game. A caller who says nothing
    // gets the safe role, which is the right default and is asserted separately below.
    for (const role of ['either', '', null, 'HOST', 'Companion', 42, {}, 'host ', 'companion ']) {
      let err = null;
      try { await o.addBots({ role, count: 1 }); } catch (e) { err = e; }
      expect(err, `role=${String(role)}`).toBeInstanceOf(BotShapeError);
      expect(err.message).toMatch(/must be "host" or "companion"/);
      // the extra explanation appears only for the value it explains
      if (role === 'either') expect(err.message).toMatch(/six companions become six separate games/);
      else expect(err.message).not.toMatch(/either/);
    }
    expect(o.config.bots.length).toBe(0);

    // and the default, when nothing is said, is the safe role
    await o.addBots({ count: 1 });
    expect(o.config.bots[0].role).toBe('companion');
  });

  it('a legacy "either" record in bot-config.json becomes a COMPANION, never a host', async () => {
    // Migration, not breakage: a config file written before 2026-10-02 may say `'either'`, and
    // the safe direction is the one that cannot create a game.
    const srv = await startTestServer(tmpDir);
    try {
      const o = new BotOrchestrator(tmpDir, srv.port, {
        createBrain: () => ({ name: 'rules', brain: registry.createRuleBrain() }),
      });
      o._startBot({ email: 'bot_legacy@bot.local', name: 'Bot_Legacy' }, 'either');
      expect(o.bots.get('bot_legacy@bot.local').role).toBe('companion');
      await o.stop();
    } finally {
      await srv.close();
    }
  });

  it('a companion bot refuses to create a session even if something calls _createSession directly', async () => {
    // The guarantee has to survive the CALLER being changed, which is what DoD 5 asks for. So it
    // is checked at the callee: `_createSession` itself refuses a non-host, and the refusal is
    // reached before any API call, which is why a bot with a throwing api client is safe here.
    const o = makeOrchestrator(tmpDir);
    const calls = [];
    const bot = {
      email: 'c@bot.local', name: 'C', role: 'companion', sessions: new Map(),
      api: { getScenarios: () => { calls.push('api'); throw new Error('should never be reached'); } },
    };
    await o._createSession(bot, 'demo');
    expect(calls, 'a companion must not even reach the session API').toEqual([]);
    expect(bot.sessions.size).toBe(0);
  });

  it('only "host" reaches _createSession — asserted at the source, so the third branch cannot come back', () => {
    const raw = fs.readFileSync(path.join(SERVER_DIR, 'bot', 'bot-orchestrator.js'), 'utf-8');
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    // Both boundaries must be CODE. The first attempt ended this slice at
    // `'// -- Control methods --'`, a comment — which `readCode`-style stripping removes, so
    // `indexOf` returned -1, `slice(start, -1)` ran to the end of the file, and the region
    // "inside _findOrCreateSession" silently included `addBots`. The test went red for the
    // right reason by luck. Boundaries are asserted rather than assumed, below.
    const findStart = code.indexOf('async _findOrCreateSession(');
    const findEnd = code.indexOf('async addBots(');
    expect(findStart, 'could not find _findOrCreateSession').toBeGreaterThan(-1);
    expect(findEnd, 'could not find addBots').toBeGreaterThan(findStart);
    const find = code.slice(findStart, findEnd);
    expect(find.length, 'could not isolate _findOrCreateSession').toBeGreaterThan(100);
    // exactly one call site inside the role fan-out, and it is in the host branch
    expect((find.match(/_createSession\(/g) || []).length).toBe(1);
    expect(find).toMatch(/bot\.role === 'host'/);
    // and no 'either' anywhere in the fan-out: that is where a third role would have to appear
    // to turn a companion into a host, and it is the precise property DoD 5 asks for.
    expect(find).not.toMatch(/'either'/);

    // `'either'` DOES still appear once in the file's code, and the narrower assertion above is
    // why this test does not simply grep the whole file. The surviving use is a string
    // comparison inside `addBots`'s refusal message — it decides whether to explain the word to
    // a caller who used it, and it cannot route anything. Pinned by location so that a *second*
    // occurrence, anywhere else, fails here.
    const occurrences = [...code.matchAll(/'either'/g)].map(m => m.index);
    expect(occurrences.length, 'a new use of the third role appeared somewhere').toBe(1);
    const addBotsStart = code.indexOf('async addBots(');
    const addBotsEnd = code.indexOf('async removeBot(');
    expect(addBotsStart).toBeGreaterThan(-1);
    expect(occurrences[0], "the only 'either' must be inside addBots")
      .toBeGreaterThan(addBotsStart);
    expect(occurrences[0]).toBeLessThan(addBotsEnd);

    // `_startBot` normalises to two roles and there is no third case to fall into.
    const startBot = code.slice(code.indexOf('_startBot(account, role ='), code.indexOf('_wireSessionSlot('));
    expect(startBot).toMatch(/role === 'host' \? 'host' : 'companion'/);
    expect(startBot).not.toMatch(/'either'/);
  });

  it('the session label a bot creates is the chair\'s own data, not a sentence (qc-tester item 5)', async () => {
    // The behavioural half of the label fix; the source half is in `bot-brain-seam.test.js`.
    // Driven end to end through `_createSession` with a stubbed API, so what is asserted is the
    // string that reaches `setSessionLabel` and the slot — i.e. what the chair reads in the
    // session list and in the bot table.
    const o2 = makeOrchestrator(tmpDir);
    // No real socket: `_wireSessionSlot` would construct a BotWebSocketClient and connect it.
    // The stub installs an inert one with the two members `_createSession` goes on to use, so
    // nothing opens a port and nothing is emitted.
    const inertWs = () => ({ on() {}, connect() {}, close() {}, connected: false });
    o2._wireSessionSlot = (b, slot) => { slot.ws = inertWs(); };
    const labels = [];
    const bot = {
      email: 'h@bot.local', name: 'H', role: 'host', sessions: new Map(),
      api: {
        getScenarios: async () => [{ id: 'sc1', name: 'The Sunless Citadel' }],
        getCharacters: async () => [{ id: 'ch1', name: 'Thorin', status: 'alive' }],
        getNpcs: async () => [],
        createSession: async () => ({ id: 'sess-new' }),
        setSessionLabel: async (campaignId, id, label) => { labels.push(label); },
      },
    };
    await o2._createSession(bot, 'demo');

    expect(labels.length, 'a label should have been set').toBe(1);
    expect(labels[0]).toBe('Thorin \u2014 The Sunless Citadel');
    expect(labels[0], 'the banned phrase').not.toMatch(/Adventure with/);
    expect(bot.sessions.get('sess-new').sessionLabel).toBe('Thorin \u2014 The Sunless Citadel');

    // ...and with no scenario name there is no padding: the label degrades to the data that
    // exists rather than inventing words to fill the gap.
    const o3 = makeOrchestrator(tmpDir);
    o3._wireSessionSlot = (b, slot) => { slot.ws = inertWs(); };
    const labels3 = [];
    const bot3 = {
      ...bot,
      sessions: new Map(),
      api: { ...bot.api,
        getScenarios: async () => [{ id: 'sc1' }],
        setSessionLabel: async (c, i, l) => { labels3.push(l); },
      },
    };
    await o3._createSession(bot3, 'demo');
    expect(labels3).toEqual(['Thorin']);
  });

  it('one game across the whole farm: a second host session is refused', async () => {
    const o = makeOrchestrator(tmpDir);
    const other = {
      email: 'h1@bot.local', name: 'H1', role: 'host',
      sessions: new Map([['sess-existing', { sessionId: 'sess-existing' }]]),
    };
    o.bots.set(other.email, other);
    expect(o._countGames()).toBe(1);

    const calls = [];
    const second = {
      email: 'h2@bot.local', name: 'H2', role: 'host', sessions: new Map(),
      api: { getScenarios: () => { calls.push('api'); throw new Error('should never be reached'); } },
    };
    await o._createSession(second, 'demo');
    expect(calls).toEqual([]);
    expect(second.sessions.size).toBe(0);
  });

  it('a host that already holds its one session does not open a second', async () => {
    const o = makeOrchestrator(tmpDir);
    const calls = [];
    const bot = {
      email: 'h@bot.local', name: 'H', role: 'host',
      sessions: new Map([['sess-mine', { sessionId: 'sess-mine' }]]),
      api: { getScenarios: () => { calls.push('api'); throw new Error('should never be reached'); } },
    };
    o.bots.set(bot.email, bot);
    await o._createSession(bot, 'demo');
    expect(calls).toEqual([]);
    expect(bot.sessions.size).toBe(1);
  });
});

// ── 3. the route turns a refusal into a specific 400 (DoD 1) ──────────────────────────────────

describe('the HTTP layer reports what it refused (WO-0036 DoD 1)', () => {
  let tmpDir;
  let srv;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-route-'));
    // `requireAdmin` reads `players[email].role === 'admin'` from players.json
    // (`admin-auth.js:13`). It trusts the spoofable `X-Player-Email` header, which is an
    // accepted risk of this build (decision 0005) and not something these tests establish.
    fs.writeFileSync(path.join(tmpDir, 'players.json'), JSON.stringify({
      'admin@test.local': { email: 'admin@test.local', name: 'Admin', role: 'admin' },
    }, null, 2));
    // The real app, with the real gate open — this is the only way to exercise the real router.
    srv = await startTestServer(tmpDir, { env: { CLAUDEDM_BOTS: '1' } });

    // ── WHY THIS USED TO NEED A MONKEY-PATCH, AND NO LONGER DOES (S-3c) ─────────────────────
    //
    // Since WO-0036 J3 the registry's default brain is a MODEL brain, so a successful
    // `POST /add` here creates a bot that would, when its lookup timer fires 3-8 seconds later,
    // create a session and ask a model for a turn. Revision 1 handled that by replacing the
    // factory on the instance AFTER construction:
    //
    //     srv.botOrchestrator._createBrain = () => ({ name: 'rules', brain: registry.createRuleBrain() });
    //
    // It worked, and it was disclosed, and `sdet` was right that it is a weaker shape than
    // `createEngine`: it relies on every future test remembering to patch, and on nothing being
    // constructed in between. `createApp` now takes `opts.createBotOrchestrator`, so
    // `startTestServer` injects a rule-brain factory at BUILD time; `assertNoLiveBrains()` below
    // checks the seam was used rather than trusting that it was; and `close()` stops the
    // orchestrator, so no test has to remember.
    //
    // The suite-wide no-live-agent guard is still underneath all of it, as the backstop.
  });
  afterEach(async () => {
    if (srv) {
      // Both assertions BEFORE close(), since close() empties `bots`.
      srv.assertNoLiveBrains();
      await srv.close();
      expect(srv.botOrchestrator._running, 'close() must stop the orchestrator (S-4)').toBe(false);
      expect(srv.botOrchestrator._lookupTimers.size, 'close() must leave no lookup timer armed (S-4)').toBe(0);
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function post(body) {
    const res = await fetch(`${srv.baseUrl}/api/bots/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Player-Email': 'admin@test.local' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  it('GET /api/bots/status exists when the gate is open, and reports the shape and ceilings', async () => {
    const res = await fetch(`${srv.baseUrl}/api/bots/status`);
    expect(res.status).toBe(200);
    const status = await res.json();
    expect(status.shape).toMatchObject({ maxHostBots: 1, maxCompanionBots: 6, maxConcurrentGames: 1 });
    expect(status.maxBrainCalls).toBe(100);
    expect(status.sessionMaxDurationMs).toBe(3600000);
    expect(status.brainModel).toBe(registry.DEFAULT_BOT_MODEL);
  });

  it('the status endpoint 404s when the gate is CLOSED — the signal the panel reads (item 9 / J6)', async () => {
    // Item 9: *"the `GET /api/bots/status` 404 is the signal and needs no new endpoint"*. This is
    // the assertion the panel's absent-state branch depends on, so it is checked against the
    // real app rather than assumed. A separate server with no CLAUDEDM_BOTS at all.
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-nogate-'));
    fs.writeFileSync(path.join(bare, 'players.json'), '{}');
    const closed = await startTestServer(bare);
    try {
      const res = await fetch(`${closed.baseUrl}/api/bots/status`);
      expect(res.status, 'if this ever stops being 404 the panel loses its only signal').toBe(404);
      const add = await fetch(`${closed.baseUrl}/api/bots/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'companion', count: 1 }),
      });
      expect(add.status).toBe(404);
    } finally {
      // No orchestrator exists on this one — the gate was closed, which is the thing under test.
      expect(closed.botOrchestrator).toBe(null);
      await closed.close();
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });

  it('a shape refusal is a 400 carrying the sentence, not a 500 saying "Failed to add bots"', async () => {
    const r = await post({ role: 'either', count: 1 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/must be "host" or "companion"/);
    // and specifically NOT the old flattened message
    expect(r.body.error).not.toBe('Failed to add bots.');
  });

  it('an over-limit request is a 400 naming the limit', async () => {
    const r = await post({ role: 'companion', count: 99 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/only 6 more will fit|limit is 6/);
  });

  it('the harness seam is real: every bot the ROUTE created holds a brain from the test factory (S-3c)', async () => {
    // The injection point asserted from the other end. `POST /add` goes through the real route,
    // the real `addBots` and the real `_startBot`; if `createApp` ignored
    // `createBotOrchestrator`, or if `_startBot` stopped using `this._createBrain`, these bots
    // would hold brains from the registry — whose default spends money — and
    // `assertNoLiveBrains()` would throw.
    const res = await post({ role: 'companion', count: 2 });
    expect(res.status).toBe(200);
    expect(srv.botBrains.created.length, 'the factory must have been asked for a brain per bot').toBe(2);
    for (const bot of srv.botOrchestrator.bots.values()) {
      expect(bot.brainName).toBe('rules');
      expect(srv.botBrains.brains.has(bot.brain), 'this brain did not come from the harness').toBe(true);
    }
    srv.assertNoLiveBrains();   // explicit as well as in afterEach, so the assertion is visible

    // ...and the assertion is not vacuous: a bot holding a brain the harness never made fails it.
    const smuggled = [...srv.botOrchestrator.bots.values()][0];
    const realBrain = smuggled.brain;
    smuggled.brain = async () => 'I would have cost money.';
    expect(() => srv.assertNoLiveBrains()).toThrow(/constructed outside the test harness/);
    smuggled.brain = realBrain;
  });

  it('close() alone stops the orchestrator — no test has to remember (S-4)', async () => {
    // `sdet`'s HARNESS probe: `POST /add` then `srv.close()` and nothing else used to leave
    // `_running === true` and `_lookupTimers.size === 1`, i.e. a live bot with an armed 3-8s
    // lookup timer outliving the test. The route tests' own `afterEach` called `stop()`
    // explicitly, which is exactly the "one place remembers" shape S-4 is about.
    const res = await post({ role: 'companion', count: 1 });
    expect(res.status).toBe(200);
    const o = srv.botOrchestrator;
    expect(o._running).toBe(true);
    expect(o._lookupTimers.size).toBe(1);
    const handle = [...o._lookupTimers.values()][0];
    expect(handle._destroyed).toBe(false);

    await srv.close();

    expect(o._running, 'close() must stop the farm').toBe(false);
    expect(o._lookupTimers.size).toBe(0);
    expect(handle._destroyed, 'close() must leave no armed lookup timer').toBe(true);
    // afterEach calls close() again; it is idempotent, and the assertions there still hold.
  });

  it('the route still cannot select a brain, and that property is unchanged by WO-0036', async () => {
    // J3 made the spending brain the default; it did NOT make it selectable over HTTP. Both
    // halves still hold, and the second is the one that keeps the test double off the network.
    const r = await post({ role: 'companion', count: 1, brain: 'rules' });
    expect(r.status).toBe(200);
    const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'bot-config.json'), 'utf-8'));
    expect(cfg.bots.length).toBe(1);
    expect(cfg.bots[0].brain).toBeUndefined();
    expect(Object.keys(cfg.bots[0]).sort()).toEqual(['email', 'maxSessionsPerBot', 'role', 'turnDelayMs']);
  });
});

// ── 4. cleanup does not orphan sessions, and does not delete anyone else's (J5) ───────────────

// ── 4. S-4: stop() CANCELS THE LOOKUP TIMERS, AND THAT IS NOW ASSERTED ─────────────────────────
//
// `sdet` measured that the teardown **works** — three real-time probes, 10 seconds each:
// control (no stop) → the tick fired; treatment (stop) → 0 ticks, `_lookupTimers.size === 0`,
// `_running` false. And then measured that **nothing asserts it**: mutation **V48**, deleting
// `stop()`'s `clearTimeout` loop, killed **0 of 900** tests.
//
// That matters more than an ordinary coverage gap. The chain protecting this suite against a
// fourth accidental agent spawn was: one `afterEach` remembers to call `stop()` → `stop()`
// happens to contain a `clearTimeout` loop → that loop is checked by nothing. Delete the loop in
// a refactor and every route test that adds a bot leaves a live brain on a timer, green.
//
// These run in ~400ms rather than `sdet`'s 10 seconds, by scheduling a NON-INITIAL lookup for a
// host bot with a tiny `turnDelayMs`: the initial delay is a fixed 3-8s, but the ordinary cadence
// is `turnDelayMs * 2 + random * turnDelayMs`, so 50ms gives a 100-150ms timer. Real timers, real
// cancellation, no fake clock — a fake clock would not have caught V48 either, since the thing
// under test is whether a real handle was really cleared.
describe('stop() cancels the lookup timers — the no-live-agent teardown (WO-0036 S-4)', () => {
  let tmpDir;
  let o;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-teardown-'));
    fs.writeFileSync(path.join(tmpDir, 'players.json'), '{}');
    o = makeOrchestrator(tmpDir);
  });
  afterEach(async () => {
    await o.stop().catch(() => {});
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** A bot whose ordinary lookup cadence is ~100-150ms, with `_lookupTick` spied. */
  function fastBot(o) {
    const ticks = [];
    const bot = {
      email: 'h@bot.local', name: 'H', role: 'host', turnDelayMs: 50,
      maxSessionsPerBot: 1, sessions: new Map(), chatWs: { close() {}, connected: false },
      api: {},
    };
    o.bots.set(bot.email, bot);
    o._running = true;
    o._lookupTick = async (b) => { ticks.push(b.email); };
    return { bot, ticks };
  }

  const wait = ms => new Promise(r => setTimeout(r, ms));

  it('CONTROL: an unstopped lookup timer really does fire — the hazard this guards is real', async () => {
    const { bot, ticks } = fastBot(o);
    o._scheduleLookup(bot);
    expect(o._lookupTimers.size).toBe(1);
    await wait(400);
    // At least once — `_scheduleLookup` re-arms itself after each tick, so a 400ms window at a
    // ~100-150ms cadence sees two or three. The number is machine-dependent; "more than zero" is
    // the property, and if it were zero the two tests below would prove nothing.
    expect(ticks.length, 'if this is zero the two tests below prove nothing').toBeGreaterThan(0);
    expect([...new Set(ticks)]).toEqual(['h@bot.local']);
  });

  it('TREATMENT: after stop() the timer does NOT fire, and the handle was really cleared (kills V48)', async () => {
    const { bot, ticks } = fastBot(o);
    o._scheduleLookup(bot);
    const handle = o._lookupTimers.get(bot.email);
    expect(handle, 'no timer was registered — re-point this test').toBeTruthy();
    expect(handle._destroyed, 'a live timer must not already be destroyed').toBe(false);

    await o.stop();

    // Three independent assertions, because each fails for a different edit. `size === 0` alone
    // would survive V48, since V48 deletes the `clearTimeout` loop and leaves the `.clear()`.
    expect(o._running, 'stop() must mark the farm stopped').toBe(false);
    expect(o._lookupTimers.size, 'the registry must be emptied').toBe(0);
    // `_destroyed` is a Node internal, read deliberately: it is the only way to assert that
    // `clearTimeout` was actually called on THIS handle without waiting out the real delay.
    // Guarded by the control above, which proves the field is `false` on a live timer, so this
    // cannot pass by the field being absent or always-true.
    expect(handle._destroyed, 'stop() must clearTimeout the handle it registered — this is V48').toBe(true);

    await wait(400);
    expect(ticks, 'and behaviourally: no lookup ran after stop()').toEqual([]);
  });

  it('cleanup() cancels them too, by the same three measurements', async () => {
    const { bot, ticks } = fastBot(o);
    o._scheduleLookup(bot);
    const handle = o._lookupTimers.get(bot.email);
    await o.cleanup();
    expect(o._running).toBe(false);
    expect(o._lookupTimers.size).toBe(0);
    expect(handle._destroyed).toBe(true);
    await wait(400);
    expect(ticks).toEqual([]);
  });

  it('a stopped farm refuses to schedule a new lookup at all — the second line of defence', () => {
    const { bot } = fastBot(o);
    o._running = false;
    o._scheduleLookup(bot);
    expect(o._lookupTimers.size, 'no timer may be armed on a stopped farm').toBe(0);
  });
});

describe('bot session cleanup (WO-0036 J5)', () => {
  let tmpDir;
  let o;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-cleanup-'));
    fs.mkdirSync(path.join(tmpDir, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'sessions', 'noDelete.txt'), 'keep\n');
    writePlayers(tmpDir, []);
    o = makeOrchestrator(tmpDir);
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('deletes a session owned by a bot being removed, and reports it by name', () => {
    writeSession(tmpDir, 'sess-bot-1', { ownerEmail: 'bot_a@bot.local', settings: { visibility: 'public' } });
    const result = o._deleteBotSessions(['bot_a@bot.local']);
    expect(result.deleted).toEqual(['sess-bot-1']);
    expect(fs.existsSync(path.join(tmpDir, 'sessions', 'sess-bot-1'))).toBe(false);
  });

  it('KEEPS a session owned by a human, and says why', () => {
    writeSession(tmpDir, 'sess-human', { ownerEmail: 'tom@example.com' });
    const result = o._deleteBotSessions(['bot_a@bot.local']);
    expect(result.deleted).toEqual([]);
    expect(result.kept).toEqual([{ sessionId: 'sess-human', reason: 'owner is not a bot (tom@example.com)' }]);
    expect(fs.existsSync(path.join(tmpDir, 'sessions', 'sess-human'))).toBe(true);
  });

  it('KEEPS a bot-owned session that has a human companion in it — the one J5 cares most about', () => {
    // *"an orphan is a nuisance, deleting the chair's game is not."*
    writeSession(tmpDir, 'sess-mixed', {
      ownerEmail: 'bot_a@bot.local',
      companionPlayers: {
        'npc-1': { email: 'bot_b@bot.local', characterName: 'Bot Char' },
        'npc-2': { email: 'tom@example.com', characterName: 'Tom Char' },
      },
    });
    const result = o._deleteBotSessions(['bot_a@bot.local', 'bot_b@bot.local']);
    expect(result.deleted).toEqual([]);
    expect(result.kept).toEqual([{ sessionId: 'sess-mixed', reason: 'a human is in this session' }]);
    expect(fs.existsSync(path.join(tmpDir, 'sessions', 'sess-mixed'))).toBe(true);
  });

  it('a human in the `players` array counts too, not only in companionPlayers', () => {
    writeSession(tmpDir, 'sess-players', {
      ownerEmail: 'bot_a@bot.local',
      players: ['bot_b@bot.local', { email: 'tom@example.com' }],
    });
    const result = o._deleteBotSessions(['bot_a@bot.local']);
    expect(result.deleted).toEqual([]);
    expect(result.kept[0].reason).toBe('a human is in this session');
  });

  it('an all-bot session IS deleted — a bot companion is not a human', () => {
    writeSession(tmpDir, 'sess-allbot', {
      ownerEmail: 'bot_a@bot.local',
      companionPlayers: { 'npc-1': { email: 'bot_b@bot.local' } },
    });
    expect(o._deleteBotSessions(['bot_a@bot.local']).deleted).toEqual(['sess-allbot']);
  });

  it('KEEPS a session owned by a bot that is NOT being removed', () => {
    // So a second operator's bot session is not collateral damage of this cleanup.
    writeSession(tmpDir, 'sess-other', { ownerEmail: 'bot_other@bot.local' });
    const result = o._deleteBotSessions(['bot_a@bot.local']);
    expect(result.deleted).toEqual([]);
    expect(result.kept[0].reason).toMatch(/owned by bot_other@bot\.local, which is not being removed/);
    expect(fs.existsSync(path.join(tmpDir, 'sessions', 'sess-other'))).toBe(true);
  });

  it('FAILS CLOSED: an unreadable or ownerless record is kept, not guessed at', () => {
    const dir = path.join(tmpDir, 'sessions', 'sess-broken');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'session.json'), '{ this is not json');
    const empty = path.join(tmpDir, 'sessions', 'sess-nofile');
    fs.mkdirSync(empty, { recursive: true });
    writeSession(tmpDir, 'sess-noowner', { label: 'no owner at all' });

    const result = o._deleteBotSessions(['bot_a@bot.local']);
    expect(result.deleted).toEqual([]);
    const reasons = Object.fromEntries(result.kept.map(k => [k.sessionId, k.reason]));
    expect(reasons['sess-broken']).toBe('no readable session.json');
    expect(reasons['sess-nofile']).toBe('no readable session.json');
    expect(reasons['sess-noowner']).toBe('owner is not a bot (none)');
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.existsSync(empty)).toBe(true);
  });

  it('never touches a non-directory — the noDelete.txt marker survives', () => {
    writeSession(tmpDir, 'sess-bot-1', { ownerEmail: 'bot_a@bot.local' });
    o._deleteBotSessions(['bot_a@bot.local']);
    expect(fs.existsSync(path.join(tmpDir, 'sessions', 'noDelete.txt'))).toBe(true);
    expect(fs.readFileSync(path.join(tmpDir, 'sessions', 'noDelete.txt'), 'utf-8')).toBe('keep\n');
  });

  it('a non-bot email in the owners list authorises nothing', () => {
    // Defence against the caller: even if something passes a human address as "an account being
    // removed", it cannot authorise a deletion, because the owner must independently be
    // `@bot.local`.
    writeSession(tmpDir, 'sess-human', { ownerEmail: 'tom@example.com' });
    const result = o._deleteBotSessions(['tom@example.com']);
    expect(result.deleted).toEqual([]);
    expect(fs.existsSync(path.join(tmpDir, 'sessions', 'sess-human'))).toBe(true);
  });

  it('a crafted session id cannot escape data/sessions/ — asserted THROUGH the function (S-6)', () => {
    // ── REWRITTEN 2026-10-03. The old version was the suite's one self-declared non-test. ─────
    //
    // It computed the predicate **in the test** and never called `_deleteBotSessions`, so
    // `sdet`'s V18 — delete condition 5 from production entirely — killed **zero** tests. It
    // declared what it was doing in its own comment and carried a positive control, which is why
    // it was recorded as low rather than blocking; but the honest label was *"one self-declared
    // non-test"*, and the fix `sdet` named is to make it real rather than to delete it.
    //
    // There is genuinely no way to plant a `..` entry through `readdir` on a real filesystem, so
    // `readdirSync` is stubbed for exactly one call to hand back a crafted `Dirent`. That is the
    // only way to drive condition 5 through the real function, and it is worth the stub: the
    // alternative is an assertion that cannot fail when the code it names is deleted.
    const crafted = ['..', '../..', 'a/../../b'];
    const victim = path.join(tmpDir, 'sessions', 'sess-real');
    writeSession(tmpDir, 'sess-real', { ownerEmail: 'bot_a@bot.local' });

    for (const id of crafted) {
      const spy = vi.spyOn(fs, 'readdirSync').mockReturnValueOnce([
        { name: id, isDirectory: () => true, isSymbolicLink: () => false },
      ]);
      // `_readSessionRecord` must also answer for the crafted id, or condition 1 would reject it
      // first and condition 5 would never be reached — which would make this test vacuous in a
      // new way. It is pointed at the real record so the walk gets all the way to condition 5.
      const readSpy = vi.spyOn(o, '_readSessionRecord').mockReturnValue({ ownerEmail: 'bot_a@bot.local' });
      try {
        const result = o._deleteBotSessions(['bot_a@bot.local']);
        expect(result.deleted, `id=${id} must not be deleted`).toEqual([]);
        expect(result.kept, `id=${id}`).toEqual([
          { sessionId: id, reason: 'path did not resolve inside data/sessions/' },
        ]);
      } finally {
        spy.mockRestore();
        readSpy.mockRestore();
      }
    }
    // Nothing above `sessions/` was touched, and the real session is still there — the positive
    // control that the walk was running at all rather than erroring out early.
    expect(fs.existsSync(victim)).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'players.json'))).toBe(true);

    // And the control in the other direction: the SAME stub with a well-formed id DOES delete,
    // so the refusals above are condition 5 refusing and not the stub breaking the function.
    const spy = vi.spyOn(fs, 'readdirSync').mockReturnValueOnce([
      { name: 'sess-real', isDirectory: () => true, isSymbolicLink: () => false },
    ]);
    try {
      expect(o._deleteBotSessions(['bot_a@bot.local']).deleted).toEqual(['sess-real']);
    } finally {
      spy.mockRestore();
    }
    expect(fs.existsSync(victim)).toBe(false);
  });

  it('a symlink in sessions/ is refused by name, and what it points at survives (S-7)', () => {
    // `sdet` VP12: the symlink branch had no test. `security-reviewer` exercised it by hand and
    // found the behaviour sound; this is that measurement, kept.
    const precious = path.join(tmpDir, 'precious');
    fs.mkdirSync(precious, { recursive: true });
    fs.writeFileSync(path.join(precious, 'keep.json'), '{"keep":true}');
    writeSession(tmpDir, 'sess-bot-1', { ownerEmail: 'bot_a@bot.local' });
    fs.symlinkSync(precious, path.join(tmpDir, 'sessions', 'sess-link'));

    const result = o._deleteBotSessions(['bot_a@bot.local']);

    expect(result.kept).toContainEqual({ sessionId: 'sess-link', reason: 'symlink' });
    expect(result.deleted, 'the real bot session still goes').toEqual(['sess-bot-1']);
    expect(fs.existsSync(path.join(precious, 'keep.json')), 'rmSync must not follow the link out of the tree').toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'sessions', 'sess-link')), 'the link itself is left alone').toBe(true);
  });

  it('a missing sessions directory is not an error and deletes nothing', () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-nosess-'));
    try {
      const p = makeOrchestrator(bare);
      expect(p._deleteBotSessions(['bot_a@bot.local'])).toEqual({ deleted: [], kept: [] });
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });

  it('cleanup() deletes the orphans and returns both lists — the end-to-end shape of J5', async () => {
    // The real defect: cleanup() stopped timers, deleted accounts and never touched
    // data/sessions/, so every bot game left a directory owned by an account that no longer
    // existed, visible for ever in Show-all-players because bot sessions are created
    // `visibility: 'public'`. The chair has two such orphans.
    writePlayers(tmpDir, ['bot_a@bot.local', 'tom@example.com']);
    writeSession(tmpDir, 'sess-orphan', { ownerEmail: 'bot_a@bot.local', settings: { visibility: 'public' } });
    writeSession(tmpDir, 'sess-mine', { ownerEmail: 'tom@example.com' });

    const result = await o.cleanup();
    expect(result.deletedAccounts).toBe(1);
    expect(result.deletedSessions).toEqual(['sess-orphan']);
    expect(result.keptSessions.map(k => k.sessionId)).toEqual(['sess-mine']);
    expect(fs.existsSync(path.join(tmpDir, 'sessions', 'sess-orphan'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'sessions', 'sess-mine'))).toBe(true);
    // the human's account is untouched by a bot cleanup
    const players = JSON.parse(fs.readFileSync(path.join(tmpDir, 'players.json'), 'utf-8'));
    expect(Object.keys(players)).toEqual(['tom@example.com']);
  });

  it('cleanup() on a tree with no bots deletes nothing at all', async () => {
    writePlayers(tmpDir, ['tom@example.com']);
    writeSession(tmpDir, 'sess-mine', { ownerEmail: 'tom@example.com' });
    const result = await o.cleanup();
    expect(result.deletedAccounts).toBe(0);
    expect(result.deletedSessions).toEqual([]);
    expect(fs.existsSync(path.join(tmpDir, 'sessions', 'sess-mine'))).toBe(true);
  });

  // ── S-1 / SR-36-2: THE CHAIR'S ACTUAL CASE, WHICH NO TEST REPRESENTED ─────────────────────
  //
  // Revision 1 of the deliverable told the chair: *"They satisfy conditions 1-5 and will be
  // deleted the first time the chair uses `Cleanup All`. … that is a deletion you are authorising
  // by clicking, and this paragraph is the notice."* **It was false.** `cleanup()` authorises on
  // `listBotAccounts`, which filters on `isBot`; an orphan's owning account is gone; the
  // authorising set is empty; condition 3 keeps the directory.
  //
  // The behaviour is CORRECT and is not changed here. Condition 3 is what stops a second
  // operator's bot sessions becoming collateral, and both reviewers said in terms: do not widen
  // it. What is added is the test that makes the real case representable, so the next person
  // cannot write that notice again.

  it('an ACTUALLY orphaned session is the case the chair has, and cleanup() does NOT touch it (S-1)', async () => {
    // The chair's real state, read from `data/players.json` by two reviewers: three accounts, all
    // human, `isBot` absent on all three; two session directories owned by
    // `bot_jasper-silverleaf@bot.local`, an account that no longer exists.
    writePlayers(tmpDir, ['tom@example.com', 'pandawrite@example.com', 'tomcarbon@example.com']);
    writeSession(tmpDir, '52ae868a-orphan', { ownerEmail: 'bot_jasper-silverleaf@bot.local', settings: { visibility: 'public', allowBots: true } });
    writeSession(tmpDir, '5888545b-orphan', { ownerEmail: 'bot_jasper-silverleaf@bot.local', settings: { visibility: 'public', allowBots: true } });

    const result = await o.cleanup();

    expect(result.deletedAccounts, 'there is no bot account to delete').toBe(0);
    expect(result.deletedSessions, 'an orphan is OUT OF REACH of cleanup — this is the fix to the notice, not to the code').toEqual([]);
    expect(result.keptSessions.map(k => k.sessionId).sort()).toEqual(['52ae868a-orphan', '5888545b-orphan']);
    // And the reason now SAYS orphan, instead of "a bot that is not being removed" — which was
    // literally true and read, to the person who clicked, as though an account existed.
    for (const k of result.keptSessions) {
      expect(k.reason).toMatch(/^ORPHAN: owned by bot_jasper-silverleaf@bot\.local, which has no account/);
    }
    expect(fs.existsSync(path.join(tmpDir, 'sessions', '52ae868a-orphan'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'sessions', '5888545b-orphan'))).toBe(true);
    // the humans' accounts are untouched
    expect(Object.keys(JSON.parse(fs.readFileSync(path.join(tmpDir, 'players.json'), 'utf-8'))).length).toBe(3);
  });

  it('the fixture can now write the disagreement production cares about: a @bot.local address with no isBot flag (S-1)', async () => {
    // This is the half the old fixture made impossible, and it is the mechanism of the false
    // notice: `listBotAccounts` reads the FLAG, so an address that looks like a bot but is not
    // flagged as one authorises nothing — and an orphan is the limit case of that, where there
    // is no record at all.
    writePlayers(tmpDir, [{ email: 'bot_ghost@bot.local', isBot: false }, 'tom@example.com']);
    writeSession(tmpDir, 'sess-ghost', { ownerEmail: 'bot_ghost@bot.local' });

    const { readPlayers, listBotAccounts } = require('../bot/bot-accounts');
    expect(Object.keys(readPlayers(tmpDir)).sort()).toEqual(['bot_ghost@bot.local', 'tom@example.com']);
    expect(listBotAccounts(tmpDir), 'the FLAG is what production reads, not the address').toEqual([]);

    const result = await o.cleanup();
    expect(result.deletedSessions).toEqual([]);
    expect(result.keptSessions[0].reason, 'the account EXISTS, so this is not an orphan — the two cases must read differently')
      .toBe('owned by bot_ghost@bot.local, which is not being removed');
    expect(fs.existsSync(path.join(tmpDir, 'sessions', 'sess-ghost'))).toBe(true);
  });

  it('the converse: a bot account IS authorised by its flag, so the orphan test above is not passing vacuously (S-1)', async () => {
    // The control. Same two directories, same predicate, one difference — the owning account
    // exists and is flagged `isBot` — and both are deleted. Without this, "nothing was deleted"
    // would be consistent with a broken harness.
    writePlayers(tmpDir, ['bot_jasper-silverleaf@bot.local', 'tom@example.com']);
    writeSession(tmpDir, '52ae868a-orphan', { ownerEmail: 'bot_jasper-silverleaf@bot.local' });
    writeSession(tmpDir, '5888545b-orphan', { ownerEmail: 'bot_jasper-silverleaf@bot.local' });

    const result = await o.cleanup();
    expect(result.deletedAccounts).toBe(1);
    expect(result.deletedSessions.sort()).toEqual(['52ae868a-orphan', '5888545b-orphan']);
  });

  it('SR-36-5: a bot-owned session with a human `playerEmail` is KEPT — the predicate is as wide as the app\'s owner resolver', () => {
    // `routes/sessions.js:26-30` resolves ownership as
    // `session.ownerEmail || session.playerEmail || players[].email`. `_sessionHasHuman` omitted
    // `playerEmail`, and both reviewers measured this exact record DELETED.
    writeSession(tmpDir, 'sess-divergent', {
      ownerEmail: 'bot_a@bot.local',
      playerEmail: 'tom@example.com',
      players: [],
      companionPlayers: {},
    });
    const result = o._deleteBotSessions(['bot_a@bot.local']);
    expect(result.deleted).toEqual([]);
    expect(result.kept).toEqual([{ sessionId: 'sess-divergent', reason: 'a human is in this session' }]);
    expect(fs.existsSync(path.join(tmpDir, 'sessions', 'sess-divergent'))).toBe(true);
    // the predicate itself, directly, so a later caller change cannot hide it
    expect(o._sessionHasHuman('sess-divergent')).toBe(true);
    // and a BOT playerEmail still authorises deletion, so the line above is not simply "keep
    // everything with a playerEmail"
    writeSession(tmpDir, 'sess-allbot', { ownerEmail: 'bot_a@bot.local', playerEmail: 'bot_a@bot.local' });
    expect(o._deleteBotSessions(['bot_a@bot.local']).deleted).toEqual(['sess-allbot']);
  });

  // ── S-3: `removeBot` — the × button, "the path the chair will actually use" ────────────────
  //
  // 13 deletion tests and **not one of them called `removeBot`**: eleven called
  // `_deleteBotSessions` directly and two called `cleanup()`. `sdet`'s VP13 — remove the
  // `_deleteBotSessions` call from `removeBot` — killed **0 of 114**. And `qc-tester` found the
  // second half: `removeBot` filtered its kept list to one reason, so delete failures and
  // unreadable records were silent and the panel printed *"No session directories were owned by
  // that bot."* about a directory still on disk.

  it('removeBot deletes the sessions that bot owned, and the × button path is asserted (S-3)', async () => {
    writePlayers(tmpDir, ['bot_x@bot.local', 'tom@example.com']);
    writeSession(tmpDir, 'sess-x-owned', { ownerEmail: 'bot_x@bot.local' });
    writeSession(tmpDir, 'sess-mine', { ownerEmail: 'tom@example.com' });
    // `removeBot` requires a live bot in `this.bots`, which is why no existing test reached it.
    // `makeOrchestrator` already stubs `_startBot`, so the bot is placed directly — with the
    // shape `removeBot` actually touches.
    o.bots.set('bot_x@bot.local', {
      email: 'bot_x@bot.local', name: 'X', role: 'companion',
      sessions: new Map(), chatWs: { close() {} },
    });

    const result = await o.removeBot('bot_x@bot.local');

    expect(result.removed).toBe(true);
    expect(result.deletedSessions, 'the × button must delete the bot\'s own session directory').toEqual(['sess-x-owned']);
    expect(fs.existsSync(path.join(tmpDir, 'sessions', 'sess-x-owned'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'sessions', 'sess-mine')), 'and nothing else').toBe(true);
    expect(o.bots.has('bot_x@bot.local')).toBe(false);
  });

  it('removeBot returns BOTH halves unfiltered — a session kept for ANY reason is reported (S-3)', async () => {
    // The false sentence `qc-tester` reproduced. One session owned by the bot, unreadable, so it
    // is kept by condition 1. Revision 1 returned `keptSessions: []` and the panel said "No
    // session directories were owned by that bot."
    writePlayers(tmpDir, ['bot_x@bot.local']);
    const dir = path.join(tmpDir, 'sessions', 'sess-broken');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'session.json'), '{ this is not json');
    o.bots.set('bot_x@bot.local', {
      email: 'bot_x@bot.local', name: 'X', role: 'companion',
      sessions: new Map(), chatWs: { close() {} },
    });

    const result = await o.removeBot('bot_x@bot.local');

    expect(result.deletedSessions).toEqual([]);
    expect(result.keptSessions, 'the unreadable session must be NAMED, not dropped')
      .toEqual([{ sessionId: 'sess-broken', reason: 'no readable session.json' }]);
    expect(result.keptHumanSessions, 'and the human subset stays its own field').toEqual([]);
    expect(fs.existsSync(dir), 'it really is still on disk — which is why silence was a false statement').toBe(true);
  });

  it('removeBot still refuses to delete a session with a human in it, and says which (S-3)', async () => {
    writePlayers(tmpDir, ['bot_x@bot.local']);
    writeSession(tmpDir, 'sess-shared', {
      ownerEmail: 'bot_x@bot.local',
      companionPlayers: { npc1: { email: 'tom@example.com' } },
    });
    o.bots.set('bot_x@bot.local', {
      email: 'bot_x@bot.local', name: 'X', role: 'companion',
      sessions: new Map(), chatWs: { close() {} },
    });
    const result = await o.removeBot('bot_x@bot.local');
    expect(result.deletedSessions).toEqual([]);
    expect(result.keptHumanSessions).toEqual([{ sessionId: 'sess-shared', reason: 'a human is in this session' }]);
    expect(fs.existsSync(path.join(tmpDir, 'sessions', 'sess-shared'))).toBe(true);
  });

  it('_readSessionRecord uses the REAL layout — the path the old predicate got wrong', () => {
    // `_hasHumanCompanions` built `data/players/<slug>/<campaign>/sessions/<id>.json`, a layout
    // this application does not use: `player-data.js:23-32` says sessions live at
    // `data/sessions/<id>/`. `fs.existsSync` therefore returned false every time, so the
    // human-companion protection in `_closeSessionSlot` had never once fired. Found while
    // implementing J5 and fixed, because J5's promise cannot rest on a structurally false
    // predicate.
    writeSession(tmpDir, 'sess-real', { ownerEmail: 'bot_a@bot.local', companionPlayers: { n: { email: 'tom@example.com' } } });
    expect(o._readSessionRecord('sess-real').ownerEmail).toBe('bot_a@bot.local');
    expect(o._readSessionRecord('sess-missing')).toBe(null);
    // and the protection it feeds now actually sees a human
    expect(o._hasHumanCompanions({ email: 'bot_a@bot.local' }, { sessionId: 'sess-real', campaignId: 'demo' })).toBe(true);
  });
});
