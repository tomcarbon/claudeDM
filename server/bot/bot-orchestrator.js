const fs = require('fs');
const path = require('path');
const { readPlayers, listBotAccounts, createBotAccount, deleteBotAccount, deleteAllBotAccounts } = require('./bot-accounts');
const { BotApiClient } = require('./bot-api-client');
const { BotWebSocketClient } = require('./bot-ws-client');
// The brain seam (WO-0033, WO-0036). The orchestrator resolves one brain per bot through the
// registry. **Since 2026-10-02 the registry's default is the MODEL brain** (WO-0036 J3) and the
// rule brain is a test double reachable only by naming it — read the registry's header for what
// that changed and for the security review it is waiting on.
const {
  createBrain: createBrainFromRegistry,
  resolveBotModel,
  DEFAULT_BRAIN,
} = require('./bot-brain-registry');
const { getAvailableCampaigns, getSessionDir, getSessionFilePath } = require('../player-data');

// WO-0036 J2: there were fifteen canned chat replies here, fired when a human said a bot's name
// in global chat. They are deleted, not disabled. The chair's words were *"We can remove the
// canned dumb bots entirely, I don't want to see them any more"*, and a bot that answers
// "You rang?" in chat is a canned dumb bot in the one place the chair cannot avoid reading it.
// Bots still connect to chat for presence; they no longer say anything there.

const CONFIG_FILE = 'bot-config.json';

/**
 * Deadline for each unjoin issued while shutting down (SR-5).
 *
 * `stop()` is awaited by the SIGINT handler before `process.exit`, so every HTTP call it makes
 * sits between the operator pressing Ctrl-C and the process going away. The client's ordinary
 * 15s deadline is right for gameplay and much too long for that; three seconds is enough for a
 * loopback request to a server that is still up, and short enough that a server that is already
 * going down does not hold the terminal.
 */
const SHUTDOWN_UNJOIN_TIMEOUT_MS = 3000;

// ── THE SHAPE (WO-0036 DoD 1) ────────────────────────────────────────────────────────────────
//
// The human chair, decision `0019`: *"a haiku-based agent(s) representing up to six players in a
// game run by one host who is allowed to run one game."* These four numbers are that sentence,
// and they are enforced here rather than remembered in a document.
//
// They are also the compensating control for J3. Since the environment switch no longer gates
// spend (see `bot-brain-registry.js`), the bound on what an unwanted `POST /api/bots/add` can
// cost is arithmetic: at most seven thinking agents, one game, one session each.
//
// `MAX_COMPANION_BOTS` is six because six is the number the chair said. `MAX_HOST_BOTS` is one
// for the same reason, and because six *host* bots at the old `maxSessionsPerBot: 5` was
// estimated at ~$45/hour — the shape the chair asked for and the cheap shape are the same
// object, which is the whole economic argument of WO-0036.

/** At most one bot may host. A host creates sessions; a companion never does. */
const MAX_HOST_BOTS = 1;
/** At most six companions — the chair's "up to six players". */
const MAX_COMPANION_BOTS = 6;
/** One game at a time, across the whole farm. */
const MAX_CONCURRENT_GAMES = 1;
/** One session per bot. The old clamp permitted five, which multiplied the farm by five. */
const MAX_SESSIONS_PER_BOT = 1;

// ── THE CEILINGS (WO-0036 DoD 4 and item 10) ─────────────────────────────────────────────────
//
// Two bounds, both stated here as numbers rather than as dispositions, because the Ethics
// Officer's B1(a)(ii) reasoning holds whether or not the role exists to ask for it: *"a ceiling
// tells you when to stop; a stated number tells you whether you were surprised."* A run that
// halts at a ceiling nobody wrote down first cannot be told apart from a run that went seven
// times longer than expected.
//
// **DEFAULT_MAX_BRAIN_CALLS counts BOT-BRAIN calls, not DM turns.** That is the Security
// Reviewer's amendment to DoD 4 and it is the right meter: `[DM:USAGE]` measures the DM, and the
// six player agents are what WO-0036 adds. Every call is counted whether it succeeds, fails,
// times out or is skipped, because a failing brain still costs tokens.
//
// 100 is chosen, stated, and small: at the default 60s turn delay with one host and two
// companions it is roughly twenty minutes of play. It is not a guess at what the chair wants —
// it is a number they can see in the panel and raise on purpose.

/** Farm-wide bot-brain calls per server run. Refuses and says so; never silent. */
const DEFAULT_MAX_BRAIN_CALLS = 100;
/** Wall-clock life of one bot session — the chair's "default session time 1 hour". */
const DEFAULT_SESSION_MAX_DURATION_MS = 3600000;

/**
 * ── THE CLOSED SET OF SKIP REASONS (SR-36-6) ─────────────────────────────────────────────────
 *
 * Every reason that may appear on `GET /api/bots/status`, which is declared **above**
 * `requireAdmin` (`routes/bots.js:21`) and is therefore readable by any caller with no headers
 * at all, and is rendered to every player by the panel.
 *
 * Revision 1 put `err.message` from the brain straight onto that payload. The Security Reviewer
 * was right that this is an **unbounded channel**: an SDK or HTTP exception string can carry
 * filesystem paths, model ids, API error bodies — whatever the thrower put in it. Today the
 * exposure is bounded by the mount gate and the loopback bind, and the condition under which it
 * stops being bounded is in the project's own README: `CLAUDEDM_HOST=0.0.0.0`, to play with
 * someone on the network.
 *
 * The chair still needs to debug a silent skip, so the detail is not discarded — it goes to the
 * **server log** (`_recordSkip`'s `detail` argument) and nowhere else. The categories below are
 * generated by this file from a `switch`, never from a request and never from an exception, so
 * the public payload's vocabulary is finite and reviewable in one place.
 */
const SKIP_REASONS = Object.freeze({
  EMPTY: 'empty response',
  TIMEOUT: 'timed out',
  ABORTED: 'cancelled on shutdown',
  ERROR: 'error',
});

/**
 * Map a thrown value to one of `SKIP_REASONS`. Never returns anything derived from the error's
 * own text — that is the entire point. See `SKIP_REASONS`.
 */
function classifySkip(err) {
  const name = err && typeof err.name === 'string' ? err.name : '';
  const msg = err && typeof err.message === 'string' ? err.message : '';
  if (name === 'AbortError' || /\baborted\b/i.test(msg)) return SKIP_REASONS.ABORTED;
  if (name === 'TimeoutError' || /\btimed? ?out\b/i.test(msg)) return SKIP_REASONS.TIMEOUT;
  return SKIP_REASONS.ERROR;
}

const DEFAULT_CONFIG = {
  enabled: false,
  maxConcurrentApiCalls: 3,
  // The model the player brains think with. Absent means the registry's verified Haiku id.
  // A model id only: it cannot name a brain, so it cannot be used to select one.
  brainModel: null,
  maxBrainCalls: DEFAULT_MAX_BRAIN_CALLS,
  sessionMaxDurationMs: DEFAULT_SESSION_MAX_DURATION_MS,
  bots: [], // [{ email, role, turnDelayMs, maxSessionsPerBot }]
};

/**
 * A refusal the HTTP layer can turn into a specific 400.
 *
 * The chair twice took *"Failed to add bots: Not Found"* to the CEO, and a refusal that looks
 * like a 404 is the defect WO-0036 DoD 1 names. Every rejection in `addBots` carries a sentence
 * that says which limit was hit and what the limit is.
 */
class BotShapeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BotShapeError';
    this.statusCode = 400;
  }
}

/**
 * A single session slot — one WS connection, one game.
 */
function createSessionSlot(sessionId, opts) {
  return {
    sessionId,
    sessionLabel: opts.label || null,
    campaignId: opts.campaignId,
    characterId: opts.characterId || null,
    scenarioId: opts.scenarioId || null,
    character: opts.character || null,
    role: opts.role || 'host', // 'host' | 'companion'
    companionNpcId: opts.companionNpcId || null,
    companionNpcName: opts.companionNpcName || null,
    state: 'idle', // idle | waiting_for_dm | playing | thinking | expired
    ws: null,      // dedicated BotWebSocketClient for this session
    recentMessages: [],      // last 20 messages for LLM context
    allMessages: [],         // full history for persistence
    claudeSessionId: null,
    tickTimer: null,
    // The duration ceiling's clock (WO-0036 item 10) and this session's share of the meter.
    startedAt: Date.now(),
    brainCalls: 0,
    expired: false,
  };
}

class BotOrchestrator {
  /**
   * @param {string} dataDir
   * @param {number} port
   * @param {object} [opts]
   * @param {Function} [opts.createBrain] injection point for the brain registry, so tests can
   *        supply a brain without touching config or the environment. Default is the registry,
   *        whose default is the free rule brain.
   */
  constructor(dataDir, port = 3001, opts = {}) {
    this.dataDir = dataDir;
    this.port = port;
    this.bots = new Map(); // email -> BotInstance
    this.config = { ...DEFAULT_CONFIG, bots: [] };
    this._activeApiCalls = 0;
    this._apiQueue = [];
    this._lookupTimers = new Map(); // email -> timer for session-finding ticks
    this._running = false;
    this._createBrain = opts.createBrain || createBrainFromRegistry;
    // WO-0036 J2: THERE IS NO FALLBACK BRAIN. Revision 0 of this line built a rule brain here
    // and played the turn with it whenever a model brain threw, timed out or returned nothing —
    // which is precisely the canned output the chair banned. A brain that cannot think now skips
    // the turn and says so. `_brainSkips` is the counter that was `_brainFallbacks`; it counts
    // turns NOT taken, not turns substituted, and `getStatus()` reports both names so nothing
    // reading the old key breaks while the panel moves to the new one.
    this._brainSkips = 0;
    this._lastSkipReason = null;
    // The meter and the ceiling (DoD 3, DoD 4). `_brainCalls` counts every bot-brain call this
    // run, successful or not; `_ceilingHit` is the reason the farm stopped, or null.
    this._brainCalls = 0;
    this._ceilingHit = null;
    // How many sessions have hit the per-session duration ceiling this run. Separate from
    // `_ceilingHit` on purpose — see `_recordSessionExpiry`. Monotonic, like the call meter.
    this._expiredSessions = 0;
    // Aborted on stop(), so a model call in flight does not outlive the 3s SIGINT deadline.
    this._shutdown = new AbortController();
  }

  /** The model id the player brains think with. Resolved from config, then env, then default. */
  get botModel() {
    return resolveBotModel(this.config.brainModel);
  }

  /** The farm-wide bot-brain-call ceiling actually in force. */
  get maxBrainCalls() {
    const v = this.config.maxBrainCalls;
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_MAX_BRAIN_CALLS;
  }

  /** The wall-clock life of one session, in ms. */
  get sessionMaxDurationMs() {
    const v = this.config.sessionMaxDurationMs;
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_SESSION_MAX_DURATION_MS;
  }

  /** How many bots currently hold the given role, counting config records not yet started. */
  _countRole(role) {
    return (this.config.bots || []).filter(bc => (bc.role === 'host' ? 'host' : 'companion') === role).length;
  }

  /** How many games are open across the whole farm right now. */
  _countGames() {
    const ids = new Set();
    for (const bot of this.bots.values()) {
      for (const sid of bot.sessions.keys()) ids.add(sid);
    }
    return ids.size;
  }

  // -- Config persistence --

  _configPath() {
    return path.join(this.dataDir, CONFIG_FILE);
  }

  loadConfig() {
    try {
      if (fs.existsSync(this._configPath())) {
        const data = JSON.parse(fs.readFileSync(this._configPath(), 'utf-8'));

        // Backward compat: migrate old global-count format to per-bot array
        if (data.bots === undefined) {
          const oldHostCount = data.hostCount || 0;
          const oldCompanionCount = data.companionCount || 0;
          const oldEitherCount = data.count !== undefined ? data.count : (data.eitherCount || 0);
          const oldDelay = data.turnDelayMs || 60000;
          const oldMaxSessions = data.maxSessionsPerBot || 1;

          // Build per-bot entries from existing bot accounts
          const accounts = listBotAccounts(this.dataDir);
          const totalNeeded = oldHostCount + oldCompanionCount + oldEitherCount;
          const bots = [];
          for (let i = 0; i < Math.min(accounts.length, totalNeeded); i++) {
            let role;
            if (i < oldHostCount) role = 'host';
            // WO-0036 DoD 5: the old `'either'` third case folds into `'companion'`. There are
            // only two roles now, and a migration must land on the one that cannot create a game.
            else role = 'companion';
            bots.push({
              email: accounts[i].email,
              role,
              turnDelayMs: oldDelay,
              maxSessionsPerBot: oldMaxSessions,
            });
          }

          this.config = {
            enabled: !!data.enabled,
            maxConcurrentApiCalls: data.maxConcurrentApiCalls || 3,
            bots,
          };
          console.log(`[BotOrchestrator] Migrated old config format → ${bots.length} per-bot entries`);
          this.saveConfig();
          return this.config;
        }

        this.config = { ...DEFAULT_CONFIG, ...data, bots: data.bots || [] };
      }
    } catch (err) {
      console.error('[BotOrchestrator] Config load error:', err.message);
    }
    return this.config;
  }

  saveConfig() {
    fs.writeFileSync(this._configPath(), JSON.stringify(this.config, null, 2));
  }

  // -- API call rate limiting --

  async _acquireApiSlot() {
    if (this._activeApiCalls < this.config.maxConcurrentApiCalls) {
      this._activeApiCalls++;
      return;
    }
    return new Promise(resolve => {
      this._apiQueue.push(resolve);
    });
  }

  _releaseApiSlot() {
    this._activeApiCalls--;
    if (this._apiQueue.length > 0) {
      this._activeApiCalls++;
      const next = this._apiQueue.shift();
      next();
    }
  }

  async _withApiSlot(fn) {
    await this._acquireApiSlot();
    try {
      return await fn();
    } finally {
      this._releaseApiSlot();
    }
  }

  // -- Bot lifecycle --

  async start() {
    this.loadConfig();
    if (!this.config.enabled) {
      console.log('[BotOrchestrator] Bot farm is disabled.');
      return;
    }
    const botConfigs = this.config.bots || [];
    console.log(`[BotOrchestrator] Starting bot farm — ${botConfigs.length} bots`);
    this._running = true;

    for (const bc of botConfigs) {
      const accounts = listBotAccounts(this.dataDir);
      const account = accounts.find(a => a.email === bc.email);
      if (account) {
        this._startBot(account, bc.role, bc.turnDelayMs, bc.maxSessionsPerBot, bc.brain);
      } else {
        console.warn(`[BotOrchestrator] Bot account not found for ${bc.email}, skipping`);
      }
    }
  }

  _startBot(account, role = 'companion', turnDelayMs = 60000, maxSessionsPerBot = 1, brainName) {
    if (this.bots.has(account.email)) return;

    // One brain per bot, resolved once at start. `resolved.name` is what was actually BUILT,
    // which is not always what was asked for, and it is the only thing recorded or reported —
    // `getStatus()` serves `bot.brainName`, so the panel reads back the live brain rather than
    // the requested one (WO-0036 J6).
    //
    // **The model id goes HERE and nowhere else** (WO-0036 J4). `{ model }` reaches
    // `createModelBrain` → `buildBrainQueryOptions` → `options.model`
    // (`bot-brain-model.js:496`), which is per-call SDK input. It is deliberately NOT
    // `process.env.ANTHROPIC_MODEL`: the DM spawns the same CLI from the same process and sets
    // no model of its own, so an environment variable would move the DM onto Haiku as well, and
    // the chair asked for *"the selected AI DM but with Haiku powered players."* The rule brain
    // ignores the option, because it does not think.
    const resolved = this._createBrain(brainName, { model: this.botModel });

    const bot = {
      email: account.email,
      name: account.name,
      // Normalised to the two roles the shape allows. A legacy `'either'` record in
      // bot-config.json becomes a companion, which is the safe direction: a companion can never
      // create a session, so no old record can turn into a seventh host (DoD 5).
      role: role === 'host' ? 'host' : 'companion',
      brain: resolved.brain,
      brainName: resolved.name,
      brainModel: resolved.name === 'model' ? this.botModel : null,
      brainCalls: 0,
      brainSkips: 0,
      lastSkipReason: null,
      turnDelayMs: Math.max(30000, Math.min(3600000, turnDelayMs || 60000)),
      maxSessionsPerBot: MAX_SESSIONS_PER_BOT,
      api: new BotApiClient({ email: account.email, port: this.port }),
      // Chat-only WS connection (not used for game sessions)
      chatWs: new BotWebSocketClient({ email: account.email, name: account.name, port: this.port }),
      sessions: new Map(), // sessionId -> SessionSlot
      lastActionTime: null,
    };

    // Wire up chat WS — only for chat and presence
    bot.chatWs.on('connected', () => {
      console.log(`[Bot:${bot.name}] Chat WS connected`);
      bot.chatWs.joinChat('global');
    });

    bot.chatWs.on('error', (msg) => {
      console.error(`[Bot:${bot.name}] Chat WS error:`, msg.error);
    });

    // WO-0036 J2: no `chat_message` handler. A bot used to answer one of fifteen canned lines
    // when a human said its name in global chat. The chair asked not to see canned bots again,
    // and global chat is the one place they could not look away from. The socket stays for
    // presence; it no longer speaks.

    bot.chatWs.connect();
    this.bots.set(account.email, bot);

    // Start the lookup loop — first tick fires quickly (3-8s), then normal cadence
    this._scheduleLookup(bot, true);
    console.log(
      `[BotOrchestrator] Started bot: ${bot.name} (${bot.role}, brain=${bot.brainName}`
      + `${bot.brainModel ? `, model=${bot.brainModel}` : ''}, delay=${bot.turnDelayMs}ms)`
    );
  }

  // -- Session slot management --

  _wireSessionSlot(bot, slot) {
    const ws = new BotWebSocketClient({ email: bot.email, name: bot.name, port: this.port });
    slot.ws = ws;

    ws.on('connected', () => {
      console.log(`[Bot:${bot.name}] Session WS connected for ${slot.sessionId}`);
    });

    ws.on('dm_complete', (msg) => {
      if (slot.state === 'waiting_for_dm') {
        slot.state = 'playing';
      }
      // Only the host bot owns the session file — companions can't save to it
      if (slot.role === 'host') {
        bot.api.updateSession(slot.campaignId, slot.sessionId, {
          messages: slot.allMessages,
          claudeSessionId: slot.claudeSessionId || msg.sessionId || null,
        }).catch(err => {
          console.error(`[Bot:${bot.name}] Session save error (${slot.sessionId}):`, err.message);
        });
      }
    });

    ws.on('session_id', (msg) => {
      if (msg.sessionId) slot.claudeSessionId = msg.sessionId;
    });

    ws.on('dm_response', (msg) => {
      if (msg.text) {
        slot.recentMessages.push({ type: 'dm', text: msg.text });
        slot.allMessages.push({ type: 'dm', text: msg.text, timestamp: new Date().toISOString() });
        if (slot.recentMessages.length > 20) {
          slot.recentMessages = slot.recentMessages.slice(-20);
        }
      }
    });

    ws.on('dice_roll', (msg) => {
      const roll = { type: 'dice_roll', notation: msg.notation, total: msg.total, label: msg.label };
      slot.recentMessages.push(roll);
      slot.allMessages.push({ ...roll, timestamp: new Date().toISOString() });
    });

    ws.on('session_status', (msg) => {
      if (msg.status === 'thinking') {
        slot.state = 'waiting_for_dm';
      }
    });

    // Companion bots: when turn_status shows host has submitted and we're waiting,
    // transition to 'playing' so we submit our turn (prevents first-round deadlock)
    ws.on('turn_status', (msg) => {
      if (slot.role === 'companion' && slot.state === 'waiting_for_dm' && msg.hostSubmitted) {
        slot.state = 'playing';
      }
    });

    ws.on('error', (msg) => {
      console.error(`[Bot:${bot.name}] Session WS error (${slot.sessionId}):`, msg.error);
    });

    ws.connect();
  }

  _startSessionTick(bot, slot) {
    if (!this._running) return;
    const jitter = bot.turnDelayMs * (0.1 + Math.random() * 0.2);
    const delay = bot.turnDelayMs + jitter;
    slot.tickTimer = setTimeout(() => {
      this._sessionTick(bot, slot).catch(err => {
        console.error(`[Bot:${bot.name}] Session tick error (${slot.sessionId}):`, err.message);
      }).finally(() => {
        if (bot.sessions.has(slot.sessionId)) {
          this._startSessionTick(bot, slot);
        }
      });
    }, delay);
  }

  /**
   * Read a session record from the shared store, or null.
   *
   * **The path matters and it was wrong.** This used to be built inline in
   * `_hasHumanCompanions` as
   * `data/players/<slug>/<campaignId>/sessions/<sessionId>.json`, which is a layout this
   * application does not use: `player-data.js:23-32` says *"Sessions live at
   * data/sessions/<sessionId>/ — not under any player's directory"*, and the chair's own tree
   * confirms it (`data/sessions/<uuid>/session.json`, two of them). `fs.existsSync` therefore
   * returned false every time, `_hasHumanCompanions` returned false every time, and the
   * human-companion protection in `_closeSessionSlot` has never once fired.
   *
   * Found while implementing WO-0036 J5, and fixed here rather than reported and left, because
   * J5's instruction is *"never a session with a human companion"* and that promise cannot be
   * built on a predicate that is structurally false. It is reported as a found defect in the
   * deliverable as well. `emailToSlug` is no longer needed for this and the import is dropped.
   */
  _readSessionRecord(sessionId) {
    try {
      const file = getSessionFilePath(this.dataDir, sessionId);
      if (!fs.existsSync(file)) return null;
      return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch (err) {
      console.error(`[BotOrchestrator] Could not read session ${String(sessionId).slice(0, 8)}: ${err.message}`);
      return null;
    }
  }

  /**
   * Does this session have a participant who is not a bot?
   *
   * Fails CLOSED: an unreadable or missing record answers **true** — "assume a human" — because
   * this predicate gates a deletion, and the asymmetry J5 states is the whole of the design:
   * *"an orphan is a nuisance, deleting the chair's game is not."* The old inline version failed
   * open, which was the safe direction for its caller (it only decided whether to keep a socket
   * alive) and is the wrong direction for this one.
   */
  _sessionHasHuman(sessionId, record = undefined) {
    const session = record === undefined ? this._readSessionRecord(sessionId) : record;
    if (!session) return true;
    const emails = [];
    if (session.ownerEmail) emails.push(session.ownerEmail);
    // SR-36-5 / `qc-tester` item 7. `playerEmail` was missing here, and the application's own
    // owner resolver consults it: `routes/sessions.js:26-30` is
    // `session.ownerEmail || session.playerEmail || players[].email`. Both reviewers built the
    // divergent record — bot `ownerEmail`, human `playerEmail`, nothing else — and measured it
    // DELETED. It is not reachable over HTTP today (creation writes both fields from one value
    // and `PUT /:id` strips both), so this is defence in depth. It is worth one line because
    // "the deletion predicate and the app disagree about who owns a session" is the kind of
    // divergence an unrelated change turns into a deleted game, and the predicate should be the
    // WIDER of the two by construction, never the narrower.
    if (session.playerEmail) emails.push(session.playerEmail);
    for (const cp of Object.values(session.companionPlayers || {})) {
      if (cp && cp.email) emails.push(cp.email);
    }
    for (const p of Array.isArray(session.players) ? session.players : []) {
      const e = typeof p === 'string' ? p : p && p.email;
      if (e) emails.push(e);
    }
    return emails.some(e => typeof e === 'string' && !e.endsWith('@bot.local'));
  }

  _hasHumanCompanions(bot, slot) {
    const session = this._readSessionRecord(slot.sessionId);
    if (!session) return false;   // caller only decides whether to keep a socket open
    const companions = session.companionPlayers || {};
    return Object.values(companions).some(cp => cp.email && !cp.email.endsWith('@bot.local'));
  }

  /**
   * Delete the session directories a bot created, and only those (WO-0036 J5).
   *
   * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────
   *
   * `cleanup()` stopped timers, closed sockets, deleted bot accounts and emptied `config.bots`,
   * and never touched `data/sessions/`. The only `rmSync` in the bot path is
   * `bot-accounts.js:71`, which removes a player's *library*. So every bot game left behind a
   * directory owned by an account that no longer exists, and because bot sessions are created
   * `visibility: 'public'` they stayed visible in Show-all-players for ever. The chair has two
   * such orphans and called it *"clutter and other problems"*.
   *
   * ── HOW CONSERVATIVE, AND WHY ───────────────────────────────────────────────────────────
   *
   * Deletion is a gated action in this company, and this one runs unattended behind an HTTP
   * route. So it refuses far more than it accepts. A directory is removed only if **all** of:
   *
   *   1. its `session.json` parses, and
   *   2. `ownerEmail` is a `@bot.local` address, and
   *   3. that address is one of the accounts this cleanup is removing — not merely any bot, so
   *      a second operator's bot session is not collateral, and
   *   4. no participant anywhere in the record is a non-`@bot.local` address
   *      (`_sessionHasHuman`, which fails closed), and
   *   5. the resolved path is inside `<dataDir>/sessions/` and is a directory whose name is the
   *      session id — checked after resolution, so a crafted id cannot escape the tree.
   *
   * Anything else is **left alone and reported**. Every outcome is returned and printed; this
   * function never deletes anything it cannot name in its own return value.
   *
   * ── WHAT CONDITION 3 DELIBERATELY DOES NOT REACH: ORPHANS (SR-36-2, S-1) ────────────────
   *
   * Revision 1 of the deliverable told the chair their two existing orphans *"satisfy conditions
   * 1-5 and will be deleted the first time the chair uses `Cleanup All`"*. **That was false and
   * both reviewers measured it false on replicas of the chair's exact state.** `cleanup()` builds
   * `botEmails` from `listBotAccounts`, which filters `players.json` on `isBot`; an orphan is by
   * definition a session whose owning account is **gone**, so it is in no account list, the
   * authorising set is empty, and condition 3 keeps it. The behaviour is right — condition 3 is
   * what stops a second operator's bot sessions becoming collateral, and both reviewers said
   * explicitly not to widen it. **The notice was wrong, not the code.**
   *
   * What revision 2 changes is only the *reason string*: a kept session whose bot owner has no
   * account at all is now reported as an **orphan out of reach of cleanup**, rather than as
   * *"owned by X, which is not being removed"* — which is literally true and reads, to the person
   * who clicked, as though an account existed and was being spared. Naming it is also the listing
   * half of the adopt-orphans action proposed in the deliverable and deliberately NOT built here:
   * the chair gets the list without a widened deletion.
   *
   * @param {string[]} botEmails the accounts being removed.
   * @param {object} [opts]
   * @param {Set<string>|null} [opts.registeredOwners] every address that holds an account at the
   *        moment of the call. Used only to tell "a bot that exists and is being spared" from
   *        "a bot that no longer exists" in the KEPT reason. It can never authorise a deletion:
   *        the `owners` set above is the only thing that does.
   * @returns {{deleted: string[], kept: Array<{sessionId: string, reason: string}>}}
   */
  _deleteBotSessions(botEmails, { registeredOwners = null } = {}) {
    const owners = new Set((botEmails || []).filter(e => typeof e === 'string' && e.endsWith('@bot.local')));
    const result = { deleted: [], kept: [] };
    const sessionsRoot = path.join(this.dataDir, 'sessions');

    let entries;
    try {
      if (!fs.existsSync(sessionsRoot)) return result;
      entries = fs.readdirSync(sessionsRoot, { withFileTypes: true });
    } catch (err) {
      console.error(`[BotOrchestrator] Could not list ${sessionsRoot}: ${err.message} — deleted nothing.`);
      return result;
    }

    for (const entry of entries) {
      const id = entry.name;
      if (entry.isSymbolicLink()) { result.kept.push({ sessionId: id, reason: 'symlink' }); continue; }
      if (!entry.isDirectory()) continue;   // noDelete.txt and friends are not sessions

      const record = this._readSessionRecord(id);
      if (!record) { result.kept.push({ sessionId: id, reason: 'no readable session.json' }); continue; }

      const owner = record.ownerEmail;
      if (typeof owner !== 'string' || !owner.endsWith('@bot.local')) {
        result.kept.push({ sessionId: id, reason: `owner is not a bot (${owner || 'none'})` });
        continue;
      }
      if (!owners.has(owner)) {
        // Condition 3. Unchanged in effect; only the sentence distinguishes the two cases.
        const orphaned = registeredOwners instanceof Set && !registeredOwners.has(owner);
        result.kept.push({
          sessionId: id,
          reason: orphaned
            ? `ORPHAN: owned by ${owner}, which has no account — out of reach of cleanup`
            : `owned by ${owner}, which is not being removed`,
        });
        continue;
      }
      if (this._sessionHasHuman(id, record)) {
        result.kept.push({ sessionId: id, reason: 'a human is in this session' });
        continue;
      }

      // (5) the path check, after resolution rather than before.
      // getSessionDir refuses a non-id outright (WO-0041); that is the same verdict as a path that
      // resolves outside data/sessions/, and is reported the same way.
      let dir = null;
      try { dir = path.resolve(getSessionDir(this.dataDir, id)); } catch { dir = null; }
      const root = path.resolve(sessionsRoot);
      if (!dir || path.dirname(dir) !== root || path.basename(dir) !== id) {
        result.kept.push({ sessionId: id, reason: 'path did not resolve inside data/sessions/' });
        continue;
      }

      try {
        fs.rmSync(dir, { recursive: true, force: true });
        result.deleted.push(id);
      } catch (err) {
        result.kept.push({ sessionId: id, reason: `delete failed: ${err.message}` });
      }
    }
    return result;
  }

  _closeSessionSlot(bot, slot, { force = false } = {}) {
    // Protect sessions with human companions unless forced
    if (!force && slot.role === 'host' && this._hasHumanCompanions(bot, slot)) {
      console.log(`[Bot:${bot.name}] Skipping close for session ${slot.sessionId.slice(0, 8)} — human companion present`);
      // Stop the bot from taking turns, but keep connection alive
      if (slot.tickTimer) {
        clearTimeout(slot.tickTimer);
        slot.tickTimer = null;
      }
      return false;
    }

    if (slot.tickTimer) {
      clearTimeout(slot.tickTimer);
      slot.tickTimer = null;
    }
    if (slot.ws) {
      slot.ws.close();
      slot.ws = null;
    }
    bot.sessions.delete(slot.sessionId);
    return true;
  }

  // -- Tick logic --

  _scheduleLookup(bot, initial = false) {
    if (!this._running) return;
    // First tick fires fast (3-8s)
    // Companion bots check more frequently (30-60s) since they're just scanning for games to join
    // Host/either bots use 2-3x turn delay
    const isCompanionRole = bot.role === 'companion';
    const delay = initial
      ? 3000 + Math.random() * 5000
      : isCompanionRole
        ? 30000 + Math.random() * 30000
        : bot.turnDelayMs * 2 + Math.random() * bot.turnDelayMs;
    const timer = setTimeout(() => {
      this._lookupTick(bot).catch(err => {
        console.error(`[Bot:${bot.name}] Lookup tick error:`, err.message);
      }).finally(() => {
        this._scheduleLookup(bot);
      });
    }, delay);
    this._lookupTimers.set(bot.email, timer);
  }

  async _lookupTick(bot) {
    if (!this._running) return;
    bot.lastActionTime = new Date().toISOString();

    // If we have room for more sessions, try to find/create one
    if (bot.sessions.size < bot.maxSessionsPerBot) {
      await this._findOrCreateSession(bot);
    }
  }

  async _sessionTick(bot, slot) {
    if (!this._running || !slot.ws?.connected) return;
    bot.lastActionTime = new Date().toISOString();

    if (slot.state === 'playing') {
      await this._playTurn(bot, slot);
    }
    // If waiting_for_dm or idle, skip — next tick will check again
  }

  /**
   * Record a ceiling as hit, once, loudly.
   *
   * DoD 4 and item 10 both say the same thing about this: *"When it trips, say so visibly; do
   * not stop silently."* So it logs at `warn` on the transition only, and it sets
   * `_ceilingHit`, which `getStatus()` serves and the panel renders.
   */
  _tripCeiling(reason, detail) {
    if (this._ceilingHit) return;
    this._ceilingHit = reason;
    console.warn(`[BotOrchestrator] CEILING REACHED — ${reason}: ${detail}. Bots will take no further turns.`);
  }

  /**
   * ── WHY THE DURATION CEILING DOES NOT CALL `_tripCeiling` (`qc-tester` item 8) ────────────
   *
   * `qc-tester` measured that after a session passes sixty minutes `getStatus().ceilingHit` is
   * still `null`, and the deliverable's §7.2 claimed *"Both trip visibly: `ceilingHit` on the
   * status payload, and a red line in the panel naming the limit."* The measurement is right and
   * the sentence was wrong. **The fix is not to wire the duration branch into `_tripCeiling`,**
   * and that is a judgement worth stating rather than leaving as an omission:
   *
   * `_ceilingHit` is **farm-wide and one-way**. `_playTurn` parks every slot as `expired` when it
   * is set (`:799`) and `_createSession` refuses outright (`:945`). It is the farm's "stop"
   * flag. The duration ceiling is **per session** — the chair's *"default session time 1 hour"*.
   * Setting a farm-wide stop because one session aged out would mean a bot that has played for an
   * hour silently ends a game that started five minutes ago, and nothing but a restart clears it.
   * That is a worse defect than the missing banner.
   *
   * So the duration ceiling gets its own visible surface instead, of the same loudness: a farm
   * counter of how many sessions have expired (`expiredSessions`), the per-session `expired` flag
   * and age already on the payload, the skip with its reason, and a dedicated red line in the
   * panel naming the limit. What `ceilingHit` means is now written down: *the farm stopped*.
   */
  _recordSessionExpiry(slot) {
    if (slot.expired) return;
    slot.expired = true;
    this._expiredSessions += 1;
  }

  /**
   * Whether this slot may take another turn, and why not if it may not.
   *
   * Two ceilings, checked in the order that costs least: the farm-wide brain-call count (DoD 4,
   * counting bot-brain calls rather than DM turns, per the Security Reviewer's amendment) and
   * the per-session wall clock (item 10, the chair's one hour).
   *
   * @returns {null|string} null to proceed, or the reason to stop.
   */
  _ceilingBlock(slot) {
    if (this._brainCalls >= this.maxBrainCalls) {
      this._tripCeiling('brain-call ceiling', `${this._brainCalls}/${this.maxBrainCalls} bot-brain calls this run`);
      return `brain-call ceiling reached (${this._brainCalls}/${this.maxBrainCalls})`;
    }
    const age = Date.now() - (slot.startedAt || Date.now());
    if (age >= this.sessionMaxDurationMs) {
      if (!slot.expired) {
        this._recordSessionExpiry(slot);
        console.warn(
          `[BotOrchestrator] CEILING REACHED — session duration: ${slot.sessionId?.slice(0, 8)} `
          + `ran ${Math.round(age / 60000)} min, limit ${Math.round(this.sessionMaxDurationMs / 60000)} min. `
          + 'Bots will take no further turns in it.'
        );
      }
      return `session duration ceiling reached (${Math.round(age / 60000)} min)`;
    }
    return null;
  }

  /**
   * Count a skipped turn and say so. **There is no substitute text** (WO-0036 J2).
   *
   * The chair banned canned output, so a brain that cannot think produces nothing rather than
   * something it was not asked for. Every skip is counted on the bot, counted on the farm,
   * carries its reason into `getStatus()`, and logs once. A model brain that is broken,
   * rate-limited or out of budget must not look identical to a working one — that is the shape
   * of defect this company has shipped twice (`records/LESSONS.md`) — and under J2 it also must
   * not look identical to a brain that had nothing to say.
   */
  _recordSkip(bot, slot, reason, detail = null) {
    bot.brainSkips = (bot.brainSkips || 0) + 1;
    bot.lastSkipReason = reason;
    this._brainSkips += 1;
    this._lastSkipReason = reason;
    // `reason` goes on the UNAUTHENTICATED status payload and must be from the closed set above;
    // `detail` is the raw exception text and goes **only here**, to the server log (SR-36-6).
    console.warn(
      `[Bot:${bot.name}] turn SKIPPED in ${slot.sessionId?.slice(0, 8) || '?'} — ${reason}`
      + `${detail ? ` [${detail}]` : ''}. `
      + `No text was sent (${bot.brainSkips} skip(s) for this bot, ${this._brainSkips} in total).`
    );
  }

  /**
   * Ask this bot's brain for a turn.
   *
   * THE SEAM. The first argument is byte-for-byte the shape `generateTurnText` has always
   * taken; `{ signal }` is a second argument so the first is untouched, and the rule brain
   * ignores it. The signal is the orchestrator's shutdown controller, so a model call in
   * flight does not outlive the 3s SIGINT deadline (SR-5).
   *
   * @returns {Promise<string|null>} the turn text, or **null** meaning "no turn this tick".
   *          Null is the J2 contract: the caller sends nothing at all. It never returns
   *          substitute text, and it never throws for an ordinary brain failure — a failure is
   *          a counted skip, not an exception, because an exception here was what the old
   *          fallback was papering over.
   */
  async _brainTurn(bot, slot) {
    const blocked = this._ceilingBlock(slot);
    if (blocked) {
      this._recordSkip(bot, slot, blocked);
      return null;
    }

    const input = {
      recentMessages: slot.recentMessages,
      character: slot.character,
      scenarioName: slot.scenarioId,
    };
    const brain = bot.brain;
    const brainName = bot.brainName || DEFAULT_BRAIN;

    if (typeof brain !== 'function') {
      this._recordSkip(bot, slot, `no '${brainName}' brain was built for this bot`);
      return null;
    }


    // Counted BEFORE the call, and counted whether it succeeds: a call that throws or times out
    // has already cost tokens, so a meter that only counted successes would under-report spend
    // in exactly the circumstance a reader cares about.
    this._brainCalls += 1;
    bot.brainCalls = (bot.brainCalls || 0) + 1;
    slot.brainCalls = (slot.brainCalls || 0) + 1;

    let text;
    let reason = null;      // from SKIP_REASONS — safe for the public payload
    let detail = null;      // the raw exception text — server log only (SR-36-6)
    try {
      text = await brain(input, { signal: this._shutdown.signal });
      if (typeof text !== 'string' || text.trim() === '') reason = SKIP_REASONS.EMPTY;
    } catch (err) {
      detail = err && err.message ? err.message : String(err);
      reason = classifySkip(err);
    }

    if (reason === null) return text;

    this._recordSkip(bot, slot, `'${brainName}' brain: ${reason}`, detail);
    return null;
  }

  async _playTurn(bot, slot) {
    const previous = slot.state;
    slot.state = 'thinking';
    try {
      const turnText = await this._withApiSlot(() => this._brainTurn(bot, slot));

      // J2: null means the brain had nothing. Send nothing, say nothing, retry next tick —
      // unless a ceiling stopped us, in which case the slot parks rather than spinning.
      if (turnText === null) {
        slot.state = slot.expired || this._ceilingHit ? 'expired' : (previous === 'thinking' ? 'playing' : previous);
        return;
      }

      if (slot.role === 'host') {
        slot.ws.sendUserMessage(turnText);
      } else {
        slot.ws.submitCompanionTurn(turnText, slot.companionNpcId, slot.companionNpcName, slot.character?.id, slot.character?.name);
      }
      slot.recentMessages.push({ type: 'player', text: turnText });
      slot.allMessages.push({ type: 'player', text: turnText, timestamp: new Date().toISOString() });
      slot.state = 'waiting_for_dm';
      console.log(`[Bot:${bot.name}] Sent turn (${slot.role}, ${slot.sessionId.slice(0, 8)}): "${turnText.slice(0, 60)}..."`);
    } catch (err) {
      console.error(`[Bot:${bot.name}] Turn error (${slot.sessionId}):`, err.message);
      slot.state = 'playing'; // Retry next tick
    }
  }

  async _joinSession(bot, campaignId) {
    const sessions = await bot.api.getSessions(campaignId);
    const alreadyIn = new Set(Array.from(bot.sessions.values()).map(s => s.sessionId));
    const publicSessions = (sessions || []).filter(s => s.settings?.visibility === 'public' && s.ownerEmail !== bot.email && !alreadyIn.has(s.id));
    const joinable = publicSessions.filter(s =>
      s.settings?.allowBots === true &&
      s.companionSlots?.open > 0 &&
      (s.botCount || 0) < (s.settings?.maxBots ?? 2)
    );

    if (joinable.length === 0) {
      if (bot.role === 'companion' && publicSessions.length > 0) {
        const reasons = publicSessions.map(s => {
          const parts = [];
          if (s.settings?.allowBots !== true) parts.push('bots_off');
          if (!s.companionSlots?.open) parts.push('no_slots');
          if ((s.botCount || 0) >= (s.settings?.maxBots ?? 2)) parts.push('max_bots');
          return `${s.label || s.id.slice(0, 8)}(${parts.join(',')})`;
        });
        console.log(`[Bot:${bot.name}] Scanned ${campaignId}: ${publicSessions.length} public, 0 joinable — ${reasons.join(', ')}`);
      }
      return false;
    }

    const session = joinable[Math.floor(Math.random() * joinable.length)];
    const openSlot = session.companionSlots.slots.find(s => s.type === 'player' && !s.claimedBy);
    if (!openSlot) return false;

    try {
      await bot.api.joinSession(campaignId, session.id, openSlot.npcId);
    } catch (err) {
      // 409 = already joined this slot — treat as success
      if (err.message.includes('(409)')) {
        console.log(`[Bot:${bot.name}] Already joined session "${session.label || session.id}", re-attaching.`);
      } else {
        throw err;
      }
    }
    // Fetch NPC name and bot's character roster
    let companionNpcName = openSlot.npcId;
    let chosenCharacter = null;
    try {
      const [npcs, characters] = await Promise.all([
        bot.api.getNpcs(campaignId),
        bot.api.getCharacters(campaignId),
      ]);
      const npc = (npcs || []).find(n => n.id === openSlot.npcId);
      if (npc?.name) companionNpcName = npc.name;

      // Pick a random player character, avoiding duplicates within this session
      const aliveChars = (characters || []).filter(c => c.status === 'alive');
      if (aliveChars.length > 0) {
        // Collect character names already taken in this session (by host or other companions)
        const takenNames = new Set();
        // Host's character
        if (session.characterId) {
          const hostChar = aliveChars.find(c => c.id === session.characterId);
          if (hostChar?.name) takenNames.add(hostChar.name.toLowerCase());
        }
        // Other companions already claimed in this session
        for (const s of session.companionSlots.slots) {
          if (s.claimedBy?.characterName) takenNames.add(s.claimedBy.characterName.toLowerCase());
        }
        // Other bots in this orchestrator that already picked a character for this session
        for (const [, otherBot] of this.bots) {
          const otherSlot = otherBot.sessions.get(session.id);
          if (otherSlot && otherSlot.character?.name) {
            takenNames.add(otherSlot.character.name.toLowerCase());
          }
        }
        // Also exclude active NPC names to avoid name collisions
        for (const n of (npcs || [])) {
          if (n.id !== openSlot.npcId && n.status !== 'dead') {
            takenNames.add(n.name.toLowerCase());
          }
        }
        const available = aliveChars.filter(c => !takenNames.has(c.name.toLowerCase()));
        const pool = available.length > 0 ? available : aliveChars;
        chosenCharacter = pool[Math.floor(Math.random() * pool.length)];
      }
    } catch {}
    const slot = createSessionSlot(session.id, {
      label: session.label || session.name,
      campaignId,
      role: 'companion',
      companionNpcId: openSlot.npcId,
      companionNpcName,
      character: chosenCharacter,
    });
    slot.state = 'waiting_for_dm';
    bot.sessions.set(session.id, slot);
    this._wireSessionSlot(bot, slot);
    slot.ws.on('connected', () => {
      slot.ws.watchSession(session.id);
      // Set the companion's chosen character after watching
      if (chosenCharacter) {
        slot.ws.setCompanionCharacter(chosenCharacter.id, chosenCharacter.name, companionNpcName, chosenCharacter);
        console.log(`[Bot:${bot.name}] Selected character "${chosenCharacter.name}" for companion slot ${companionNpcName}`);
      }
    });
    this._startSessionTick(bot, slot);
    console.log(`[Bot:${bot.name}] Joined session "${session.label || session.id}" as companion (${bot.sessions.size}/${bot.maxSessionsPerBot})`);
    return true;
  }

  async _createSession(bot, campaignId) {
    // ── ONE GAME, AND ONLY A HOST MAY MAKE IT (WO-0036 DoD 1 and DoD 5) ──────────────────────
    //
    // The clamp in `addBots` bounds how many bots exist; this bounds how many games they open,
    // and it is the check that has to hold, because `_findOrCreateSession` runs on a timer long
    // after any HTTP request. Both conditions are belt and braces over `_findOrCreateSession`,
    // which already routes only hosts here — stated twice on purpose, since DoD 5 asks for a
    // guarantee that survives *"a later change to `role` handling"*, and a guarantee that lives
    // only in the caller does not.
    if (bot.role !== 'host') {
      console.warn(`[Bot:${bot.name}] refused to create a session: only a host bot may, and this bot is a ${bot.role}.`);
      return;
    }
    const games = this._countGames();
    if (games >= MAX_CONCURRENT_GAMES) {
      console.warn(
        `[Bot:${bot.name}] refused to create a session: ${games}/${MAX_CONCURRENT_GAMES} game(s) already open. `
        + 'One concurrent game is the enforced shape (decision 0019).'
      );
      return;
    }
    if (bot.sessions.size >= MAX_SESSIONS_PER_BOT) return;
    if (this._ceilingHit) {
      console.warn(`[Bot:${bot.name}] refused to create a session: ${this._ceilingHit} already reached.`);
      return;
    }

    const [scenarios, characters, npcs] = await Promise.all([
      bot.api.getScenarios(campaignId),
      bot.api.getCharacters(campaignId),
      bot.api.getNpcs(campaignId),
    ]);
    const aliveChars = (characters || []).filter(c => c.status === 'alive');

    if (!scenarios?.length || !aliveChars?.length) return;

    const scenario = scenarios[Math.floor(Math.random() * scenarios.length)];
    const character = aliveChars[Math.floor(Math.random() * aliveChars.length)];

    // Build companion config: guarantee at least 2 open player slots (or all if fewer NPCs)
    const companionConfig = { states: {}, reservations: {} };
    const aliveNpcs = (npcs || []).filter(n => n.status === 'alive');
    // Shuffle NPCs so the guaranteed slots are random, not always the first ones
    const shuffled = [...aliveNpcs].sort(() => Math.random() - 0.5);
    const minOpen = Math.min(2, shuffled.length);
    for (let i = 0; i < shuffled.length; i++) {
      companionConfig.states[shuffled[i].id] = i < minOpen ? 'player' : (Math.random() < 0.5 ? 'player' : 'removed');
    }

    const created = await bot.api.createSession(campaignId, {
      characterId: character.id,
      scenarioId: scenario.id,
      campaignId,
      companionConfig,
      settings: { visibility: 'public', allowBots: true, maxBots: 5 },
    });

    // WO-0036 J2, revision 2 (`qc-tester` item 5). This read `` `Adventure with ${name}` ``,
    // which is a sentence the chair did not write, rendered in the session list and in the bot
    // table. The fifteen canned chat replies and the canned opener went in revision 1 and this
    // one survived because it is metadata rather than a turn — but the chair's instruction was
    // about what they *read*, not about which field it came out of.
    //
    // The replacement is the chair's own data joined by a separator: a character name and a
    // scenario name, both of which they authored. No invented words. `sessionLabel` is also
    // allowed to be null (`createSessionSlot`, and the panel falls back to the session id), so
    // if either name is missing the label is dropped rather than padded with filler.
    const labelParts = [character.name, scenario.name].filter(n => typeof n === 'string' && n.trim() !== '');
    const label = labelParts.join(' \u2014 ') || null;
    if (label) {
      await bot.api.setSessionLabel(campaignId, created.id, label).catch(err => {
        console.error(`[Bot:${bot.name}] Label set error:`, err.message);
      });
    }

    const slot = createSessionSlot(created.id, {
      label: label,
      campaignId,
      characterId: character.id,
      scenarioId: scenario.name || scenario.id,
      character,
      role: 'host',
    });
    slot.state = 'waiting_for_dm';
    bot.sessions.set(created.id, slot);
    this._wireSessionSlot(bot, slot);

    slot.ws.on('connected', () => {
      slot.ws.startSession(character.id, scenario.id, campaignId, companionConfig);
      slot.ws.watchSession(created.id);
      // WO-0036 J2: the opener used to be the hardcoded sentence
      // *"I look around and take in my surroundings."* It was the first thing the chair read in
      // every bot game, and it was canned. It now comes from the brain like every other turn —
      // the 2s timer is kept only so play starts promptly instead of one turn-delay later, and
      // `_playTurn` already handles a brain that has nothing to say by retrying on the next
      // tick rather than by inventing a line.
      setTimeout(() => {
        if (slot.state === 'playing' || slot.state === 'waiting_for_dm') {
          slot.state = 'playing';
          this._playTurn(bot, slot).catch(err => {
            console.error(`[Bot:${bot.name}] Opening turn error (${created.id}):`, err.message);
          });
        }
      }, 2000);
    });

    this._startSessionTick(bot, slot);
    console.log(`[Bot:${bot.name}] Created session — ${campaignId}/${scenario.name || scenario.id} (${bot.sessions.size}/${bot.maxSessionsPerBot})`);
  }

  async _findOrCreateSession(bot) {
    try {
      const campaigns = getAvailableCampaigns(this.dataDir);
      const hasNoSessions = bot.sessions.size === 0;

      // 30% chance to idle this tick (but always act if bot has no sessions yet)
      if (!hasNoSessions && Math.random() < 0.3) return;

      // ── TWO ROLES, NOT THREE (WO-0036 DoD 5) ────────────────────────────────────────────
      //
      // The old third branch was `'either'`: join if you can, otherwise create. That is the
      // branch that could quietly turn six companions into six hosts, which is the thing DoD 5
      // asks a test to hold — *"the batching property is the whole economic argument."* Six
      // companions in one hosted game is roughly one extra DM turn per round; six hosts is six
      // separate games. So there is no third branch. `_startBot` normalises any role that is
      // not `'host'` to `'companion'`, including a legacy `'either'` record, and only `'host'`
      // reaches `_createSession`.
      if (bot.role === 'host') {
        const campaignId = campaigns[Math.floor(Math.random() * campaigns.length)] || 'demo';
        await this._createSession(bot, campaignId);
      } else {
        // Companions scan ALL campaigns for a joinable session, and never create one.
        for (const cid of campaigns) {
          const joined = await this._joinSession(bot, cid);
          if (joined) return;
        }
      }
    } catch (err) {
      console.error(`[Bot:${bot.name}] Session find/create error:`, err.message);
    }
  }

  // -- Control methods --

  /**
   * Add new bots with individual configuration.
   * Creates accounts, persists config, and starts each bot.
   *
   * **`brain` is still deliberately NOT a parameter here** (WO-0033; Ethics condition B2), and
   * the two tests that hold it — `addBots does not accept a brain` and `the HTTP path cannot
   * select a brain` in `__tests__/bot-brain-seam.test.js` — are unchanged and still pass. They
   * exist because QC's mutation (add the parameter, persist it) passed the whole suite 731/731
   * with zero kills at revision 0.
   *
   * **But read what that property is worth now, because WO-0036 J3 changed it and leaving the
   * old sentence here would be the over-wide claim this stream keeps catching.** Until
   * 2026-10-02 the sentence was "HTTP cannot select a spending brain, so HTTP cannot spend".
   * The first half is still true; the second half is **false**, because the spending brain is
   * now the default and arrives without being selected. What the absence of the parameter buys
   * today is narrower and still worth keeping: HTTP cannot *choose* which brain runs, so it
   * cannot pin a bot to a brain that a later default change would move, and the test double
   * stays unreachable from the network.
   *
   * What bounds `POST /api/bots/add` instead is the clamp immediately below — one host, six
   * companions, one game, one session each — and the two ceilings in `_ceilingBlock`. Those are
   * the compensating controls for J3 and they are the ones to review.
   *
   * If you have a reason to add `brain` here, the review is `security-reviewer`'s: decision
   * `0006`'s obligation on brain selection was reassigned to that role by decision `0020`
   * amendment 1, Ethics being suspended. It is not the CEO's to waive and it is not mine.
   */
  async addBots({ role = 'companion', count = 1, turnDelayMs = 60000, maxSessionsPerBot = 1 } = {}) {
    // ── THE SHAPE, ENFORCED AND EXPLAINED (WO-0036 DoD 1) ───────────────────────────────────
    //
    // Every refusal below is a `BotShapeError`, which the route turns into a 400 carrying this
    // sentence. The chair took *"Failed to add bots: Not Found"* to the CEO twice; a refusal
    // that does not say what it refused is the defect, not the refusal.
    //
    // `count` was previously unclamped — `routes/bots.js` destructured it and nothing checked
    // it — so a single request could create any number of bots. It is now bounded by the
    // remaining room under the role's limit, and asking for more is an error rather than a
    // silent truncation: truncating would tell the chair they got six when they asked for ten.
    const wanted = Number.isFinite(count) ? Math.floor(count) : NaN;
    if (!Number.isFinite(wanted) || wanted < 0) {
      throw new BotShapeError(`count must be a whole number, got ${JSON.stringify(count)}.`);
    }

    const normalisedRole = role === 'host' ? 'host' : role === 'companion' ? 'companion' : null;
    if (normalisedRole === null) {
      // The `'either'` clause is conditional because a refusal that explains a value the caller
      // did not send is noise, and noise is how `"Failed to add bots: Not Found"` got ignored.
      throw new BotShapeError(
        `role must be "host" or "companion", got ${JSON.stringify(role)}.`
        + (role === 'either'
          ? ' "either" is no longer offered: one host and up to six companions is the enforced'
            + ' shape, and a bot that can decide to host is how six companions become six'
            + ' separate games.'
          : '')
      );
    }

    if (wanted > 0) {
      const limit = normalisedRole === 'host' ? MAX_HOST_BOTS : MAX_COMPANION_BOTS;
      const existing = this._countRole(normalisedRole);
      const room = limit - existing;
      if (room <= 0) {
        throw new BotShapeError(
          `There are already ${existing} ${normalisedRole} bot(s) and the limit is ${limit}. `
          + `Remove one before adding another${normalisedRole === 'host' ? ' — one host runs one game' : ''}.`
        );
      }
      if (wanted > room) {
        throw new BotShapeError(
          `Asked for ${wanted} ${normalisedRole} bot(s) but only ${room} more will fit: `
          + `${existing} of a maximum ${limit} already exist.`
        );
      }
    }

    const added = [];
    for (let i = 0; i < wanted; i++) {
      const account = createBotAccount(this.dataDir);
      const botConfig = {
        email: account.email,
        role: normalisedRole,
        turnDelayMs: Math.max(30000, Math.min(3600000, turnDelayMs)),
        // One session per bot, not the five the old clamp allowed. `maxSessionsPerBot` is still
        // accepted and still persisted so the record shape is unchanged, but it cannot exceed
        // one: one concurrent game is the shape, and five-per-bot multiplied the farm by five.
        maxSessionsPerBot: Math.max(1, Math.min(MAX_SESSIONS_PER_BOT, maxSessionsPerBot || 1)),
      };
      this.config.bots.push(botConfig);
      added.push(account);

      // Start immediately if farm is running. No brain argument: `botConfig` is the record this
      // loop just built and it has no `brain` field, by design (see the note on addBots).
      if (this._running) {
        this._startBot(account, botConfig.role, botConfig.turnDelayMs, botConfig.maxSessionsPerBot);
      }
    }

    this.config.enabled = true;
    this._running = true;
    this.saveConfig();

    // If farm wasn't running, start any bots that were in config but not yet started.
    //
    // `bc.brain` IS passed here, unlike the loop above, and the difference is not an accident:
    // this loop re-starts records that were already in bot-config.json, which is precisely where
    // a hand-written `"brain": "rules"` lives. Revision 0 omitted it (F-QCT33-1 / SR-5), so the
    // same bot record resolved one way through start() and as `undefined` through this path —
    // a configuration silently ignored with no log line at all, which is the WO-0019 bug class.
    //
    // **The direction of that asymmetry inverted on 2026-10-02** (WO-0036 J3) and the inversion
    // is the whole point of the change: `undefined` now resolves to the MODEL brain, so a
    // dropped `brain` field no longer means "silently free". The field a hand edit would write
    // is now `"rules"`, and the path that honours it is this one.
    for (const bc of this.config.bots) {
      if (!this.bots.has(bc.email)) {
        const accounts = listBotAccounts(this.dataDir);
        const account = accounts.find(a => a.email === bc.email);
        if (account) {
          this._startBot(account, bc.role, bc.turnDelayMs, bc.maxSessionsPerBot, bc.brain);
        }
      }
    }

    console.log(
      `[BotOrchestrator] Added ${added.length} ${normalisedRole} bot(s) `
      + `(delay=${turnDelayMs}ms). Shape now: ${this._countRole('host')}/${MAX_HOST_BOTS} host, `
      + `${this._countRole('companion')}/${MAX_COMPANION_BOTS} companion, `
      + `${MAX_CONCURRENT_GAMES} concurrent game. Ceilings: ${this.maxBrainCalls} bot-brain calls, `
      + `${Math.round(this.sessionMaxDurationMs / 60000)} min per session.`
    );
    return added;
  }

  /**
   * Remove a specific bot entirely — force-disconnect all sessions, delete account.
   * If the bot is a host, cascade-disconnect companion bots from its sessions.
   */
  async removeBot(botEmail) {
    const bot = this.bots.get(botEmail);
    if (!bot) throw new Error(`Bot not found: ${botEmail}`);

    // For each session this bot hosts, disconnect companion bots first
    for (const [sid, slot] of bot.sessions) {
      if (slot.role === 'host') {
        for (const [email, otherBot] of this.bots) {
          if (email === botEmail) continue;
          const companionSlot = otherBot.sessions.get(sid);
          if (companionSlot && companionSlot.role === 'companion') {
            try {
              await otherBot.api.unjoinSession(companionSlot.campaignId, sid, companionSlot.companionNpcId);
            } catch (err) {
              console.error(`[BotOrchestrator] Unjoin failed for companion ${otherBot.name}:`, err.message);
            }
            this._closeSessionSlot(otherBot, companionSlot, { force: true });
            console.log(`[BotOrchestrator] Cascade-disconnected companion ${otherBot.name} from session ${sid.slice(0, 8)}`);
          }
        }
      }

      // If this bot is a companion, unjoin from the session API
      if (slot.role === 'companion' && slot.companionNpcId) {
        try {
          await bot.api.unjoinSession(slot.campaignId, sid, slot.companionNpcId);
        } catch (err) {
          console.error(`[BotOrchestrator] Unjoin failed for ${bot.name}:`, err.message);
        }
      }

      this._closeSessionSlot(bot, slot, { force: true });
    }

    // Stop lookup timer
    const timer = this._lookupTimers.get(botEmail);
    if (timer) {
      clearTimeout(timer);
      this._lookupTimers.delete(botEmail);
    }

    // Close chat WS
    bot.chatWs.close();
    this.bots.delete(botEmail);

    // Remove from config and delete account
    this.config.bots = this.config.bots.filter(bc => bc.email !== botEmail);
    this.saveConfig();
    deleteBotAccount(this.dataDir, botEmail);

    // WO-0036 J5: this bot's own session directories go with it, by the same five conditions
    // `_deleteBotSessions` applies in `cleanup()` — including "a human is in this session",
    // which leaves it alone. The × button in the panel is the path the chair will actually use,
    // so cleaning up only on Cleanup All would have left the clutter they complained about.
    //
    // ── S-3 / `qc-tester` item 7: BOTH HALVES, UNFILTERED ──────────────────────────────────
    //
    // Revision 1 filtered this half — the log line and the returned list — to
    // `reason === 'a human is in this session'`. Every other reason was dropped on the floor:
    // `no readable session.json`, `symlink`, `path did not resolve inside data/sessions/` and,
    // the one an operator most needs, `delete failed: <errno>`. `qc-tester` measured the
    // consequence and it is a **false statement to the person who clicked**: with one unreadable
    // session owned by the bot, `_deleteBotSessions` kept 1, `removeBot` returned 0, and the
    // panel printed *"No session directories were owned by that bot."* while the directory was
    // still on disk.
    //
    // `cleanup()` printed both halves in full from the start; this path — the `×` button, the one
    // the chair actually uses — did not, and the deliverable claimed *"Both print both halves and
    // both return the lists."* The filter is removed rather than widened: the whole point of
    // `_deleteBotSessions` returning its kept half with reasons is that *"this function never
    // deletes anything it cannot name in its own return value"*, and a caller that then hides
    // some of those names undoes it.
    const sessions = this._deleteBotSessions([botEmail]);
    if (sessions.deleted.length) {
      console.log(`[BotOrchestrator] Deleted session directory(ies) for ${botEmail}: ${sessions.deleted.join(', ')}`);
    } else {
      console.log(`[BotOrchestrator] Deleted no session directories for ${botEmail}.`);
    }
    for (const k of sessions.kept) {
      console.log(`[BotOrchestrator] Kept session ${k.sessionId} — ${k.reason}`);
    }

    console.log(`[BotOrchestrator] Removed bot: ${bot.name} (${botEmail})`);
    return {
      removed: true,
      botName: bot.name,
      email: botEmail,
      deletedSessions: sessions.deleted,
      // Every kept session with its reason. `keptHumanSessions` is the subset the panel used to
      // get as `keptSessions`, kept as its own field so the UI can still say "kept N with a human
      // in it" without the two meanings sharing one name.
      keptSessions: sessions.kept,
      keptHumanSessions: sessions.kept.filter(k => k.reason === 'a human is in this session'),
    };
  }

  /**
   * Disconnect a specific bot from a specific session (without deleting the bot).
   * If the bot is the host, also disconnect any companion bots in that session.
   */
  async disconnectBotSession(botEmail, sessionId) {
    const bot = this.bots.get(botEmail);
    if (!bot) throw new Error(`Bot not found: ${botEmail}`);
    const slot = bot.sessions.get(sessionId);
    if (!slot) throw new Error(`Session not found for bot: ${sessionId}`);

    // If host, disconnect all companion bots in this session first
    if (slot.role === 'host') {
      for (const [email, otherBot] of this.bots) {
        if (email === botEmail) continue;
        const companionSlot = otherBot.sessions.get(sessionId);
        if (companionSlot && companionSlot.role === 'companion') {
          try {
            await otherBot.api.unjoinSession(companionSlot.campaignId, sessionId, companionSlot.companionNpcId);
          } catch (err) {
            console.error(`[BotOrchestrator] Unjoin failed for companion ${otherBot.name}:`, err.message);
          }
          this._closeSessionSlot(otherBot, companionSlot, { force: true });
          console.log(`[BotOrchestrator] Disconnected companion ${otherBot.name} from session ${sessionId.slice(0, 8)}`);
        }
      }
    }

    // If this bot is a companion, unjoin from session API
    if (slot.role === 'companion' && slot.companionNpcId) {
      try {
        await bot.api.unjoinSession(slot.campaignId, sessionId, slot.companionNpcId);
      } catch (err) {
        console.error(`[BotOrchestrator] Unjoin failed for ${bot.name}:`, err.message);
      }
    }

    // Force-close the slot (admin override — bypass human companion protection)
    this._closeSessionSlot(bot, slot, { force: true });
    console.log(`[BotOrchestrator] Disconnected ${bot.name} from session ${sessionId.slice(0, 8)}`);

    return { disconnected: true, botName: bot.name, sessionId };
  }

  async stop() {
    console.log('[BotOrchestrator] Stopping all bots...');
    this._running = false;

    // Cancel any brain call in flight. `stop()` is awaited by the SIGINT handler against a
    // 3-second deadline (SHUTDOWN_UNJOIN_TIMEOUT_MS), and an uncancellable model call would
    // hold the terminal open — the same failure SR-5 fixed once on the HTTP client. The
    // controller is then replaced so a later start()/addBots() is not born pre-aborted.
    this._shutdown.abort();
    this._shutdown = new AbortController();

    for (const [email, timer] of this._lookupTimers) {
      clearTimeout(timer);
    }
    this._lookupTimers.clear();

    for (const [email, bot] of this.bots) {
      // Close session slots — skip any with human companions.
      //
      // The unjoin below is not tidiness; leaving it out stalls a live human table.
      // `_closeSessionSlot` drops the socket but never touches `session.companionPlayers`, so a
      // companion slot closed without unjoining leaves this bot's claim on the NPC in the
      // session file. ws-handler's `getJoinedCompanionEmails` reads that file, so `checkAutoFire`
      // goes on waiting for a submission from an agent that has gone, and the DM never fires
      // again for anyone. The host's only recovery is `host_skip_companion` or
      // `host_turn_continue`, with nothing on screen saying why. `removeBot` and
      // `disconnectBotSession` already unjoin first; this path was the one that did not.
      //
      // Only companion slots hold a claim, and `_closeSessionSlot`'s human-companion protection
      // only ever spares a *host* slot — so a companion slot is always about to be closed here,
      // and releasing its claim first is always right.
      for (const [sid, slot] of bot.sessions) {
        if (slot.role === 'companion' && slot.companionNpcId) {
          try {
            // Bounded: see SHUTDOWN_UNJOIN_TIMEOUT_MS. A hung unjoin must not hold Ctrl-C.
            await bot.api.unjoinSession(slot.campaignId, sid, slot.companionNpcId, {
              timeoutMs: SHUTDOWN_UNJOIN_TIMEOUT_MS,
            });
          } catch (err) {
            console.error(`[BotOrchestrator] Unjoin failed for ${bot.name} on stop:`, err.message);
          }
        }
        this._closeSessionSlot(bot, slot);
      }
      // Only fully disconnect bot if all its sessions were closed
      if (bot.sessions.size === 0) {
        bot.chatWs.close();
        this.bots.delete(email);
      } else {
        console.log(`[BotOrchestrator] Bot ${bot.name} kept alive — ${bot.sessions.size} session(s) with human companions`);
      }
    }

    this._activeApiCalls = 0;
    this._apiQueue = [];

    const remaining = this.bots.size;
    console.log(`[BotOrchestrator] All bots stopped.${remaining ? ` ${remaining} bot(s) kept alive for human companions.` : ''}`);
  }

  async cleanup() {
    // Force-close everything including sessions with human companions
    console.log('[BotOrchestrator] Cleanup — force-stopping all bots...');
    this._running = false;
    for (const [email, timer] of this._lookupTimers) {
      clearTimeout(timer);
    }
    this._lookupTimers.clear();
    for (const [email, bot] of this.bots) {
      for (const [sid, slot] of bot.sessions) {
        this._closeSessionSlot(bot, slot, { force: true });
      }
      bot.chatWs.close();
    }
    this.bots.clear();
    this._activeApiCalls = 0;
    this._apiQueue = [];

    // Collect the owners BEFORE the accounts go, since ownership is what authorises the
    // deletion below and `deleteAllBotAccounts` is what destroys the evidence of it.
    const botEmails = listBotAccounts(this.dataDir).map(a => a.email);
    // And every registered address, bot or human, for the KEPT reasons only (SR-36-2). This
    // authorises nothing: `_deleteBotSessions` deletes on `botEmails` alone. It exists so a
    // session owned by an account that no longer exists is reported as an ORPHAN instead of as
    // "a bot that is not being removed", which is what made revision 1's chair-facing notice
    // read as a promise it could not keep.
    let registeredOwners = null;
    try {
      registeredOwners = new Set(Object.keys(readPlayers(this.dataDir) || {}));
    } catch (err) {
      console.error(`[BotOrchestrator] Could not read players.json for the cleanup report: ${err.message}`);
    }

    const count = deleteAllBotAccounts(this.dataDir);

    // WO-0036 J5. Printed in full, both halves: what went and what stayed and why. A deletion
    // that reports only its successes is a deletion you cannot audit.
    const sessions = this._deleteBotSessions(botEmails, { registeredOwners });
    if (sessions.deleted.length) {
      console.log(
        `[BotOrchestrator] Deleted ${sessions.deleted.length} bot-owned session directory(ies): `
        + sessions.deleted.join(', ')
      );
    } else {
      console.log('[BotOrchestrator] Deleted no session directories.');
    }
    for (const k of sessions.kept) {
      console.log(`[BotOrchestrator] Kept session ${k.sessionId} — ${k.reason}`);
    }

    this.config.bots = [];
    this.config.enabled = false;
    this.saveConfig();
    return { deletedAccounts: count, deletedSessions: sessions.deleted, keptSessions: sessions.kept };
  }

  getStatus() {
    const bots = [];
    for (const [email, bot] of this.bots) {
      const sessionList = [];
      for (const [sid, slot] of bot.sessions) {
        sessionList.push({
          sessionId: slot.sessionId,
          sessionLabel: slot.sessionLabel,
          campaignId: slot.campaignId,
          role: slot.role,
          state: slot.state,
          connected: !!slot.ws?.connected,
          messageCount: slot.allMessages.length,
          // The meter, per session (DoD 3): calls made and minutes elapsed against the ceiling.
          brainCalls: slot.brainCalls || 0,
          ageMs: Date.now() - (slot.startedAt || Date.now()),
          expired: !!slot.expired,
        });
      }
      bots.push({
        email: bot.email,
        name: bot.name,
        botRole: bot.role,
        turnDelayMs: bot.turnDelayMs,
        maxSessionsPerBot: bot.maxSessionsPerBot,
        connected: bot.chatWs.connected,
        sessionCount: bot.sessions.size,
        sessions: sessionList,
        lastActionTime: bot.lastActionTime,
        // Which brain this bot actually GOT, and which model it thinks with. `brainName` is set
        // from what the registry built, never from what was requested, which is what lets the
        // panel name the live brain rather than the intended one (WO-0036 J6).
        //
        // A name, an id and counts only — this payload is served by the UNAUTHENTICATED
        // GET /api/bots/status (routes/bots.js:21, above requireAdmin), so nothing free-text
        // and nothing personal may be added here without moving the route. `lastSkipReason` is
        // the one judgement call in that rule: it is a brain-failure string
        // (`'model' brain: empty response`), it is generated by this file rather than taken
        // from a request, and the chair cannot debug a silent skip without it.
        brain: bot.brainName || DEFAULT_BRAIN,
        brainModel: bot.brainModel || null,
        brainCalls: bot.brainCalls || 0,
        brainSkips: bot.brainSkips || 0,
        lastSkipReason: bot.lastSkipReason || null,
        // Compatibility alias. Under J2 nothing "falls back" any more, so this counts the same
        // skipped turns as `brainSkips`; it is kept so an older reader of this payload does not
        // silently see zero where it used to see a number. Prefer `brainSkips`.
        brainFallbacks: bot.brainSkips || 0,
      });
    }
    return {
      enabled: this.config.enabled,
      running: this._running,
      maxConcurrentApiCalls: this.config.maxConcurrentApiCalls,
      activeBots: this.bots.size,
      // What the chair is actually running, read back rather than assumed (J6). `brain` is the
      // distinct set of brains live across the farm, so a mixed farm cannot be reported as one
      // thing — if it ever says `['rules']` the chair is watching canned text and should be
      // told, and if it says two names something is wrong and that is worth seeing too.
      brain: [...new Set([...this.bots.values()].map(b => b.brainName || DEFAULT_BRAIN))],
      brainModel: this.botModel,
      // The meter and the ceilings (DoD 3, DoD 4, item 10).
      brainCalls: this._brainCalls,
      maxBrainCalls: this.maxBrainCalls,
      sessionMaxDurationMs: this.sessionMaxDurationMs,
      // `ceilingHit` means THE FARM STOPPED, and only the brain-call ceiling can say that. The
      // duration ceiling is per session and reports through `expiredSessions` plus each
      // session's own `expired`/`ageMs` — `_recordSessionExpiry` explains why they are separate.
      ceilingHit: this._ceilingHit,
      expiredSessions: this._expiredSessions,
      brainSkips: this._brainSkips,
      lastSkipReason: this._lastSkipReason,
      brainFallbacks: this._brainSkips,   // compatibility alias; see the per-bot note above
      // The shape, so the panel states the limits rather than hardcoding a second copy of them.
      shape: {
        maxHostBots: MAX_HOST_BOTS,
        maxCompanionBots: MAX_COMPANION_BOTS,
        maxConcurrentGames: MAX_CONCURRENT_GAMES,
        maxSessionsPerBot: MAX_SESSIONS_PER_BOT,
        hostBots: this._countRole('host'),
        companionBots: this._countRole('companion'),
        games: this._countGames(),
      },
      bots,
    };
  }
}

module.exports = {
  BotOrchestrator,
  BotShapeError,
  SKIP_REASONS,
  classifySkip,
  SHUTDOWN_UNJOIN_TIMEOUT_MS,
  MAX_HOST_BOTS,
  MAX_COMPANION_BOTS,
  MAX_CONCURRENT_GAMES,
  MAX_SESSIONS_PER_BOT,
  DEFAULT_MAX_BRAIN_CALLS,
  DEFAULT_SESSION_MAX_DURATION_MS,
};
