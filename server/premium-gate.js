// The Premium gate (WO-0050).
//
// WHICH CAMPAIGNS ARE PREMIUM. Every campaign except the ids in FREE_CAMPAIGN_IDS. This list is the
// whole of the decision. `listing.badge` in campaign.json does NOT decide it: POST /api/campaigns
// lets any logged-in user write a campaign with any `listing` they like, so a badge is data the
// campaign's author controls. A missing, unknown or user-created campaign is therefore Premium —
// the gate fails closed. `server/__tests__/premium-gate.test.js` holds the shipped badges to this
// list so the label and the rule cannot drift apart.
//
// WHO MAY START ONE. A player whose `premiumAccess` resolves true (server/player-auth.js,
// `resolvePremiumAccess`; the default is true, so today nobody's play changes).
//
// WHERE IT IS ENFORCED. Only where a NEW adventure starts:
//   - POST /api/sessions                       (server/routes/sessions.js)
//   - WebSocket `session_start`                (server/ws-handler.js)
//   - WebSocket `session_resume` when it does not resume a saved session in that campaign, and
//     a single-player `user_message` with no saved session bound — both are a new adventure under
//     another name (server/ws-handler.js). With a saved session bound, a single-player turn runs
//     in that session's SAVED campaignId, not the connection's last-named one (revision 2,
//     SR-50-1), so a refused start cannot be carried into a free save. That saved value is trusted
//     only if it is a well-formed id (revision 3, SR-50-5), and the turn's inputs are pinned at
//     the gate so a message landing mid-turn cannot re-route it (revision 3, SR-50-4).
// Resuming a saved game, joining another player's session as a companion and the bot orchestrator
// are deliberately NOT gated (the chair's wording was "start an adventure").
//
// WHAT THIS IS NOT. Identity in this app is a self-asserted `X-Player-Email` header / WebSocket
// `playerEmail` (decision 0005), and an identity with no record gets the default. So while
// DEFAULT_PREMIUM_ACCESS is `true`, ANY unregistered or self-registered identity passes this gate
// — a `premiumAccess: false` player needs nobody else's email: a made-up WebSocket `playerEmail`
// (or `guest`), a `chat_join` that rewrites the connection's email, or a fresh account from
// POST /api/players/register all get through, as does claiming another player's email. It is an
// account setting, not a paywall, and must not be described as one until there is
// authentication. (Corrected 2026-10-28, revision 2, SR-50-2: this said only "can claim another
// player's email", which understated it.) Nothing is for sale (decision 0008), so the refusal message
// says nothing about money.
//
// Revision 4 (Part C) narrows the paragraph above for STARTS: a new game now needs a logged-in
// player — an email with a registered record (player-auth.js, `isRegisteredEmail`) — over the
// WebSocket as REST already required, so a made-up `playerEmail`, `guest`, or a `chat_join` swap to
// one can no longer start anything (ws-handler.js, LOGIN_REFUSAL, checked before this gate). What
// still passes: a fresh self-registration (logged in, default `true`) and another registered
// player's email. Still an account setting, not a paywall.

const FREE_CAMPAIGN_IDS = Object.freeze(['demo']);

const PREMIUM_REFUSAL_MESSAGE = "This campaign isn't available on your account.";

/** True unless the id is on the free allowlist. Missing and unknown ids are Premium. */
function isPremiumCampaign(campaignId) {
  return !FREE_CAMPAIGN_IDS.includes(String(campaignId || ''));
}

/** May a player with this resolved premiumAccess start a new adventure in this campaign? */
function canStartCampaign(premiumAccess, campaignId) {
  return premiumAccess === true || !isPremiumCampaign(campaignId);
}

module.exports = {
  FREE_CAMPAIGN_IDS,
  PREMIUM_REFUSAL_MESSAGE,
  isPremiumCampaign,
  canStartCampaign,
};
