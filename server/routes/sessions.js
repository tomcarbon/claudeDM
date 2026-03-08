const express = require('express');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { getAuthenticatedPlayer } = require('../player-auth');
const { getPlayerSessionsDir, ensurePlayerDataExists, emailToSlug } = require('../player-data');

const DEFAULT_SETTINGS = {
  visibility: 'public', // 'private' | 'public'
  turnMode: 'initiative', // 'initiative' | 'ready-golf' | 'host-decides'
};

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

function summarizeSession(session, requester) {
  const ownerEmail = getOwnerEmail(session);
  const ownerName = getOwnerName(session);
  const canWrite = canWriteSession(session, requester);
  const settings = getSessionSettings(session);
  const companionSlots = getCompanionSlots(session);
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
    playerCount: (session.players || []).length,
    messageCount: (session.messages || []).length,
    status: session.status,
    canWrite,
    readOnly: !canWrite,
    settings,
    companionSlots,
  };
}

function withSessionAccess(session, requester) {
  const ownerEmail = getOwnerEmail(session);
  const ownerName = getOwnerName(session);
  const canWrite = canWriteSession(session, requester);
  const settings = getSessionSettings(session);
  return {
    ...session,
    ownerEmail,
    ownerName,
    playerEmail: session.playerEmail || ownerEmail || null,
    playerName: session.playerName || ownerName || null,
    canWrite,
    readOnly: !canWrite,
    settings,
  };
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

    for (const playerSlug of playerDirs) {
      const filePath = path.join(playersDir, playerSlug, campaignId || 'demo', 'sessions', `${sessionId}.json`);
      if (fs.existsSync(filePath)) return filePath;
    }
    return null;
  }

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
      const { name, scenarioId, characterId, claudeSessionId, messages } = req.body;
      console.log(`[Sessions] POST — messages: ${(messages || []).length}, claudeSessionId: ${claudeSessionId ? 'yes' : 'no'}, characterId: ${characterId}`);
      const ownerId = uuidv4();
      const createdAt = new Date().toISOString();
      const session = {
        id: uuidv4(),
        name: name || 'New Adventure',
        label: null,
        scenarioId: scenarioId || null,
        characterId: characterId || null,
        claudeSessionId: claudeSessionId || null,
        messages: messages || [],
        ownerEmail: requester.email,
        ownerName: requester.name,
        playerEmail: requester.email,
        playerName: requester.name,
        status: 'active',
        settings: { ...DEFAULT_SETTINGS },
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
        npcCompanions: [],
        currentAct: 0,
        currentScene: 0,
        log: [],
      };
      fs.writeFileSync(
        path.join(getSessionsDir(req), `${session.id}.json`),
        JSON.stringify(session, null, 2)
      );
      res.status(201).json(withSessionAccess(session, requester));
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

      // Validate turnMode
      if (incoming.turnMode !== undefined) {
        if (!['initiative', 'ready-golf', 'host-decides'].includes(incoming.turnMode)) {
          return res.status(400).json({ error: 'turnMode must be "initiative", "ready-golf", or "host-decides"' });
        }
        currentSettings.turnMode = incoming.turnMode;
      }

      // Future settings can be validated and merged here

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

      // Claim the slot
      session.companionPlayers[npcId] = {
        email: requester.email,
        name: requester.name,
        joinedAt: new Date().toISOString(),
      };
      session.updatedAt = new Date().toISOString();
      fs.writeFileSync(filePath, JSON.stringify(session, null, 2));
      res.json({
        npcId,
        claimedBy: session.companionPlayers[npcId],
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

  return router;
};
