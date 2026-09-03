// How a campaign presents itself in the campaign list on Home.
//
// The list used to be a literal in Home.jsx, so a campaign could exist on disk, be served
// correctly by GET /api/campaigns, and still be invisible to the player. The presentation now
// travels with the campaign, in an optional `listing` object in its campaign.json (WO-0009):
//
//   "listing": {
//     "order": 20,                        // lower sorts first; campaigns without one sort last
//     "badge": "Premium",                 // chip shown beside the title
//     "title": "The Floating World ⛩️",   // card title, when it should read differently
//     "blurb": "Descend into the ..."     // card description
//   }
//
// Every key is optional and every key has a fallback here, so a campaign.json with no `listing`
// at all still renders: canonical title, canonical subtitle, no badge, sorted to the end. That
// is the property that matters — adding a campaign must never again mean editing JSX.
//
// `badge` is deliberately a free string rather than an enum. It is a label and nothing gates on
// it: no route, no component and no billing code reads it (there is no billing code). If it ever
// becomes an entitlement it must stop being carried in data the campaign owner can write, and
// this comment should be the first thing that changes.

const BADGE_BOX_CLASS = { Free: 'tier-demo', Premium: 'tier-premium' };
const BADGE_CHIP_CLASS = { Free: 'tier-badge-demo', Premium: 'tier-badge-premium' };

export function listingOf(campaign) {
  const listing = campaign && campaign.listing;
  return listing && typeof listing === 'object' && !Array.isArray(listing) ? listing : {};
}

/** Card title. Falls back to the campaign's canonical title, then to its id. */
export function cardTitle(campaign) {
  return listingOf(campaign).title || campaign?.title || campaign?.id || 'Untitled campaign';
}

/** Card description. Falls back to the campaign's canonical subtitle, then to nothing. */
export function cardBlurb(campaign) {
  return listingOf(campaign).blurb || campaign?.subtitle || '';
}

/** The badge label, or null for a campaign that does not ask for one. */
export function cardBadge(campaign) {
  const badge = listingOf(campaign).badge;
  return typeof badge === 'string' && badge.trim() ? badge.trim() : null;
}

/** Class for the box around a campaign's cards. Unbadged campaigns get a neutral box. */
export function boxClassName(campaign) {
  return `tier-box ${BADGE_BOX_CLASS[cardBadge(campaign)] || 'tier-plain'}`;
}

/** Class for the badge chip. An unrecognised badge label still renders, in a neutral chip. */
export function badgeClassName(campaign) {
  return `tier-badge ${BADGE_CHIP_CLASS[cardBadge(campaign)] || 'tier-badge-plain'}`;
}

/**
 * Display order: `listing.order` ascending, then everything without one, by title then id.
 * Returns a new array; does not mutate the input.
 */
export function sortCampaigns(campaigns) {
  const rank = (c) => {
    const order = listingOf(c).order;
    return typeof order === 'number' && Number.isFinite(order) ? order : Number.POSITIVE_INFINITY;
  };
  return [...(Array.isArray(campaigns) ? campaigns : [])].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra < rb ? -1 : 1;
    return cardTitle(a).localeCompare(cardTitle(b)) || String(a?.id ?? '').localeCompare(String(b?.id ?? ''));
  });
}

/** The campaign with this id, or null. */
export function findCampaign(campaigns, id) {
  if (!Array.isArray(campaigns) || !id) return null;
  return campaigns.find(c => c && c.id === id) || null;
}
