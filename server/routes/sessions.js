const express = require('express');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { getAuthenticatedPlayer, resolvePremiumAccess } = require('../player-auth');
const { canStartCampaign, PREMIUM_REFUSAL_MESSAGE } = require('../premium-gate');
const { emailToSlug, getSessionDir, getSessionFilePath, getSessionCharactersDir, getSessionNpcsDir, getPlayerCharactersDir, provisionPlayerDefaults, snapshotToSession, updateSessionFile } = require('../player-data');
const { broadcastToAll, broadcastToSessionRoom } = require('../ws-handler');
const { loadDmSettings } = require('../dm-engine');
const { safeReadJsonFile, tryRecover, writeJsonAtomic } = require('../json-recovery');
const { verifySessionIntegrity } = require('../entity-resolver');

const DEFAULT_SETTINGS = {
  visibility: 'public', // 'private' | 'public'
  allowBots: false,
  maxBots: 2,
};

const DEFAULT_MAX_SESSIONS = 10;

function getOwnerPlayer(session) {
  return (session.players || []).find(p => p.role === 'owner')
    || (session.players || [])[0]
    || null;
}

function getOwnerEmail(session) {
  const ownerPlayer = getOwnerPlayer(session);
  const value = session.ownerEmail || session.playerEmail || ownerPlayer?.email || null;
  return value ? String(value).trim().toLowerCase() : null;
}

function getOwnerName(session) {
  const ownerPlayer = getOwnerPlayer(session);
  return session.ownerName || session.playerName || ownerPlayer?.name || null;
}

function canWriteSession(session, requester) {
  if (!requester) return false;
  const ownerEmail = getOwnerEmail(session);
  return !!ownerEmail && requester.email === ownerEmail;
}

function getSessionSettings(session) {
  return { ...DEFAULT_SETTINGS, ...(session.settings || {}) };
}

function getCompanionSlots(session) {
  const config = session.companionConfig;
  if (!config || !config.states) return { open: 0, reserved: 0, claimed: 0, slots: [] };
  const states = config.states;
  const reservations = config.reservations || {};
  const claimed = session.companionPlayers || {};
  const slots = [];
  for (const [npcId, state] of Object.entries(states)) {
    if (state === 'player' || state === 'reserved') {
      slots.push({
        npcId,
        type: state,
        reservedFor: state === 'reserved' ? reservations[npcId] || null : null,
        claimedBy: claimed[npcId] || null,
      });
    }
  }
  return {
    open: slots.filter(s => s.type === 'player' && !s.claimedBy).length,
    reserved: slots.filter(s => s.type === 'reserved' && !s.claimedBy).length,
    claimed: slots.filter(s => s.claimedBy).length,
    slots,
  };
}

function getLastPlayerName(session) {
  const msgs = session.messages || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.type === 'player') return session.playerName || session.ownerName || null;
    if (m.type === 'companion' && m.playerName) return m.playerName;
  }
  return null;
}

function summarizeSession(session, requester) {
  const ownerEmail = getOwnerEmail(session);
  const ownerName = getOwnerName(session);
  const canWrite = canWriteSession(session, requester);
  const settings = getSessionSettings(session);
  const companionSlots = getCompanionSlots(session);
  const lastPlayerName = getLastPlayerName(session);
  // Determine if the requester's turn is expected
  const pendingTurns = session.pendingTurns || {};
  const hasCompanions = session.companionPlayers && Object.keys(session.companionPlayers).length > 0;
  const requesterEmail = requester?.email?.toLowerCase() || null;
  // Check if the DM is currently thinking (last message is player/companion, not DM)
  const msgs = session.messages || [];
  const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null;
  const dmThinking = lastMsg && (lastMsg.type === 'player' || lastMsg.type === 'companion' || lastMsg.type === 'dm_partial');

  const turnExpectedFromYou = !dmThinking && hasCompanions && requesterEmail && !pendingTurns[requesterEmail] &&
    (requesterEmail === ownerEmail || Object.values(session.companionPlayers || {}).some(cp => cp.email?.toLowerCase() === requesterEmail));

  return {
    id: session.id,
    name: session.name,
    label: session.label || null,
    scenarioId: session.scenarioId,
    characterId: session.characterId,
    playerName: session.playerName || ownerName || null,
    playerEmail: session.playerEmail || ownerEmail || null,
    ownerName,
    ownerEmail,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    playerCount: (session.players || []).length + Object.keys(session.companionPlayers || {}).length,
    botCount: Object.values(session.companionPlayers || {}).filter(cp => cp.email?.endsWith('@bot.local')).length,
    messageCount: (session.messages || []).length,
    status: session.status,
    canWrite,
    readOnly: !canWrite,
    settings,
    companionSlots,
    lastPlayerName,
    turnExpectedFromYou: !!turnExpectedFromYou,
    dmThinking: !!dmThinking,
  };
}

function withSessionAccess(session, requester) {
  const ownerEmail = getOwnerEmail(session);
  const ownerName = getOwnerName(session);
  const canWrite = canWriteSession(session, requester);
  const settings = getSessionSettings(session);
  const pendingTurns = session.pendingTurns || {};
  const hasCompanions = session.companionPlayers && Object.keys(session.companionPlayers).length > 0;
  const requesterEmail = requester?.email?.toLowerCase() || null;
  const turnExpectedFromYou = hasCompanions && requesterEmail && !pendingTurns[requesterEmail] &&
    (requesterEmail === ownerEmail || Object.values(session.companionPlayers || {}).some(cp => cp.email?.toLowerCase() === requesterEmail));
  return {
    ...session,
    ownerEmail,
    ownerName,
    playerEmail: session.playerEmail || ownerEmail || null,
    playerName: session.playerName || ownerName || null,
    canWrite,
    readOnly: !canWrite,
    settings,
    turnExpectedFromYou: !!turnExpectedFromYou,
  };
}

function countPlayerSessions(dataDir, email) {
  const sessionsDir = path.join(dataDir, 'sessions');
  if (!fs.existsSync(sessionsDir)) return 0;
  const normalizedEmail = String(email).trim().toLowerCase();
  let count = 0;
  try {
    const dirs = fs.readdirSync(sessionsDir).filter(d => {
      try { return fs.statSync(path.join(sessionsDir, d)).isDirectory(); } catch { return false; }
    });
    for (const d of dirs) {
      const fp = path.join(sessionsDir, d, 'session.json');
      if (!fs.existsSync(fp)) continue;
      try {
        const data = JSON.parse(fs.readFileSync(fp, 'utf-8'));
        const ownerEmail = getOwnerEmail(data);
        if (ownerEmail && ownerEmail === normalizedEmail) count++;
      } catch { /* skip malformed */ }
    }
  } catch { /* ignore */ }
  return count;
}

// ── Restoring a character from the player's library (WO-0016) ─────────────────────────────────
// Small, side-effect-free helpers, kept at module scope so the seat rule and the "is this
// character down" rule can be asserted without standing up an HTTP server. The route below is
// their only caller.

/**
 * The one sheet in `dir` whose id is exactly `characterId`, or null.
 *
 * Exact id only, deliberately. entity-resolver.js matches loosely on name and slug so the DM can
 * say "Kaelara" and be understood; this route OVERWRITES a character sheet, and a near-miss here
 * would overwrite one character with a different character's saved copy. The client always has a
 * real id — it came from GET /:id/party — so there is nothing to be lenient about.
 */
function readSheetByExactId(dir, characterId) {
  if (!dir || !characterId || !fs.existsSync(dir)) return null;
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
    const filePath = path.join(dir, file);
    const result = safeReadJsonFile(filePath);
    if (result.ok && result.data && result.data.id === characterId) {
      return { file, filePath, data: result.data };
    }
  }
  return null;
}

/** Every character id this session has a seat for, for a refusal that can say what it did find. */
function listSessionCharacterIds(session) {
  const ids = [];
  if (session.characterId) ids.push(session.characterId);
  for (const claim of Object.values(session.companionPlayers || {})) {
    if (claim && claim.characterId) ids.push(claim.characterId);
  }
  return ids;
}

/**
 * Which seat in the session plays this character, and whose seat it is.
 * The host plays `session.characterId`; a companion player's character is recorded on their
 * claim. Returns { email, name, seat, npcId } or null when the character has no seat here.
 *
 * This is the ownership rule for the restore, and it is the reason the route does not accept the
 * host as a stand-in for a companion player: the host owns the session, but the character belongs
 * to whoever is playing it, and undoing three hours of somebody else's evening is not the host's
 * call to make.
 */
function findCharacterSeat(session, characterId) {
  if (!characterId) return null;
  if (session.characterId && session.characterId === characterId) {
    const email = getOwnerEmail(session);
    if (!email) return null;
    return { email, name: getOwnerName(session) || email, seat: 'host', npcId: null };
  }
  for (const [npcId, claim] of Object.entries(session.companionPlayers || {})) {
    if (!claim || claim.characterId !== characterId) continue;
    const email = claim.email ? String(claim.email).trim().toLowerCase() : null;
    if (!email) return null;
    return { email, name: claim.name || claim.characterName || email, seat: 'companion', npcId };
  }
  return null;
}

/**
 * Is this character dead, or down at 0 hit points?
 *
 * ADR 0005 §7.3 keeps `status` to exactly two values and derives "down"/"dying"/"unconscious"
 * from `current === 0 && status !== "dead"`, so this function is that derivation and not a new
 * state. Restore is available for both: a character at 0 with two failed death saves has not
 * technically died, and telling them to wait until they have is not a kindness.
 */
function isDownOrDead(sheet) {
  if (!sheet) return false;
  if (String(sheet.status || 'alive').toLowerCase() === 'dead') return true;
  const current = Number(sheet.hitPoints && sheet.hitPoints.current);
  return Number.isFinite(current) && current <= 0;
}

/** "dead", or "down at 0/12 hit points" — for a message a distressed player has to read once. */
function describeCondition(sheet) {
  if (String(sheet.status || 'alive').toLowerCase() === 'dead') return 'dead';
  const hp = sheet.hitPoints || {};
  return `down at ${hp.current ?? '?'}/${hp.max ?? '?'} hit points`;
}

module.exports = function (dataDir) {
  const router = express.Router();

  // All sessions live in a flat neutral directory: data/sessions/<id>/session.json
  const sessionsBaseDir = path.join(dataDir, 'sessions');

  function ensureSessionsDir() {
    if (!fs.existsSync(sessionsBaseDir)) fs.mkdirSync(sessionsBaseDir, { recursive: true });
  }

  // Find a session file by ID — simple direct lookup
  function findSessionFile(sessionId) {
    // A non-id is refused by the path helper (WO-0041); to a caller that is simply no such session.
    let fp;
    try { fp = getSessionFilePath(dataDir, sessionId); } catch { return null; }
    return fs.existsSync(fp) ? fp : null;
  }

  // Read all session directories and return parsed session data
  function readAllSessions() {
    ensureSessionsDir();
    const results = [];
    let dirs;
    try {
      dirs = fs.readdirSync(sessionsBaseDir).filter(d => {
        try { return fs.statSync(path.join(sessionsBaseDir, d)).isDirectory(); } catch { return false; }
      });
    } catch { return []; }
    for (const d of dirs) {
      const fp = path.join(sessionsBaseDir, d, 'session.json');
      if (!fs.existsSync(fp)) continue;
      try {
        results.push(JSON.parse(fs.readFileSync(fp, 'utf-8')));
      } catch { /* skip malformed */ }
    }
    return results;
  }

  // GET all sessions across all campaigns for the logged-in player (My Games scoreboard)
  router.get('/my-games', (req, res) => {
    try {
      const requester = getAuthenticatedPlayer(dataDir, req);
      if (!requester) {
        return res.status(403).json({ error: 'Login required.' });
      }

      const showAll = req.query.all === 'true';
      const requesterEmail = requester.email.toLowerCase();

      // Cache campaign titles
      const campaignTitles = {};
      function getCampaignTitle(cid) {
        if (campaignTitles[cid] !== undefined) return campaignTitles[cid];
        try {
          const meta = JSON.parse(fs.readFileSync(path.join(dataDir, 'campaigns', cid, 'campaign.json'), 'utf-8'));
          campaignTitles[cid] = meta.title || cid;
        } catch {
          campaignTitles[cid] = cid;
        }
        return campaignTitles[cid];
      }

      const allSessions = [];
      for (const data of readAllSessions()) {
        const ownerEmail = getOwnerEmail(data);
        const isOwner = ownerEmail === requesterEmail;
        const isCompanion = data.companionPlayers && Object.values(data.companionPlayers).some(
          cp => cp.email && cp.email.toLowerCase() === requesterEmail
        );

        if (!isOwner && !isCompanion && !showAll) continue;

        const summary = summarizeSession(data, requester);
        summary.campaignId = data.campaignId || 'demo';
        summary.campaignTitle = getCampaignTitle(data.campaignId || 'demo');
        allSessions.push(summary);
      }

      allSessions.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
      res.json(allSessions);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET all sessions (for current campaign)
  router.get('/', (req, res) => {
    try {
      const requester = getAuthenticatedPlayer(dataDir, req);
      const campaignId = req.campaignId || 'demo';
      const requesterEmail = requester?.email?.toLowerCase() || null;

      const allSessions = [];
      for (const data of readAllSessions()) {
        // Filter to current campaign
        if ((data.campaignId || 'demo') !== campaignId) continue;

        const ownerEmail = getOwnerEmail(data);
        const isOwner = requesterEmail && ownerEmail === requesterEmail;
        const settings = getSessionSettings(data);
        const isPublic = settings.visibility === 'public';

        if (!isOwner && !isPublic) continue;

        allSessions.push(summarizeSession(data, requester));
      }

      allSessions.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
      res.json(allSessions);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET single session
  router.get('/:id', (req, res) => {
    try {
      const requester = getAuthenticatedPlayer(dataDir, req);
      const filePath = findSessionFile(req.params.id);
      if (!filePath) {
        return res.status(404).json({ error: 'Session not found' });
      }
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      // Non-owners can only see public sessions
      if (!canWriteSession(data, requester)) {
        const settings = getSessionSettings(data);
        if (settings.visibility !== 'public') {
          return res.status(404).json({ error: 'Session not found' });
        }
      }
      res.json(withSessionAccess(data, requester));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET archived raw messages for a session (powers future export/download).
  // Compaction moves older messages out of the live session into archive.jsonl.
  router.get('/:id/archive', (req, res) => {
    try {
      const requester = getAuthenticatedPlayer(dataDir, req);
      const filePath = findSessionFile(req.params.id);
      if (!filePath) {
        return res.status(404).json({ error: 'Session not found' });
      }
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (!canWriteSession(data, requester)) {
        const settings = getSessionSettings(data);
        if (settings.visibility !== 'public') {
          return res.status(404).json({ error: 'Session not found' });
        }
      }
      const archivePath = path.join(path.dirname(filePath), 'archive.jsonl');
      if (!fs.existsSync(archivePath)) {
        return res.json({ sessionId: data.id, count: 0, messages: [] });
      }
      const messages = fs.readFileSync(archivePath, 'utf-8')
        .split('\n')
        .filter(l => l.length > 0)
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
      res.json({ sessionId: data.id, count: messages.length, messages });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST create new session
  router.post('/', (req, res) => {
    try {
      const requester = getAuthenticatedPlayer(dataDir, req);
      if (!requester) {
        return res.status(403).json({ error: 'Login required. Guests cannot create sessions.' });
      }
      // Premium gate (WO-0050). The campaign is the request's X-Campaign-Id — the same value the
      // session is written under below — never a body field and never the campaign's badge.
      if (!canStartCampaign(resolvePremiumAccess(requester), req.campaignId || 'demo')) {
        return res.status(403).json({ error: PREMIUM_REFUSAL_MESSAGE, code: 'campaign_unavailable' });
      }
      // Enforce per-player session limit
      const maxSessions = requester.maxSessions || DEFAULT_MAX_SESSIONS;
      const currentCount = countPlayerSessions(dataDir, requester.email);
      if (currentCount >= maxSessions) {
        return res.status(400).json({ error: `Session limit reached (${maxSessions}). Delete an existing session to create a new one.` });
      }

      const { name, scenarioId, characterId, claudeSessionId, messages, companionConfig, settings: incomingSettings, dmPersonality: clientDmPersonality } = req.body;
      console.log(`[Sessions] POST — messages: ${(messages || []).length}, claudeSessionId: ${claudeSessionId ? 'yes' : 'no'}, characterId: ${characterId}`);
      // Snapshot DM personality settings into the session.
      // Use client-provided personality if available, otherwise resolve from per-user/global defaults.
      let dmPersonality = clientDmPersonality;
      if (!dmPersonality) {
        const resolved = loadDmSettings(dataDir, requester.email);
        // Strip non-personality fields — model is admin-only, others are not DM personality
        const { model, aiDailyShuffle, realisticDice, friends, blocked, _isPersonalized, ...personality } = resolved;
        dmPersonality = personality;
      }
      const ownerId = uuidv4();
      const createdAt = new Date().toISOString();
      const session = {
        id: uuidv4(),
        name: name || 'New Adventure',
        label: null,
        scenarioId: scenarioId || null,
        characterId: characterId || null,
        campaignId: req.campaignId || 'demo',
        claudeSessionId: claudeSessionId || null,
        messages: messages || [],
        ownerEmail: requester.email,
        ownerName: requester.name,
        playerEmail: requester.email,
        playerName: requester.name,
        status: 'active',
        settings: { ...DEFAULT_SETTINGS, ...(incomingSettings || {}) },
        dmPersonality,
        createdAt,
        updatedAt: createdAt,
        players: [
          {
            id: ownerId,
            characterId,
            email: requester.email,
            name: requester.name,
            role: 'owner',
            joinedAt: createdAt,
          }
        ],
        companionConfig: companionConfig || null,
        npcCompanions: [],
        currentAct: 0,
        currentScene: 0,
        log: [],
      };
      // Stamp sessionId on any pre-seeded messages so the DM's recap can disambiguate.
      for (const m of session.messages) {
        if (m && typeof m === 'object' && !m.sessionId) m.sessionId = session.id;
      }
      // Write session to neutral shared location: data/sessions/<id>/session.json
      //
      // Direct write rather than updateSessionFile, and that is safe here for a reason worth
      // stating: the id was generated in this handler and the file does not exist yet, so
      // there is nothing to read-modify-write and no other writer can hold this id. Every
      // route that touches a session a client already knows about goes through the queue —
      // see the join route below and PUT /:id above. If this write is ever moved to a path
      // where the session can already be open, it has to move to the queue with it.
      const sessionDir = getSessionDir(dataDir, session.id);
      fs.mkdirSync(sessionDir, { recursive: true });
      writeJsonAtomic(path.join(sessionDir, 'session.json'), session);
      // Snapshot characters and NPCs from defaults + player library into session dir
      snapshotToSession(dataDir, session.id, requester.email, session.campaignId);

      // Verify the host's selected character made it into the session dir.
      // It might not if the host selected a character from another player's library
      // (e.g. they saw it in a previous session and picked it for a new one).
      if (session.characterId) {
        const sessCharDir = getSessionCharactersDir(dataDir, session.id);
        const sessCharFiles = fs.readdirSync(sessCharDir).filter(f => f.endsWith('.json'));
        const found = sessCharFiles.some(f => {
          try {
            const d = JSON.parse(fs.readFileSync(path.join(sessCharDir, f), 'utf-8'));
            return d.id === session.characterId;
          } catch { return false; }
        });
        if (!found) {
          // Search all player libraries for this character
          const playersDir = path.join(dataDir, 'players');
          if (fs.existsSync(playersDir)) {
            const slugs = fs.readdirSync(playersDir).filter(d => {
              try { return fs.statSync(path.join(playersDir, d)).isDirectory(); } catch { return false; }
            });
            for (const slug of slugs) {
              const libDir = path.join(playersDir, slug, session.campaignId || 'demo', 'characters');
              if (!fs.existsSync(libDir)) continue;
              for (const f of fs.readdirSync(libDir).filter(f => f.endsWith('.json'))) {
                try {
                  const d = JSON.parse(fs.readFileSync(path.join(libDir, f), 'utf-8'));
                  if (d.id === session.characterId) {
                    fs.copyFileSync(path.join(libDir, f), path.join(sessCharDir, f));
                    break;
                  }
                } catch { /* skip */ }
              }
            }
          }
        }
      }

      // Final binding check: heal by name/slug where possible; NEVER fail silently.
      // A dangling characterId is exactly how sheets stopped updating in production.
      const integrity = verifySessionIntegrity(dataDir, session);
      if (integrity.changed) {
        // Still inside POST /sessions, still an id no client has been given — see the note on
        // the first write above.
        writeJsonAtomic(path.join(sessionDir, 'session.json'), session);
      }
      if (integrity.warnings.length > 0) {
        console.error(`[Sessions] POST ${session.id} — UNRESOLVED character binding:\n  ${integrity.warnings.join('\n  ')}`);
      }

      const result = withSessionAccess(session, requester);
      if (integrity.warnings.length > 0) result.warnings = integrity.warnings;
      res.status(201).json(result);
      broadcastToAll('sessions_changed');
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT update session
  router.put('/:id', async (req, res) => {
    try {
      const requester = getAuthenticatedPlayer(dataDir, req);
      if (!requester) {
        return res.status(403).json({ error: 'Login required. Guests cannot modify sessions.' });
      }
      const filePath = findSessionFile(req.params.id);
      if (!filePath) {
        return res.status(404).json({ error: 'Session not found' });
      }
      const precheck = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (!canWriteSession(precheck, requester)) {
        return res.status(403).json({ error: 'Only the session creator can modify this session.' });
      }
      console.log(`[Sessions] PUT ${req.params.id} — messages: ${(req.body.messages || []).length}, claudeSessionId: ${req.body.claudeSessionId ? 'yes' : 'no'}`);

      // Serialized read-modify-write: the DM turn persistence and world-state tool
      // write session.json concurrently with client auto-saves.
      const updated = await updateSessionFile(dataDir, precheck.id, (existing) => {
        const ownerEmail = getOwnerEmail(existing);
        const ownerName = getOwnerName(existing);
        // Snapshot server-authoritative values BEFORE the payload is applied —
        // `precheck` was read outside the lock and may already be stale.
        const prior = {
          characterId: existing.characterId,
          claudeSessionId: existing.claudeSessionId,
          companionStates: existing.companionConfig?.states,
          messages: existing.messages,
          archiveSeq: Number(existing.archiveSeq || 0),
        };
        const payload = { ...req.body };
        delete payload.id;
        delete payload.createdAt;
        delete payload.updatedAt;
        delete payload.ownerEmail;
        delete payload.ownerName;
        delete payload.playerEmail;
        delete payload.playerName;
        delete payload.players;
        delete payload.settings; // settings updated via dedicated endpoint
        delete payload.dmPersonality; // locked at session creation
        delete payload.campaignId;    // fixed at creation; a body field must not re-route the session's files (WO-0041)
        // Server-owned state — never let a client auto-save overwrite it.
        const incomingArchiveSeq = Number(req.body.archiveSeq || 0);
        const existingArchiveSeq = prior.archiveSeq;
        delete payload.archiveSeq;
        delete payload.arcSummaries;
        delete payload.archiveMeta;
        delete payload.worldState;               // written by the DM tool + turn digest
        delete payload.dmMessagesSinceLastSummary; // written by turn persistence
        delete payload.pendingTurns;             // written by the turn queue

        Object.assign(existing, payload, {
          ownerEmail: ownerEmail || requester.email,
          ownerName: ownerName || requester.name,
          playerEmail: ownerEmail || requester.email,
          playerName: ownerName || requester.name,
        });
        // Never allow an update to blank an existing characterId
        if (!existing.characterId && prior.characterId) {
          existing.characterId = prior.characterId;
        }
        // Never let a stale auto-save wipe a stored Claude session id. After a session load,
        // the client's sessionId state is null until the next turn's session_id event — an
        // auto-save in that window would otherwise overwrite the id and break SDK conversation
        // resume (forcing a lossy recap rebuild on the next resume).
        if (!existing.claudeSessionId && prior.claudeSessionId) {
          existing.claudeSessionId = prior.claudeSessionId;
        }
        // Defense in depth: never wipe a non-empty companionConfig.states with an empty one.
        // Without this guard, a stale auto-save during session load can erase the host's
        // selected/removed/player slot configuration, causing removed NPCs to reappear.
        const incomingStates = existing.companionConfig?.states;
        if (prior.companionStates && Object.keys(prior.companionStates).length > 0
            && (!incomingStates || Object.keys(incomingStates).length === 0)) {
          existing.companionConfig = { ...(existing.companionConfig || {}), states: prior.companionStates };
          console.warn(`[Sessions] PUT ${req.params.id} — preserved existing companionConfig.states (incoming was empty)`);
        }
        // If the client is auto-saving from pre-compaction state (an older archiveSeq), its
        // full in-memory array would resurrect messages the server already archived + trimmed.
        // Keep the server's compacted history; the client reconciles on the next session_compacted.
        if (existingArchiveSeq > 0 && incomingArchiveSeq < existingArchiveSeq && Array.isArray(req.body.messages)) {
          existing.messages = prior.messages;
          console.warn(`[Sessions] PUT ${req.params.id} — ignored stale messages (client seq ${incomingArchiveSeq} < server ${existingArchiveSeq}); preserved compacted history`);
        }
        // Server-side turn persistence may be AHEAD of the client's auto-save (the
        // server appends the canonical turn at dm_complete; the client's PUT can
        // arrive with an array from before that append). If the incoming array is a
        // prefix of what the server already has, keep the server's longer history.
        if (Array.isArray(req.body.messages) && Array.isArray(prior.messages)
            && prior.messages.length > req.body.messages.length) {
          const isPrefix = req.body.messages.every((m, i) => {
            const s = prior.messages[i];
            return s && m && s.type === m.type && s.text === m.text;
          });
          if (isPrefix) {
            existing.messages = prior.messages;
            console.log(`[Sessions] PUT ${req.params.id} — kept server messages (${prior.messages.length}) over shorter client array (${req.body.messages.length})`);
          }
        }
        // Backfill sessionId on any message that lacks it — client auto-save paths
        // construct message objects without the field, and the DM's recap formatter
        // relies on it to disambiguate campaigns in multi-session contexts.
        if (Array.isArray(existing.messages)) {
          for (const m of existing.messages) {
            if (m && typeof m === 'object' && !m.sessionId) m.sessionId = existing.id;
          }
        }
      });
      res.json(withSessionAccess(updated, requester));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT update session settings
  router.put('/:id/settings', async (req, res) => {
    try {
      const requester = getAuthenticatedPlayer(dataDir, req);
      if (!requester) {
        return res.status(403).json({ error: 'Login required.' });
      }
      const filePath = findSessionFile(req.params.id);
      if (!filePath) {
        return res.status(404).json({ error: 'Session not found' });
      }
      const existing = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (!canWriteSession(existing, requester)) {
        return res.status(403).json({ error: 'Only the session creator can change settings.' });
      }

      const currentSettings = getSessionSettings(existing);
      const incoming = req.body || {};

      // Validate visibility
      if (incoming.visibility !== undefined) {
        if (!['private', 'public'].includes(incoming.visibility)) {
          return res.status(400).json({ error: 'visibility must be "private" or "public"' });
        }
        currentSettings.visibility = incoming.visibility;
      }

      if (incoming.allowBots !== undefined) {
        currentSettings.allowBots = !!incoming.allowBots;
      }
      if (incoming.maxBots !== undefined) {
        currentSettings.maxBots = Math.max(1, Math.min(5, Number(incoming.maxBots) || 2));
      }

      // Through the queue: a host changing visibility mid-turn was otherwise written and then
      // overwritten by the turn's own persistence. Validation stays outside — it only reads the
      // request body and the settings shape — and only the mutation is sequenced.
      await updateSessionFile(dataDir, req.params.id, (live) => {
        live.settings = currentSettings;
      });
      res.json({ settings: currentSettings });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT rename session (set label)
  router.put('/:id/label', async (req, res) => {
    try {
      const requester = getAuthenticatedPlayer(dataDir, req);
      if (!requester) {
        return res.status(403).json({ error: 'Login required.' });
      }
      const filePath = findSessionFile(req.params.id);
      if (!filePath) {
        return res.status(404).json({ error: 'Session not found' });
      }
      const existing = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (!canWriteSession(existing, requester)) {
        return res.status(403).json({ error: 'Only the session creator can rename this session.' });
      }
      const label = req.body.label != null ? String(req.body.label).trim().substring(0, 60) || null : null;
      // Through the queue, same reason as the settings route above.
      await updateSessionFile(dataDir, req.params.id, (live) => {
        live.label = label;
      });
      res.json({ label });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST join a companion slot
  router.post('/:id/join', async (req, res) => {
    try {
      const requester = getAuthenticatedPlayer(dataDir, req);
      if (!requester) {
        return res.status(403).json({ error: 'Login required to join a session.' });
      }
      const { npcId } = req.body;
      if (!npcId) {
        return res.status(400).json({ error: 'npcId is required.' });
      }

      const filePath = findSessionFile(req.params.id);
      if (!filePath) {
        return res.status(404).json({ error: 'Session not found' });
      }

      const session = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const settings = getSessionSettings(session);
      if (settings.visibility !== 'public') {
        return res.status(403).json({ error: 'This session is private.' });
      }

      const config = session.companionConfig;
      if (!config || !config.states) {
        return res.status(400).json({ error: 'This session has no companion slots configured.' });
      }

      const slotState = config.states[npcId];
      if (!slotState || (slotState !== 'player' && slotState !== 'reserved')) {
        return res.status(400).json({ error: 'This companion slot is not open for players.' });
      }

      // Check reservation
      if (slotState === 'reserved') {
        const reservedFor = (config.reservations || {})[npcId];
        if (reservedFor && reservedFor !== requester.email) {
          return res.status(403).json({ error: 'This slot is reserved for another player.' });
        }
      }

      // Prevent host from joining their own session as a companion
      const ownerEmail = getOwnerEmail(session);
      if (ownerEmail && requester.email.toLowerCase() === ownerEmail.toLowerCase()) {
        return res.status(400).json({ error: 'The host cannot join a companion slot in their own session.' });
      }

      // Claiming a slot is a check-then-act on a file the DM turn also writes, so it happens
      // inside the queue — the same reason and the same shape as PUT /:id above, whose comment
      // says it: a value read outside the lock may already be stale. The checks that decide
      // whether the claim is legal are re-run in here against the file as it is now, not as it
      // was when this request arrived. Two friends clicking Join in the same instant were
      // already safe (an Express handler with no await between its read and its write runs to
      // completion), but a claim landing while a DM turn persisted was not: it was written and
      // then overwritten, and the player got a 200 saying they had joined. WO-0015.4.
      let conflict = null;
      let claim = null;
      const claimed = await updateSessionFile(dataDir, req.params.id, (live) => {
        if (!live.companionPlayers) live.companionPlayers = {};
        if (live.companionPlayers[npcId]) {
          conflict = { status: 409, error: 'This slot has already been claimed.' };
          return false;
        }
        const alreadyJoined = Object.values(live.companionPlayers).some(
          cp => cp.email && cp.email.toLowerCase() === requester.email.toLowerCase()
        );
        if (alreadyJoined) {
          conflict = { status: 409, error: 'You have already joined a slot in this session.' };
          return false;
        }
        claim = {
          email: requester.email,
          name: requester.name,
          joinedAt: new Date().toISOString(),
        };
        live.companionPlayers[npcId] = claim;
      });
      if (conflict) {
        return res.status(conflict.status).json({ error: conflict.error });
      }

      broadcastToAll('sessions_changed');
      res.json({
        npcId,
        campaignId: claimed.campaignId || 'demo',
        claimedBy: claim,
        companionSlots: getCompanionSlots(claimed),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST unjoin — release a claimed companion slot
  router.post('/:id/unjoin', async (req, res) => {
    try {
      const requester = getAuthenticatedPlayer(dataDir, req);
      if (!requester) {
        return res.status(403).json({ error: 'Login required.' });
      }
      const { npcId } = req.body;
      if (!npcId) {
        return res.status(400).json({ error: 'npcId is required.' });
      }

      const filePath = findSessionFile(req.params.id);
      if (!filePath) {
        return res.status(404).json({ error: 'Session not found' });
      }

      const session = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const isOwner = canWriteSession(session, requester);
      const isAdmin = requester.role === 'admin';

      // Releasing a slot is a check-then-act, like the join above, and goes through the queue
      // for the same reason. Who is allowed to release it depends on who currently holds it,
      // so that check belongs inside the lock too.
      let refusal = null;
      const released = await updateSessionFile(dataDir, req.params.id, (live) => {
        if (!live.companionPlayers || !live.companionPlayers[npcId]) {
          refusal = { status: 400, error: 'This slot is not claimed.' };
          return false;
        }
        const claimEmail = live.companionPlayers[npcId].email;
        if (claimEmail !== requester.email && !isOwner && !isAdmin) {
          refusal = { status: 403, error: 'You can only unjoin your own slot.' };
          return false;
        }
        delete live.companionPlayers[npcId];
      });
      if (refusal) {
        return res.status(refusal.status).json({ error: refusal.error });
      }

      broadcastToAll('sessions_changed');
      res.json({
        npcId,
        companionSlots: getCompanionSlots(released),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /:id/restore-character ──────────────────────────────────────────────────────────────
  // The undo this product has never had (WO-0016, recommended by the Ethics & Safety Officer).
  //
  // Until now the only recovery from a death was POST /settings/reset-my-data, which copies
  // data/defaults/<campaign>/characters over the player's library — so a character thirty hours
  // old came back as the level-1 template they started from. This route copies the player's OWN
  // library sheet into the session directory instead. It is cheap because there is no
  // session -> library write-back anywhere in this server: the library copy has sat untouched
  // since snapshotToSession ran when the session was created, so the pre-death character is
  // already on disk and nothing needs capturing. It needs copying back.
  //
  // ── This is a sanctioned governed-field writer ───────────────────────────────────────────────
  // The write below sets hitPoints, status and deathSaves: Ring 1 of ADR 0005 §3, the exact
  // fields server/state-guard.js refuses unconditionally. The guard is not weakened for it and
  // does not see it — ADR 0005 §5.6 says in terms that the guard binds the model and not the
  // server. What makes this legitimate is not that it sits outside the guard; it is that every
  // property the guard exists to enforce holds here anyway:
  //   * no agent is involved. The DM cannot call this route and cannot cause a player to;
  //   * no number is invented. Every value is copied verbatim out of a file the server wrote at
  //     session creation and has not touched since, so nothing is being decided by anybody;
  //   * it is not silent. The player confirms it first and the whole party is told afterwards in
  //     the transcript — more visibility than any tool write gets.
  // It is listed by file and by call-site count in the whole-server sanctioned-sheet-writer scan
  // in server/__tests__/mechanical-tools.test.js. A second sheet write in this file, or a first
  // one in any unlisted file under server/, fails that scan until somebody writes down why it
  // exists. That is the point of listing it: the scan built two days ago was found by QC to be
  // blind to the very defect it existed to catch, and a new sanctioned writer waved through
  // without care is how that happens again.
  //
  // ── Why the whole operation runs inside updateSessionFile ────────────────────────────────────
  // WO-0015 established that a live-session write racing the DM's turn is silently overwritten,
  // and a restore is exactly that shape: the player clicks Restore while the server is persisting
  // the turn that killed them. So the transcript line goes on the same per-session queue as every
  // other server-side session write, and the checks that decide whether the restore is legal are
  // re-run inside the lock against the file as it is now — not as it was when the request
  // arrived. Same reason and same shape as /:id/join above.
  //
  // The sheet write is inside the lock too, and that does NOT make it race-free. Saying it did
  // would be worse than saying nothing, so: character files are not on this queue at all —
  // vitals-utils, xp-utils, resource-utils and routes/characters all write them directly — so an
  // ApplyVitals call in a turn already in flight can still land after this write, from a sheet it
  // read before it, and re-apply the damage. What the lock does buy is that the restore cannot be
  // reordered against the turn's own session.json persistence: the notice cannot be lost, and the
  // party cannot be told about a restore whose session record was then overwritten. Putting
  // character files on a queue of their own is a larger change than this work order.
  router.post('/:id/restore-character', async (req, res) => {
    try {
      const requester = getAuthenticatedPlayer(dataDir, req);
      if (!requester) {
        return res.status(403).json({ error: 'Login required to restore a character.' });
      }
      const characterId = req.body && req.body.characterId;
      if (!characterId) {
        return res.status(400).json({ error: 'characterId is required.' });
      }
      // The only destructive thing a player can do to their own game from inside a session, so it
      // does not happen on a bare POST. The client sends this once the player has read what the
      // restore discards; a caller that has not asked is refused rather than obeyed.
      if (req.body.confirm !== true) {
        return res.status(400).json({
          error: 'Restoring a character discards everything that has happened to them during this session. Send confirm: true once the player has been told that and has agreed.',
        });
      }

      const filePath = findSessionFile(req.params.id);
      if (!filePath) {
        return res.status(404).json({ error: 'Session not found' });
      }

      const requesterEmail = String(requester.email).trim().toLowerCase();
      let refusal = null;
      let outcome = null;

      await updateSessionFile(dataDir, req.params.id, (live) => {
        const seat = findCharacterSeat(live, characterId);
        if (!seat) {
          const known = listSessionCharacterIds(live);
          refusal = {
            status: 404,
            error: known.length > 0
              ? `No character with id "${characterId}" is being played in this session. The characters here are: ${known.join(', ')}.`
              : `No character with id "${characterId}" is being played in this session.`,
          };
          return false;
        }
        if (seat.email !== requesterEmail) {
          refusal = {
            status: 403,
            error: `That character is being played by ${seat.name}. Only the player of a character can bring them back${seat.seat === 'companion' ? ', so this is not the host’s to do on their behalf' : ''} — ask ${seat.name} to do it from their own screen.`,
          };
          return false;
        }

        const campaign = live.campaignId || 'demo';
        const sessionSheet = readSheetByExactId(getSessionCharactersDir(dataDir, req.params.id), characterId);
        if (!sessionSheet) {
          refusal = {
            status: 404,
            error: `This session has no character file for "${characterId}", so there is nothing to restore over. Nothing has been changed.`,
          };
          return false;
        }
        const name = sessionSheet.data.name || characterId;

        if (!isDownOrDead(sessionSheet.data)) {
          const currentHp = sessionSheet.data.hitPoints || {};
          refusal = {
            status: 409,
            error: `${name} is alive at ${currentHp.current ?? '?'}/${currentHp.max ?? '?'} hit points. Restore exists to undo a death, so it stays out of the way while your character is on their feet.`,
          };
          return false;
        }

        const librarySheet = readSheetByExactId(getPlayerCharactersDir(dataDir, seat.email, campaign), characterId);
        if (!librarySheet) {
          refusal = {
            status: 409,
            error: `There is no saved copy of ${name} in your character library for this campaign, so a restore would have nothing to bring back. Nothing has been changed. This is what it looks like when a character was made inside the session and never saved to the library.`,
          };
          return false;
        }
        // A library copy that is itself dead or down would cost the player their whole session and
        // leave them exactly where they are. Refusing is the only answer that does not take
        // something for nothing.
        if (isDownOrDead(librarySheet.data)) {
          refusal = {
            status: 409,
            error: `The saved copy of ${name} is itself ${describeCondition(librarySheet.data)}, so restoring it would discard this session and leave ${name} no better off. Nothing has been changed.`,
          };
          return false;
        }

        // Copied verbatim from the library file, with three deliberate edits and no fourth.
        const restoredSheet = { ...librarySheet.data };
        // 1. Death-save state is cleared rather than copied. The library copy predates the death
        //    and normally has none at all — but `delete` is the version that is still right on the
        //    day one appears, and "the copy happened not to have any" is not a guarantee.
        delete restoredSheet.deathSaves;
        // 2. status is filled in only when absent, exactly as copyDefaultsToDir's addStatusAlive
        //    does. It is never overwritten: a library copy reading "dead" was refused above, so
        //    the only thing this line can do is supply the default for a sheet that lacks the
        //    field. ADR 0005 §7.3 — the field has two values and "down" is derived from the HP.
        if (!restoredSheet.status) restoredSheet.status = 'alive';
        // 3. The session's own filename is kept. Minting one from the name is how a character
        //    ended up on disk twice, as daichi-mus.json and daichi-muso.json (see ws-handler.js's
        //    companion copy), and two files with one id means the DM's next read may find either.
        restoredSheet._filename = sessionSheet.data._filename || sessionSheet.file;

        const targetPath = sessionSheet.filePath;
        writeJsonAtomic(targetPath, restoredSheet);

        const restoredHp = restoredSheet.hitPoints || {};
        // Visible to the party, and phrased for someone reading it in the middle of a scene: who
        // did it, what state the character is in now, and what it cost. A character returning from
        // the dead is not a private event, and the transcript is where this game records what
        // happened.
        const notice = `${name} was restored by ${requester.name || seat.name} from their saved character, as ${name} was when this session began — ${restoredHp.current ?? '?'}/${restoredHp.max ?? '?'} hit points and no death saves. Everything that happened to ${name} during this session has been replaced by that saved copy.`;
        if (!Array.isArray(live.messages)) live.messages = [];
        live.messages.push({
          type: 'system',
          text: notice,
          timestamp: new Date().toISOString(),
          sessionId: live.id || req.params.id,
        });

        outcome = {
          name,
          notice,
          seat: seat.seat,
          hitPoints: { current: restoredHp.current ?? null, max: restoredHp.max ?? null },
          restoredFrom: librarySheet.file,
          file: path.basename(targetPath),
        };
      });

      if (refusal) {
        return res.status(refusal.status).json({ error: refusal.error });
      }

      // One message, doing two jobs: it carries the transcript line and it tells every client
      // that a character sheet changed outside the turn cycle, so the party boards stop showing
      // hit points that stopped being true a moment ago.
      //
      // It is NOT sent on the 'session_player_message' channel the integrity notices use. That
      // channel renders on the client as a message from the player — the integrity warnings live
      // with that and paper over it with a leading "⚠️", but it also means the live view and the
      // view after a page reload disagree about what kind of message it was. This one is stored
      // in session.json as `system` and arrives as `system`, so the two agree. The name is pinned
      // against the client's handler by a test in server/__tests__/restore-character.test.js.
      broadcastToSessionRoom(req.params.id, 'session_character_restored', {
        text: outcome.notice,
        characterId,
        timestamp: new Date().toISOString(),
        sessionId: req.params.id,
      });

      res.json({ restored: true, characterId, ...outcome });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE session
  router.delete('/:id', (req, res) => {
    try {
      const requester = getAuthenticatedPlayer(dataDir, req);
      if (!requester) {
        return res.status(403).json({ error: 'Login required. Guests cannot delete sessions.' });
      }
      const filePath = findSessionFile(req.params.id);
      if (!filePath) {
        return res.status(404).json({ error: 'Session not found' });
      }
      const existing = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (!canWriteSession(existing, requester)) {
        return res.status(403).json({ error: 'Only the session creator can delete this session.' });
      }
      // Remove the entire session directory (session.json + characters/ + npcs/)
      const sessionDir = getSessionDir(dataDir, req.params.id);
      fs.rmSync(sessionDir, { recursive: true, force: true });
      res.json({ success: true });
      broadcastToAll('sessions_changed');
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST add player to session (multiplayer prep)
  router.post('/:id/players', async (req, res) => {
    try {
      const requester = getAuthenticatedPlayer(dataDir, req);
      if (!requester) {
        return res.status(403).json({ error: 'Login required. Guests cannot modify sessions.' });
      }
      const filePath = findSessionFile(req.params.id);
      if (!filePath) {
        return res.status(404).json({ error: 'Session not found' });
      }
      const session = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (!canWriteSession(session, requester)) {
        return res.status(403).json({ error: 'Only the session creator can modify this session.' });
      }
      const { characterId } = req.body;
      const player = {
        id: uuidv4(),
        characterId,
        role: 'player',
        joinedAt: new Date().toISOString(),
      };
      // The party-size check is a check-then-act on a list two requests could append to, so it
      // is re-run inside the queue against the live file rather than the pre-check snapshot.
      let full = false;
      await updateSessionFile(dataDir, req.params.id, (live) => {
        if (!Array.isArray(live.players)) live.players = [];
        if (live.players.length >= 8) {
          full = true;
          return false;
        }
        live.players.push(player);
      });
      if (full) {
        return res.status(400).json({ error: 'Party is full (max 8)' });
      }
      res.status(201).json(player);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET party members for a session (filtered characters + NPCs)
  // Accessible to any authenticated player (and guests for public sessions)
  router.get('/:id/party', (req, res) => {
    try {
      const requester = getAuthenticatedPlayer(dataDir, req);

      const filePath = findSessionFile(req.params.id);
      if (!filePath) {
        return res.status(404).json({ error: 'Session not found' });
      }

      const session = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const settings = getSessionSettings(session);
      if (!canWriteSession(session, requester) && settings.visibility !== 'public') {
        if (!requester) return res.status(401).json({ error: 'Login required.' });
        return res.status(404).json({ error: 'Session not found' });
      }

      const sessionId = session.id;
      const states = session.companionConfig?.states || {};
      const claimed = session.companionPlayers || {};

      // --- Characters: read from session dir with recovery ---
      const characters = [];
      const warnings = [];
      const sessCharDir = getSessionCharactersDir(dataDir, sessionId);
      const cid = session.campaignId || 'demo';
      const defaultCharDir = path.join(dataDir, 'defaults', cid, 'characters');
      const defaultNpcDir = path.join(dataDir, 'defaults', cid, 'npcs');

      // Helper: safely read a character by id from session dir, with recovery
      function findCharacterById(targetId) {
        if (!fs.existsSync(sessCharDir)) return null;
        const files = fs.readdirSync(sessCharDir).filter(f => f.endsWith('.json'));
        for (const f of files) {
          const filePath = path.join(sessCharDir, f);
          const result = safeReadJsonFile(filePath);
          if (result.ok) {
            if (result.data.id === targetId) return result.data;
          } else {
            // Corrupt file — attempt recovery
            const recoveryDirs = [defaultCharDir];
            // Try player library if we know the owner
            if (session.ownerEmail) {
              const playerCharDir = getPlayerCharactersDir(dataDir, session.ownerEmail, cid);
              recoveryDirs.unshift(playerCharDir);
            }
            const recovery = tryRecover(filePath, f, recoveryDirs);
            if (recovery.recovered) {
              warnings.push({ filename: f, name: recovery.data.name || f, error: result.error, recovered: true, source: path.basename(recovery.source) });
              if (recovery.data.id === targetId) return recovery.data;
            } else {
              let name = f;
              try { const raw = fs.readFileSync(filePath, 'utf-8'); const m = raw.match(/"name"\s*:\s*"([^"]+)"/); if (m) name = m[1]; } catch {}
              warnings.push({ filename: f, name, error: result.error, recovered: false, source: null });
            }
          }
        }
        return null;
      }

      if (session.characterId) {
        const hostChar = findCharacterById(session.characterId);
        if (hostChar) characters.push(hostChar);
      }

      // --- Characters: companion players' PCs (also in session dir) ---
      const companionsWithoutCharacter = [];
      for (const [npcId, cp] of Object.entries(claimed)) {
        if (!cp.email) continue;
        if (!cp.characterId) {
          companionsWithoutCharacter.push(npcId);
          continue;
        }
        const compChar = findCharacterById(cp.characterId);
        if (compChar) characters.push(compChar);
      }

      // --- NPCs: read from session dir, fall back to campaign defaults ---
      const npcs = [];
      const sessNpcDir = getSessionNpcsDir(dataDir, sessionId);
      const npcDir = fs.existsSync(sessNpcDir) ? sessNpcDir : (fs.existsSync(defaultNpcDir) ? defaultNpcDir : null);
      if (npcDir) {
        const npcRecoveryDirs = npcDir !== defaultNpcDir ? [defaultNpcDir] : [];
        const files = fs.readdirSync(npcDir).filter(f => f.endsWith('.json'));
        for (const f of files) {
          const filePath = path.join(npcDir, f);
          const result = safeReadJsonFile(filePath);
          if (result.ok) {
            if (states[result.data.id] === 'removed') continue;
            if (claimed[result.data.id] && !companionsWithoutCharacter.includes(result.data.id)) continue;
            const { dmNotes, ...safe } = result.data;
            npcs.push(safe);
          } else {
            // Corrupt NPC — attempt recovery
            const recovery = tryRecover(filePath, f, npcRecoveryDirs);
            if (recovery.recovered) {
              warnings.push({ filename: f, name: recovery.data.name || f, error: result.error, recovered: true, source: path.basename(recovery.source) });
              if (states[recovery.data.id] !== 'removed' && !(claimed[recovery.data.id] && !companionsWithoutCharacter.includes(recovery.data.id))) {
                const { dmNotes, ...safe } = recovery.data;
                npcs.push(safe);
              }
            } else {
              let name = f;
              try { const raw = fs.readFileSync(filePath, 'utf-8'); const m = raw.match(/"name"\s*:\s*"([^"]+)"/); if (m) name = m[1]; } catch {}
              warnings.push({ filename: f, name, error: result.error, recovered: false, source: null });
            }
          }
        }
      }

      const response = { characters, npcs };
      if (warnings.length > 0) response.warnings = warnings;
      res.json(response);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};

// Exported for tests: the two rules the restore route turns on, assertable without a server.
module.exports._testing = { findCharacterSeat, isDownOrDead, listSessionCharacterIds, readSheetByExactId };

