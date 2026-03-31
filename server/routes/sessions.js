const express = require('express');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { getAuthenticatedPlayer } = require('../player-auth');
const { getPlayerSessionsDir, ensurePlayerDataExists, emailToSlug, getSessionCharactersDir, getSessionNpcsDir, getPlayerCharactersDir, getPlayerNpcsDir, provisionPlayerDefaults } = require('../player-data');
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
  const slug = emailToSlug(email);
  const playerDir = path.join(dataDir, 'players', slug);
  if (!fs.existsSync(playerDir)) return 0;
  let count = 0;
  try {
    const campaigns = fs.readdirSync(playerDir).filter(d => {
      try { return fs.statSync(path.join(playerDir, d)).isDirectory(); } catch { return false; }
    });
    for (const cid of campaigns) {
      const sessDir = path.join(playerDir, cid, 'sessions');
      if (!fs.existsSync(sessDir)) continue;
      count += fs.readdirSync(sessDir).filter(f => f.endsWith('.json')).length;
    }
  } catch { /* ignore */ }
  return count;
}

module.exports = function (dataDir) {
  const router = express.Router();

  function getSessionsDir(req) {
    const requester = getAuthenticatedPlayer(dataDir, req);
    if (!requester) {
      // Guest fallback — legacy global dir (read-only)
      const fallback = path.join(dataDir, 'sessions');
      if (!fs.existsSync(fallback)) fs.mkdirSync(fallback, { recursive: true });
      return fallback;
    }
    const dir = getPlayerSessionsDir(dataDir, requester.email, req.campaignId);
    ensurePlayerDataExists(dataDir, requester.email, req.campaignId);
    return dir;
  }

  // Scan all players' session directories for public sessions in the given campaign
  function getPublicSessions(requester, campaignId) {
    const playersDir = path.join(dataDir, 'players');
    if (!fs.existsSync(playersDir)) return [];

    const requesterSlug = requester ? emailToSlug(requester.email) : null;
    const results = [];

    let playerDirs;
    try {
      playerDirs = fs.readdirSync(playersDir).filter(d => {
        if (d === requesterSlug) return false; // skip own — already included
        const stat = fs.statSync(path.join(playersDir, d));
        return stat.isDirectory();
      });
    } catch {
      return [];
    }

    for (const playerSlug of playerDirs) {
      const sessDir = path.join(playersDir, playerSlug, campaignId || 'demo', 'sessions');
      if (!fs.existsSync(sessDir)) continue;
      let files;
      try {
        files = fs.readdirSync(sessDir).filter(f => f.endsWith('.json'));
      } catch {
        continue;
      }
      for (const f of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(sessDir, f), 'utf-8'));
          const settings = getSessionSettings(data);
          if (settings.visibility === 'public') {
            results.push(summarizeSession(data, requester));
          }
        } catch {
          // skip malformed files
        }
      }
    }

    return results;
  }

  // Resolve a session file by ID across all players (for public access)
  function findSessionFile(sessionId, campaignId) {
    const playersDir = path.join(dataDir, 'players');
    if (!fs.existsSync(playersDir)) return null;

    let playerDirs;
    try {
      playerDirs = fs.readdirSync(playersDir).filter(d => {
        const stat = fs.statSync(path.join(playersDir, d));
        return stat.isDirectory();
      });
    } catch {
      return null;
    }

    // First: search within the requested campaign
    for (const playerSlug of playerDirs) {
      const filePath = path.join(playersDir, playerSlug, campaignId || 'demo', 'sessions', `${sessionId}.json`);
      if (fs.existsSync(filePath)) return filePath;
    }

    // Fallback: search across ALL campaigns (handles cross-campaign companion joins)
    for (const playerSlug of playerDirs) {
      const playerDir = path.join(playersDir, playerSlug);
      let campaignDirs;
      try {
        campaignDirs = fs.readdirSync(playerDir).filter(d => {
          try { return fs.statSync(path.join(playerDir, d)).isDirectory(); } catch { return false; }
        });
      } catch { continue; }
      for (const cid of campaignDirs) {
        if (cid === (campaignId || 'demo')) continue; // Already searched
        const filePath = path.join(playerDir, cid, 'sessions', `${sessionId}.json`);
        if (fs.existsSync(filePath)) return filePath;
      }
    }
    return null;
  }

  // GET all sessions across all campaigns for the logged-in player (My Games scoreboard)
  router.get('/my-games', (req, res) => {
    try {
      const requester = getAuthenticatedPlayer(dataDir, req);
      if (!requester) {
        return res.status(403).json({ error: 'Login required.' });
      }

      const showAll = req.query.all === 'true';
      const slug = emailToSlug(requester.email);
      const playerDir = path.join(dataDir, 'players', slug);
      const seen = new Set();
      const allSessions = [];

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

      // 1. Own sessions across all campaigns
      if (fs.existsSync(playerDir)) {
        const campaigns = fs.readdirSync(playerDir).filter(d => {
          try { return fs.statSync(path.join(playerDir, d)).isDirectory(); } catch { return false; }
        });
        for (const cid of campaigns) {
          const sessDir = path.join(playerDir, cid, 'sessions');
          if (!fs.existsSync(sessDir)) continue;
          const files = fs.readdirSync(sessDir).filter(f => f.endsWith('.json'));
          for (const f of files) {
            try {
              const data = JSON.parse(fs.readFileSync(path.join(sessDir, f), 'utf-8'));
              if (seen.has(data.id)) continue;
              seen.add(data.id);
              const summary = summarizeSession(data, requester);
              summary.campaignId = data.campaignId || cid;
              summary.campaignTitle = getCampaignTitle(data.campaignId || cid);
              allSessions.push(summary);
            } catch { /* skip malformed */ }
          }
        }
      }

      // 2. Sessions from other players (companion sessions, or all if ?all=true)
      const playersDir = path.join(dataDir, 'players');
      if (fs.existsSync(playersDir)) {
        const otherDirs = fs.readdirSync(playersDir).filter(d => {
          if (d === slug) return false;
          try { return fs.statSync(path.join(playersDir, d)).isDirectory(); } catch { return false; }
        });
        for (const pSlug of otherDirs) {
          const pDir = path.join(playersDir, pSlug);
          let campaigns;
          try {
            campaigns = fs.readdirSync(pDir).filter(d => {
              try { return fs.statSync(path.join(pDir, d)).isDirectory(); } catch { return false; }
            });
          } catch { continue; }
          for (const cid of campaigns) {
            const sessDir = path.join(pDir, cid, 'sessions');
            if (!fs.existsSync(sessDir)) continue;
            let files;
            try { files = fs.readdirSync(sessDir).filter(f => f.endsWith('.json')); } catch { continue; }
            for (const f of files) {
              try {
                const data = JSON.parse(fs.readFileSync(path.join(sessDir, f), 'utf-8'));
                if (seen.has(data.id)) continue;
                if (!showAll) {
                  const isCompanion = data.companionPlayers && Object.values(data.companionPlayers).some(
                    cp => cp.email && cp.email.toLowerCase() === requester.email.toLowerCase()
                  );
                  if (!isCompanion) continue;
                }
                seen.add(data.id);
                const summary = summarizeSession(data, requester);
                summary.campaignId = data.campaignId || cid;
                summary.campaignTitle = getCampaignTitle(data.campaignId || cid);
                allSessions.push(summary);
              } catch { /* skip malformed */ }
            }
          }
        }
      }

      allSessions.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
      res.json(allSessions);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET all sessions
  router.get('/', (req, res) => {
    try {
      const requester = getAuthenticatedPlayer(dataDir, req);
      const dir = getSessionsDir(req);
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
      const ownSessions = files.map(f => {
        const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
        return summarizeSession(data, requester);
      });

      // Also include public sessions from other players
      const publicSessions = getPublicSessions(requester, req.campaignId);

      // Merge and deduplicate by ID
      const seen = new Set(ownSessions.map(s => s.id));
      const allSessions = [...ownSessions];
      for (const ps of publicSessions) {
        if (!seen.has(ps.id)) {
          seen.add(ps.id);
          allSessions.push(ps);
        }
      }

      // Sort by most recently updated
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
      // Try own sessions dir first
      let filePath = path.join(getSessionsDir(req), `${req.params.id}.json`);
      if (!fs.existsSync(filePath)) {
        // Try finding as a public session from another player
        filePath = findSessionFile(req.params.id, req.campaignId);
        if (!filePath) {
          return res.status(404).json({ error: 'Session not found' });
        }
        // Verify it's public
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        const settings = getSessionSettings(data);
        if (settings.visibility !== 'public') {
          return res.status(404).json({ error: 'Session not found' });
        }
        return res.json(withSessionAccess(data, requester));
      }
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
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
      fs.writeFileSync(
        path.join(getSessionsDir(req), `${session.id}.json`),
        JSON.stringify(session, null, 2)
      );
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
      const filePath = path.join(getSessionsDir(req), `${req.params.id}.json`);
      if (!fs.existsSync(filePath)) {
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
      const filePath = path.join(getSessionsDir(req), `${req.params.id}.json`);
      if (!fs.existsSync(filePath)) {
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
      const filePath = path.join(getSessionsDir(req), `${req.params.id}.json`);
      if (!fs.existsSync(filePath)) {
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

      // Find the session file (could be in another player's directory)
      let filePath = path.join(getSessionsDir(req), `${req.params.id}.json`);
      if (!fs.existsSync(filePath)) {
        filePath = findSessionFile(req.params.id, req.campaignId);
        if (!filePath) {
          return res.status(404).json({ error: 'Session not found' });
        }
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

      let filePath = path.join(getSessionsDir(req), `${req.params.id}.json`);
      if (!fs.existsSync(filePath)) {
        filePath = findSessionFile(req.params.id, req.campaignId);
        if (!filePath) {
          return res.status(404).json({ error: 'Session not found' });
        }
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
      const filePath = path.join(getSessionsDir(req), `${req.params.id}.json`);
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Session not found' });
      }
      const existing = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (!canWriteSession(existing, requester)) {
        return res.status(403).json({ error: 'Only the session creator can delete this session.' });
      }
      fs.unlinkSync(filePath);
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
      const filePath = path.join(getSessionsDir(req), `${req.params.id}.json`);
      if (!fs.existsSync(filePath)) {
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
  router.get('/:id/party', (req, res) => {
    try {
      const requester = getAuthenticatedPlayer(dataDir, req);
      if (!requester) {
        return res.status(401).json({ error: 'Login required.' });
      }

      // Find session file
      let filePath = path.join(getSessionsDir(req), `${req.params.id}.json`);
      if (!fs.existsSync(filePath)) {
        filePath = findSessionFile(req.params.id, req.campaignId);
        if (!filePath) {
          return res.status(404).json({ error: 'Session not found' });
        }
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        const settings = getSessionSettings(data);
        if (settings.visibility !== 'public') {
          return res.status(404).json({ error: 'Session not found' });
        }
      }

      const session = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const ownerEmail = getOwnerEmail(session);
      const campaignId = req.campaignId;
      const sessionId = session.id;
      const states = session.companionConfig?.states || {};
      const claimed = session.companionPlayers || {};

      // --- Characters: owner's selected PC ---
      const characters = [];
      if (ownerEmail && session.characterId) {
        const charDir = getSessionCharactersDir(dataDir, ownerEmail, campaignId, sessionId);
        const fallbackDir = getPlayerCharactersDir(dataDir, ownerEmail, campaignId);
        const dir = fs.existsSync(charDir) ? charDir : (fs.existsSync(fallbackDir) ? fallbackDir : null);
        if (dir) {
          const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
          for (const f of files) {
            try {
              const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
              if (data.id === session.characterId) {
                characters.push(data);
                break;
              }
            } catch { /* skip malformed */ }
          }
        }
      }

      // --- Characters: companion players' PCs ---
      const companionsWithoutCharacter = []; // npcIds of companions who haven't selected a character
      for (const [npcId, cp] of Object.entries(claimed)) {
        if (!cp.email) continue;
        if (!cp.characterId) {
          // Companion joined but hasn't selected a character yet — track for NPC fallback
          companionsWithoutCharacter.push(npcId);
          continue;
        }
        provisionPlayerDefaults(dataDir, cp.email, campaignId);
        const cpCharDir = getPlayerCharactersDir(dataDir, cp.email, campaignId);
        if (!fs.existsSync(cpCharDir)) continue;
        const cpFiles = fs.readdirSync(cpCharDir).filter(f => f.endsWith('.json'));
        for (const f of cpFiles) {
          try {
            const data = JSON.parse(fs.readFileSync(path.join(cpCharDir, f), 'utf-8'));
            if (data.id === cp.characterId) {
              characters.push(data);
              break;
            }
          } catch { /* skip malformed */ }
        }
      }

      // --- NPCs: exclude removed and claimed-by-companion-player ---
      const npcs = [];
      if (ownerEmail) {
        const npcDir = getSessionNpcsDir(dataDir, ownerEmail, campaignId, sessionId);
        const fallbackDir = getPlayerNpcsDir(dataDir, ownerEmail, campaignId);
        const dir = fs.existsSync(npcDir) ? npcDir : (fs.existsSync(fallbackDir) ? fallbackDir : null);
        if (dir) {
          const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
          for (const f of files) {
            try {
              const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
              if (states[data.id] === 'removed') continue;
              // Skip NPCs claimed by companions who HAVE selected a character (they appear in characters list)
              // But INCLUDE NPCs claimed by companions who haven't selected a character yet (show NPC data as fallback)
              if (claimed[data.id] && !companionsWithoutCharacter.includes(data.id)) continue;
              const { dmNotes, ...safe } = data;
              npcs.push(safe);
            } catch { /* skip malformed */ }
          }
        }
      }

      res.json({ characters, npcs });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
