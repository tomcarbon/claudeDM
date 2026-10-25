const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const charactersRouter = require('./routes/characters');
const npcsRouter = require('./routes/npcs');
const rulesRouter = require('./routes/rules');
const scenariosRouter = require('./routes/scenarios');
const campaignsRouter = require('./routes/campaigns');
const dmSettingsRouter = require('./routes/dm-settings');
const sessionsRouter = require('./routes/sessions');
const settingsRouter = require('./routes/settings');
const playersRouter = require('./routes/players');
const createChatRouter = require('./routes/chat');
const { campaignContext } = require('./campaign-context');
const { attachWebSocket } = require('./ws-handler');

const PORT = process.env.PORT || 3001;
const DATA_DIR = path.join(__dirname, '..', 'data');

// ── Who can reach this server, and from which browser origin (WO-0034) ───────────────────────
//
// Two separate questions, two defaults, both CLOSED, both widened by one documented variable
// each. Read this before changing either default.
//
//   CLAUDEDM_HOST             which interface the HTTP+WebSocket server binds to.
//                             Default `127.0.0.1` — this machine only.
//   CLAUDEDM_ALLOWED_ORIGINS  comma-separated list of exact browser origins the API answers.
//                             Default: the loopback origins the client is served from. `*`
//                             restores the old allow-any behaviour, explicitly.
//
// WHY. Identity in this app is a self-asserted `X-Player-Email` header with no token
// (`player-auth.js`, `admin-auth.js`) — an accepted risk, decision `0005`. Until 2026-09-22 no
// account had `role: 'admin'`, so `requireAdmin` returned 403 to everyone including a spoofer.
// An admin account now exists. Before this change the server listened on `*:3001` and answered
// `Access-Control-Allow-Origin: *` with `x-player-email` in the allowed-headers list, which made
// two different things true at once: anything on the LAN could drive the API as any account, and
// any web page the chair's browser happened to load could do the same from inside their machine.
//
// WHAT EACH DEFAULT ACTUALLY STOPS — narrower than it sounds, so do not over-trust either:
//
//   the loopback bind  stops other machines. It does NOT stop a page in a browser running on
//                      this machine: for that browser, `localhost` is reachable.
//   the origin policy  stops that page, for the HTTP API, because every identified request
//                      carries the custom header `X-Player-Email`, and a custom header forces a
//                      CORS preflight that this policy refuses — so the real request is never
//                      sent. It is a browser-side control only. It stops no script, no curl and
//                      no other program on this machine, and it is not authentication.
//
// KNOWN GAP, not fixed here and not in WO-0034's scope: the WebSocket at `/ws` performs no
// origin check (`ws-handler.js:382`, `new WebSocketServer({ server, path: '/ws' })` — the `ws`
// library does not check `Origin` by itself). A page on this machine can still open
// `ws://localhost:3001/ws`. The loopback bind applies to it, the origin policy does not.
const DEFAULT_HOST = '127.0.0.1';

// The Vite dev server's port (`client/vite.config.js`, vite's default). In dev the client page
// is on :5173 and the API on :3001, so every API call is cross-origin and CORS is load-bearing
// for the app to work at all — this is not a policy that can simply be "off".
const CLIENT_DEV_PORT = 5173;

/**
 * The interface to bind. Loopback unless the environment says otherwise on purpose.
 *
 * An empty or whitespace-only `CLAUDEDM_HOST` is treated as unset: `CLAUDEDM_HOST= npm run dev`
 * must not be a way to bind everything, and an absent variable must never mean "wider".
 *
 * @param {object} [env] environment object, normally `process.env`
 * @returns {string} host for `server.listen`
 */
function resolveHost(env = process.env) {
  const raw = String((env || {}).CLAUDEDM_HOST || '').trim();
  return raw === '' ? DEFAULT_HOST : raw;
}

/**
 * The origins allowed when nothing is configured: loopback only, on the client's dev port and on
 * this server's own port (the production build is served by this process, so the page origin is
 * then `http://localhost:<PORT>` — and a same-origin `POST` still carries an `Origin` header).
 *
 * @returns {string[]} exact origin strings
 */
function defaultAllowedOrigins({ port = PORT, clientPort = CLIENT_DEV_PORT } = {}) {
  const hosts = ['localhost', '127.0.0.1', '[::1]'];
  const ports = [];
  for (const p of [clientPort, Number(port)]) {
    if (Number.isFinite(p) && p > 0 && !ports.includes(p)) ports.push(p);
  }
  const origins = [];
  for (const p of ports) for (const h of hosts) origins.push(`http://${h}:${p}`);
  return origins;
}

/**
 * Resolve the origin policy from the environment.
 *
 * `CLAUDEDM_ALLOWED_ORIGINS` REPLACES the default list rather than adding to it, so that what is
 * allowed is exactly what the deployment wrote down. Playing over a LAN therefore needs the
 * chair's own origin listed — see README.md, "Playing with someone else on your network".
 *
 * @returns {{any: boolean, origins: string[], source: string}}
 */
function resolveAllowedOrigins(env = process.env, { port = PORT } = {}) {
  const raw = String((env || {}).CLAUDEDM_ALLOWED_ORIGINS || '').trim();
  if (raw === '') {
    return { any: false, origins: defaultAllowedOrigins({ port }), source: 'default' };
  }
  const listed = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (listed.includes('*')) return { any: true, origins: [], source: 'env:any' };
  return { any: false, origins: listed, source: 'env' };
}

/**
 * CORS middleware with a visible refusal.
 *
 * The `cors` package alone answers a rejected preflight with `204` and simply omits
 * `Access-Control-Allow-Origin` (`node_modules/cors/lib/index.js`, `configureOrigin`), which in a
 * server log looks exactly like success. A refusal here is a `403` with the variable name in the
 * body and one `warn` line naming the origin, so it fails where somebody can see it.
 *
 * Requests with NO `Origin` header are passed through untouched and get no CORS headers: that is
 * every non-browser caller — the bot clients (`bot/bot-api-client.js` talks to
 * `http://localhost:<port>/api`), curl, and the test suite. CORS has nothing to say about them,
 * and pretending otherwise would break the game without protecting anything.
 */
function createCorsMiddleware(env = process.env, { port = PORT, log = console } = {}) {
  const policy = resolveAllowedOrigins(env, { port });
  const inner = cors(policy.any ? { origin: '*' } : { origin: policy.origins });

  const middleware = function claudedmCors(req, res, next) {
    const origin = req.headers.origin;
    if (origin && !policy.any && !policy.origins.includes(origin)) {
      log.warn(
        `[CORS] refused origin ${origin} on ${req.method} ${req.originalUrl || req.url} — `
        + `allowed: ${policy.origins.join(', ')} `
        + '(widen deliberately with CLAUDEDM_ALLOWED_ORIGINS)',
      );
      res.status(403).json({
        error: 'Origin not allowed.',
        origin,
        allowedOrigins: policy.origins,
        hint: 'Set CLAUDEDM_ALLOWED_ORIGINS to a comma-separated list of exact origins '
          + '(or * for any) and restart the server.',
      });
      return;
    }
    inner(req, res, next);
  };
  middleware.policy = policy;
  return middleware;
}

/**
 * True when the bot subsystem may be mounted at all. **Opt-in, and fails closed.**
 *
 * It used to be gated on `data/bot-config.json` having `enabled: true` — a file that does not
 * exist in a fresh checkout, and which only the admin UI writes. That UI is served by the very
 * router the flag gated, so the flag could never be turned on from inside the product: to get
 * bots you first had to hand-write the file that says you have bots. Worse, it made "off in
 * production" a property of a mutable JSON file inside a data directory rather than of the
 * deployment.
 *
 * The first replacement was `NODE_ENV !== 'production'`, and the security review (SR-1) was
 * right to call that a regression rather than a fix. `NODE_ENV` is set nowhere in this project —
 * not in `package.json`'s `server` script, not in any `.env`, and `scripts/upgrade.sh` restarts
 * a unit file that does not exist here — so the gate would have read `undefined !== 'production'`
 * and mounted the whole bot admin router on the real server, where before this change it was
 * structurally absent because no `bot-config.json` had ever existed. An absent variable must not
 * mean yes.
 *
 * So the deployment must say yes on purpose: `CLAUDEDM_BOTS=1`, and never in production. Nothing
 * is mounted otherwise. The chicken-and-egg is still dead — the flag lives in the environment,
 * not in a file that only the gated UI can write, so one variable is enough to get the admin UI
 * that writes the config.
 *
 * The config file still decides whether any bots actually *run* (`BotOrchestrator.start()`
 * returns early unless `config.enabled`), which is the question it is good at.
 *
 * @param {object} env an environment object, normally `process.env`
 */
function botsAllowed(env = process.env) {
  return (env || {}).CLAUDEDM_BOTS === '1' && (env || {}).NODE_ENV !== 'production';
}

/**
 * Build the Express app against a data directory.
 *
 * Extracted from the bootstrap so a test can build the same app the server runs, pointed at a
 * temp directory. Every router already took `dataDir`; only this function assumed one.
 *
 * Side-effect-free with respect to the process: it creates no sockets, no timers and no
 * subprocesses. `app.locals` carries the handles the bootstrap needs back out:
 *   - `botOrchestrator` — the orchestrator, or `null` when the environment forbids bots
 *
 * `opts.createBotOrchestrator(dataDir, port)` is the build-time seam for the bot farm, matching
 * `createEngine` on `attachWebSocket`. Tests pass one so that no brain is ever constructed from
 * the registry — whose default spends money — and so that `assertNoLiveBrains()` in
 * `__tests__/helpers/test-server.js` can check the seam was actually used.
 *   - `appendChatMessage` — produced by the chat router, needed by `attachWebSocket`
 *   - `corsPolicy` — the resolved origin policy, so the bootstrap can print it and a test can
 *     assert it without re-deriving it
 *
 * `env` is the whole environment object rather than a single value, so that the two questions
 * that read it — may bots mount, and is this a production build — are answered from one source.
 */
function createApp(dataDir = DATA_DIR, { port = PORT, env = process.env, log = console, createBotOrchestrator = null } = {}) {
  const app = express();

  const corsMiddleware = createCorsMiddleware(env, { port, log });
  app.locals.corsPolicy = corsMiddleware.policy;
  app.use(corsMiddleware);
  app.use(express.json({ limit: '10mb' }));
  app.use(campaignContext());

  app.use('/api/characters', charactersRouter(dataDir));
  app.use('/api/npcs', npcsRouter(dataDir));
  app.use('/api/rules', rulesRouter(dataDir));
  app.use('/api/scenarios', scenariosRouter(dataDir));
  app.use('/api/campaigns', campaignsRouter(dataDir));
  app.use('/api/dm-settings', dmSettingsRouter(dataDir));
  app.use('/api/sessions', sessionsRouter(dataDir));
  app.use('/api/settings', settingsRouter(dataDir));
  app.use('/api/players', playersRouter(dataDir));

  const { router: chatRouter, appendMessage: appendChatMessage } = createChatRouter(dataDir);
  app.use('/api/chat', chatRouter);
  app.locals.appendChatMessage = appendChatMessage;

  // Bot farm (self-play test infrastructure). Never mounted in production — a 2-player
  // deployment neither pays for these ~1,700 lines nor exposes their admin surface.
  let botOrchestrator = null;
  if (botsAllowed(env)) {
    try {
      const botsRouter = require('./routes/bots');
      const { BotOrchestrator } = require('./bot/bot-orchestrator');
      // WO-0036 revision 2, S-3c. `createBotOrchestrator` is an injection point of the same
      // shape as `createEngine` on `attachWebSocket`, and it exists for the same reason: the
      // default construction here produces an orchestrator whose brains come from the registry,
      // whose default is **a model brain that spends money** (J3). Revision 1's route tests
      // monkey-patched `srv.botOrchestrator._createBrain` *after* construction, which works and
      // was disclosed honestly, but it is a weaker shape — it relies on every future test
      // remembering to patch, and on nothing being constructed in between. `sdet` asked for the
      // seam to be at build time so the harness and the product agree on where it is.
      //
      // Production passes nothing and gets the behaviour it had before this line existed.
      botOrchestrator = typeof createBotOrchestrator === 'function'
        ? createBotOrchestrator(dataDir, port)
        : new BotOrchestrator(dataDir, port);
      app.use('/api/bots', botsRouter(dataDir, botOrchestrator));
    } catch (err) {
      // Loud, but not fatal: a broken bot subsystem must not stop a person from playing. The
      // old code swallowed this silently, which is how "the bots tab is gone" became a mystery.
      botOrchestrator = null;
      console.error('[Bots] Subsystem failed to mount — continuing without it:', err.message);
    }
  }
  app.locals.botOrchestrator = botOrchestrator;

  // Serve static build in production
  if (env && env.NODE_ENV === 'production') {
    app.use(express.static(path.join(__dirname, '..', 'client', 'dist')));
    app.get('*', (req, res) => {
      res.sendFile(path.join(__dirname, '..', 'client', 'dist', 'index.html'));
    });
  }

  return app;
}

function start() {
  // Allow the Claude Agent SDK to spawn Claude Code subprocesses even when this server is
  // launched from within a Claude Code session. Confined to the bootstrap on purpose: requiring
  // this module from a test must not quietly strip a marker from the test process's environment.
  delete process.env.CLAUDECODE;

  const app = createApp(DATA_DIR, { port: PORT, env: process.env });
  const botOrchestrator = app.locals.botOrchestrator;
  const server = http.createServer(app);
  attachWebSocket(server, DATA_DIR, { appendChatMessage: app.locals.appendChatMessage });

  // The bind host is resolved here, from the environment, and is never a literal at the call
  // site. `server/__tests__/bind-and-cors.test.js` scans this file and fails if a literal or an
  // identifier from anywhere but `resolveHost` appears as the second argument, because the line
  // this replaced — `server.listen(PORT, () => {` — is how the server came to be on every
  // interface without anyone deciding that it should be.
  const host = resolveHost(process.env);
  const policy = app.locals.corsPolicy;

  server.listen(PORT, host, () => {
    const shown = host === DEFAULT_HOST ? 'localhost' : host;
    console.log(`adventurefrog server running on http://${shown}:${PORT} (bound to ${host})`);
    console.log(
      `[CORS] allowed origins: ${policy.any ? '* (any — CLAUDEDM_ALLOWED_ORIGINS=*)' : policy.origins.join(', ')}`,
    );
    if (host !== DEFAULT_HOST) {
      // Conditional on purpose: `CLAUDEDM_HOST=127.0.0.2` widens the bind without reaching the
      // network, and a warning that asserted otherwise would be the kind of over-wide claim this
      // work order exists to stop repeating.
      console.warn(
        `[Net] CLAUDEDM_HOST=${host}: bind widened from the ${DEFAULT_HOST} default. If that is a `
        + 'network address, anything that can reach this port can act as any account, including '
        + 'admin — identity here is a self-asserted X-Player-Email header with no password.',
      );
    }
    if (botOrchestrator) {
      botOrchestrator.start().catch(err => {
        console.error('[BotOrchestrator] Startup error:', err.message);
      });
    }
  });

  // Graceful shutdown. `stop()` now releases each bot's companion claim over HTTP, so the
  // process has to stay alive until it settles — exiting first would leave exactly the stale
  // claim stop() exists to clear.
  const shutdown = async (exitAfter) => {
    try {
      if (botOrchestrator) await botOrchestrator.stop();
    } catch (err) {
      console.error('[BotOrchestrator] Shutdown error:', err.message);
    }
    if (exitAfter) process.exit(0);
  };
  process.on('SIGTERM', () => { shutdown(false); });
  process.on('SIGINT', () => { shutdown(true); });

  return { app, server, botOrchestrator };
}

if (require.main === module) {
  start();
}

module.exports = {
  createApp,
  start,
  botsAllowed,
  DATA_DIR,
  PORT,
  // WO-0034 — bind and CORS. Exported so the defaults are testable as values rather than
  // described in prose.
  resolveHost,
  defaultAllowedOrigins,
  resolveAllowedOrigins,
  createCorsMiddleware,
  DEFAULT_HOST,
  CLIENT_DEV_PORT,
};
