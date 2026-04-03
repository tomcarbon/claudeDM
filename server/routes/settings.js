const express = require('express');
const { requirePlayer } = require('../player-auth');
const { resetPlayerData, resetSingleEntity } = require('../player-data');

module.exports = function (dataDir) {
  const router = express.Router();

  // POST /api/settings/reset-my-data — player resets their own data
  const playerOnly = requirePlayer(dataDir);
  router.post('/reset-my-data', playerOnly, (req, res) => {
    try {
      const scope = req.query.scope || 'all';
      const id = req.query.id;

      const campaignId = req.campaignId;

      if (id && scope === 'character') {
        resetSingleEntity(dataDir, req.player.email, 'character', id, campaignId);
        return res.json({ reset: scope, id, campaignId });
      }

      if (['all', 'characters'].includes(scope)) {
        resetPlayerData(dataDir, req.player.email, scope, campaignId);
        return res.json({ reset: scope, campaignId });
      }

      res.status(400).json({ error: 'Invalid scope. Use: all, characters, or character (with id).' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
