const express = require('express');
const fs = require('fs');
const path = require('path');
const { requirePlayer } = require('../player-auth');
const { getSessionNpcsDir } = require('../player-data');

module.exports = function (dataDir) {
  const router = express.Router();
  const playerAuth = requirePlayer(dataDir);

  // Apply auth to all routes
  router.use(playerAuth);

  function getNpcDir(req) {
    // If an active session is specified, read from session-scoped directory
    const sessionId = req.get('x-session-id');
    if (sessionId) {
      const sessDir = getSessionNpcsDir(dataDir, sessionId);
      if (fs.existsSync(sessDir)) return sessDir;
      // Fall through to campaign defaults if session dir doesn't exist
    }
    // Outside session (or no session snapshot yet): read from campaign defaults (read-only)
    return path.join(dataDir, 'defaults', req.campaignId || 'demo', 'npcs');
  }

  function readAllNpcs(req) {
    const npcDir = getNpcDir(req);
    if (!fs.existsSync(npcDir)) return [];
    const files = fs.readdirSync(npcDir).filter(f => f.endsWith('.json'));
    return files.reduce((npcs, f) => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(npcDir, f), 'utf-8'));
        data._filename = f;
        npcs.push(data);
      } catch (err) {
        console.error(`Skipping ${f}: invalid JSON — ${err.message}`);
      }
      return npcs;
    }, []);
  }

  // GET all NPCs (strip secrets/dmNotes for player-facing view)
  router.get('/', (req, res) => {
    try {
      const npcs = readAllNpcs(req);
      const safe = npcs.map(({ dmNotes, _filename, ...rest }) => rest);
      res.json(safe);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET single NPC by id
  router.get('/:id', (req, res) => {
    try {
      const npcs = readAllNpcs(req);
      const npc = npcs.find(n => n.id === req.params.id);
      if (!npc) return res.status(404).json({ error: 'NPC not found' });
      const { dmNotes, _filename, ...safe } = npc;
      res.json(safe);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET single NPC with DM notes (for AI/DM use)
  router.get('/:id/dm', (req, res) => {
    try {
      const npcs = readAllNpcs(req);
      const npc = npcs.find(n => n.id === req.params.id);
      if (!npc) return res.status(404).json({ error: 'NPC not found' });
      const { _filename, ...data } = npc;
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
