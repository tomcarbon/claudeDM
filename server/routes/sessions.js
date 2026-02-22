const express = require('express');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { getAuthenticatedPlayer } = require('../player-auth');

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

function summarizeSession(session, requester) {
  const ownerEmail = getOwnerEmail(session);
  const ownerName = getOwnerName(session);
  const canWrite = canWriteSession(session, requester);
  return {
    id: session.id,
    name: session.name,
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
  };
}

function withSessionAccess(session, requester) {
  const ownerEmail = getOwnerEmail(session);
  const ownerName = getOwnerName(session);
  const canWrite = canWriteSession(session, requester);
  return {
    ...session,
    ownerEmail,
    ownerName,
    playerEmail: session.playerEmail || ownerEmail || null,
    playerName: session.playerName || ownerName || null,
    canWrite,
    readOnly: !canWrite,
  };
}

module.exports = function (dataDir) {
  const router = express.Router();
  const sessionsDir = path.join(dataDir, 'sessions');

  // Ensure sessions directory exists
  if (!fs.existsSync(sessionsDir)) {
    fs.mkdirSync(sessionsDir, { recursive: true });
  }

  // GET all sessions
  router.get('/', (req, res) => {
    try {
      const requester = getAuthenticatedPlayer(dataDir, req);
      const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json'));
      const sessions = files.map(f => {
        const data = JSON.parse(fs.readFileSync(path.join(sessionsDir, f), 'utf-8'));
        return summarizeSession(data, requester);
      });
      // Sort by most recently updated
      sessions.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
      res.json(sessions);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET single session
  router.get('/:id', (req, res) => {
    try {
      const requester = getAuthenticatedPlayer(dataDir, req);
      const filePath = path.join(sessionsDir, `${req.params.id}.json`);
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Session not found' });
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
        scenarioId: scenarioId || null,
        characterId: characterId || null,
        claudeSessionId: claudeSessionId || null,
        messages: messages || [],
        ownerEmail: requester.email,
        ownerName: requester.name,
        playerEmail: requester.email,
        playerName: requester.name,
        status: 'active',
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
        path.join(sessionsDir, `${session.id}.json`),
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
      const filePath = path.join(sessionsDir, `${req.params.id}.json`);
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

  // DELETE session
  router.delete('/:id', (req, res) => {
    try {
      const requester = getAuthenticatedPlayer(dataDir, req);
      if (!requester) {
        return res.status(403).json({ error: 'Login required. Guests cannot delete sessions.' });
      }
      const filePath = path.join(sessionsDir, `${req.params.id}.json`);
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
      const filePath = path.join(sessionsDir, `${req.params.id}.json`);
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
