const fs = require('fs');
const path = require('path');

// Game categories (decision 0023, WO-0040). A campaign declares `"category"` in its campaign.json;
// a campaign without one is Fantasy, which is how every campaign that predates categories is
// classified.
//
// Every category runs on the same d20 chassis — abilities, proficiency, XP, hit points, hit dice,
// death saves and rests are shared, and so is every mechanical tool the server implements
// (vitals-utils, xp-utils, resource-utils). What differs is the content the chassis is filled with:
// classes, origins, skills, equipment, adversaries, and the combat chapter. That content lives in
// one rules directory per category.
//
// Fantasy keeps `data/rules/` rather than moving to `data/rules/fantasy/`: the death-rule and XP
// readers, the generator and two dozen test files name that path, and the chassis files
// (leveling.json, the death-save rules in combat.json) are read from it for every category.
//
// `engine` says which code path fills a sheet and the GM prompt: 'srd' (Fantasy — spells, races,
// the SRD generator) or 'modern' (no magic, firearms, counted ammo, money in `equipment[]` —
// Sci-Fi, Noir, Western and Horror, decisions 0024–0026). A new no-magic category is a registry entry and a
// rules directory. `periodArmor` is the coat a light-armored character of a period category wears by
// default (decision 0025); categories without it choose armor by era in the generator.
//
// The client keeps a mirror of the labels in client/src/utils/gameCategories.js.

const DEFAULT_CATEGORY = 'fantasy';

const CATEGORIES = {
  fantasy: {
    id: 'fantasy',
    label: 'Fantasy',
    rulesDir: 'rules',
    adversariesFile: 'monsters.json',
    // The SRD 5.1 attribution is owed by this ruleset and only this one (NOTICE).
    attribution: 'srd-5.1',
    engine: 'srd',
    currency: { name: 'gold pieces', symbol: '', abbrev: 'gp' },
    terms: { race: 'Race', class: 'Class', adversaries: 'monsters' },
  },
  scifi: {
    id: 'scifi',
    label: 'Sci-Fi',
    rulesDir: 'rules-scifi',
    adversariesFile: 'adversaries.json',
    attribution: null,
    engine: 'modern',
    currency: { name: 'dollars', symbol: '$', abbrev: 'USD' },
    terms: { race: 'Origin', class: 'Class', adversaries: 'adversaries' },
  },
  noir: {
    id: 'noir',
    label: 'Noir',
    rulesDir: 'rules-noir',
    adversariesFile: 'adversaries.json',
    attribution: null,
    engine: 'modern',
    periodArmor: { name: 'Heavy overcoat', type: 'light', baseAc: 11 },
    currency: { name: 'dollars', symbol: '$', abbrev: 'USD' },
    terms: { race: 'Origin', class: 'Class', adversaries: 'adversaries' },
  },
  western: {
    id: 'western',
    label: 'Western',
    rulesDir: 'rules-western',
    adversariesFile: 'adversaries.json',
    attribution: null,
    engine: 'modern',
    periodArmor: { name: 'Leather duster', type: 'light', baseAc: 11 },
    currency: { name: 'dollars', symbol: '$', abbrev: 'USD' },
    terms: { race: 'Origin', class: 'Class', adversaries: 'adversaries' },
  },
  horror: {
    id: 'horror',
    label: 'Horror',
    rulesDir: 'rules-horror',
    adversariesFile: 'adversaries.json',
    attribution: null,
    engine: 'modern',
    periodArmor: { name: 'Heavy coat', type: 'light', baseAc: 11 },
    currency: { name: 'dollars', symbol: '$', abbrev: 'USD' },
    terms: { race: 'Origin', class: 'Class', adversaries: 'adversaries' },
  },
};

function listCategories() {
  return Object.values(CATEGORIES).map(c => ({ id: c.id, label: c.label }));
}

/** The registry entry for a category id. Unknown or missing ids are Fantasy. */
function getCategory(id) {
  const key = String(id || '').trim().toLowerCase();
  return CATEGORIES[key] || CATEGORIES[DEFAULT_CATEGORY];
}

/** True for a no-magic, firearms category (Sci-Fi, Noir, Western, Horror): the 'modern' generator and GM prompt. */
function isModernCategory(id) {
  return getCategory(id).engine === 'modern';
}

function isKnownCategory(id) {
  return Object.prototype.hasOwnProperty.call(CATEGORIES, String(id || '').trim().toLowerCase());
}

/** The category id a campaign record belongs to. */
function categoryIdOf(campaign) {
  const declared = campaign && typeof campaign.category === 'string' ? campaign.category.trim().toLowerCase() : '';
  return isKnownCategory(declared) ? declared : DEFAULT_CATEGORY;
}

// Campaign ids reach here from the X-Campaign-Id header, so they are not trusted as path segments.
const SAFE_ID = /^[a-z0-9][a-z0-9-]*$/;

/** The parsed campaign.json for an id, or null (unknown, unsafe id, or unreadable). */
function loadCampaignRecord(dataDir, campaignId) {
  const cid = String(campaignId || '').trim().toLowerCase();
  if (!SAFE_ID.test(cid)) return null;
  try {
    const file = path.join(dataDir, 'campaigns', cid, 'campaign.json');
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

/** The registry entry for the category a campaign belongs to. */
function categoryForCampaign(dataDir, campaignId) {
  return getCategory(categoryIdOf(loadCampaignRecord(dataDir, campaignId)));
}

/** Absolute rules directory for a category id. */
function rulesDirForCategory(dataDir, categoryId) {
  return path.join(dataDir, getCategory(categoryId).rulesDir);
}

/** Absolute rules directory for the category a campaign belongs to. */
function rulesDirForCampaign(dataDir, campaignId) {
  return path.join(dataDir, categoryForCampaign(dataDir, campaignId).rulesDir);
}

/** The stat-block file LookupMonster reads for a campaign: SRD monsters, or the category's adversaries. */
function adversariesFileForCampaign(dataDir, campaignId) {
  const category = categoryForCampaign(dataDir, campaignId);
  return path.join(dataDir, category.rulesDir, category.adversariesFile);
}

/** A campaign's money: its own `currency` if it declares one, else its category's default. */
function currencyForCampaign(dataDir, campaignId, campaign = loadCampaignRecord(dataDir, campaignId)) {
  const own = campaign && campaign.currency;
  if (own && typeof own === 'object' && typeof own.name === 'string') {
    return {
      name: own.name,
      symbol: typeof own.symbol === 'string' ? own.symbol : '',
      abbrev: typeof own.abbrev === 'string' ? own.abbrev : '',
    };
  }
  return { ...getCategory(categoryIdOf(campaign)).currency };
}

module.exports = {
  CATEGORIES,
  DEFAULT_CATEGORY,
  listCategories,
  getCategory,
  isKnownCategory,
  isModernCategory,
  categoryIdOf,
  loadCampaignRecord,
  categoryForCampaign,
  rulesDirForCategory,
  rulesDirForCampaign,
  currencyForCampaign,
  adversariesFileForCampaign,
};
