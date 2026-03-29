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

  // POST /api/bots/add — add bots with individual configuration
  router.post('/add', async (req, res) => {
    try {
      const { role = 'either', count = 1, turnDelayMs = 60000, maxSessionsPerBot = 1 } = req.body;
      await orchestrator.addBots({ role, count, turnDelayMs, maxSessionsPerBot });
      res.json(orchestrator.getStatus());
    } catch (err) {
      console.error('[Bots] Add error:', err);
      res.status(500).json({ error: 'Failed to add bots.' });
    }
  });

  // DELETE /api/bots/:email — remove a specific bot
  router.delete('/bot/:email', async (req, res) => {
    try {
      const result = await orchestrator.removeBot(req.params.email);
      res.json({ ...result, ...orchestrator.getStatus() });
    } catch (err) {
      console.error('[Bots] Remove error:', err);
      res.status(400).json({ error: err.message });
    }
  });

  // POST /api/bots/disconnect — disconnect a bot from a specific session
  router.post('/disconnect', async (req, res) => {
    try {
      const { botEmail, sessionId } = req.body;
      if (!botEmail || !sessionId) {
        return res.status(400).json({ error: 'botEmail and sessionId are required.' });
      }
      const result = await orchestrator.disconnectBotSession(botEmail, sessionId);
      res.json(result);
    } catch (err) {
      console.error('[Bots] Disconnect error:', err);
      res.status(400).json({ error: err.message });
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
