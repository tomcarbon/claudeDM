const { DEFAULT_CAMPAIGN, SAFE_CAMPAIGN_ID, SAFE_SESSION_ID } = require('./player-data');

// X-Campaign-Id and X-Session-Id are joined into file paths all over the server (player-data,
// characters, npcs, scenarios, xp-utils, sessions). They used to be trimmed and lowercased and
// nothing else, so `X-Campaign-Id: ../../defaults/coldwar` plus a reset deleted a campaign's
// baseline characters (security-reviewer SR-40-2, WO-0041). Both are now a closed vocabulary,
// checked once here, before any route sees them: lowercase letters, digits and dashes for a
// campaign; letters, digits and dashes for a session (they are UUIDs). Anything else is a 400 —
// refused, not repaired, so a caller can never be routed somewhere it did not name.

function getCampaignId(req) {
  const campaignId = String(req.get('x-campaign-id') || '').trim().toLowerCase();
  return campaignId || DEFAULT_CAMPAIGN;
}

function campaignContext() {
  return (req, res, next) => {
    const campaignId = getCampaignId(req);
    if (!SAFE_CAMPAIGN_ID.test(campaignId)) {
      return res.status(400).json({ error: 'Invalid X-Campaign-Id' });
    }
    const sessionId = req.get('x-session-id');
    if (sessionId !== undefined && sessionId !== '' && !SAFE_SESSION_ID.test(sessionId)) {
      return res.status(400).json({ error: 'Invalid X-Session-Id' });
    }
    req.campaignId = campaignId;
    next();
  };
}

module.exports = { campaignContext, getCampaignId, SAFE_CAMPAIGN_ID, SAFE_SESSION_ID };
