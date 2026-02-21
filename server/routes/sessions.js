const express = require('express');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

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
      const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json'));
      const sessions = files.map(f => {
        const data = JSON.parse(fs.readFileSync(path.join(sessionsDir, f), 'utf-8'));
        const ownerPlayer = (data.players || []).find(p => p.role === 'owner') || (data.players || [])[0] || {};
        return {
          id: data.id,
          name: data.name,
          scenarioId: data.scenarioId,
          characterId: data.characterId,
          playerName: data.playerName || ownerPlayer.name || null,
          playerEmail: data.playerEmail || ownerPlayer.email || null,
          createdAt: data.createdAt,
          updatedAt: data.updatedAt,
          playerCount: (data.players || []).length,
          messageCount: (data.messages || []).length,
          status: data.status,
        };
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
      const filePath = path.join(sessionsDir, `${req.params.id}.json`);
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Session not found' });
      }
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST create new session
  router.post('/', (req, res) => {
    try {
      const { name, scenarioId, characterId, claudeSessionId, messages, playerEmail, playerName } = req.body;
      console.log(`[Sessions] POST — messages: ${(messages || []).length}, claudeSessionId: ${claudeSessionId ? 'yes' : 'no'}, characterId: ${characterId}`);
      const session = {
        id: uuidv4(),
        name: name || 'New Adventure',
        scenarioId: scenarioId || null,
        characterId: characterId || null,
        claudeSessionId: claudeSessionId || null,
        messages: messages || [],
        playerEmail: playerEmail || null,
        playerName: playerName || null,
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        players: [
          {
            id: uuidv4(),
            characterId,
            email: playerEmail || null,
            name: playerName || null,
            role: 'owner',
            joinedAt: new Date().toISOString(),
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
      res.status(201).json(session);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT update session
  router.put('/:id', (req, res) => {
    try {
      const filePath = path.join(sessionsDir, `${req.params.id}.json`);
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Session not found' });
      }
      const existing = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      console.log(`[Sessions] PUT ${req.params.id} — messages: ${(req.body.messages || []).length}, claudeSessionId: ${req.body.claudeSessionId ? 'yes' : 'no'}`);
      const updated = { ...existing, ...req.body, id: existing.id, updatedAt: new Date().toISOString() };
      fs.writeFileSync(filePath, JSON.stringify(updated, null, 2));
      res.json(updated);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE session
  router.delete('/:id', (req, res) => {
    try {
      const filePath = path.join(sessionsDir, `${req.params.id}.json`);
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Session not found' });
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
      const filePath = path.join(sessionsDir, `${req.params.id}.json`);
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Session not found' });
      }
      const session = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const { characterId } = req.body;
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
