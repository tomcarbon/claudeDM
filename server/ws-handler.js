const { WebSocketServer } = require('ws');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { DmEngine, summarizeArc } = require('./dm-engine');
const { maybeCompact } = require('./compaction');
const { emailToSlug, getPlayerCharactersDir, getSessionFilePath, getSessionCharactersDir, getSessionNpcsDir, snapshotToSession, updateSessionFile, SAFE_CAMPAIGN_ID } = require('./player-data');
const { auditDmTurn, auditPlayerTurn, formatWarnings, logAuditTrace, needsReconcile, buildReconcilePrompt, buildMechanicalCorrection } = require('./dm-audit');
const { slugify, verifySessionIntegrity } = require('./entity-resolver');
const { writeJsonAtomic } = require('./json-recovery');
const { getPremiumAccessForEmail, isRegisteredEmail } = require('./player-auth');
const { canStartCampaign, PREMIUM_REFUSAL_MESSAGE } = require('./premium-gate');

// The two ways a new game can be refused over the WebSocket (WO-0050). Each refusal is sent as the
// `error` payload and is also what `startRefused` holds, so a user_message after a refused start is
// refused with the same words and code as the start was.
const PREMIUM_REFUSAL = Object.freeze({ error: PREMIUM_REFUSAL_MESSAGE, code: 'campaign_unavailable' });
// Revision 4, Part C: only a logged-in player — an email that names a registered record in
// players.json, the test REST's getAuthenticatedPlayer applies — may start a new game, in every
// campaign including `demo`. REST `POST /api/sessions` already refused guests with "Login required.
// Guests cannot create sessions."; this closes the WebSocket half.
const LOGIN_REQUIRED_MESSAGE = 'Login required. Guests cannot start a new game.';
const LOGIN_REFUSAL = Object.freeze({ error: LOGIN_REQUIRED_MESSAGE, code: 'login_required' });
// An empty playerEmail keeps the message it always had, and gains the code.
const NO_EMAIL_REFUSAL = Object.freeze({ error: 'playerEmail is required to start a session.', code: 'login_required' });

// Collapse warnings to one per category so a transfer flagged by both the DM-narration scan and the
// player-intent scan doesn't double-report in the reconcile prompt.
function dedupeWarningsByCategory(warnings) {
  const seen = new Set();
  const out = [];
  for (const w of warnings || []) {
    if (!w || seen.has(w.category)) continue;
    seen.add(w.category);
    out.push(w);
  }
  return out;
}

// Module-level chat rooms: chatKey -> Set<wsEntry>
// Each wsEntry: { ws, playerEmail, playerName, isAdmin }
const chatRooms = new Map();
// Session watch rooms: sessionDbId -> Set<wsEntry>
const sessionRooms = new Map();
// Pending companion turns: sessionDbId -> Map<playerEmail, { playerEmail, playerName, npcId, text }>
const sessionTurns = new Map();
// Track which companion characters have had their sheet sent to the DM: sessionDbId -> Set<characterId>
const companionSheetsSent = new Map();
// Session-level DM engines: sessionDbId -> { engine, characterId, scenarioId, campaignId, ownerEmail, messageHistory }
const sessionEngines = new Map();
// Grace period timers for engine cleanup: sessionDbId -> timeout
const engineCleanupTimers = new Map();
const sessionFirstFireTimers = new Map(); // sessionDbId -> setTimeout handle for first-turn grace period
let nextConnectionId = 1;

// Which visible system notices have already been shown for a session during the turn now in
// flight. Condition M4 (ETHICS.md Review 3): the mechanical correction message must not stack
// with "⚠️ Session integrity:" in the same turn — one machine voice interrupting the story is a
// correction, two is the app talking over the table.
const turnNotices = new Map();

// Fire-and-forget work that is deliberately not awaited by the request path, kept so that
// something else can await it. See scheduleSessionIntegrityCheck.
const backgroundWork = new Map();

/**
 * Resolve once no deliberately-un-awaited session work is still in flight.
 * For tests and shutdown; production never calls this. With no argument, waits on every session.
 */
async function whenSessionWorkSettled(sessionDbId) {
  const pending = sessionDbId
    ? [backgroundWork.get(sessionDbId)].filter(Boolean)
    : Array.from(backgroundWork.values());
  await Promise.allSettled(pending);
}
function beginTurnNotices(key) { turnNotices.set(key || '__local__', new Set()); }
function noteTurnNotice(key, kind) {
  const k = key || '__local__';
  if (!turnNotices.has(k)) turnNotices.set(k, new Set());
  turnNotices.get(k).add(kind);
}
function hasTurnNotice(key, kind) {
  const set = turnNotices.get(key || '__local__');
  return !!set && set.has(kind);
}

// Post-turn enforcement: if the audit flagged narrated-but-unsaved stat changes, resume the
// turn's Claude session and have the DM apply the missing file edits before the turn ends.
// Runs only when needed (clean turns return immediately), is bounded to MAX_RECONCILE_ATTEMPTS,
// suppresses any narrative the pass produces, and never throws — the caller must still reach its
// `finally` and emit the 'idle'/Ready status. Shared by the single-player and multiplayer paths.
const MAX_RECONCILE_ATTEMPTS = 2;
async function reconcileTurnIfNeeded({ engine, warnings, auditDmText, auditPlayerText, auditToolCalls, auditOutcomes, knownEntities, speakers, runOpts }) {
  if (!needsReconcile(warnings)) return; // fast path: nothing to fix, zero added latency

  const sessionDbId = runOpts.sessionDbId;
  const cid = runOpts.campaignId || 'demo';
  const slug = runOpts.playerEmail ? emailToSlug(runOpts.playerEmail) : null;
  const charPathPrefix = sessionDbId ? `data/sessions/${sessionDbId}/characters`
    : `data/players/${slug || 'unknown-player'}/${cid}/characters`;
  const npcPathPrefix = sessionDbId ? `data/sessions/${sessionDbId}/npcs`
    : `data/defaults/${cid}/npcs`;

  const allToolCalls = Array.isArray(auditToolCalls) ? [...auditToolCalls] : [];
  const allOutcomes = Array.isArray(auditOutcomes) ? [...auditOutcomes] : [];
  let current = warnings;
  // A warning raised only by the player scan is the loosest signal this system produces — the
  // patterns are deliberately wide and the entity gate is the only thing behind them. One attempt
  // is enough for it: each attempt is a full resumed model query against a budget line of 0, and
  // the player can provoke this class on demand by naming a rostered NPC beside a coin phrase
  // (WO-0032 S3).
  const playerOnly = (warnings || []).every(w => w && w.source === 'player');
  const maxAttempts = playerOnly ? 1 : MAX_RECONCILE_ATTEMPTS;
  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      console.warn(`[DM:RECONCILE] session=${sessionDbId} attempt=${attempt}/${maxAttempts} applying missed edits`);
      const prompt = buildReconcilePrompt(current, charPathPrefix, npcPathPrefix);
      for await (const event of engine.runReconcile(prompt, runOpts)) {
        if (event.type === 'tool_use') allToolCalls.push({ name: event.name, input: event.input });
        if (event.type === 'mechanical_outcome') allOutcomes.push(event);
        // Intentionally suppress dm_partial/dm_response/dm_warmup — this is an internal pass and
        // must not surface as a second DM message to the player.
      }
      // Re-audit BOTH sides, with the same roster as the first pass.
      //
      // The roster matters because without it the re-audit falls back to the write-count rule and
      // would declare a still-one-sided transfer resolved — the bug surviving inside its own fix.
      // Both sides matter for the same reason one step further out (WO-0032 S4): revision 0
      // re-audited the DM narration only, and `auditPlayerTurn` exists precisely because the DM
      // "paraphrases qualitatively and never restates a number", so on the turns where the player
      // scan is the only thing that fired, the re-audit had nothing to look at and logged
      // "resolved" having verified nothing. A guard that reports success it did not measure is
      // worse than no guard, because it is evidence.
      // The speakers travel with the re-audit too: without them the re-audit would apply the
      // weaker any-character rule and could declare resolved a transfer whose player side was
      // written on somebody else's sheet (revision 2, Security R3 / QC N1).
      const auditOpts = { speakers, outcomes: allOutcomes };
      current = dedupeWarningsByCategory([
        ...auditDmTurn(auditDmText, allToolCalls, allOutcomes, knownEntities, auditOpts),
        ...auditPlayerTurn(auditPlayerText, allToolCalls, knownEntities, auditOpts),
      ]);
      if (!needsReconcile(current)) {
        console.log(`[DM:RECONCILE] session=${sessionDbId} resolved after attempt=${attempt}`);
        return;
      }
    }
    const formatted = formatWarnings(current, sessionDbId);
    console.warn(`[DM:RECONCILE_GIVEUP] session=${sessionDbId} still unbacked after ${maxAttempts} attempt(s)\n${formatted || ''}`);
  } catch (e) {
    console.error('[DM:RECONCILE] error:', e);
  }
}

// Server-side dice-roll text formatter. Mirrors the client formatter in
// `client/src/hooks/useWebSocket.js` byte-for-byte so dice_roll messages persisted by the
// server look identical to ones written by the client's auto-save.
function formatDiceRoll({ notation, rolls, modifier, total, label }) {
  const rollsStr = rolls.length > 1 ? `[${rolls.join(', ')}]` : `${rolls[0]}`;
  const modStr = modifier > 0 ? ` + ${modifier}` : modifier < 0 ? ` - ${Math.abs(modifier)}` : '';
  const prefix = label ? `${label} — ` : '';
  return `${prefix}${notation}: ${rollsStr}${modStr} = ${total}`;
}

function getRoomParticipants(chatKey) {
  if (!chatRooms.has(chatKey)) return [];
  return Array.from(chatRooms.get(chatKey))
    .filter(entry => entry.ws.readyState === entry.ws.OPEN)
    .map(entry => ({
      playerEmail: entry.playerEmail || 'guest',
      playerName: entry.playerName || 'Guest',
      isAdmin: !!entry.isAdmin,
      connectionId: entry.connectionId,
    }));
}

function getSessionOwnerEmail(session) {
  const ownerPlayer = (session.players || []).find(p => p.role === 'owner') || (session.players || [])[0] || {};
  const value = session.ownerEmail || session.playerEmail || ownerPlayer.email || null;
  return value ? String(value).trim().toLowerCase() : null;
}

function getSessionOwnerName(session) {
  const ownerPlayer = (session.players || []).find(p => p.role === 'owner') || (session.players || [])[0] || {};
  return session.ownerName || session.playerName || ownerPlayer.name || null;
}

function getCompanionNpcId(session, email) {
  if (!email) return null;
  // companionPlayers is a top-level field on the session (set by POST /:id/join)
  const players = session.companionPlayers;
  if (!players) return null;
  for (const [npcId, info] of Object.entries(players)) {
    if (info?.email?.toLowerCase() === email.toLowerCase()) return npcId;
  }
  return null;
}

function broadcastSessionTurns(sessionDbId) {
  if (!sessionRooms.has(sessionDbId)) return;
  const turns = sessionTurns.has(sessionDbId)
    ? Array.from(sessionTurns.get(sessionDbId).values())
    : [];
  for (const entry of sessionRooms.get(sessionDbId)) {
    if (entry.ws.readyState === entry.ws.OPEN) {
      entry.ws.send(JSON.stringify({ type: 'companion_turns_update', sessionDbId, turns }));
    }
  }
}

function getOrCreateSessionEngine(sessionDbId, dataDir, opts) {
  // Cancel any pending cleanup timer
  if (engineCleanupTimers.has(sessionDbId)) {
    clearTimeout(engineCleanupTimers.get(sessionDbId));
    engineCleanupTimers.delete(sessionDbId);
  }
  if (sessionEngines.has(sessionDbId)) {
    const ctx = sessionEngines.get(sessionDbId);
    // Update mutable fields if provided
    if (opts.characterId) ctx.characterId = opts.characterId;
    if (opts.scenarioId) ctx.scenarioId = opts.scenarioId;
    if (opts.campaignId) ctx.campaignId = opts.campaignId;
    if (opts.dmPersonality) ctx.dmPersonality = opts.dmPersonality;
    if (opts.ownerEmail) ctx.ownerEmail = opts.ownerEmail;
    if (opts.claudeSessionId && !ctx.engine.sessionId) ctx.engine.sessionId = opts.claudeSessionId;
    if (opts.messageHistory && opts.messageHistory.length > ctx.messageHistory.length) ctx.messageHistory = opts.messageHistory;
    if (opts.companionConfig) ctx.companionConfig = opts.companionConfig;
    return ctx;
  }
  const engine = _createEngine(dataDir);
  engine.sessionId = opts.claudeSessionId || null;
  const ctx = {
    engine,
    characterId: opts.characterId || null,
    scenarioId: opts.scenarioId || null,
    campaignId: opts.campaignId || null,
    ownerEmail: opts.ownerEmail || null,
    sessionDbId,
    messageHistory: opts.messageHistory || [],
    companionConfig: opts.companionConfig || null,
    dmPersonality: opts.dmPersonality || null,
  };
  sessionEngines.set(sessionDbId, ctx);
  return ctx;
}

function scheduleEngineCleanup(sessionDbId) {
  // Clean up session engine after 5 minutes of no connections
  if (engineCleanupTimers.has(sessionDbId)) return;
  const timer = setTimeout(() => {
    engineCleanupTimers.delete(sessionDbId);
    // Only clean up if room is still empty
    if (!sessionRooms.has(sessionDbId) || sessionRooms.get(sessionDbId).size === 0) {
      const ctx = sessionEngines.get(sessionDbId);
      if (ctx) {
        ctx.engine.abort();
        sessionEngines.delete(sessionDbId);
        console.log(`[WS] Cleaned up session engine for ${sessionDbId} (5 min grace period expired)`);
      }
    }
  }, 5 * 60 * 1000);
  engineCleanupTimers.set(sessionDbId, timer);
}

async function isMultiplayerSession(sessionDbId) {
  const session = await _findAndReadSession(sessionDbId);
  if (!session) return false;
  return session.companionPlayers && Object.keys(session.companionPlayers).length > 0;
}

// Module-level session read helper (set inside attachWebSocket)
let _findAndReadSession = async () => null;
// Data dir for serialized session updates (set inside attachWebSocket)
let _dataDir = null;

const SUMMARY_PATTERN = /## 📜 Chapter Summary:/;

// Recognize subscription-auth expiry (the production "DM died mid-boat-chase" cause)
// so the client can show an actionable message instead of a generic engine error.
function describeEngineError(message) {
  const raw = String(message || 'DM engine error');
  if (/401|authentication_error|Failed to authenticate|invalid.*api key|OAuth token has expired/i.test(raw)) {
    return {
      error: raw,
      authError: true,
      hint: 'Claude subscription auth expired on the server. Run `claude login` (or `claude setup-token`) on the server, then retry your last message.',
    };
  }
  return { error: raw };
}

// Reconcile one completed turn's canonical events into sess.messages. Idempotent
// against a client whose auto-save already captured the full turn; replaces any
// partial fragment. Shared by the single-player and multiplayer dm_complete paths.
// Runs inside an updateSessionFile mutator.
function persistCanonicalTurn(sess, { sessionDbId, claudeSessionId, playerMsg, companionMsgs = [], stampedTurnEvents, lastDmText }) {
  if (claudeSessionId) sess.claudeSessionId = claudeSessionId;
  if (!Array.isArray(sess.messages)) sess.messages = [];

  // Find the latest occurrence of this turn's player message in the file.
  // Safe to scan unbounded: at dm_complete no later turn has been written yet,
  // so the latest matching player line is by definition THIS turn's.
  let playerIdx = -1;
  for (let i = sess.messages.length - 1; i >= 0; i--) {
    const m = sess.messages[i];
    if (m && m.type === 'player' && m.text === playerMsg.text) { playerIdx = i; break; }
  }

  if (playerIdx >= 0) {
    const fullyPersisted = lastDmText
      ? sess.messages.slice(playerIdx + 1).some(m => m.type === 'dm' && m.text === lastDmText)
      : true;
    if (fullyPersisted) {
      console.log(`[WS] dm_complete: client already persisted full turn, skipping append (session ${sessionDbId})`);
    } else {
      // Trim partial fragment of this turn (anything from the player message
      // onward — could be just [player], or [player, dm₁, dice₁, …]) and
      // replace with the canonical full turn.
      sess.messages = sess.messages.slice(0, playerIdx);
      sess.messages.push(playerMsg, ...companionMsgs, ...stampedTurnEvents);
      console.log(`[WS] dm_complete: reconciled partial client save at idx ${playerIdx} with ${stampedTurnEvents.length} turn events (session ${sessionDbId})`);
    }
  } else {
    sess.messages.push(playerMsg, ...companionMsgs, ...stampedTurnEvents);
    console.log(`[WS] dm_complete: client did not persist, appended canonical turn (${stampedTurnEvents.length} events, session ${sessionDbId})`);
  }

  // Track summary counter regardless of who persisted the messages
  for (const te of stampedTurnEvents) {
    if (te.type !== 'dm') continue;
    sess.dmMessagesSinceLastSummary = SUMMARY_PATTERN.test(te.text)
      ? 0
      : (sess.dmMessagesSinceLastSummary || 0) + 1;
  }
  appendTurnToWorldState(sess, playerMsg.text, lastDmText);
}

// Server-maintained world-state digest, appended after EVERY completed DM turn.
// Guarantees the resume snapshot can never be older than the last turn, even when
// the DM never volunteers an UpdateWorldState call. The DM's tool still owns the
// structured fields (location, quests, keyFacts).
function appendTurnToWorldState(session, playerText, dmText) {
  if (!playerText && !dmText) return;
  const clip = (s, n) => {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
  };
  const ws = session.worldState || (session.worldState = {});
  if (!Array.isArray(ws.recentEvents)) ws.recentEvents = [];
  ws.recentEvents.push(`Turn: "${clip(playerText, 120)}" → ${clip(dmText, 200)}`);
  while (ws.recentEvents.length > 8) ws.recentEvents.shift();
  ws.updatedAt = new Date().toISOString();
}

// All three go through updateSessionFile so concurrent writers (world-state tool,
// message persistence, counters) can't clobber each other's fields.
async function persistTurnToSession(sessionDbId, turnData) {
  try {
    await updateSessionFile(_dataDir, sessionDbId, (session) => {
      if (!session.pendingTurns) session.pendingTurns = {};
      session.pendingTurns[turnData.playerEmail] = turnData;
    });
  } catch { /* session file may not exist yet */ }
}

async function removeTurnFromSession(sessionDbId, playerEmail) {
  let text = null;
  try {
    await updateSessionFile(_dataDir, sessionDbId, (session) => {
      const turn = session.pendingTurns && session.pendingTurns[playerEmail];
      if (!turn) return false;
      text = turn.text || null;
      delete session.pendingTurns[playerEmail];
    });
  } catch { /* session file may not exist yet */ }
  return text;
}

async function clearPendingTurns(sessionDbId) {
  try {
    await updateSessionFile(_dataDir, sessionDbId, (session) => {
      session.pendingTurns = {};
    });
  } catch { /* session file may not exist yet */ }
}

// Module-level file path helper (set inside attachWebSocket)
let _findSessionFilePath = async () => null;

// Module-level engine factory (set inside attachWebSocket, same pattern as the helpers above).
// Production passes nothing and gets a real DmEngine. Tests pass `createEngine` so the suite can
// never construct one — a real DmEngine's query() runs with cwd = PROJECT_ROOT and Edit
// auto-allowed, i.e. a billable agent with write access to the live data/ directory.
const defaultCreateEngine = (dir) => new DmEngine(dir);
let _createEngine = defaultCreateEngine;

function attachWebSocket(server, dataDir, { appendChatMessage, createEngine, summarize } = {}) {
  const wss = new WebSocketServer({ server, path: '/ws' });
  _wss = wss;
  const playersDir = path.join(dataDir, 'players');

  // Wire module-level helpers to closure functions (defined below)
  _findSessionFilePath = (id) => findSessionFilePathAsync(id);
  _findAndReadSession = (id) => readSessionByDbIdAsync(id);
  _dataDir = dataDir;
  _createEngine = createEngine || defaultCreateEngine;
  const summarizeFn = summarize || summarizeArc;

  function broadcastChatParticipants(chatKey) {
    const participants = getRoomParticipants(chatKey);
    if (!chatRooms.has(chatKey)) return;
    for (const entry of chatRooms.get(chatKey)) {
      if (entry.ws.readyState === entry.ws.OPEN) {
        entry.ws.send(JSON.stringify({
          type: 'chat_participants',
          chatKey,
          participants,
          selfConnectionId: entry.connectionId,
        }));
      }
    }
  }

  function findSessionFilePath(sessionDbId) {
    if (!sessionDbId) return null;
    // A non-id is refused by the path helper (WO-0041); here that is simply no such session.
    let fp;
    try { fp = getSessionFilePath(dataDir, sessionDbId); } catch { return null; }
    if (fs.existsSync(fp)) return fp;
    return null;
  }

  // Verify (and where possible heal) the session's character bindings. Runs at the
  // three safe anchors — session watch, resume, and turn fire — never mid-turn.
  // Unresolvable bindings surface as a visible system message instead of failing
  // silently (a dangling characterId is how sheets stopped updating in production).
  //
  // ── Why two of the four call sites await this and two do not ────────────────────────────
  // The asymmetry is deliberate, and it is safe for a reason that lives in another file, which
  // is why it has now been read as a race twice (WO-0015.5, and the review of it).
  //
  //   awaited      the two pre-turn checks. A turn must not start against a broken binding, so
  //                the DM's first Read has to see a healed session.
  //   not awaited  the two handshake checks (session_watch, session_resume). Awaiting them
  //                would put a file read, a directory scan and possibly a file copy in front of
  //                the session_access / turn_status frames the client is waiting on.
  //
  // **The writes are sequenced even though the calls are not — under a condition worth stating
  // exactly, because the first version of this comment claimed it unconditionally and was
  // wrong.** The claim that holds:
  //
  //     Two session.json writers cannot lose each other's update PROVIDED both go through
  //     updateSessionFile, the per-session serialised read-modify-write queue in
  //     player-data.js.
  //
  // Verified, not assumed: two concurrent updateSessionFile calls, the first deliberately slow
  // inside its mutator, both land. So a handshake check still in flight when a turn fires
  // cannot clobber the turn's write, and the mutation is idempotent besides
  // (heal-if-different, copy-if-absent, append-if-not-already-present).
  //
  // The condition is not free. A writer that calls writeJsonAtomic on session.json directly is
  // NOT sequenced against the queue, and loses: `routes/sessions.js` had five such writers on
  // live sessions and a route write during an in-flight queued update was lost 200 times out
  // of 200 (WO-0015.4). They now go through the queue; the only direct writes left in that
  // file are inside POST /sessions, on an id no client can hold yet, and they say so where
  // they are. `server/__tests__/mechanical-tools.test.js` scans every server file for new
  // ones, because this condition is invisible from the call site and has now had to be
  // rediscovered three times.
  //
  // If you are about to add `await` to the two handshake calls: it is not needed for
  // correctness, and it costs the handshake.
  //
  // `partOfTurn` says this call is the turn's own pre-turn check. Only such a call may mark the
  // per-turn notice flag — a handshake straggler settling mid-turn must not silence the
  // mechanical correction, which is the message built to catch the chair's original bug.
  async function runSessionIntegrityCheck(sessionDbId, { partOfTurn = false } = {}) {
    if (!sessionDbId) return;
    try {
      let appendedWarning = null;
      await updateSessionFile(dataDir, sessionDbId, (sess) => {
        const integrity = verifySessionIntegrity(dataDir, sess);
        let changed = integrity.changed;
        if (integrity.warnings.length > 0) {
          const text = `⚠️ Session integrity: ${integrity.warnings.join(' ')}`;
          const already = Array.isArray(sess.messages)
            && sess.messages.some(m => m && m.type === 'system' && m.text === text);
          if (!already) {
            if (!Array.isArray(sess.messages)) sess.messages = [];
            sess.messages.push({ type: 'system', text, timestamp: new Date().toISOString(), sessionId: sessionDbId });
            appendedWarning = text;
            changed = true;
          }
        }
        if (!changed) return false;
      });
      if (appendedWarning) {
        // Only the turn's own check may suppress this turn's mechanical correction. A handshake
        // check that lands mid-turn and shows a binding warning may therefore stack with a
        // correction — rare (it needs a broken binding), and the right way round: losing the
        // correction is worse than showing two system lines.
        if (partOfTurn) noteTurnNotice(sessionDbId, 'integrity');
        console.error(`[WS] ${appendedWarning} (session ${sessionDbId})`);
        broadcastSessionMessage(sessionDbId, 'session_player_message', {
          text: appendedWarning,
          timestamp: new Date().toISOString(),
          sessionId: sessionDbId,
        });
      }
    } catch (e) {
      console.error('[WS] Session integrity check error:', e);
    }
  }

  // The handshake checks are fire-and-forget on purpose (see runSessionIntegrityCheck), but
  // "nobody awaits it" and "nobody CAN await it" are different things. The promise is kept here
  // so a caller that needs quiescence — a test tearing down its tmp directory, a future
  // shutdown path — has something to wait on. Production behaviour is unchanged: nothing in the
  // request path awaits this.
  function scheduleSessionIntegrityCheck(sessionDbId) {
    if (!sessionDbId) return Promise.resolve();
    const pending = runSessionIntegrityCheck(sessionDbId).catch((e) => {
      console.error('[WS] Background session integrity check failed:', e && e.message);
    });
    const previous = backgroundWork.get(sessionDbId) || Promise.resolve();
    const chained = previous.then(() => pending);
    backgroundWork.set(sessionDbId, chained);
    chained.then(() => {
      if (backgroundWork.get(sessionDbId) === chained) backgroundWork.delete(sessionDbId);
    });
    return pending;
  }

  // A visible system message in the transcript, on the same channel runSessionIntegrityCheck
  // uses. Persisted into session.json so it survives a reload and is still there when the chair
  // scrolls back, then broadcast to everyone watching.
  async function emitSessionNotice(sessionDbId, text, kind, excludedEntry) {
    if (!text) return false;
    if (kind && hasTurnNotice(sessionDbId, 'integrity')) {
      console.warn(`[DM:INTEGRITY] ${kind} suppressed (an integrity message was already shown this turn): ${text}`);
      return false;
    }
    const message = { type: 'system', text, timestamp: new Date().toISOString(), sessionId: sessionDbId || null };
    if (sessionDbId) {
      try {
        await updateSessionFile(dataDir, sessionDbId, (sess) => {
          if (!Array.isArray(sess.messages)) sess.messages = [];
          sess.messages.push(message);
        });
      } catch (e) {
        console.error('[WS] Failed to persist session notice:', e.message);
      }
      broadcastSessionMessage(sessionDbId, 'session_player_message', message, excludedEntry || null);
    }
    if (kind) {
      noteTurnNotice(sessionDbId, kind);
      // Anything on the integrity channel counts as the integrity message for this turn, so a
      // permission notice and a mechanical correction cannot both interrupt the same scene.
      if (text.startsWith('⚠️ Session integrity:')) noteTurnNotice(sessionDbId, 'integrity');
    }
    return true;
  }

  // Every creature this session holds a sheet for — the party and its NPCs — as { name, file }.
  //
  // Two consumers, both in dm-audit:
  //   - buildMechanicalCorrection uses the NAMES to scope the in-transcript death correction: a
  //     death claim about a name on this list is a claim we can check; a death claim about a
  //     goblin is not, and the correction stays out of it.
  //   - the transfer check (WO-0032) uses the FILE to decide whether the sheet a narrated
  //     transfer implicates was actually written this turn. The file name is read off disk
  //     rather than derived from the name, so a sheet whose file name does not follow the
  //     slug convention is still matched correctly.
  //
  // Passed as a function so these two readdirs happen only on a turn that mentions a death or
  // narrates a transfer — which is not most turns.
  function sessionRosterSheets(sessionDbId) {
    if (!sessionDbId) return [];
    const sheets = [];
    const tiers = [
      { dir: getSessionCharactersDir(dataDir, sessionDbId), kind: 'character' },
      { dir: getSessionNpcsDir(dataDir, sessionDbId), kind: 'npc' },
    ];
    for (const { dir, kind } of tiers) {
      // Session-relative ("sessions/<id>/npcs"), so the audit can tell an Edit to THIS sheet from
      // an Edit to the player-library copy of the same creature, or to /tmp (WO-0032 S7).
      const rel = path.relative(dataDir, dir).split(path.sep).join('/');
      let files;
      try {
        files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
      } catch {
        continue; // no such tier in this session
      }
      for (const file of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
          // `kind` is what lets the audit resolve a pronoun: "you hand Eldon a coin" implicates a
          // player character, and a player character is a sheet under characters/ (WO-0032 S2).
          // `id` (WO-0032 revision 2) is what lets the audit tell the turn's SPEAKER from any
          // other player character: ws-handler holds the speaker's characterId, and without a
          // way to match it to a sheet, "you hand Eldon a coin" was satisfied by a write to any
          // of the six characters on this session's roster (Security R3 / QC N1).
          if (data && typeof data.name === 'string' && data.name.trim()) {
            sheets.push({ name: data.name.trim(), file, dir: rel, kind, id: typeof data.id === 'string' ? data.id : null });
          }
        } catch {
          // A sheet that will not parse is json-recovery's problem, not this function's. A name
          // we cannot read means one fewer name to check, never a wrong correction.
        }
      }
    }
    return sheets;
  }

  async function findSessionFilePathAsync(sessionDbId) {
    if (!sessionDbId) return null;
    // A non-id is refused by the path helper (WO-0041); here that is simply no such session.
    let fp;
    try { fp = getSessionFilePath(dataDir, sessionDbId); } catch { return null; }
    try { await fsp.access(fp); return fp; } catch { return null; }
  }

  function readSessionByDbId(sessionDbId) {
    const fp = findSessionFilePath(sessionDbId);
    if (!fp) return null;
    try { return JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch { return null; }
  }

  // The campaign a saved session.json names, or null when it names none or names something that is
  // not a well-formed campaign id (SR-50-5, WO-0050 revision 3). session.json is writable by the
  // GM's Edit tool, so this value is validated before it is trusted; null means "treat the turn as
  // a start", which the Premium gate then decides.
  function savedCampaignIdOf(session) {
    const cid = session && session.campaignId;
    return typeof cid === 'string' && SAFE_CAMPAIGN_ID.test(cid) ? cid : null;
  }

  async function readSessionByDbIdAsync(sessionDbId) {
    const fp = await findSessionFilePathAsync(sessionDbId);
    if (!fp) return null;
    try { return JSON.parse(await fsp.readFile(fp, 'utf-8')); } catch { return null; }
  }

  // Kept as a closure-local name because ~30 call sites in here use it. The implementation moved
  // to module scope (broadcastToSessionRoom, below) so that an HTTP route can reach it too; there
  // is one implementation, and one place that decides who is watching a session.
  function broadcastSessionMessage(sessionDbId, type, payload = {}, excludedEntry = null) {
    broadcastToSessionRoom(sessionDbId, type, payload, excludedEntry);
  }

  wss.on('connection', (ws) => {
    console.log('[WS] Client connected');

    const engine = _createEngine(dataDir);
    let characterId = null;
    let scenarioId = null;
    let campaignId = null;
    let companionConfig = null; // Host's NPC slot assignments (removed, open, reserved)
    let dmPersonality = null; // Session-scoped DM personality settings
    let processing = false;
    // WO-0050 revision 3 (SR-50-4). Set when this connection's last session_start or session_resume
    // was refused by the Premium gate; cleared by a successful session_start, session_resume, or an
    // owner's session_watch. While set, user_message is refused. The refusal therefore depends on
    // this flag, not on connection state the refused message had to mutate first.
    // Revision 4 (Part C): it holds the refusal payload itself (PREMIUM_REFUSAL, LOGIN_REFUSAL or
    // NO_EMAIL_REFUSAL) rather than `true`, so the refused user_message carries the start's words
    // and code. `false` still means "not refused".
    let startRefused = false;
    let messageHistory = []; // Track conversation for resume fallback
    let currentChatKey = null;
    let currentSessionDbId = null;
    let currentSessionCanWrite = false;

    // This connection's chat entry
    const wsEntry = {
      ws,
      playerEmail: null,
      playerName: null,
      isAdmin: false,
      connectionId: nextConnectionId++,
      // Called by companion handlers to force fresh DM context on next turn
      invalidateSession(contextMessage) {
        engine.sessionId = null;
        if (contextMessage) messageHistory.push({ type: 'player', text: contextMessage, sessionId: currentSessionDbId || undefined });
      },
    };

    // Pending permission requests: toolUseID -> { resolve }
    const pendingPermissions = new Map();

    function send(type, payload = {}) {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type, ...payload }));
      }
    }

    function leaveCurrentChatRoom() {
      if (currentChatKey && chatRooms.has(currentChatKey)) {
        const room = chatRooms.get(currentChatKey);
        room.delete(wsEntry);
        if (room.size === 0) {
          chatRooms.delete(currentChatKey);
        } else {
          broadcastChatParticipants(currentChatKey);
        }
      }
      currentChatKey = null;
    }

    function leaveCurrentSessionRoom() {
      if (currentSessionDbId && sessionRooms.has(currentSessionDbId)) {
        const prevSessionId = currentSessionDbId;
        const leaveName = wsEntry.playerName || wsEntry.playerEmail || 'Someone';
        const leaveNpcId = wsEntry.companionNpcId || null;
        const leaveCharacterName = wsEntry.companionCharacterName || null;
        const wasHost = wsEntry.isHost;
        const room = sessionRooms.get(currentSessionDbId);
        room.delete(wsEntry);
        if (room.size === 0) {
          sessionRooms.delete(currentSessionDbId);
          sessionTurns.delete(currentSessionDbId);
          companionSheetsSent.delete(currentSessionDbId);
          // Don't clear pendingTurns from session JSON — they persist
          // Schedule engine cleanup after grace period
          scheduleEngineCleanup(currentSessionDbId);
        } else {
          // Only broadcast leave for companion players (not host, not observers)
          if (!wasHost && leaveNpcId) {
            broadcastSessionMessage(prevSessionId, 'session_player_left', {
              playerEmail: wsEntry.playerEmail,
              playerName: leaveName,
              companionNpcId: leaveNpcId,
              companionCharacterName: leaveCharacterName,
            });
          }
          broadcastSessionParticipants(prevSessionId);
        }
      }
      currentSessionDbId = null;
      currentSessionCanWrite = false;
    }

    function getSessionParticipants(sessionDbId) {
      const live = sessionRooms.has(sessionDbId)
        ? Array.from(sessionRooms.get(sessionDbId))
            .filter(e => e.ws.readyState === e.ws.OPEN)
            .map(e => {
              const isObserver = !e.isHost && !e.companionNpcId;
              return {
                playerEmail: e.playerEmail || 'guest',
                playerName: e.playerName || 'Guest',
                isHost: !!e.isHost,
                isObserver,
                isAway: false,
                characterName: e.characterName || null,
                companionNpcId: e.companionNpcId || null,
                companionCharacterName: e.companionCharacterName || null,
                companionCharacterId: e.companionCharacterId || null,
              };
            })
        : [];

      // Include disconnected companion players as "away" from persisted session data
      const session = readSessionByDbId(sessionDbId);
      if (session && session.companionPlayers) {
        const liveNpcIds = new Set(live.filter(p => p.companionNpcId).map(p => p.companionNpcId));
        for (const [npcId, cp] of Object.entries(session.companionPlayers)) {
          if (!liveNpcIds.has(npcId) && cp.email) {
            live.push({
              playerEmail: cp.email,
              playerName: cp.name || cp.email,
              isHost: false,
              isObserver: false,
              isAway: true,
              characterName: null,
              companionNpcId: npcId,
              companionCharacterName: cp.characterName || null,
              companionCharacterId: cp.characterId || null,
            });
          }
        }
      }

      return live;
    }

    function broadcastSessionParticipants(sessionDbId) {
      if (!sessionRooms.has(sessionDbId)) return;
      const participants = getSessionParticipants(sessionDbId);
      for (const entry of sessionRooms.get(sessionDbId)) {
        if (entry.ws.readyState === entry.ws.OPEN) {
          entry.ws.send(JSON.stringify({
            type: 'session_participants',
            sessionDbId,
            participants,
          }));
        }
      }
    }

    // Get all joined companion emails from the session file (not just connected ones)
    function getJoinedCompanionEmails(sessionDbId) {
      const session = readSessionByDbId(sessionDbId);
      if (!session || !session.companionPlayers) return [];
      return Object.values(session.companionPlayers)
        .filter(cp => cp && cp.email)
        .map(cp => cp.email);
    }

    function broadcastTurnStatus(sessionDbId) {
      if (!sessionRooms.has(sessionDbId)) return;
      // Count ALL joined companions (from session file), not just connected ones
      const joinedEmails = getJoinedCompanionEmails(sessionDbId);
      const joinedCompanionCount = joinedEmails.length;
      // Check host turn from in-memory sessionTurns (host stores turn with npcId=null)
      const allTurns = sessionTurns.has(sessionDbId)
        ? Array.from(sessionTurns.get(sessionDbId).values())
        : [];
      const hostSubmitted = allTurns.some(t => t.isHost);
      const submittedEmails = allTurns.filter(t => !t.isHost).map(t => t.playerEmail);
      const companionSubmittedCount = joinedEmails.filter(email => submittedEmails.includes(email)).length;
      const submittedCount = (hostSubmitted ? 1 : 0) + companionSubmittedCount;
      const allReady = hostSubmitted && (joinedCompanionCount === 0 || companionSubmittedCount >= joinedCompanionCount);
      const pendingTurns = allTurns.map(t => ({
        playerEmail: t.playerEmail,
        playerName: t.playerName,
        npcId: t.npcId,
        npcName: t.npcName || null,
        characterName: t.characterName || null,
        text: t.text,
        isHost: !!t.isHost,
      }));
      for (const entry of sessionRooms.get(sessionDbId)) {
        if (entry.ws.readyState === entry.ws.OPEN) {
          entry.ws.send(JSON.stringify({
            type: 'turn_status',
            sessionDbId,
            hostSubmitted,
            pendingTurns,
            joinedCompanionCount,
            submittedCount,
            allReady,
          }));
        }
      }
    }

    function checkAutoFire(sessionDbId) {
      broadcastTurnStatus(sessionDbId);
      if (!sessionRooms.has(sessionDbId)) return;
      const allTurns = sessionTurns.has(sessionDbId)
        ? Array.from(sessionTurns.get(sessionDbId).values())
        : [];
      const hostTurn = allTurns.find(t => t.isHost);
      if (!hostTurn) return;
      // Check against ALL joined companions (from session file), not just connected ones
      const joinedEmails = getJoinedCompanionEmails(sessionDbId);
      if (joinedEmails.length === 0) {
        // No companions joined yet — on first turn, wait 30s for companions to arrive
        if (!sessionFirstFireTimers.has(sessionDbId)) {
          console.log(`[WS] First turn with no companions — waiting 30s for joins (session: ${sessionDbId})`);
          const timer = setTimeout(() => {
            sessionFirstFireTimers.delete(sessionDbId);
            // Re-check: if companions joined during the wait, let normal flow handle it
            const nowJoined = getJoinedCompanionEmails(sessionDbId);
            if (nowJoined.length > 0) {
              checkAutoFire(sessionDbId);
            } else {
              fireDmForSession(sessionDbId);
            }
          }, 30_000);
          sessionFirstFireTimers.set(sessionDbId, timer);
        }
        return;
      }
      // If companions joined during the grace period, cancel the timer
      if (sessionFirstFireTimers.has(sessionDbId)) {
        clearTimeout(sessionFirstFireTimers.get(sessionDbId));
        sessionFirstFireTimers.delete(sessionDbId);
      }
      const submittedEmails = allTurns.filter(t => !t.isHost).map(t => t.playerEmail);
      const allReady = joinedEmails.every(email => submittedEmails.includes(email));
      if (!allReady) return;

      // Everyone is ready — fire DM
      fireDmForSession(sessionDbId);
    }

    async function fireDmForSession(sessionDbId) {
      if (!sessionRooms.has(sessionDbId)) return;
      const allTurns = sessionTurns.has(sessionDbId)
        ? Array.from(sessionTurns.get(sessionDbId).values())
        : [];
      const hostTurn = allTurns.find(t => t.isHost);
      if (!hostTurn) return;
      const companionTurnsArr = allTurns.filter(t => !t.isHost);

      // Get or create session engine
      const session = await readSessionByDbIdAsync(sessionDbId);
      if (!session) return;
      // SR-50-5 (WO-0050 revision 3): session.json is GM-writable, so a campaignId that is present
      // but not a well-formed id is refused rather than joined into paths. Absent still means demo.
      if (session.campaignId != null && !savedCampaignIdOf(session)) {
        console.error(`[WS] Refusing to fire session ${sessionDbId}: its saved campaignId is not a valid id`);
        broadcastSessionMessage(sessionDbId, 'error', { error: 'This saved game names an invalid campaign.' });
        return;
      }
      const ownerEmail = getSessionOwnerEmail(session);
      const existingCtx = sessionEngines.get(sessionDbId);
      const engineCtx = getOrCreateSessionEngine(sessionDbId, dataDir, {
        characterId: session.characterId,
        scenarioId: session.scenarioId,
        campaignId: savedCampaignIdOf(session) || 'demo',
        ownerEmail,
        claudeSessionId: session.claudeSessionId,
        messageHistory: existingCtx?.messageHistory || [],
        companionConfig: session.companionConfig || null,
        dmPersonality: session.dmPersonality || null,
      });

      // Build the combined player text (host + companion actions)
      let playerText = hostTurn.text;
      if (companionTurnsArr.length > 0) {
        const companionActions = companionTurnsArr.map(t => {
          const charLabel = t.characterName || t.npcName || t.npcId;
          const swapNote = t.characterName && t.npcName
            ? ` (playing their own character ${t.characterName}, who has replaced ${t.npcName} in the party)`
            : '';
          let line = `[Companion player ${t.playerName} as ${charLabel}${swapNote}]: ${t.text}`;
          // Include character sheet only on first turn with this character
          const sheetKey = t.characterId || t.characterName;
          if (!companionSheetsSent.has(sessionDbId)) companionSheetsSent.set(sessionDbId, new Set());
          const sentSheets = companionSheetsSent.get(sessionDbId);
          if (t.characterData && t.characterName && sheetKey && !sentSheets.has(sheetKey)) {
            sentSheets.add(sheetKey);
            try {
              const cd = t.characterData;
              const fmtArr = (val) => Array.isArray(val) ? val.map(v => typeof v === 'string' ? v : v.name || JSON.stringify(v)).join(', ') : '';
              const abilities = cd.abilities ? Object.entries(cd.abilities).map(([k,v]) => `${k.toUpperCase()}:${v.score}(${v.modifier >= 0 ? '+' : ''}${v.modifier})`).join(' ') : '';
              const hp = cd.hitPoints ? `HP:${cd.hitPoints.current}/${cd.hitPoints.max}` : '';
              const spellsL1 = cd.spells?.level1 ? (Array.isArray(cd.spells.level1) ? cd.spells.level1 : cd.spells.level1.known || []) : [];
              const sheet = [
                `${cd.name} — Level ${cd.level} ${cd.subrace || ''} ${cd.race} ${cd.class}`,
                `${hp} AC:${cd.armorClass || '?'} Speed:${cd.speed || '?'} Prof:+${cd.proficiencyBonus || 2}`,
                abilities,
                cd.equipment ? `Equipment: ${fmtArr(cd.equipment)}` : '',
                cd.weapons ? `Weapons: ${fmtArr(cd.weapons)}` : '',
                cd.spells?.cantrips ? `Cantrips: ${fmtArr(cd.spells.cantrips)}` : '',
                spellsL1.length > 0 ? `Level 1 spells (${cd.spells.level1.slots || '?'} slots): ${fmtArr(spellsL1)}` : '',
                cd.features ? `Features: ${fmtArr(cd.features)}` : '',
              ].filter(Boolean).join('\n  ');
              line += `\n  [Character Sheet: ${sheet}]`;
            } catch (sheetErr) {
              console.error('[WS] Error formatting companion character sheet:', sheetErr);
              line += `\n  [Character Sheet: ${t.characterName} — see character file for details]`;
            }
          }
          return line;
        }).join('\n');
        playerText += `\n\n--- Companion Actions ---\n${companionActions}`;
      }

      // Broadcast companion actions as separate messages
      // Exclude the submitter (they already added the message locally on submit)
      for (const t of companionTurnsArr) {
        const charLabel = t.characterName || t.npcName || t.npcId;
        const submitterEntry = Array.from(sessionRooms.get(sessionDbId) || [])
          .find(e => e.playerEmail === t.playerEmail);
        broadcastSessionMessage(sessionDbId, 'companion_action', {
          characterName: charLabel,
          playerName: t.playerName,
          playerEmail: t.playerEmail,
          text: t.text,
          timestamp: new Date().toISOString(),
          sessionId: sessionDbId,
        }, submitterEntry);
      }

      // Host's player message was already broadcast when queued — no duplicate needed

      // Clear pending turns
      sessionTurns.delete(sessionDbId);
      broadcastSessionTurns(sessionDbId);
      await clearPendingTurns(sessionDbId);
      broadcastTurnStatus(sessionDbId);

      // Broadcast sessions_changed so widgets refresh
      broadcastToAll('sessions_changed');

      // Fire DM engine
      const { engine } = engineCtx;
      engineCtx.messageHistory.push({ type: 'player', text: playerText, sessionId: sessionDbId });

      // Gather active companion players for system prompt
      const activeCompanions = sessionRooms.has(sessionDbId)
        ? Array.from(sessionRooms.get(sessionDbId))
            .filter(e => e.companionNpcId && e.ws.readyState === e.ws.OPEN)
            .map(e => ({
              playerEmail: e.playerEmail,
              playerName: e.playerName,
              companionNpcId: e.companionNpcId,
              companionCharacterName: e.companionCharacterName || null,
              companionCharacterId: e.companionCharacterId || null,
            }))
        : [];

      // Set status to thinking for all watchers (broadcastSessionMessage with no excludedEntry sends to ALL)
      for (const entry of (sessionRooms.get(sessionDbId) || [])) {
        if (entry.ws.readyState === entry.ws.OPEN) {
          entry.ws.send(JSON.stringify({ type: 'session_status', status: 'thinking' }));
        }
      }

      try {
        // Snapshot session data dir if needed
        const cid = engineCtx.campaignId || 'demo';
        try { snapshotToSession(dataDir, sessionDbId, ownerEmail, cid); } catch (e) { console.error('[WS] Snapshot error:', e); }
        beginTurnNotices(sessionDbId);
        await runSessionIntegrityCheck(sessionDbId, { partOfTurn: true });

        // Load world state and summary counter from session for context persistence
        const sessionForState = await readSessionByDbIdAsync(sessionDbId);
        const worldState = sessionForState?.worldState || undefined;
        const dmMessagesSinceLastSummary = sessionForState?.dmMessagesSinceLastSummary || 0;
        const arcSummaries = sessionForState?.arcSummaries || undefined;

        const stream = engine.run(playerText, {
          characterId: engineCtx.characterId,
          scenarioId: engineCtx.scenarioId,
          campaignId: engineCtx.campaignId,
          messageHistory: engineCtx.messageHistory,
          // No onPermissionRequest on this path — there is no single player to ask, so a tool
          // that needs approval is declined. onSessionNotice is what makes that audible
          // (condition M6(b), ETHICS.md Review 3 §M2.2). A real host-facing modal for
          // multiplayer is a recommendation, not a condition, and is not in this work order.
          onSessionNotice: (text) => { emitSessionNotice(sessionDbId, text, 'permission').catch(() => {}); },
          playerEmail: ownerEmail,
          companionPlayers: activeCompanions.length > 0 ? activeCompanions : undefined,
          sessionDbId,
          companionConfig: engineCtx.companionConfig || undefined,
          dmPersonality: engineCtx.dmPersonality || undefined,
          worldState,
          dmMessagesSinceLastSummary,
          arcSummaries,
        });

        const auditToolCalls = [];
        const auditOutcomes = [];
        let auditDmText = '';
        // The player side of the turn, kept in the same scope as auditDmText so the reconcile
        // loop can re-audit it (WO-0032 S4) rather than re-checking the DM narration alone.
        let auditPlayerText = '';
        let auditWarnings = [];
        // The player character(s) whose turn this is, in the same scope for the same reason.
        let turnSpeakers = [];
        // Ordered record of every renderable event emitted during this turn (DM narration chunks
        // and dice rolls, in stream order). Used at dm_complete to persist the canonical full
        // turn — the previous code only saved the final dm_response and no dice rolls, so a host
        // who disconnected mid-turn would lose every intermediate combat chunk.
        const turnEvents = [];
        for await (const event of stream) {
          switch (event.type) {
            case 'dm_partial':
              broadcastSessionMessage(sessionDbId, 'dm_partial', { text: event.text });
              break;
            case 'dm_warmup':
              // Phase 4: Show warm-up status to all session participants
              broadcastSessionMessage(sessionDbId, 'dm_warmup', { text: event.text, visible: true });
              break;
            case 'dice_roll':
              broadcastSessionMessage(sessionDbId, 'dice_roll', {
                notation: event.notation, rolls: event.rolls,
                modifier: event.modifier, total: event.total, label: event.label,
              });
              turnEvents.push({ type: 'dice_roll', text: formatDiceRoll(event) });
              break;
            case 'scene_image':
              // Scene imagery (docs/adr/0002-scene-imagery.md §7). Same path as dice_roll:
              // broadcast to every watcher, and record in turnEvents so persistCanonicalTurn
              // writes it into session.messages in stream order.
              // The payload carries ids and text, never a path and never a URL — the browser
              // builds the URL from campaignId + assetId, so its request goes back through the
              // asset route's manifest lookup.
              broadcastSessionMessage(sessionDbId, 'scene_image', {
                assetId: event.assetId, kind: event.kind, title: event.title,
                alt: event.alt, caption: event.caption, text: event.text,
              });
              turnEvents.push({
                type: 'scene_image', assetId: event.assetId, kind: event.kind,
                title: event.title, alt: event.alt, caption: event.caption, text: event.text,
              });
              break;
            case 'tool_use':
              auditToolCalls.push({ name: event.name, input: event.input });
              break;
            case 'mechanical_outcome':
              // The ledger of what the server computed (ADR 0005 §10). Not shown to players —
              // the audit compares it against what the DM said happened.
              auditOutcomes.push(event);
              break;
            case 'dm_response':
              engineCtx.messageHistory.push({ type: 'dm', text: event.text, sessionId: sessionDbId });
              auditDmText += (auditDmText ? '\n\n' : '') + event.text;
              broadcastSessionMessage(sessionDbId, 'dm_response', { text: event.text });
              turnEvents.push({ type: 'dm', text: event.text });
              break;
            case 'dm_complete':
              broadcastSessionMessage(sessionDbId, 'dm_complete', { sessionId: event.sessionId });
              try {
                // Scan raw host + companion turn texts (not the assembled playerText, which embeds
                // character sheets whose equipment can contain "X gp" and would false-positive).
                auditPlayerText = [hostTurn.text, ...companionTurnsArr.map(t => t.text)]
                  .filter(Boolean).join('\n');
                // The roster is passed to both scans so a transfer that writes only one of its
                // two sides is caught (WO-0032). Lazy: resolved only if a transfer is narrated.
                const rosterSheets = () => sessionRosterSheets(sessionDbId);
                // Who spoke this turn: the host's character plus any companion player's. A
                // pronoun or an elided party in a transfer must be matched against one of THESE
                // sheets, not against any character on the roster (revision 2).
                //
                // REVISION 3 (Security R2-1). The companion half used to read
                // `t.characterId || t.characterName`, and `t.characterId` came straight off the
                // wire: `companion_turn_submit` takes `msg.characterId` unvalidated, and the
                // host-character rejection at `companion_set_character` does not cover the
                // per-turn field. A companion could therefore nominate any of the session's
                // character sheets as a speaker and widen this check to include it — executed:
                // speakers `[Zephyr, Thorin]` is silent where `[Zephyr]` warns, and a VALID other
                // character's id widens it without even producing the `speaker-unresolved` log a
                // bogus one would. It is now `t.speakerCharacterId`, which the submit handler
                // takes from `wsEntry.companionCharacterId` — the claim the server persisted and
                // broadcast — and the display-name fallback is gone, because a label a client
                // chooses should not decide a check. Ceiling was revision 1's any-character rule,
                // so this closed a widening, not an escalation.
                turnSpeakers = [engineCtx.characterId, ...companionTurnsArr.map(t => t.speakerCharacterId)]
                  .filter(Boolean);
                const auditOpts = { speakers: turnSpeakers, outcomes: auditOutcomes };
                auditWarnings = dedupeWarningsByCategory([
                  ...auditDmTurn(auditDmText, auditToolCalls, auditOutcomes, rosterSheets, auditOpts),
                  ...auditPlayerTurn(auditPlayerText, auditToolCalls, rosterSheets, auditOpts),
                ]);
                logAuditTrace(sessionDbId, auditDmText, auditToolCalls, auditWarnings);
                const formatted = formatWarnings(auditWarnings, sessionDbId);
                if (formatted) console.warn(formatted);
                const correction = buildMechanicalCorrection(auditDmText, auditOutcomes, rosterSheets);
                if (correction) {
                  console.warn(`[DM:INTEGRITY] ${correction.kind} session=${sessionDbId} ${correction.text}`);
                  await emitSessionNotice(sessionDbId, correction.text, correction.kind);
                }
              } catch (e) { console.error('[DM:AUDIT] error:', e); }
              // Persist the full ordered turn (player + companions + every DM chunk + every
              // dice roll) to the session JSON, reconciling against whatever partial fragment
              // the host's client managed to write before any disconnect. The server is
              // authoritative for the turn boundary; idempotent against a connected host whose
              // own auto-save already captured the complete turn.
              try {
                const turnTimestamp = new Date().toISOString();
                const playerMsg = { type: 'player', text: hostTurn.text, timestamp: turnTimestamp, sessionId: sessionDbId };
                const companionMsgs = companionTurnsArr.map(ct => ({
                  type: 'companion',
                  characterName: ct.characterName || ct.npcName || ct.npcId,
                  playerName: ct.playerName,
                  text: ct.text,
                  timestamp: turnTimestamp,
                  sessionId: sessionDbId,
                }));
                const stampedTurnEvents = turnEvents.map(te => ({ ...te, timestamp: turnTimestamp, sessionId: sessionDbId }));
                let lastDmText = null;
                for (let i = turnEvents.length - 1; i >= 0; i--) {
                  if (turnEvents[i].type === 'dm') { lastDmText = turnEvents[i].text; break; }
                }

                await updateSessionFile(dataDir, sessionDbId, (sess) => {
                  persistCanonicalTurn(sess, {
                    sessionDbId,
                    claudeSessionId: event.sessionId,
                    playerMsg,
                    companionMsgs,
                    stampedTurnEvents,
                    lastDmText,
                  });
                });
              } catch (e) { console.error('[WS] Failed to persist multiplayer turn:', e); }
              break;
            case 'session_id':
              broadcastSessionMessage(sessionDbId, 'session_id', { sessionId: event.sessionId });
              break;
            case 'error':
              broadcastSessionMessage(sessionDbId, 'error', describeEngineError(event.error));
              break;
          }
        }

        // Enforcement: apply any narrated-but-unsaved stat changes before the turn's `finally`
        // emits 'idle'. Status stays 'thinking' (Ready stays off) until this resolves.
        await reconcileTurnIfNeeded({
          engine,
          warnings: auditWarnings,
          auditDmText,
          auditPlayerText,
          auditToolCalls,
          auditOutcomes,
          knownEntities: () => sessionRosterSheets(sessionDbId),
          speakers: turnSpeakers,
          runOpts: {
            onSessionNotice: (text) => { emitSessionNotice(sessionDbId, text, 'permission').catch(() => {}); },
            characterId: engineCtx.characterId,
            scenarioId: engineCtx.scenarioId,
            campaignId: engineCtx.campaignId,
            playerEmail: ownerEmail,
            companionPlayers: activeCompanions.length > 0 ? activeCompanions : undefined,
            sessionDbId,
            companionConfig: engineCtx.companionConfig || undefined,
            dmPersonality: engineCtx.dmPersonality || undefined,
            worldState,
          },
        });
      } catch (err) {
        console.error('[WS] DM engine error (multiplayer fire):', err);
        broadcastSessionMessage(sessionDbId, 'error', describeEngineError(err.message));
      } finally {
        // Set status to idle for all
        for (const entry of (sessionRooms.get(sessionDbId) || [])) {
          if (entry.ws.readyState === entry.ws.OPEN) {
            entry.ws.send(JSON.stringify({ type: 'session_status', status: 'idle' }));
          }
        }
      }
    }

    function joinSessionRoom(sessionDbId, canWrite) {
      // Skip re-join if already in this room (e.g. host re-watches on save)
      if (currentSessionDbId === sessionDbId) {
        currentSessionCanWrite = !!canWrite;
        wsEntry.isHost = !!canWrite;
        return;
      }
      leaveCurrentSessionRoom();
      currentSessionDbId = sessionDbId;
      currentSessionCanWrite = !!canWrite;
      wsEntry.isHost = !!canWrite;
      if (!sessionRooms.has(sessionDbId)) sessionRooms.set(sessionDbId, new Set());
      sessionRooms.get(sessionDbId).add(wsEntry);
      // Only broadcast join for companion players (not host, not observers)
      if (!canWrite && wsEntry.companionNpcId) {
        const joinName = wsEntry.playerName || wsEntry.playerEmail || 'Someone';
        broadcastSessionMessage(sessionDbId, 'session_player_joined', {
          playerEmail: wsEntry.playerEmail,
          playerName: joinName,
          isHost: false,
          companionNpcId: wsEntry.companionNpcId || null,
        }, wsEntry);
      }
      broadcastSessionParticipants(sessionDbId);
    }

    function broadcastToSessionWatchers(type, payload = {}) {
      if (!currentSessionDbId) return;
      broadcastSessionMessage(currentSessionDbId, type, payload, wsEntry);
    }

    function joinChatRoom(chatKey, playerEmail, playerName, isAdmin) {
      leaveCurrentChatRoom();
      currentChatKey = chatKey;
      wsEntry.playerEmail = playerEmail;
      wsEntry.playerName = playerName;
      wsEntry.isAdmin = !!isAdmin;
      if (!chatRooms.has(chatKey)) chatRooms.set(chatKey, new Set());
      chatRooms.get(chatKey).add(wsEntry);
      broadcastChatParticipants(chatKey);
      console.log(`[WS] Chat joined — key: ${chatKey}, player: ${playerEmail}, room size: ${chatRooms.get(chatKey).size}`);
    }

    // One failing message must cost that message, not the process: the switch below is async and
    // a throw inside it (e.g. a refused session id reaching a guarded path helper, WO-0041) would
    // otherwise be an unhandled rejection, and Node exits on those.
    ws.on('message', (raw) => {
      handleWsMessage(raw).catch((err) => {
        console.error('[WS] message handler failed:', err && err.message);
        try { send('error', { error: 'That request could not be processed.' }); } catch { /* socket gone */ }
      });
    });

    const handleWsMessage = async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        send('error', { error: 'Invalid JSON' });
        return;
      }

      switch (msg.type) {
        case 'session_start': {
          // Login gate (WO-0050 revision 4, Part C). Before the Premium gate and, like it, before any
          // connection state is assigned: a refusal sets only `startRefused` (so the next unbound
          // user_message is refused with the same payload) and unbinds the session room, as any
          // start does. Covers empty, `guest` and every email with no record in players.json, in
          // every campaign. An empty email used to get this message with no code and no
          // `startRefused`; it now gets both.
          if (!isRegisteredEmail(dataDir, msg.playerEmail)) {
            const refusal = msg.playerEmail ? LOGIN_REFUSAL : NO_EMAIL_REFUSAL;
            startRefused = refusal;
            leaveCurrentSessionRoom();
            send('error', refusal);
            console.log(`[WS] Session start refused (login required) — player: ${msg.playerEmail || '(none)'}`);
            break;
          }
          // Premium gate (WO-0050), checked BEFORE any connection state is assigned (revision 3,
          // SR-50-4). Revisions 1-2 assigned campaign/scenario/character first and refused after,
          // so a refused start arriving mid-turn swapped the in-flight turn's inputs. Now a refusal
          // assigns nothing but `startRefused` and unbinds the session room (what any start does;
          // the in-flight turn has its own pinned session id, so unbinding cannot redirect it).
          // An ill-formed campaignId is left to the existing "Invalid campaignId." check below.
          {
            const requested = msg.campaignId == null ? null
              : (typeof msg.campaignId === 'string' && SAFE_CAMPAIGN_ID.test(msg.campaignId) ? msg.campaignId : undefined);
            if (requested !== undefined
                && !canStartCampaign(getPremiumAccessForEmail(dataDir, msg.playerEmail), requested || 'demo')) {
              startRefused = PREMIUM_REFUSAL;
              leaveCurrentSessionRoom();
              send('error', PREMIUM_REFUSAL);
              console.log(`[WS] Session start refused (premium gate) — campaign: ${requested || 'demo'}, player: ${msg.playerEmail}`);
              break;
            }
          }
          leaveCurrentSessionRoom();
          // Reset engine and history for a clean slate
          engine.sessionId = null;
          messageHistory = [];
          characterId = msg.characterId || null;
          scenarioId = msg.scenarioId || null;
          // A campaign id is a string or absent. `String(['demo'])` is 'demo', so without the type check an
          // array passed the regex and reached the engine and the path helpers (SR-50-3, WO-0050).
          if (msg.campaignId != null && (typeof msg.campaignId !== 'string' || !SAFE_CAMPAIGN_ID.test(msg.campaignId))) {
            send('error', { error: 'Invalid campaignId.' });
            break;
          }
          campaignId = msg.campaignId || null;
          companionConfig = msg.companionConfig || null;
          dmPersonality = msg.dmPersonality || null;
          wsEntry.playerEmail = msg.playerEmail;
          wsEntry.campaignId = campaignId;
          wsEntry.characterId = characterId;
          startRefused = false;
          // Clear companion state from previous session
          wsEntry.companionNpcId = null;
          wsEntry.companionCharacterId = null;
          wsEntry.companionCharacterName = null;
          wsEntry.companionCharacterData = null;
          wsEntry.isHost = true;
          // Clear stale participants on the client
          send('session_participants', { sessionDbId: null, participants: [] });
          // Look up character name for participants broadcast
          wsEntry.characterName = null;
          if (characterId && msg.playerEmail) {
            // Check player library for character name
            const dirsToCheck = [getPlayerCharactersDir(dataDir, msg.playerEmail, campaignId || 'demo')];
            for (const charDir of dirsToCheck) {
              try {
                for (const f of fs.readdirSync(charDir).filter(f => f.endsWith('.json'))) {
                  const d = JSON.parse(fs.readFileSync(path.join(charDir, f), 'utf-8'));
                  if (d.id === characterId) { wsEntry.characterName = d.name; break; }
                }
              } catch { /* ignore */ }
              if (wsEntry.characterName) break;
            }
          }
          if (msg.playerName) wsEntry.playerName = msg.playerName;
          send('session_status', { status: 'idle' });
          console.log(`[WS] Session started — character: ${characterId}, scenario: ${scenarioId}, campaign: ${campaignId}, player: ${wsEntry.playerEmail}`);
          break;
        }

        case 'session_resume': {
          if (!msg.playerEmail) {
            send('error', { error: 'playerEmail is required to resume a session.' });
            break;
          }
          // Prevent non-owners from resuming a session they're watching/companion in
          if (currentSessionDbId && !currentSessionCanWrite) {
            send('error', { error: 'Only the session host can resume this session.' });
            break;
          }
          // Detect session or campaign switch and force a fresh Claude conversation
          // to prevent cross-contamination (e.g. Shattered Coast context bleeding
          // into a Wonderland session).
          const prevClaudeId = engine.sessionId;
          const newClaudeId = msg.claudeSessionId || null;
          const prevCampaignId = campaignId;
          // A campaign id is a string or absent. `String(['demo'])` is 'demo', so without the type check an
          // array passed the regex and reached the engine and the path helpers (SR-50-3, WO-0050).
          if (msg.campaignId != null && (typeof msg.campaignId !== 'string' || !SAFE_CAMPAIGN_ID.test(msg.campaignId))) {
            send('error', { error: 'Invalid campaignId.' });
            break;
          }
          const newCampaignId = msg.campaignId || null;
          // Premium gate (WO-0050). Resuming a SAVED game is not gated. But this message carries
          // its own campaignId, so with no saved session bound — or a saved session in a different
          // campaign — it would start a new adventure in any campaign it names. That case is a
          // start, and is gated like one. Refused before any state changes.
          if (!canStartCampaign(getPremiumAccessForEmail(dataDir, msg.playerEmail), newCampaignId || 'demo')) {
            const saved = currentSessionDbId ? readSessionByDbId(currentSessionDbId) : null;
            const resumesSavedGame = !!savedCampaignIdOf(saved) && savedCampaignIdOf(saved) === (newCampaignId || 'demo');
            if (!resumesSavedGame) {
              startRefused = PREMIUM_REFUSAL;
              send('error', PREMIUM_REFUSAL);
              console.log(`[WS] Session resume refused (premium gate, no saved game in that campaign) — campaign: ${newCampaignId || 'demo'}, player: ${msg.playerEmail}`);
              break;
            }
          }
          const isSameClaudeSession = prevClaudeId && newClaudeId && prevClaudeId === newClaudeId;
          const isCampaignSwitch = prevCampaignId && newCampaignId && prevCampaignId !== newCampaignId;

          if (isCampaignSwitch) {
            console.log(`[WS] Campaign switch detected — forcing fresh Claude session (${prevCampaignId} → ${newCampaignId})`);
          } else if (prevClaudeId && !isSameClaudeSession) {
            console.log(`[WS] Session switch detected — forcing fresh Claude session (was: ${prevClaudeId}, switching to: ${newClaudeId || 'new'})`);
          }

          characterId = msg.characterId || null;
          scenarioId = msg.scenarioId || null;
          campaignId = newCampaignId;
          companionConfig = msg.companionConfig || null;
          dmPersonality = msg.dmPersonality || null;
          // Use the new session's Claude ID, UNLESS switching campaigns —
          // in which case force null to start a fresh conversation with the
          // correct system prompt. Claude's old conversation context would
          // have the wrong campaign's characters, NPCs, and scenario.
          engine.sessionId = isCampaignSwitch ? null : newClaudeId;
          startRefused = false;
          wsEntry.playerEmail = msg.playerEmail;
          wsEntry.campaignId = campaignId;
          wsEntry.characterId = characterId;
          wsEntry.characterName = null;
          // Clear companion state from previous session (host resuming their own game)
          wsEntry.companionNpcId = null;
          wsEntry.companionCharacterId = null;
          wsEntry.companionCharacterName = null;
          wsEntry.companionCharacterData = null;
          if (characterId && msg.playerEmail) {
            // Check session dir first (if resuming), then player library
            const dirsToCheck = [];
            if (currentSessionDbId) dirsToCheck.push(getSessionCharactersDir(dataDir, currentSessionDbId));
            dirsToCheck.push(getPlayerCharactersDir(dataDir, msg.playerEmail, campaignId || 'demo'));
            for (const charDir of dirsToCheck) {
              try {
                for (const f of fs.readdirSync(charDir).filter(f => f.endsWith('.json'))) {
                  const d = JSON.parse(fs.readFileSync(path.join(charDir, f), 'utf-8'));
                  if (d.id === characterId) { wsEntry.characterName = d.name; break; }
                }
              } catch { /* ignore */ }
              if (wsEntry.characterName) break;
            }
          }
          if (msg.playerName) wsEntry.playerName = msg.playerName;
          // Store message history for resume fallback
          if (msg.messages && Array.isArray(msg.messages)) {
            messageHistory = msg.messages;
          }
          // Rolling compaction runs here, at resume — the one race-free moment where the
          // client's in-memory history equals the file (it just loaded it) and no player
          // turn has happened yet, so the server can archive + condense + trim authoritatively.
          if (currentSessionDbId && messageHistory.length > 0) {
            try {
              const result = await maybeCompact(dataDir, currentSessionDbId, {
                summarize: (text) => summarizeFn(text, { dataDir, playerEmail: wsEntry.playerEmail }),
              });
              if (result && result.compacted) {
                messageHistory = result.liveMessages;
                const ctx = sessionEngines.get(currentSessionDbId);
                if (ctx) ctx.messageHistory = result.liveMessages;
                broadcastSessionMessage(currentSessionDbId, 'session_compacted', {
                  messages: result.liveMessages,
                  arcSummaries: result.arcSummaries,
                  archiveSeq: result.archiveSeq,
                });
                console.log(`[WS] Resume compaction — session ${currentSessionDbId}: archived ${result.archivedCount}, live=${result.liveMessages.length}, seq=${result.archiveSeq}`);
              }
            } catch (e) {
              console.error('[WS] Resume compaction error:', e);
            }
          }
          // Fire-and-forget (see runSessionIntegrityCheck); the pre-turn check is blocking.
          scheduleSessionIntegrityCheck(currentSessionDbId);
          send('session_status', { status: 'idle' });
          console.log(`[WS] Session resumed — claude: ${engine.sessionId}, character: ${characterId}, scenario: ${scenarioId}, campaign: ${campaignId}, player: ${wsEntry.playerEmail}, history: ${messageHistory.length} messages`);
          break;
        }

        case 'chat_join': {
          const { chatKey, playerEmail, playerName, isAdmin } = msg;
          if (chatKey && playerEmail) {
            joinChatRoom(chatKey, playerEmail, playerName || playerEmail, isAdmin || false);
          }
          break;
        }

        case 'chat_typing': {
          if (currentChatKey && chatRooms.has(currentChatKey)) {
            for (const entry of chatRooms.get(currentChatKey)) {
              if (entry !== wsEntry && entry.ws.readyState === entry.ws.OPEN) {
                entry.ws.send(JSON.stringify({
                  type: 'chat_typing',
                  playerEmail: wsEntry.playerEmail,
                  playerName: wsEntry.playerName,
                  typing: !!msg.typing,
                }));
              }
            }
          }
          break;
        }

        case 'chat_message': {
          const { text, playerEmail, playerName, isAdmin } = msg;
          if (!text || !text.trim()) break;
          const chatMsg = {
            playerEmail: playerEmail || wsEntry.playerEmail || 'guest',
            playerName: playerName || wsEntry.playerName || 'Guest',
            isAdmin: isAdmin || wsEntry.isAdmin || false,
            text: text.trim(),
            timestamp: new Date().toISOString(),
          };
          // Broadcast to all in same chat room
          if (currentChatKey && chatRooms.has(currentChatKey)) {
            for (const entry of chatRooms.get(currentChatKey)) {
              if (entry.ws.readyState === entry.ws.OPEN) {
                entry.ws.send(JSON.stringify({ type: 'chat_message', ...chatMsg }));
              }
            }
          } else {
            // Echo back to sender only if no room
            send('chat_message', chatMsg);
          }
          // Persist global chat messages to daily file
          if (currentChatKey === 'global' && appendChatMessage) {
            try { appendChatMessage(chatMsg); } catch (e) { console.error('[WS] Chat persist error:', e); }
          }
          break;
        }

        case 'session_watch': {
          const requestedSessionId = String(msg.sessionDbId || '').trim();
          if (!requestedSessionId) {
            leaveCurrentSessionRoom();
            send('session_access', { sessionDbId: null, canWrite: false, readOnly: true });
            break;
          }

          const session = readSessionByDbId(requestedSessionId);
          if (!session) {
            send('error', { error: 'Session not found for live watch.' });
            break;
          }

          const msgEmail = String(msg.playerEmail || '').trim().toLowerCase();
          if (msgEmail) {
            wsEntry.playerEmail = msgEmail;
            if (!wsEntry.playerName && msg.playerName) {
              wsEntry.playerName = msg.playerName;
            }
          }

          const ownerEmail = getSessionOwnerEmail(session);
          const requesterEmail = String(wsEntry.playerEmail || '').trim().toLowerCase();
          const canWrite = !!ownerEmail && !!requesterEmail && ownerEmail === requesterEmail;
          const companionNpcId = !canWrite ? getCompanionNpcId(session, requesterEmail) : null;

          // Set companionNpcId BEFORE joining room so participants broadcast includes it
          // Also restore persisted character choice from session JSON
          let companionCharacterId = null;
          let companionCharacterName = null;
          if (companionNpcId) {
            wsEntry.companionNpcId = companionNpcId;
            const cp = (session.companionPlayers || {})[companionNpcId];
            if (cp?.characterId) {
              companionCharacterId = cp.characterId;
              companionCharacterName = cp.characterName || null;
              wsEntry.companionCharacterId = companionCharacterId;
              wsEntry.companionCharacterName = companionCharacterName;
            }
          }
          joinSessionRoom(requestedSessionId, canWrite);
          if (canWrite) startRefused = false; // binding your own save is a fresh, gated-or-resumed context
          const ownerName = getSessionOwnerName(session);
          const accessPayload = {
            sessionDbId: requestedSessionId,
            ownerEmail,
            ownerName,
            canWrite,
            readOnly: !canWrite,
          };
          if (companionNpcId) {
            accessPayload.companionNpcId = companionNpcId;
            if (companionCharacterId) {
              accessPayload.companionCharacterId = companionCharacterId;
              accessPayload.companionCharacterName = companionCharacterName;
            }
          }
          send('session_access', accessPayload);

          // Snapshot character/NPC files to session-scoped directory (creates if not exists, skips existing)
          if (canWrite && ownerEmail) {
            try { snapshotToSession(dataDir, requestedSessionId, ownerEmail, savedCampaignIdOf(session) || campaignId || 'demo'); } catch (e) { console.error('[WS] Snapshot error:', e); }
            // Fire-and-forget: must not delay the watch handshake (session_access /
            // turn_status ordering). The blocking check runs before each DM turn fires.
            scheduleSessionIntegrityCheck(requestedSessionId);
          }

          // Restore pending turns from session JSON into in-memory map (reconnect support)
          if (session.pendingTurns && Object.keys(session.pendingTurns).length > 0) {
            if (!sessionTurns.has(requestedSessionId)) sessionTurns.set(requestedSessionId, new Map());
            const turnsMap = sessionTurns.get(requestedSessionId);
            for (const [email, turnData] of Object.entries(session.pendingTurns)) {
              if (!turnsMap.has(email)) {
                turnsMap.set(email, turnData);
              }
            }
          }

          // Always send current pending turns (empty array clears stale client state)
          const watchTurns = sessionTurns.has(requestedSessionId)
            ? Array.from(sessionTurns.get(requestedSessionId).values())
            : [];
          send('companion_turns_update', { sessionDbId: requestedSessionId, turns: watchTurns });

          // Send unified turn status
          broadcastTurnStatus(requestedSessionId);

          // Initialize session engine if this is a multiplayer session
          if (canWrite && session.companionPlayers && Object.keys(session.companionPlayers).length > 0) {
            getOrCreateSessionEngine(requestedSessionId, dataDir, {
              characterId: session.characterId,
              scenarioId: session.scenarioId,
              campaignId: savedCampaignIdOf(session) || campaignId || 'demo',
              ownerEmail,
              claudeSessionId: session.claudeSessionId,
              companionConfig: session.companionConfig || null,
              dmPersonality: session.dmPersonality || null,
            });
          }

          break;
        }

        case 'session_unwatch': {
          leaveCurrentSessionRoom();
          send('session_access', { sessionDbId: null, canWrite: false, readOnly: true });
          send('companion_turns_update', { sessionDbId: null, turns: [] });
          break;
        }

        case 'user_message': {
          if (startRefused) {
            send('error', startRefused);
            return;
          }
          if (currentSessionDbId && !currentSessionCanWrite) {
            send('error', { error: 'This session is read-only. Only the creator can send messages.' });
            return;
          }
          if (processing) {
            send('error', { error: 'Already processing a message. Please wait.' });
            return;
          }
          if (!msg.text || !msg.text.trim()) {
            send('error', { error: 'Empty message.' });
            return;
          }

          // Multiplayer: queue the host's turn instead of firing immediately
          // Pinned before the first await (WO-0050 revision 3, SR-50-4): a session_start/resume/
          // watch can land during isMultiplayerSession's await and rebind the connection.
          const msgSessionDbId = currentSessionDbId;
          if (msgSessionDbId && await isMultiplayerSession(msgSessionDbId)) {
            const turnText = msg.text.trim();
            if (!sessionTurns.has(msgSessionDbId)) sessionTurns.set(msgSessionDbId, new Map());
            sessionTurns.get(msgSessionDbId).set(wsEntry.playerEmail, {
              playerEmail: wsEntry.playerEmail,
              playerName: wsEntry.playerName || wsEntry.playerEmail,
              npcId: null,
              npcName: null,
              characterName: wsEntry.characterName || null,
              characterId: characterId || null,
              text: turnText,
              isHost: true,
            });
            await persistTurnToSession(msgSessionDbId, {
              playerEmail: wsEntry.playerEmail,
              playerName: wsEntry.playerName || wsEntry.playerEmail,
              npcId: null,
              text: turnText,
              isHost: true,
              submittedAt: new Date().toISOString(),
            });
            console.log(`[WS] Host turn queued — session: ${msgSessionDbId}, player: ${wsEntry.playerEmail}`);
            // Broadcast host's message to all session watchers immediately
            broadcastSessionMessage(msgSessionDbId, 'session_player_message', {
              text: turnText,
              timestamp: new Date().toISOString(),
              sessionId: msgSessionDbId,
            }, wsEntry);
            // Also echo back to the host
            send('session_player_message', { text: turnText, timestamp: new Date().toISOString(), sessionId: msgSessionDbId });
            broadcastToAll('sessions_changed');
            checkAutoFire(msgSessionDbId);
            break;
          }

          // Re-checked after that await: a refusal or a rebind that landed during it wins over this
          // message (revision 3). Without the first, a refused start arriving in that window was
          // followed by this turn running unbound; the second only refuses a message whose
          // session changed under it, which an ordinary client does not do.
          if (startRefused) {
            send('error', startRefused);
            return;
          }
          if (currentSessionDbId !== msgSessionDbId) {
            send('error', { error: 'The session changed while this message was being handled. Please send it again.' });
            return;
          }

          // Which campaign this turn runs in (WO-0050 revision 2, SR-50-1). With a saved session
          // bound, it is THAT SESSION'S saved campaignId — never the connection's `campaignId`,
          // which is only whatever the last session_start/session_resume named and can disagree
          // with the bound session. The saved value is trusted only if it is a well-formed id
          // (revision 3, SR-50-5); otherwise — and with no session bound, or a legacy save with no
          // campaignId — the turn is gated as a start.
          //
          // PINNED (revision 3, SR-50-4). Every input of this turn is captured here, at the gate,
          // and only these constants are used below — snapshot, engine.run, persistence, audit,
          // reconcile and broadcasts. handleWsMessage is async and messages are not serialised, so
          // a session_start/session_resume/session_watch can land at any await below and reassign
          // the connection's variables; before this, a refused Premium start landing 0-2 ms after
          // the gate swapped this turn into the refused campaign.
          const boundAtGate = currentSessionDbId ? readSessionByDbId(currentSessionDbId) : null;
          const savedCampaignId = savedCampaignIdOf(boundAtGate);
          if (savedCampaignId) {
            campaignId = savedCampaignId;
            wsEntry.campaignId = savedCampaignId;
          } else if (!isRegisteredEmail(dataDir, wsEntry.playerEmail)) {
            // Login gate (revision 4, Part C): a turn gated as a start needs a logged-in player,
            // exactly as session_start does. Synchronous, so `turnPlayerEmail` below pins the same
            // email this checked. A turn on a bound save with a well-formed campaignId (resuming,
            // watching-as-owner) does not reach this branch and is unchanged.
            send('error', LOGIN_REFUSAL);
            return;
          } else if (!canStartCampaign(getPremiumAccessForEmail(dataDir, wsEntry.playerEmail), campaignId || 'demo')) {
            send('error', PREMIUM_REFUSAL);
            return;
          }
          const turnCampaignId = campaignId;
          const turnCharacterId = characterId;
          const turnScenarioId = scenarioId;
          const turnCompanionConfig = companionConfig;
          const turnDmPersonality = dmPersonality;
          const turnPlayerEmail = wsEntry.playerEmail;
          const turnHistory = messageHistory;
          const turnStartSessionDbId = currentSessionDbId || null;
          // The session this turn belongs to. Bound at the gate: always that one. Unbound at the
          // gate (a new, unsaved adventure): the client's first auto-save creates the save and
          // binds it with session_watch DURING this turn, and the turn has always been persisted
          // into it — so a save bound later is adopted, but only if it is this connection's own
          // (canWrite) save in THIS turn's campaign. Memoised per bound id.
          let adoptCheckedFor = null;
          let adoptResult = null;
          const turnSessionDbId = () => {
            if (turnStartSessionDbId) return turnStartSessionDbId;
            if (!currentSessionDbId || !currentSessionCanWrite) return null;
            if (adoptCheckedFor !== currentSessionDbId) {
              adoptCheckedFor = currentSessionDbId;
              const later = readSessionByDbId(currentSessionDbId);
              adoptResult = savedCampaignIdOf(later) === (turnCampaignId || 'demo') ? currentSessionDbId : null;
            }
            return adoptResult;
          };
          const toWatchers = (type, payload = {}) => {
            const sid = turnSessionDbId();
            if (sid) broadcastSessionMessage(sid, type, payload, wsEntry);
          };

          // Single player: fire DM engine immediately
          processing = true;
          send('session_status', { status: 'thinking' });
          toWatchers('session_status', { status: 'thinking' });

          try {
            const playerText = msg.text.trim();

            // Send host's player message back to them
            send('session_player_message', { text: playerText, sessionId: turnSessionDbId() || undefined });

            turnHistory.push({ type: 'player', text: playerText, sessionId: turnSessionDbId() || undefined });
            toWatchers('session_player_message', {
              text: playerText,
              timestamp: new Date().toISOString(),
              sessionId: turnSessionDbId() || undefined,
            });

            // Snapshot session data if we have a saved session
            const snapshotSid = turnSessionDbId();
            if (snapshotSid && turnPlayerEmail) {
              try { snapshotToSession(dataDir, snapshotSid, turnPlayerEmail, turnCampaignId || 'demo'); } catch (e) { console.error('[WS] Snapshot error:', e); }
              beginTurnNotices(snapshotSid);
              await runSessionIntegrityCheck(snapshotSid, { partOfTurn: true });
            }

            // Load world state and summary counter from session for context persistence
            let singlePlayerWorldState;
            let singlePlayerSummaryCount = 0;
            let singlePlayerArcSummaries;
            if (turnSessionDbId()) {
              try {
                const sessData = await readSessionByDbIdAsync(turnSessionDbId());
                if (sessData) {
                  singlePlayerWorldState = sessData.worldState || undefined;
                  singlePlayerSummaryCount = sessData.dmMessagesSinceLastSummary || 0;
                  singlePlayerArcSummaries = sessData.arcSummaries || undefined;
                }
              } catch { /* ignore */ }
            }

            const stream = engine.run(playerText, {
              characterId: turnCharacterId,
              scenarioId: turnScenarioId,
              campaignId: turnCampaignId,
              messageHistory: turnHistory,
              playerEmail: turnPlayerEmail,
              sessionDbId: turnSessionDbId() || undefined,
              companionConfig: turnCompanionConfig || undefined,
              dmPersonality: turnDmPersonality || undefined,
              worldState: singlePlayerWorldState,
              dmMessagesSinceLastSummary: singlePlayerSummaryCount,
              arcSummaries: singlePlayerArcSummaries,
              onPermissionRequest: (toolName, input, toolUseID, context) => {
                return new Promise((resolve) => {
                  const description = describeToolUse(toolName, input, context);
                  pendingPermissions.set(toolUseID, { resolve });
                  send('permission_request', {
                    toolUseID,
                    toolName,
                    description,
                    input,
                    // Structured fields so the modal can lay the question out rather than
                    // print a blob. Absent for every tool but the override (condition M1).
                    details: context || null,
                  });
                  send('session_status', { status: 'awaiting_permission' });
                });
              },
              // Condition M6(b): when a tool needs a player's approval and nobody can be asked,
              // say so at the table instead of failing silently.
              onSessionNotice: (text) => { emitSessionNotice(turnSessionDbId(), text, 'permission').catch(() => {}); },
            });

            const auditToolCalls = [];
            const auditOutcomes = [];
            let auditDmText = '';
            let auditWarnings = [];
            let turnSpeakers = [];
            // Ordered record of renderable events this turn (DM chunks + dice rolls),
            // persisted server-side at dm_complete so a crash before the client's
            // auto-save can no longer lose the turn (the stale-resume bug).
            const turnEvents = [];
            for await (const event of stream) {
              switch (event.type) {
                case 'dm_partial':
                  send('dm_partial', { text: event.text });
                  toWatchers('dm_partial', { text: event.text });
                  break;
                case 'dm_warmup':
                  // Phase 4: Show warm-up status to player and watchers
                  send('dm_warmup', { text: event.text, visible: true });
                  toWatchers('dm_warmup', { text: event.text, visible: true });
                  break;
                case 'tool_use':
                  auditToolCalls.push({ name: event.name, input: event.input });
                  break;
                case 'mechanical_outcome':
                  // The ledger of what the server computed (ADR 0005 §10).
                  auditOutcomes.push(event);
                  break;
                case 'dice_roll':
                  send('dice_roll', {
                    notation: event.notation,
                    rolls: event.rolls,
                    modifier: event.modifier,
                    total: event.total,
                    label: event.label,
                  });
                  toWatchers('dice_roll', {
                    notation: event.notation,
                    rolls: event.rolls,
                    modifier: event.modifier,
                    total: event.total,
                    label: event.label,
                  });
                  turnEvents.push({ type: 'dice_roll', text: formatDiceRoll(event) });
                  break;
                case 'scene_image': {
                  // Scene imagery (docs/adr/0002-scene-imagery.md §7) — the dice_roll path
                  // exactly: send to the player, broadcast to every watcher, and record in
                  // turnEvents so the turn persists with the picture in stream order.
                  // `text` is non-empty by construction in the tool (condition S3), which is what
                  // stops normalizeSavedMessages dropping the entry on reload.
                  const sceneImage = {
                    assetId: event.assetId, kind: event.kind, title: event.title,
                    alt: event.alt, caption: event.caption, text: event.text,
                  };
                  send('scene_image', sceneImage);
                  toWatchers('scene_image', sceneImage);
                  turnEvents.push({ type: 'scene_image', ...sceneImage });
                  break;
                }
                case 'dm_response':
                  turnHistory.push({ type: 'dm', text: event.text, sessionId: turnSessionDbId() || undefined });
                  auditDmText += (auditDmText ? '\n\n' : '') + event.text;
                  send('dm_response', { text: event.text });
                  toWatchers('dm_response', { text: event.text });
                  turnEvents.push({ type: 'dm', text: event.text });
                  break;
                case 'dm_complete':
                  send('dm_complete', { sessionId: event.sessionId });
                  toWatchers('dm_complete', { sessionId: event.sessionId });
                  // Persist the full turn (player message + every DM chunk + every dice
                  // roll) + summary counter + world-state digest, serialized against
                  // other session.json writers. The client auto-save remains; the PUT
                  // handler dedupes against what's persisted here.
                  if (turnSessionDbId()) {
                    try {
                      const turnTimestamp = new Date().toISOString();
                      const playerMsg = { type: 'player', text: playerText, timestamp: turnTimestamp, sessionId: turnSessionDbId() };
                      const stampedTurnEvents = turnEvents.map(te => ({ ...te, timestamp: turnTimestamp, sessionId: turnSessionDbId() }));
                      let lastDmText = null;
                      for (let i = turnEvents.length - 1; i >= 0; i--) {
                        if (turnEvents[i].type === 'dm') { lastDmText = turnEvents[i].text; break; }
                      }
                      await updateSessionFile(dataDir, turnSessionDbId(), (sess) => {
                        persistCanonicalTurn(sess, {
                          sessionDbId: turnSessionDbId(),
                          claudeSessionId: event.sessionId,
                          playerMsg,
                          stampedTurnEvents,
                          lastDmText,
                        });
                      });
                    } catch (e) { console.error('[WS] Failed to persist single-player turn:', e); }
                  }
                  try {
                    // Audit the DM's narration AND the player's own turn text — a transfer the
                    // player declared ("I give everyone 1 gp") is often paraphrased qualitatively by
                    // the DM and never restated as a number, so the narration scan alone misses it.
                    const rosterSheets = () => sessionRosterSheets(turnSessionDbId());
                    // This path is single-player: the one speaker is the connection's own
                    // character (revision 2, Security R3 / QC N1).
                    turnSpeakers = turnCharacterId ? [turnCharacterId] : [];
                    const auditOpts = { speakers: turnSpeakers, outcomes: auditOutcomes };
                    auditWarnings = dedupeWarningsByCategory([
                      ...auditDmTurn(auditDmText, auditToolCalls, auditOutcomes, rosterSheets, auditOpts),
                      ...auditPlayerTurn(playerText, auditToolCalls, rosterSheets, auditOpts),
                    ]);
                    logAuditTrace(turnSessionDbId(), auditDmText, auditToolCalls, auditWarnings);
                    const formatted = formatWarnings(auditWarnings, turnSessionDbId());
                    if (formatted) console.warn(formatted);
                    // The only correction this app puts in front of the table (ADR 0005 §10):
                    // it fires when the narration and the server's ledger disagree about
                    // whether somebody died, and it states the fact without blaming anyone.
                    const correction = buildMechanicalCorrection(auditDmText, auditOutcomes, rosterSheets);
                    if (correction) {
                      console.warn(`[DM:INTEGRITY] ${correction.kind} session=${turnSessionDbId() || 'none'} ${correction.text}`);
                      // Broadcast to the other watchers with this connection excluded, then
                      // echo to the player themselves — the same pairing every other
                      // session message in this file uses.
                      const shown = await emitSessionNotice(turnSessionDbId(), correction.text, correction.kind, wsEntry);
                      if (shown) {
                        send('session_player_message', { text: correction.text, timestamp: new Date().toISOString(), sessionId: turnSessionDbId() || undefined });
                      }
                    }
                  } catch (e) { console.error('[DM:AUDIT] error:', e); }
                  break;
                case 'session_id':
                  send('session_id', { sessionId: event.sessionId });
                  toWatchers('session_id', { sessionId: event.sessionId });
                  break;
                case 'error':
                  send('error', describeEngineError(event.error));
                  toWatchers('error', describeEngineError(event.error));
                  break;
              }
            }

            // Enforcement: apply any narrated-but-unsaved stat changes before the `finally`
            // emits 'idle'. Status stays 'thinking' (Ready stays off) until this resolves.
            await reconcileTurnIfNeeded({
              engine,
              warnings: auditWarnings,
              auditDmText,
              auditPlayerText: playerText,
              auditToolCalls,
              auditOutcomes,
              knownEntities: () => sessionRosterSheets(turnSessionDbId()),
              speakers: turnSpeakers,
              runOpts: {
                onSessionNotice: (text) => { emitSessionNotice(turnSessionDbId(), text, 'permission').catch(() => {}); },
                characterId: turnCharacterId,
                scenarioId: turnScenarioId,
                campaignId: turnCampaignId,
                playerEmail: turnPlayerEmail,
                sessionDbId: turnSessionDbId() || undefined,
                companionConfig: turnCompanionConfig || undefined,
                dmPersonality: turnDmPersonality || undefined,
                worldState: singlePlayerWorldState,
              },
            });
          } catch (err) {
            console.error('[WS] Engine error:', err);
            send('error', describeEngineError(err.message));
            toWatchers('error', describeEngineError(err.message));
          } finally {
            processing = false;
            send('session_status', { status: 'idle' });
            toWatchers('session_status', { status: 'idle' });
          }
          break;
        }

        case 'permission_response': {
          const pending = pendingPermissions.get(msg.toolUseID);
          if (pending) {
            pendingPermissions.delete(msg.toolUseID);
            pending.resolve(msg.allowed === true);
            send('session_status', { status: 'thinking' });
          }
          break;
        }

        case 'companion_set_character': {
          if (!currentSessionDbId || !wsEntry.companionNpcId) break;
          // Reject if companion selected the host's character
          if (msg.characterId) {
            const sessCheck = await readSessionByDbIdAsync(currentSessionDbId);
            if (sessCheck && msg.characterId === sessCheck.characterId) {
              send('error', { error: 'That character is already being played by the host.' });
              break;
            }
          }
          const prevCharName = wsEntry.companionCharacterName;
          wsEntry.companionCharacterName = msg.characterName || null;
          wsEntry.companionCharacterId = msg.characterId || null;
          wsEntry.companionCharacterData = msg.characterData || null;
          // Reset sheet-sent tracking if character changed so sheet is sent on next turn
          if (msg.characterName !== prevCharName && companionSheetsSent.has(currentSessionDbId)) {
            companionSheetsSent.get(currentSessionDbId).delete(msg.characterId || msg.characterName);
          }
          // Persist character choice to session JSON (serialized with other writers)
          try {
            await updateSessionFile(dataDir, currentSessionDbId, (sessionFile) => {
              const claim = sessionFile.companionPlayers && sessionFile.companionPlayers[wsEntry.companionNpcId];
              if (!claim) return false;
              claim.characterId = msg.characterId || null;
              claim.characterName = msg.characterName || null;
            });
          } catch (err) {
            console.error('[WS] Failed to persist companion character choice:', err);
          }
          broadcastSessionParticipants(currentSessionDbId);

          // Copy companion's character file to the session directory (neutral, shared).
          // Resolve by id first: if any session file already holds this character id,
          // overwrite THAT file (and remove stale same-id duplicates) instead of
          // minting a new filename from a re-slugified name — that's how one
          // character ended up as both daichi-mus.json and daichi-muso.json.
          if (msg.characterData && msg.characterId) {
            try {
              const sessCharDir = getSessionCharactersDir(dataDir, currentSessionDbId);
              await fsp.mkdir(sessCharDir, { recursive: true });

              const existingFiles = (await fsp.readdir(sessCharDir)).filter(f => f.endsWith('.json'));
              const sameId = [];
              for (const f of existingFiles) {
                try {
                  const d = JSON.parse(await fsp.readFile(path.join(sessCharDir, f), 'utf-8'));
                  if (d.id === msg.characterId) sameId.push(f);
                } catch { /* skip unreadable */ }
              }

              const destFile = sameId[0] || `${slugify(msg.characterData.name || msg.characterId)}.json`;
              const charDataToWrite = { ...msg.characterData, _filename: destFile };
              writeJsonAtomic(path.join(sessCharDir, destFile), charDataToWrite);
              for (const stale of sameId.slice(1)) {
                await fsp.unlink(path.join(sessCharDir, stale));
                console.warn(`[WS] Removed duplicate character file ${stale} (same id as ${destFile})`);
              }
              console.log(`[WS] Copied companion character "${msg.characterData.name}" to session dir: ${path.join(sessCharDir, destFile)}`);
            } catch (err) {
              console.error(`[WS] Failed to copy companion character to session dir:`, err);
            }
          }

          // Notify the session about the character swap
          if (msg.characterName && msg.characterName !== prevCharName) {
            const npcLabel = msg.npcName || wsEntry.companionNpcId;
            broadcastSessionMessage(currentSessionDbId, 'session_player_message', {
              text: `[System: Companion player ${wsEntry.playerName} is playing as ${msg.characterName}, replacing ${npcLabel} in the party.]`,
              timestamp: new Date().toISOString(),
              sessionId: currentSessionDbId,
            });
            // Invalidate the host's Claude session so the next turn starts fresh
            // with the updated system prompt (new party composition)
            const hostEntry = sessionRooms.has(currentSessionDbId)
              ? Array.from(sessionRooms.get(currentSessionDbId)).find(e => e.isHost)
              : null;
            if (hostEntry && hostEntry.invalidateSession) {
              const swapMsg = `[System: Companion player ${wsEntry.playerName} is playing as ${msg.characterName}, replacing ${npcLabel} in the party. The companion's character file has been copied to the session's characters directory. Treat ${msg.characterName} as a full party member — read their character file for stats, track HP, award XP, and manage inventory just like any other character.]`;
              hostEntry.invalidateSession(swapMsg);
              console.log(`[WS] Invalidated host's Claude session for party composition change`);
            }
          }
          break;
        }

        case 'companion_turn_submit': {
          if (!currentSessionDbId) {
            send('error', { error: 'Not in a session.' });
            break;
          }
          if (!wsEntry.companionNpcId) {
            send('error', { error: 'You are not a companion player in this session.' });
            break;
          }
          const turnText = String(msg.text || '').trim();
          if (!turnText) {
            send('error', { error: 'Empty turn.' });
            break;
          }
          if (!sessionTurns.has(currentSessionDbId)) sessionTurns.set(currentSessionDbId, new Map());
          const npcName = msg.npcName || wsEntry.companionNpcId;
          // WO-0032 revision 3, Security R2-1. `characterId` below is the wire value and keeps its
          // existing meaning (display label, character-sheet-sent key). `speakerCharacterId` is a
          // SEPARATE field that only the transfer audit reads, and it is the server's own record
          // of what this companion claimed via `companion_set_character` — never `msg`. The two
          // are kept apart rather than merged so that tightening the security check cannot change
          // unrelated presentation behaviour, and so that a reader of either line can see which
          // one is trusted. A disagreement is logged: a companion whose per-turn character is not
          // the one they registered is worth a line.
          if (msg.characterId && msg.characterId !== wsEntry.companionCharacterId) {
            console.warn(`[WS] companion_turn_submit carried characterId=${String(msg.characterId).slice(0, 64)} `
              + `but the registered companion character is ${wsEntry.companionCharacterId || 'none'} — `
              + 'the registered one is used for the transfer audit (WO-0032 R2-1)');
          }
          sessionTurns.get(currentSessionDbId).set(wsEntry.playerEmail, {
            playerEmail: wsEntry.playerEmail,
            playerName: wsEntry.playerName || wsEntry.playerEmail,
            npcId: wsEntry.companionNpcId,
            npcName,
            characterName: msg.characterName || wsEntry.companionCharacterName || null,
            characterId: msg.characterId || wsEntry.companionCharacterId || null,
            speakerCharacterId: wsEntry.companionCharacterId || null,
            characterData: wsEntry.companionCharacterData || null,
            text: turnText,
            isHost: false,
          });
          await persistTurnToSession(currentSessionDbId, {
            playerEmail: wsEntry.playerEmail,
            playerName: wsEntry.playerName || wsEntry.playerEmail,
            npcId: wsEntry.companionNpcId,
            npcName,
            characterName: msg.characterName || wsEntry.companionCharacterName || null,
            text: turnText,
            isHost: false,
            submittedAt: new Date().toISOString(),
          });
          console.log(`[WS] Companion turn submitted — session: ${currentSessionDbId}, player: ${wsEntry.playerEmail}, npc: ${wsEntry.companionNpcId}`);
          broadcastSessionTurns(currentSessionDbId);
          broadcastToAll('sessions_changed');
          checkAutoFire(currentSessionDbId);
          break;
        }

        case 'companion_turn_retract': {
          if (!currentSessionDbId) break;
          let retractedCompText = null;
          if (sessionTurns.has(currentSessionDbId)) {
            const turn = sessionTurns.get(currentSessionDbId).get(wsEntry.playerEmail);
            retractedCompText = turn?.text || null;
            sessionTurns.get(currentSessionDbId).delete(wsEntry.playerEmail);
            broadcastSessionTurns(currentSessionDbId);
          }
          await removeTurnFromSession(currentSessionDbId, wsEntry.playerEmail);
          // Send retracted text back for input restoration
          send('companion_turn_retracted', { text: retractedCompText });
          broadcastTurnStatus(currentSessionDbId);
          broadcastToAll('sessions_changed');
          break;
        }

        case 'typing_status': {
          if (!currentSessionDbId) break;
          broadcastSessionMessage(currentSessionDbId, 'typing_status', {
            playerEmail: wsEntry.playerEmail,
            playerName: wsEntry.playerName,
            isHost: !!wsEntry.isHost,
            companionNpcId: wsEntry.companionNpcId || null,
            typing: !!msg.typing,
          }, wsEntry); // exclude sender
          break;
        }

        case 'host_skip_companion': {
          if (!currentSessionDbId || !currentSessionCanWrite) {
            send('error', { error: 'Only the host can skip companions.' });
            break;
          }
          const skipEmail = String(msg.playerEmail || '').trim().toLowerCase();
          await removeTurnFromSession(currentSessionDbId, skipEmail);
          if (skipEmail && sessionTurns.has(currentSessionDbId)) {
            sessionTurns.get(currentSessionDbId).delete(skipEmail);
            broadcastSessionTurns(currentSessionDbId);
          }
          checkAutoFire(currentSessionDbId);
          break;
        }

        case 'host_turn_submit': {
          // Unified multiplayer: host queues their turn, waits for companions
          if (!currentSessionDbId || !currentSessionCanWrite) {
            send('error', { error: 'Only the host can submit a turn.' });
            break;
          }
          const hostText = String(msg.text || '').trim();
          if (!hostText) {
            send('error', { error: 'Empty turn.' });
            break;
          }
          if (!sessionTurns.has(currentSessionDbId)) sessionTurns.set(currentSessionDbId, new Map());
          sessionTurns.get(currentSessionDbId).set(wsEntry.playerEmail, {
            playerEmail: wsEntry.playerEmail,
            playerName: wsEntry.playerName || wsEntry.playerEmail,
            npcId: null,
            npcName: null,
            characterName: wsEntry.characterName || null,
            characterId: characterId || null,
            text: hostText,
            isHost: true,
          });
          await persistTurnToSession(currentSessionDbId, {
            playerEmail: wsEntry.playerEmail,
            playerName: wsEntry.playerName || wsEntry.playerEmail,
            npcId: null,
            text: hostText,
            isHost: true,
            submittedAt: new Date().toISOString(),
          });
          console.log(`[WS] Host turn queued — session: ${currentSessionDbId}, player: ${wsEntry.playerEmail}`);
          // Broadcast host's message to all session watchers (excluding host)
          broadcastSessionMessage(currentSessionDbId, 'session_player_message', {
            text: hostText,
            timestamp: new Date().toISOString(),
            sessionId: currentSessionDbId,
          }, wsEntry);
          // Echo back to the host so their message appears in the adventure box
          send('session_player_message', { text: hostText, timestamp: new Date().toISOString(), sessionId: currentSessionDbId });
          broadcastToAll('sessions_changed');
          checkAutoFire(currentSessionDbId);
          break;
        }

        case 'host_turn_retract': {
          if (!currentSessionDbId) break;
          let retractedHostText = null;
          if (sessionTurns.has(currentSessionDbId)) {
            const turn = sessionTurns.get(currentSessionDbId).get(wsEntry.playerEmail);
            retractedHostText = turn?.text || null;
            sessionTurns.get(currentSessionDbId).delete(wsEntry.playerEmail);
          }
          await removeTurnFromSession(currentSessionDbId, wsEntry.playerEmail);
          // Send retracted text back for input restoration
          send('host_turn_retracted', { text: retractedHostText });
          broadcastTurnStatus(currentSessionDbId);
          broadcastToAll('sessions_changed');
          break;
        }

        case 'host_turn_continue': {
          // Fire DM without waiting for all companions
          if (!currentSessionDbId || !currentSessionCanWrite) break;
          // Check there's a host turn queued
          const hasTurn = sessionTurns.has(currentSessionDbId) &&
            Array.from(sessionTurns.get(currentSessionDbId).values()).some(t => t.isHost);
          if (!hasTurn) break;
          fireDmForSession(currentSessionDbId);
          break;
        }

        default:
          send('error', { error: `Unknown message type: ${msg.type}` });
      }
    };

    ws.on('close', () => {
      console.log('[WS] Client disconnected');
      leaveCurrentChatRoom();
      leaveCurrentSessionRoom();
      engine.abort();
      // Reject any pending permissions
      for (const [, pending] of pendingPermissions) {
        pending.resolve(false);
      }
      pendingPermissions.clear();
    });

    ws.on('error', (err) => {
      console.error('[WS] Error:', err.message);
    });
  });

  console.log('[WS] WebSocket server attached at /ws');
  return wss;
}

// What the player is actually asked to approve.
//
// Condition M1 (ETHICS.md Review 3 §M2.1, §M2.4): this used to fall through to
// "Use tool: mcp__dnd-tools__OverrideMechanicalState" and nothing else — not the character, not
// the field, not either value, not the DM's reason. That is not a consent surface; it is a
// dialog box that trains people to click Allow. This is the application's first consent prompt
// and the path has never run in production, so there is no habit to lean on.
//
// `context` is built server-side by vitals-utils.describeOverrideRequest, which is the only
// place that can read the sheet to state the current value. Five things in the text are
// load-bearing: the entity by name and never by slug; the field in the player's words and never
// as a JSON pointer; both values, so the question is a comparison and not an assertion; the
// reason quoted and attributed to the DM so a player may disbelieve it; and an explicit
// statement that nothing has happened yet and that declining is safe — which it is.
function describeToolUse(toolName, input, context) {
  switch (toolName) {
    case 'Edit':
      return `Edit file: ${input.file_path || 'unknown'}`;
    case 'Write':
      return `Write file: ${input.file_path || 'unknown'}`;
    case 'Bash':
      return `Run command: ${(input.command || '').substring(0, 100)}`;
    case 'mcp__dnd-tools__OverrideMechanicalState':
      if (context && context.description) return context.description;
      return `The GM wants to change ${(input && input.characterId) || 'a character'} outside the rules. Nothing has changed yet; declining is safe.`;
    default:
      return context && context.description ? context.description : `Use tool: ${toolName}`;
  }
}

// Broadcast to everyone watching one session.
//
// Module-level, and exported, because a session event no longer arrives only over the WebSocket:
// POST /sessions/:id/restore-character (WO-0016) is an HTTP route, triggered by the player whose
// character died, and the rest of the table has to see it happen. Routing it through the same
// function the turn loop uses means the restore notice reaches watchers on exactly the channel
// every other system notice does, rather than through a second path that could drift from it.
//
// Silent when nobody is watching that session — a restore performed by the only player in a
// single-player game has no room to broadcast to, and that is not an error.
function broadcastToSessionRoom(sessionDbId, type, payload = {}, excludedEntry = null) {
  if (!sessionDbId || !sessionRooms.has(sessionDbId)) return;
  for (const entry of sessionRooms.get(sessionDbId)) {
    if (entry === excludedEntry) continue;
    if (entry.ws.readyState === entry.ws.OPEN) {
      entry.ws.send(JSON.stringify({ type, sessionDbId, ...payload }));
    }
  }
}

// Broadcast a message to ALL connected WebSocket clients
let _wss = null;
function broadcastToAll(type, payload = {}) {
  if (!_wss) return;
  const msg = JSON.stringify({ type, ...payload });
  for (const client of _wss.clients) {
    if (client.readyState === client.OPEN) {
      client.send(msg);
    }
  }
}

module.exports = { attachWebSocket, broadcastToAll, broadcastToSessionRoom, whenSessionWorkSettled };
