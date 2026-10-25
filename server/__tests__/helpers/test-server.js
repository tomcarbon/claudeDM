/**
 * Boot the real server — the real Express app and the real WebSocket handler — against a
 * temporary data directory, on an ephemeral port.
 *
 * Why this exists: `ws-turns.test.js` builds a bare `express()` and attaches only the WebSocket
 * handler, so no test has ever exercised an HTTP route and a WebSocket against the same data
 * directory at the same time. Several real behaviours only appear at that seam — a claim
 * released by `POST /api/sessions/:id/unjoin` changing what `checkAutoFire` waits for is exactly
 * one of them, and it is a defect that stalls a live human table.
 *
 * Two things are guaranteed here and are the point of the helper:
 *
 *   1. **No live agent.** `attachWebSocket` gets a `createEngine` factory producing
 *      `FakeDmEngine`, and a fake `summarize`. A real `DmEngine` calls the Claude Agent SDK with
 *      `cwd` = the project root and `Edit` auto-allowed, so an un-injected engine would be a
 *      billable agent with write access to the chair's live `data/`. `assertNoLiveEngines()`
 *      turns "we injected" into a checked assertion at teardown, and the suite-wide guard in
 *      `no-live-agent.js` is the backstop under both.
 *   2. **No live data directory.** The caller owns `dataDir` and it is expected to be a
 *      `mkdtemp`. Nothing here reaches for `../../data`.
 *   3. **No live bot brain, and no bot left running at teardown** (WO-0036 revision 2, S-3/S-4).
 *      Since WO-0036 J3 the registry's DEFAULT brain is a model brain that spends money, so an
 *      un-injected orchestrator is the same hazard as an un-injected DM engine, one layer across.
 *      `createApp` is given `createBotOrchestrator`, so every brain in a test comes from the rule
 *      factory here; `assertNoLiveBrains()` turns that from an intention into a checked assertion
 *      the same way `assertNoLiveEngines()` does; and **`close()` now stops the orchestrator**,
 *      because `server.close()` never did and a bot added by a route test otherwise outlives the
 *      test with a 3-8 second lookup timer armed. `sdet` measured that leak directly: `POST /add`
 *      then `srv.close()` alone left `_running === true` and `_lookupTimers.size === 1`.
 *
 * The port is 0 (ephemeral) so parallel test files cannot collide, and `port` is reported back
 * because the bot clients build their own URLs from it.
 */

const http = require('http');
const { createApp } = require('../../index');
const { attachWebSocket } = require('../../ws-handler');
const { createFakeEngineFactory, createFakeSummarize } = require('./fake-dm-engine');
const { BotOrchestrator } = require('../../bot/bot-orchestrator');
const { createRuleBrain } = require('../../bot/bot-brain-registry');

/**
 * @param {string} dataDir              temp directory to run against
 * @param {object} [opts]
 * @param {object} [opts.engineOptions] passed to `createFakeEngineFactory` (script, etc.)
 * @param {object} [opts.env]           environment object the app is built for. Defaults to
 *                                      `{}` — an empty environment, not the test runner's — so
 *                                      that a test which wants an opt-in subsystem such as the
 *                                      bot farm has to ask for it explicitly, and a test that
 *                                      does not ask cannot pick one up from the outside world.
 * @returns {Promise<object>} handle with `{ app, server, wss, port, baseUrl, wsUrl,
 *                            engineFactory, summarize, assertNoLiveEngines, close }`
 */
async function startTestServer(dataDir, opts = {}) {
  const { engineOptions = {}, env = {} } = opts;

  // The bot-brain seam. Every brain handed to the orchestrator is a rule brain built here, and
  // each one is remembered by identity so `assertNoLiveBrains()` can prove the orchestrator used
  // THIS factory rather than the registry. Identity, not name: a check on `brainName` would pass
  // against a model brain that reported itself as `rules`, and the failure being guarded is
  // exactly "the injection point stopped being used".
  const botBrains = { created: [], brains: new Set() };
  const createBotBrain = (requested, brainOpts = {}) => {
    const brain = createRuleBrain();
    botBrains.created.push({ requested, model: brainOpts.model || null, brain });
    botBrains.brains.add(brain);
    return { name: 'rules', brain };
  };

  const app = createApp(dataDir, {
    port: 0,
    env,
    createBotOrchestrator: (dd, port) => new BotOrchestrator(dd, port, { createBrain: createBotBrain }),
  });
  const server = http.createServer(app);

  const engineFactory = createFakeEngineFactory(engineOptions);
  const summarize = createFakeSummarize();
  const wss = attachWebSocket(server, dataDir, {
    createEngine: engineFactory,
    summarize,
    appendChatMessage: app.locals.appendChatMessage,
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;

  return {
    app,
    server,
    wss,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    engineFactory,
    summarize,
    botOrchestrator: app.locals.botOrchestrator,
    botBrains,

    /** Every engine the handler used came from the fake factory. Call in teardown. */
    assertNoLiveEngines() {
      for (const engine of engineFactory.created) {
        if (engine.constructor.name !== 'FakeDmEngine') {
          throw new Error(
            `A live DM engine was constructed during this test (${engine.constructor.name}). `
            + 'attachWebSocket must be given createEngine — see helpers/fake-dm-engine.js.'
          );
        }
      }
    },

    /**
     * Every brain any bot holds came from this helper's rule factory. Call in teardown.
     *
     * S-4. `sdet` mutation V48 — delete `stop()`'s `clearTimeout` loop — killed **0 of 900**
     * tests, so the only thing standing between the suite and a fourth accidental agent spawn
     * was one `afterEach` calling a loop nothing checked. This is the checked half: it fails if
     * the orchestrator built a brain the harness did not hand it, which is what a removed or
     * bypassed injection point looks like from here.
     */
    assertNoLiveBrains() {
      const o = app.locals.botOrchestrator;
      if (!o) return;
      for (const bot of o.bots.values()) {
        if (!botBrains.brains.has(bot.brain)) {
          throw new Error(
            `A bot brain was constructed outside the test harness (bot ${bot.email}, `
            + `reported name "${bot.brainName}"). Since WO-0036 J3 the registry's default is a `
            + 'MODEL brain that spends money — createApp must be given createBotOrchestrator. '
            + 'See helpers/test-server.js.'
          );
        }
      }
    },

    async close() {
      // S-4. Stop the orchestrator BEFORE the sockets go. `server.close()` terminates WS
      // clients and waits for the HTTP server; it has never touched `app.locals.botOrchestrator`,
      // so a test that called `POST /api/bots/add` left `_running === true` and a live lookup
      // timer behind — measured. Doing it here means no future test has to remember.
      const o = app.locals.botOrchestrator;
      if (o && typeof o.stop === 'function') {
        try {
          await o.stop();
        } catch (err) {
          // A teardown that throws hides the test's own failure. Say so and carry on.
          console.error('[test-server] botOrchestrator.stop() threw during close():', err.message);
        }
      }
      for (const client of wss.clients) client.terminate();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * Small JSON HTTP client for talking to the app under test the way a bot's `BotApiClient` does:
 * identity is an `X-Player-Email` header and nothing else (SECURITY.md — any caller may claim
 * any identity; that is an accepted risk of this build, not something this helper introduces).
 */
async function apiFetch(baseUrl, apiPath, { method = 'GET', email, campaignId, body } = {}) {
  const res = await fetch(`${baseUrl}${apiPath}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(email ? { 'X-Player-Email': email } : {}),
      ...(campaignId ? { 'X-Campaign-Id': campaignId } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON — the caller may care */ }
  return { status: res.status, json, text, contentType: res.headers.get('content-type') || '' };
}

module.exports = { startTestServer, apiFetch };
