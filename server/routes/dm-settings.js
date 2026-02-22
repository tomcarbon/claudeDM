const express = require('express');
const fs = require('fs');
const path = require('path');
const { requireAdmin } = require('../admin-auth');

module.exports = function (dataDir) {
  const router = express.Router();
  const settingsFile = path.join(dataDir, 'dm-settings.json');
  const adminOnly = requireAdmin(dataDir);

  const defaultSettings = {
    humor: 50,
    drama: 50,
    verbosity: 50,
    difficulty: 50,
    horror: 20,
    romance: 10,
    puzzleFocus: 50,
    playerAutonomy: 50,
    combatFocus: 50,
    tone: 'balanced',
    narrationStyle: 'descriptive',
    playerAgency: 'collaborative',
    aiDailyShuffle: false,
  };

  function readSettings() {
    try {
      if (fs.existsSync(settingsFile)) {
        return JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
      }
    } catch {}
    return defaultSettings;
  }

  // GET current DM settings
  router.get('/', (req, res) => {
    res.json(readSettings());
  });

  // PUT update DM settings
  router.put('/', adminOnly, (req, res) => {
    try {
      const updated = { ...readSettings(), ...req.body };
      fs.writeFileSync(settingsFile, JSON.stringify(updated, null, 2));
      res.json(updated);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
