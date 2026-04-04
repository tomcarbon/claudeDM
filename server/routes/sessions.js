const express = require('express');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { getAuthenticatedPlayer } = require('../player-auth');
const { emailToSlug, getSessionDir, getSessionFilePath, getSessionCharactersDir, getSessionNpcsDir, getPlayerCharactersDir, provisionPlayerDefaults, snapshotToSession } = require('../player-data');
const { broadcastToAll } = require('../ws-handler');
const { loadDmSettings } = require('../dm-engine');

const DEFAULT_SETTINGS = {
  visibility: 'public', // 'private' | 'public'
  allowBots: false,
  maxBots: 2,
};

const DEFAULT_MAX_SESSIONS = 3;

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

module.exports = function (dataDir) {
  const router = express.Router();

  // All sessions live in a flat neutral directory: data/sessions/<id>/session.json
  const sessionsBaseDir = path.join(dataDir, 'sessions');

  function ensureSessionsDir() {
    if (!fs.existsSync(sessionsBaseDir)) fs.mkdirSync(sessionsBaseDir, { recursive: true });
  }

  // Find a session file by ID — simple direct lookup
  function findSessionFile(sessionId) {
    const fp = getSessionFilePath(dataDir, sessionId);
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

  // POST create new session
  router.post('/', (req, res) => {
    try {
      const requester = getAuthenticatedPlayer(dataDir, req);
      if (!requester) {
        return res.status(403).json({ error: 'Login required. Guests cannot create sessions.' });
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
      // Write session to neutral shared location: data/sessions/<id>/session.json
      const sessionDir = getSessionDir(dataDir, session.id);
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(
        path.join(sessionDir, 'session.json'),
        JSON.stringify(session, null, 2)
      );
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

      const result = withSessionAccess(session, requester);
      res.status(201).json(result);
      broadcastToAll('sessions_changed');
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT update session
  router.put('/:id', (req, res) => {
    try {
      const requester = getAuthenticatedPlayer(dataDir, req);
      if (!requester) {
        return res.status(403).json({ error: 'Login required. Guests cannot modify sessions.' });
      }
      const filePath = findSessionFile(req.params.id);
      if (!filePath) {
        return res.status(404).json({ error: 'Session not found' });
      }
      const existing = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (!canWriteSession(existing, requester)) {
        return res.status(403).json({ error: 'Only the session creator can modify this session.' });
      }
      console.log(`[Sessions] PUT ${req.params.id} — messages: ${(req.body.messages || []).length}, claudeSessionId: ${req.body.claudeSessionId ? 'yes' : 'no'}`);
      const ownerEmail = getOwnerEmail(existing);
      const ownerName = getOwnerName(existing);
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

      const updated = {
        ...existing,
        ...payload,
        id: existing.id,
        ownerEmail: ownerEmail || requester.email,
        ownerName: ownerName || requester.name,
        playerEmail: ownerEmail || requester.email,
        playerName: ownerName || requester.name,
        updatedAt: new Date().toISOString(),
      };
      // Never allow an update to blank an existing characterId
      if (!updated.characterId && existing.characterId) {
        updated.characterId = existing.characterId;
      }
      fs.writeFileSync(filePath, JSON.stringify(updated, null, 2));
      res.json(withSessionAccess(updated, requester));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT update session settings
  router.put('/:id/settings', (req, res) => {
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

      existing.settings = currentSettings;
      existing.updatedAt = new Date().toISOString();
      fs.writeFileSync(filePath, JSON.stringify(existing, null, 2));
      res.json({ settings: currentSettings });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT rename session (set label)
  router.put('/:id/label', (req, res) => {
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
      existing.label = label;
      existing.updatedAt = new Date().toISOString();
      fs.writeFileSync(filePath, JSON.stringify(existing, null, 2));
      res.json({ label: existing.label });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST join a companion slot
  router.post('/:id/join', (req, res) => {
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

      // Check if already claimed
      if (!session.companionPlayers) session.companionPlayers = {};
      if (session.companionPlayers[npcId]) {
        return res.status(409).json({ error: 'This slot has already been claimed.' });
      }

      // Prevent host from joining their own session as a companion
      const ownerEmail = getOwnerEmail(session);
      if (ownerEmail && requester.email.toLowerCase() === ownerEmail.toLowerCase()) {
        return res.status(400).json({ error: 'The host cannot join a companion slot in their own session.' });
      }

      // Prevent a player from claiming more than one slot
      const alreadyJoined = Object.values(session.companionPlayers).some(
        cp => cp.email && cp.email.toLowerCase() === requester.email.toLowerCase()
      );
      if (alreadyJoined) {
        return res.status(409).json({ error: 'You have already joined a slot in this session.' });
      }

      // Claim the slot
      session.companionPlayers[npcId] = {
        email: requester.email,
        name: requester.name,
        joinedAt: new Date().toISOString(),
      };
      session.updatedAt = new Date().toISOString();
      fs.writeFileSync(filePath, JSON.stringify(session, null, 2));
      broadcastToAll('sessions_changed');
      res.json({
        npcId,
        campaignId: session.campaignId || 'demo',
        claimedBy: session.companionPlayers[npcId],
        companionSlots: getCompanionSlots(session),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST unjoin — release a claimed companion slot
  router.post('/:id/unjoin', (req, res) => {
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

      if (!session.companionPlayers || !session.companionPlayers[npcId]) {
        return res.status(400).json({ error: 'This slot is not claimed.' });
      }

      // Only the player who claimed it, the session owner, or an admin can unjoin
      const claimEmail = session.companionPlayers[npcId].email;
      const isAdmin = requester.role === 'admin';
      if (claimEmail !== requester.email && !isOwner && !isAdmin) {
        return res.status(403).json({ error: 'You can only unjoin your own slot.' });
      }

      delete session.companionPlayers[npcId];
      session.updatedAt = new Date().toISOString();
      fs.writeFileSync(filePath, JSON.stringify(session, null, 2));
      broadcastToAll('sessions_changed');
      res.json({
        npcId,
        companionSlots: getCompanionSlots(session),
      });
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
  router.post('/:id/players', (req, res) => {
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
      if (!Array.isArray(session.players)) {
        session.players = [];
      }
      if (session.players.length >= 8) {
        return res.status(400).json({ error: 'Party is full (max 8)' });
      }
      const player = {
        id: uuidv4(),
        characterId,
        role: 'player',
        joinedAt: new Date().toISOString(),
      };
      session.players.push(player);
      session.updatedAt = new Date().toISOString();
      fs.writeFileSync(filePath, JSON.stringify(session, null, 2));
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

      // --- Characters: read from session dir ---
      const characters = [];
      const sessCharDir = getSessionCharactersDir(dataDir, sessionId);
      if (session.characterId && fs.existsSync(sessCharDir)) {
        const files = fs.readdirSync(sessCharDir).filter(f => f.endsWith('.json'));
        for (const f of files) {
          try {
            const data = JSON.parse(fs.readFileSync(path.join(sessCharDir, f), 'utf-8'));
            if (data.id === session.characterId) {
              characters.push(data);
              break;
            }
          } catch { /* skip malformed */ }
        }
      }

      // --- Characters: companion players' PCs (also in session dir) ---
      const companionsWithoutCharacter = [];
      for (const [npcId, cp] of Object.entries(claimed)) {
        if (!cp.email) continue;
        if (!cp.characterId) {
          companionsWithoutCharacter.push(npcId);
          continue;
        }
        // Companion characters are stored in the session directory
        if (fs.existsSync(sessCharDir)) {
          const cpFiles = fs.readdirSync(sessCharDir).filter(f => f.endsWith('.json'));
          for (const f of cpFiles) {
            try {
              const data = JSON.parse(fs.readFileSync(path.join(sessCharDir, f), 'utf-8'));
              if (data.id === cp.characterId) {
                characters.push(data);
                break;
              }
            } catch { /* skip malformed */ }
          }
        }
      }

      // --- NPCs: read from session dir, fall back to campaign defaults ---
      const npcs = [];
      const sessNpcDir = getSessionNpcsDir(dataDir, sessionId);
      const defaultNpcDir = path.join(dataDir, 'defaults', session.campaignId || 'demo', 'npcs');
      const npcDir = fs.existsSync(sessNpcDir) ? sessNpcDir : (fs.existsSync(defaultNpcDir) ? defaultNpcDir : null);
      if (npcDir) {
        const files = fs.readdirSync(npcDir).filter(f => f.endsWith('.json'));
        for (const f of files) {
          try {
            const data = JSON.parse(fs.readFileSync(path.join(npcDir, f), 'utf-8'));
            if (states[data.id] === 'removed') continue;
            if (claimed[data.id] && !companionsWithoutCharacter.includes(data.id)) continue;
            const { dmNotes, ...safe } = data;
            npcs.push(safe);
          } catch { /* skip malformed */ }
        }
      }

      res.json({ characters, npcs });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
