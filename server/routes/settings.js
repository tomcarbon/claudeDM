const express = require('express');
const fs = require('fs');
const path = require('path');
const { requireAdmin } = require('../admin-auth');
const { requirePlayer } = require('../player-auth');
const { resetPlayerData, resetSingleEntity } = require('../player-data');

module.exports = function (dataDir) {
  const router = express.Router();
  const defaultsDir = path.join(dataDir, 'defaults');
  const adminOnly = requireAdmin(dataDir);

  const SCOPES = ['characters', 'npcs', 'scenarios', 'dm-settings'];

  function copyDir(src, dest) {
    const files = fs.readdirSync(src);
    for (const file of files) {
      fs.copyFileSync(path.join(src, file), path.join(dest, file));
    }
  }

  // POST /api/settings/restore-defaults
  router.post('/restore-defaults', adminOnly, (req, res) => {
    try {
      const scopeParam = req.query.scope;
      const scopes = scopeParam
        ? scopeParam.split(',').filter(s => SCOPES.includes(s))
        : SCOPES;

      const restored = [];

      for (const scope of scopes) {
        if (scope === 'dm-settings') {
          fs.copyFileSync(
            path.join(defaultsDir, 'dm-settings.json'),
            path.join(dataDir, 'dm-settings.json')
          );
        } else {
          copyDir(
            path.join(defaultsDir, scope),
            path.join(dataDir, scope)
          );
        }
        restored.push(scope);
      }

      res.json({ restored });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/settings/reset-my-data — player resets their own data
  const playerOnly = requirePlayer(dataDir);
  router.post('/reset-my-data', playerOnly, (req, res) => {
    try {
      const scope = req.query.scope || 'all';
      const id = req.query.id;

      if (id && (scope === 'character' || scope === 'npc')) {
        resetSingleEntity(dataDir, req.player.email, scope, id);
        return res.json({ reset: scope, id });
      }

      if (['all', 'characters', 'npcs'].includes(scope)) {
        resetPlayerData(dataDir, req.player.email, scope);
        return res.json({ reset: scope });
      }

      res.status(400).json({ error: 'Invalid scope. Use: all, characters, npcs, character (with id), or npc (with id).' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
