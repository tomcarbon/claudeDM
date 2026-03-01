const express = require('express');
const fs = require('fs');
const path = require('path');
const { requireAdmin } = require('../admin-auth');
const { requirePlayer, getAuthenticatedPlayer } = require('../player-auth');

module.exports = function (dataDir) {
  const router = express.Router();
  const globalSettingsFile = path.join(dataDir, 'dm-settings.json');
  const userSettingsDir = path.join(dataDir, 'dm-settings');
  const adminOnly = requireAdmin(dataDir);
  const playerOnly = requirePlayer(dataDir);

  // Ensure per-user settings directory exists
  if (!fs.existsSync(userSettingsDir)) {
    fs.mkdirSync(userSettingsDir, { recursive: true });
  }

  const defaultSettings = {
    humor: 50,
    drama: 50,
    verbosity: 50,
    difficulty: 50,
    horror: 20,
    puzzleFocus: 50,
    playerAutonomy: 50,
    tone: 'balanced',
    narrationStyle: 'descriptive',
    playerAgency: 'collaborative',
    aiDailyShuffle: false,
  };

  function emailToFilename(email) {
    return String(email).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.json';
  }

  function readGlobalSettings() {
    try {
      if (fs.existsSync(globalSettingsFile)) {
        return JSON.parse(fs.readFileSync(globalSettingsFile, 'utf-8'));
      }
    } catch {}
    return defaultSettings;
  }

  function readUserSettings(email) {
    if (!email) return null;
    const filePath = path.join(userSettingsDir, emailToFilename(email));
    try {
      if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      }
    } catch {}
    return null;
  }

  function getEffectiveSettings(email) {
    const global = readGlobalSettings();
    const user = readUserSettings(email);
    if (user) {
      return { ...global, ...user, _isPersonalized: true };
    }
    return { ...global, _isPersonalized: false };
  }

  // GET effective settings for requesting player (user -> global -> defaults)
  router.get('/', (req, res) => {
    const player = getAuthenticatedPlayer(dataDir, req);
    const email = player?.email || null;
    res.json(getEffectiveSettings(email));
  });

  // PUT save personal settings for requesting player
  router.put('/', playerOnly, (req, res) => {
    try {
      const email = req.player.email;
      const global = readGlobalSettings();
      const existing = readUserSettings(email) || {};
      const updated = { ...global, ...existing, ...req.body };
      // Strip metadata before writing
      delete updated._isPersonalized;
      const filePath = path.join(userSettingsDir, emailToFilename(email));
      fs.writeFileSync(filePath, JSON.stringify(updated, null, 2));
      res.json({ ...updated, _isPersonalized: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET global template
  router.get('/global', (req, res) => {
    res.json(readGlobalSettings());
  });

  // PUT update global template (admin only)
  router.put('/global', adminOnly, (req, res) => {
    try {
      const updated = { ...readGlobalSettings(), ...req.body };
      fs.writeFileSync(globalSettingsFile, JSON.stringify(updated, null, 2));
      res.json(updated);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE personal settings (revert to global defaults)
  router.delete('/mine', playerOnly, (req, res) => {
    try {
      const filePath = path.join(userSettingsDir, emailToFilename(req.player.email));
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      res.json({ message: 'Personal settings removed. Using global defaults.', ...readGlobalSettings(), _isPersonalized: false });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
