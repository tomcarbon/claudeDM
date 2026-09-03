// Bounding for untrusted-ish text that is about to be put in front of the DM.
//
// Written as zero-dependency ES MODULE on purpose, and this is load-bearing — see WO-0007.
// The client is an ESM package served by Vite; the server is CommonJS and consumes this via
// Node's native require(ESM). Vite 7 already requires Node ^20.19 || >=22.12 (client/node_modules/
// vite/package.json), which are exactly the versions that shipped require(ESM) unflagged, so this
// adds no Node floor the project did not already have.
//
// DO NOT convert this back to CommonJS. Vite registers its `commonjs` plugin only in the BUILD
// pipeline, not in `serve`, so a .cjs here builds cleanly and then dies under `npm run dev`.
// It is also reachable only because client/vite.config.js allowlists this one directory in
// server.fs.allow. Do not copy this function; import it.
//
// Why it exists (ETHICS.md Review 2, condition S1 and risk E11): the DM holds auto-allowed
// `Edit` over the project root, so both `data/campaigns/<cid>/assets.json` and
// `data/campaigns/<cid>/campaign.json` are files the model can write. Both are campaign-scoped
// rather than session-scoped, so text the DM writes into either one would otherwise reach the
// standing instructions of every LATER session of that campaign, for every player.
//
// This does not filter content and does not pretend to. It bounds the SHAPE — one line, capped
// length — which is what stops a page-sized injection, and it bounds token cost. Ethics assessed
// this exact pattern for the asset manifest; WO-0007 applies the same conclusion to campaign.json.

// Collapse a value to one bounded, single-line, control-character-free string.
// Returns '' for anything that is not a string.
export function flattenAndTruncate(value, maxLength) {
  if (typeof value !== 'string') return '';
  // Strip C0/C1 control characters (including newlines) and collapse runs of whitespace.
  const flat = value
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat.length <= maxLength) return flat;
  return flat.slice(0, Math.max(0, maxLength - 1)) + '…';
}

// --- Caps for the three campaign.json fields the open-world opening message interpolates -------
// Sized from the ten campaigns that exist (largest explorationRules 2,630 chars, largest
// setting.name 40, largest wilderness label 31), with headroom so no current campaign is
// truncated in normal use. The cap bounds a hostile edit; it is not a content budget.
export const CAMPAIGN_EXPLORATION_RULES_MAX = 3000;
export const CAMPAIGN_SETTING_NAME_MAX = 80;
export const CAMPAIGN_START_LABEL_MAX = 80;
export const CAMPAIGN_START_LABELS_MAX = 12;
