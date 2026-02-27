const express = require('express');
const fs = require('fs');
const path = require('path');
const { requirePlayer } = require('../player-auth');
const { getPlayerNpcsDir, ensurePlayerDataExists } = require('../player-data');

module.exports = function (dataDir) {
  const router = express.Router();
  const playerAuth = requirePlayer(dataDir);

  // Apply auth to all routes
  router.use(playerAuth);

  function getNpcDir(req) {
    const dir = getPlayerNpcsDir(dataDir, req.player.email);
    ensurePlayerDataExists(dataDir, req.player.email);
    return dir;
  }

  function readAllNpcs(req) {
    const npcDir = getNpcDir(req);
    const files = fs.readdirSync(npcDir).filter(f => f.endsWith('.json'));
    return files.map(f => {
      const data = JSON.parse(fs.readFileSync(path.join(npcDir, f), 'utf-8'));
      data._filename = f;
      return data;
    });
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
