const express = require('express');
const { requireAdmin } = require('../admin-auth');

module.exports = function (dataDir, orchestrator) {
  const router = express.Router();

  // ── SR-36-6, revision 2: what may appear on this payload ──────────────────────────────────
  //
  // Revision 1 put the brain's raw `err.message` on `lastSkipReason`, which the Security Reviewer
  // correctly called an unbounded channel on an endpoint any caller reaches with no headers: an
  // SDK or HTTP exception can carry paths, model ids and API error bodies. The reason is now from
  // `SKIP_REASONS` — a frozen set of four phrases this codebase wrote — and the raw text goes to
  // the server log only. See `SKIP_REASONS` in `bot/bot-orchestrator.js`.
  //
  // The endpoint stays open, and that is still the right call for the reason below: the panel
  // renders for every player. The rule for anything added here is unchanged — a name, an id or a
  // count, never free text and never anything personal.

  // GET /api/bots/status — read-only, and **unauthenticated**: it is declared above the
  // requireAdmin middleware below, and Express only applies middleware to routes declared after
  // it, so any caller reaches this with no headers at all. This comment used to say "visible to
  // all logged-in users", which described an access control that has never existed here.
  //
  // The endpoint is left open rather than moved below the middleware, because non-admins are
  // meant to read it: client/src/pages/Settings.jsx renders <BotFarmPanel> for every player
  // (`:401`, outside the isAdmin branch) and polls this every 10s, with only the controls behind
  // isAdmin. Putting it behind requireAdmin would blank that panel for ordinary players — a UI
  // change, on someone else's product, that no work order asked for.
  //
  // What it discloses: bot names, bot emails, session ids and counts. What actually keeps that
  // from the world is the mount gate in server/index.js — CLAUDEDM_BOTS=1 and never production —
  // so this router does not exist at all unless the deployment asked for it.
  router.get('/status', (req, res) => {
    res.json(orchestrator.getStatus());
  });

  // All other bot endpoints require admin access. Note that requireAdmin trusts the
  // X-Player-Email header, which any caller may set — an accepted risk of this build recorded in
  // decision 0005, not a property this router establishes.
  router.use(requireAdmin(dataDir));

  // POST /api/bots/add — add bots with individual configuration
  //
  // WO-0036 DoD 1: **a refusal has to say what it refused.** The chair hit
  // `"Failed to add bots: Not Found"` twice and took it to the CEO both times, and this handler
  // used to flatten every rejection into a bare 500 `'Failed to add bots.'`, which is the same
  // defect one layer down. A shape rejection from the orchestrator carries `statusCode` 400 and
  // a sentence naming the limit; it is passed through verbatim. Anything else stays a 500 with
  // a generic message, because an unexpected error's text is not for the network.
  router.post('/add', async (req, res) => {
    try {
      const { role = 'companion', count = 1, turnDelayMs = 60000, maxSessionsPerBot = 1 } = req.body || {};
      await orchestrator.addBots({ role, count, turnDelayMs, maxSessionsPerBot });
      res.json(orchestrator.getStatus());
    } catch (err) {
      if (err && err.statusCode === 400) {
        console.warn('[Bots] Add refused:', err.message);
        return res.status(400).json({ error: err.message });
      }
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
  //
  // WO-0036 J5: cleanup now also removes the session directories those bot accounts owned, and
  // it reports both halves — what it deleted and what it deliberately left behind. The caller
  // gets the lists, not just a count, because *"print what was deleted"* is the instruction and
  // a count is not a name. `deletedAccounts` keeps its old shape and meaning.
  router.delete('/cleanup', async (req, res) => {
    try {
      const result = await orchestrator.cleanup();
      res.json({ success: true, ...result });
    } catch (err) {
      console.error('[Bots] Cleanup error:', err);
      res.status(500).json({ error: 'Failed to clean up bots.' });
    }
  });

  return router;
};
