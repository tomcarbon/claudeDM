const express = require('express');
const { requireAdmin } = require('../admin-auth');

module.exports = function (dataDir, orchestrator) {
  const router = express.Router();

  // GET /api/bots/status — visible to all logged-in users (read-only)
  router.get('/status', (req, res) => {
    res.json(orchestrator.getStatus());
  });

  // All other bot endpoints require admin access
  router.use(requireAdmin(dataDir));

  // PUT /api/bots/config — update bot farm configuration
  router.put('/config', async (req, res) => {
    try {
      await orchestrator.reconfigure(req.body);
      res.json(orchestrator.getStatus());
    } catch (err) {
      console.error('[Bots] Config update error:', err);
      res.status(500).json({ error: 'Failed to update bot configuration.' });
    }
  });

  // POST /api/bots/start — manually start the bot farm
  router.post('/start', async (req, res) => {
    try {
      orchestrator.config.enabled = true;
      orchestrator.saveConfig();
      await orchestrator.start();
      res.json(orchestrator.getStatus());
    } catch (err) {
      console.error('[Bots] Start error:', err);
      res.status(500).json({ error: 'Failed to start bot farm.' });
    }
  });

  // POST /api/bots/stop — manually stop all bots
  router.post('/stop', async (req, res) => {
    try {
      orchestrator.config.enabled = false;
      orchestrator.saveConfig();
      await orchestrator.stop();
      res.json(orchestrator.getStatus());
    } catch (err) {
      console.error('[Bots] Stop error:', err);
      res.status(500).json({ error: 'Failed to stop bot farm.' });
    }
  });

  // DELETE /api/bots/cleanup — stop all bots and delete all bot accounts + data
  router.delete('/cleanup', async (req, res) => {
    try {
      const count = await orchestrator.cleanup();
      res.json({ success: true, deletedAccounts: count });
    } catch (err) {
      console.error('[Bots] Cleanup error:', err);
      res.status(500).json({ error: 'Failed to clean up bots.' });
    }
  });

  return router;
};
