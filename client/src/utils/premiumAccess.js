// Whether the client should OFFER a new adventure in a campaign (WO-0050).
//
// This is appearance only. The server decides, at every place a new adventure starts
// (server/premium-gate.js). These helpers exist so the client does not offer a start the server
// is going to refuse; when they are wrong — a stale cached player, an old campaign list — the
// server still refuses and the client shows its message.
//
// - `player.premiumAccess` comes from login/register, already resolved by the server. A player
//   object cached before WO-0050 has no field, which means the default: offered.
// - `campaign.premium` is computed by the server from its free allowlist, never from the badge.
//   A campaign with no `premium` field (an old cached list, an unknown campaign) is treated as
//   Premium, the same fail-closed rule the server applies.

export const START_UNAVAILABLE_REASON = 'Not available on your account';

/** Premium unless the server said otherwise. */
export function campaignIsPremium(campaign) {
  return !campaign || campaign.premium !== false;
}

/** Only an explicit `false` withholds access; absent means the server default. */
export function playerLacksPremium(player) {
  return !!player && player.premiumAccess === false;
}

/** True when a new adventure in this campaign should be shown as unavailable to this player. */
export function startUnavailable(player, campaign) {
  return playerLacksPremium(player) && campaignIsPremium(campaign);
}
