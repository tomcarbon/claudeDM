const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { getCategory, categoryIdOf, currencyForCampaign } = require('./game-categories');

// Random character generation for the no-magic rulesets — Sci-Fi (WO-0040), Noir (WO-0042),
// Western (WO-0043) and Horror (WO-0045), every category whose registry `engine` is 'modern'. Same
// chassis as the Fantasy generator in character-generator.js — 4d6-drop-lowest, best scores to the
// class's primary ability, max hit die at 1st level and the average after, proficiency by level — filled from the campaign's
// category's rules directory instead of data/rules/. There is no magic, so every sheet carries the
// empty spells block that hand-authored sheets carry. The file keeps its Sci-Fi name because the
// exports below are the Sci-Fi round's.

const ABILITY_ORDER = ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'];
const ABILITY_BY_ABBREV = { STR: 'strength', DEX: 'dexterity', CON: 'constitution', INT: 'intelligence', WIS: 'wisdom', CHA: 'charisma' };

// Sci-Fi's skills. A ruleset's own abilities-and-skills.json is authoritative (skillsOf); this list
// is the fallback when that file cannot be read.
const ALL_SKILLS = [
  'Acrobatics', 'Athletics', 'Computers', 'Deception', 'Insight', 'Intimidation',
  'Investigation', 'Mechanics', 'Medicine', 'Perception', 'Performance', 'Persuasion',
  'Piloting', 'Science', 'Sleight of Hand', 'Stealth', 'Streetwise', 'Survival',
];

const FIRST_NAMES = {
  male: ['Marcus', 'Danny', 'Luis', 'Sam', 'Theo', 'Ray', 'Omar', 'Viktor', 'Kenji', 'Eli', 'Jonah', 'Mateo', 'Andre', 'Felix', 'Hank', 'Ravi'],
  female: ['Dana', 'Rosa', 'Mia', 'Keisha', 'Lena', 'Yuki', 'Nadia', 'Carla', 'Imani', 'Joan', 'Priya', 'Tess', 'Ingrid', 'Sofia', 'Ruth', 'Ana'],
};
const LAST_NAMES = ['Reyes', 'Kowalski', 'Okafor', 'Brennan', 'Nakamura', 'Haddad', 'Lindqvist', 'Morrow', 'Castillo', 'Park',
  'Novak', 'Delacroix', 'Mbeki', 'Sullivan', 'Achterberg', 'Varga', 'Quinn', 'Santos', 'Iqbal', 'Fischer'];
const FUTURE_SURNAMES = ['Vance-Okoro', 'Tal', 'Kessler-9', 'Arunde', 'Moss', 'Ilyin', 'Sato-Reyes', 'Brask', 'Oyelaran', 'Venn'];

const ALIGNMENTS = [
  'Lawful Good', 'Neutral Good', 'Chaotic Good',
  'Lawful Neutral', 'True Neutral', 'Chaotic Neutral',
  'Lawful Evil', 'Neutral Evil', 'Chaotic Evil',
];

const EXTRA_LANGUAGES = ['Spanish', 'Russian', 'German', 'French', 'Mandarin', 'Arabic', 'Japanese', 'Portuguese', 'Polish', 'Korean'];

const PERSONALITY = {
  traits: [
    'I keep my voice level when everyone else is shouting.',
    'I make a joke when I am scared, and I am scared more often than I let on.',
    'I count exits when I walk into a room. Old habit.',
    'I trust machines more than people, and I can tell you why.',
    'I have a story for every situation, and about half of them are true.',
    'I do not sit with my back to a door.',
  ],
  ideals: [
    'People first. Everything else can be replaced.',
    'A job done right is the only kind worth doing.',
    'Nobody gets left behind. Not ever.',
    'Information wants to be free, and I am happy to help it along.',
    'Survive today. Worry about the rest tomorrow.',
    'Power has to answer to someone.',
  ],
  bonds: [
    'Someone back home is counting on me to come back in one piece.',
    'I owe my life to one person in this crew, and I intend to pay it back.',
    'There is a name on a list I am still looking for.',
    'The last people I worked with are dead. I will not let that happen twice.',
    'I am doing this for the money, and the money is for someone else.',
  ],
  flaws: [
    'I cannot walk away from a locked door.',
    'I have a temper, and it has cost me jobs before.',
    'I lie when the truth would do just as well.',
    'I take risks I would never let anyone else take.',
    'I do not ask for help, even when I very obviously need it.',
  ],
};

// --- small helpers (deliberately local: the Fantasy generator's are not exported) ---
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
function pickN(arr, n) {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.max(0, n));
}
function roll4d6DropLowest() {
  const rolls = Array.from({ length: 4 }, () => Math.floor(Math.random() * 6) + 1);
  rolls.sort((a, b) => a - b);
  return rolls[1] + rolls[2] + rolls[3];
}
function abilityModifier(score) {
  return Math.floor((score - 10) / 2);
}
function formatDamage(dice, mod) {
  if (!mod) return dice;
  return mod > 0 ? `${dice}+${mod}` : `${dice}${mod}`;
}
function hitDieMax(hitDie) {
  const match = String(hitDie || 'd8').match(/d(\d+)/);
  return match ? parseInt(match[1], 10) : 8;
}
function profBonusForLevel(level) {
  return Math.floor((Math.max(1, level) - 1) / 4) + 2;
}
function readList(rulesDir, file, key) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(rulesDir, file), 'utf-8'));
    return Array.isArray(data[key]) ? data[key] : [];
  } catch {
    return [];
  }
}
function nameOf(entry) {
  return entry && typeof entry.name === 'string' ? entry.name : '';
}
function describeTrait(trait) {
  if (typeof trait === 'string') return trait;
  if (!trait || typeof trait !== 'object') return '';
  const desc = String(trait.description || '');
  if (!trait.name) return desc;
  return desc ? `${trait.name} (${desc.length > 120 ? desc.slice(0, 117) + '...' : desc})` : trait.name;
}
function article(noun) {
  return `${/^[aeiou]/i.test(noun) ? 'an' : 'a'} ${noun}`;
}
function eraAllows(entry, era) {
  if (!era || !entry || !Array.isArray(entry.eras) || entry.eras.length === 0) return true;
  return entry.eras.includes(era);
}

/**
 * The options a campaign offers: its category's content, narrowed by the campaign's era and by
 * `characterOptions` ({ races: [...], classes: [...] }) when it declares them. A list the campaign
 * narrows to nothing falls back to the unfiltered list rather than to an empty menu.
 */
function categoryOfCampaign(campaign) {
  return getCategory(categoryIdOf(campaign) === 'fantasy' ? 'scifi' : categoryIdOf(campaign));
}

function rulesDirOf(dataDir, campaign) {
  return path.join(dataDir, categoryOfCampaign(campaign).rulesDir);
}

/** Skill names of the campaign's ruleset, from its abilities-and-skills.json. */
function skillsOf(dataDir, campaign) {
  const names = readList(rulesDirOf(dataDir, campaign), 'abilities-and-skills.json', 'skills')
    .map(s => (typeof s === 'string' ? s : s && s.name))
    .filter(n => typeof n === 'string' && n);
  return names.length > 0 ? names : ALL_SKILLS;
}

function sciFiCatalogue(dataDir, campaign) {
  const rulesDir = rulesDirOf(dataDir, campaign);
  const era = campaign && typeof campaign.era === 'string' ? campaign.era : null;
  const allowed = (campaign && campaign.characterOptions) || {};
  const narrow = (list, names) => {
    const byEra = list.filter(e => eraAllows(e, era));
    const base = byEra.length > 0 ? byEra : list;
    if (!Array.isArray(names) || names.length === 0) return base;
    const chosen = base.filter(e => names.includes(nameOf(e)));
    return chosen.length > 0 ? chosen : base;
  };
  return {
    era,
    races: narrow(readList(rulesDir, 'races.json', 'races'), allowed.races),
    classes: narrow(readList(rulesDir, 'classes.json', 'classes'), allowed.classes),
    backgrounds: narrow(readList(rulesDir, 'backgrounds.json', 'backgrounds'), allowed.backgrounds),
  };
}

function getSciFiCharacterOptions(dataDir, campaign) {
  const { races, classes, backgrounds } = sciFiCatalogue(dataDir, campaign);
  const category = categoryOfCampaign(campaign);
  return {
    category: category.id,
    terms: category.terms,
    races: races.map(r => ({ name: r.name, subraces: [] })),
    classes: classes.map(c => ({ name: c.name })),
    backgrounds: backgrounds.map(b => ({ name: b.name })),
    alignments: ALIGNMENTS,
  };
}

function applyOriginBonuses(scores, race, primaryAbilities) {
  const increase = race.ability_score_increase || {};
  let applied = false;
  for (const [stat, bonus] of Object.entries(increase)) {
    const key = ABILITY_BY_ABBREV[String(stat).toUpperCase()] || String(stat).toLowerCase();
    if (scores[key] !== undefined && typeof bonus === 'number') {
      scores[key] += bonus;
      applied = true;
    }
  }
  // An origin that describes a free choice ("+2 to one ability, +1 to another") rather than fixed
  // keys: spend it on the class's primary ability and Constitution, which is what a player would do.
  if (!applied && Object.keys(increase).length > 0) {
    const primary = primaryAbilities.find(a => scores[a] !== undefined) || 'dexterity';
    scores[primary] += 2;
    scores[primary === 'constitution' ? 'dexterity' : 'constitution'] += 1;
  }
}

// Body armor by proficiency and era. Numbers are the anchors in each ruleset's equipment.json.
// In a period category (Noir, Western, Horror) armor is a coat — the registry's `periodArmor` — and nobody
// straps on a steel or iron vest (or a padded one) by default.
function chooseArmor(charClass, dexMod, era, periodArmor = null) {
  const profs = (charClass.armor_proficiencies || []).join(' ').toLowerCase();
  if (periodArmor) {
    return profs.includes('light')
      ? { name: periodArmor.name, type: periodArmor.type, ac: periodArmor.baseAc + dexMod }
      : { name: 'None', type: 'none', ac: 10 + dexMod };
  }
  if (profs.includes('medium') || profs.includes('heavy')) {
    if (era === 'future') return { name: 'Hardshell', type: 'medium', ac: 15 + Math.min(dexMod, 2) };
    return { name: 'Tactical vest', type: 'medium', ac: 14 + Math.min(dexMod, 2) };
  }
  if (profs.includes('light')) {
    if (era === 'future') return { name: 'Ballistic weave', type: 'light', ac: 13 + dexMod };
    if (era === '1980s') return { name: 'Leather jacket', type: 'light', ac: 11 + dexMod };
    return { name: 'Concealable aramid vest', type: 'light', ac: 12 + dexMod };
  }
  return { name: 'None', type: 'none', ac: 10 + dexMod };
}

const FALLBACK_WEAPONS = [
  { name: '9mm pistol', attackAbility: 'DEX', damage: '1d8', damageType: 'piercing', ammo: '9mm rounds (30)' },
  { name: 'Knife', attackAbility: 'DEX', damage: '1d4', damageType: 'slashing' },
];

// A far-future character trained in Energy Weapons carries the future equivalent of a class's
// era-neutral firearm; everyone else keeps the slug-thrower, which is still plausible in any era.
const FUTURE_SWAPS = {
  '9mm pistol': 'Laser pistol',
  '.38 revolver': 'Laser pistol',
  'Silenced .22 pistol': 'Laser pistol',
  'Assault rifle (AK pattern)': 'Laser rifle',
  'Hunting rifle (bolt-action)': 'Laser rifle',
  'Baseball bat': 'Arc baton',
};

// A class's declared weapon can be newer than the campaign's era (the Western Army revolver is
// 1870s; WO-0048's 1860s campaign is the first to notice). Prefer the named period equivalent;
// otherwise the first era-legal weapon of the same group in the table.
const PERIOD_SWAPS = {
  'Army revolver': 'Navy revolver',
  'Buffalo rifle': 'Repeating rifle',
  'Dynamite': 'Black-powder charge',
};

function eraLegalSwap(name, era, table) {
  const row = table.get(name);
  if (!row || eraAllows(row, era)) return null;
  const named = table.get(PERIOD_SWAPS[name]);
  if (named && eraAllows(named, era)) return named;
  return [...table.values()].find(w => w.group === row.group && eraAllows(w, era)) || null;
}

// Counted ammunition for the sheet, three magazines' worth, named the way authored sheets name it.
const AMMO_NAMES = {
  '9mm pistol': '9mm rounds',
  '.38 revolver': '.38 rounds',
  'Silenced .22 pistol': '.22 rounds',
  'Assault rifle (AK pattern)': '7.62mm rounds',
  'Hunting rifle (bolt-action)': 'Rifle rounds',
  'Laser pistol': 'Laser pistol cells',
  'Laser rifle': 'Laser rifle cells',
  'Stun gun': 'Stun gun cartridges',
};

function loadWeaponTable(dataDir, campaign) {
  const list = readList(rulesDirOf(dataDir, campaign), 'equipment.json', 'weapons');
  return new Map(list.filter(w => w && typeof w.name === 'string').map(w => [w.name, w]));
}

function buildWeapons(charClass, abilities, profBonus, { era, table = new Map() } = {}) {
  const declared = Array.isArray(charClass.default_weapons) && charClass.default_weapons.length > 0
    ? charClass.default_weapons
    : FALLBACK_WEAPONS;
  const energyTrained = (charClass.weapon_proficiencies || []).some(p => /energy/i.test(String(p)));
  const weapons = [];
  const ammo = [];
  for (const declaredWeapon of declared) {
    let w = declaredWeapon;
    if (!w || typeof w.name !== 'string' || typeof w.damage !== 'string') continue;
    const swap = era === 'future' ? FUTURE_SWAPS[w.name] : null;
    const swapped = swap && table.get(swap);
    if (swapped && (swapped.group !== 'Energy Weapons' || energyTrained)) {
      w = { ...w, name: swapped.name, damage: swapped.damage, damageType: swapped.damageType };
    }
    const period = eraLegalSwap(w.name, era, table);
    if (period) w = { ...w, name: period.name, damage: period.damage, damageType: period.damageType, ammo: undefined };
    const row = table.get(w.name);
    const ability = ABILITY_BY_ABBREV[String(w.attackAbility || 'DEX').toUpperCase()] || 'dexterity';
    // A finesse weapon in the table uses the better of STR and DEX, whatever the class declared.
    const finesse = row && Array.isArray(row.properties) && row.properties.includes('finesse');
    const mod = finesse
      ? Math.max(abilities.strength.modifier, abilities.dexterity.modifier)
      : abilities[ability].modifier;
    weapons.push({
      name: w.name,
      attackBonus: mod + profBonus,
      damage: formatDamage(w.damage, mod),
      damageType: w.damageType || 'piercing',
    });
    if (typeof w.ammo === 'string') ammo.push(w.ammo);
    else if (row && Number.isFinite(row.magazine) && row.magazine > 0) {
      const ammoName = typeof row.ammo_name === 'string' && row.ammo_name ? row.ammo_name : AMMO_NAMES[w.name];
      ammo.push(`${ammoName || `${w.name} rounds`} (${row.magazine * 3})`);
    }
  }
  return { weapons, ammo };
}

// Money in background equipment is written in dollars ("Wallet containing $40"). A credits
// campaign gets the same amount as a credit chit, in the exact form the UI parses.
function localiseMoney(equipment, currency) {
  if (!currency || currency.abbrev !== 'cr') return equipment;
  return equipment.map(item => {
    const m = String(item).match(/\$\s?([\d,]+)/);
    if (!m) return item;
    return `Credit chit: ${parseInt(m[1].replace(/,/g, ''), 10)} cr`;
  });
}

function startingLevelOf(campaign) {
  const range = campaign && (campaign.levelRange || campaign.levels);
  const match = typeof range === 'string' ? range.match(/(\d+)/) : null;
  return match ? parseInt(match[1], 10) : 1;
}

function startingXp(dataDir, level) {
  if (level <= 1) return 0;
  try {
    const leveling = JSON.parse(fs.readFileSync(path.join(dataDir, 'rules', 'leveling.json'), 'utf-8'));
    const entry = (leveling.xp_thresholds || []).find(e => e.level === level);
    return entry ? entry.xp_required : 0;
  } catch {
    return 0;
  }
}

function generateSciFiCharacter(dataDir, options = {}, campaign = null) {
  const { era, races, classes, backgrounds } = sciFiCatalogue(dataDir, campaign);
  if (races.length === 0 || classes.length === 0) {
    throw new Error(`The ${categoryOfCampaign(campaign).label} ruleset is missing classes or origins (data/${categoryOfCampaign(campaign).rulesDir}/).`);
  }

  const race = races.find(r => r.name === options.race) || pick(races);
  const charClass = classes.find(c => c.name === options.class) || pick(classes);
  const background = backgrounds.find(b => b.name === options.background)
    || (backgrounds.length > 0 ? pick(backgrounds) : { name: 'Drifter', skill_proficiencies: [], equipment: [] });
  const alignment = options.alignment || pick(ALIGNMENTS);

  let name;
  if (options.name && String(options.name).trim()) {
    name = String(options.name).trim();
  } else {
    const first = pick(FIRST_NAMES[Math.random() < 0.5 ? 'male' : 'female']);
    name = `${first} ${pick(era === 'future' ? [...LAST_NAMES, ...FUTURE_SURNAMES] : LAST_NAMES)}`;
  }

  // Scores: best to the class's primary abilities, the rest at random.
  const sorted = Array.from({ length: 6 }, roll4d6DropLowest).sort((a, b) => b - a);
  const primaryAbilities = String(charClass.primary_ability || '')
    .toLowerCase()
    .split(/\s*(?:,|\bor\b|\band\b)\s*/)
    .map(s => ABILITY_BY_ABBREV[s.toUpperCase()] || s.trim())
    .filter(s => ABILITY_ORDER.includes(s));
  const scores = {};
  let idx = 0;
  for (const p of primaryAbilities) {
    if (scores[p] === undefined) scores[p] = sorted[idx++];
  }
  for (const abil of pickN(ABILITY_ORDER.filter(a => scores[a] === undefined), 6)) {
    scores[abil] = sorted[idx++];
  }
  applyOriginBonuses(scores, race, primaryAbilities);

  const abilities = {};
  for (const stat of ABILITY_ORDER) {
    const score = Math.min(20, scores[stat]);
    abilities[stat] = { score, modifier: abilityModifier(score) };
  }

  const level = Math.min(20, Math.max(1, Math.floor(Number(options.level)) || startingLevelOf(campaign)));
  const profBonus = profBonusForLevel(level);
  const conMod = abilities.constitution.modifier;
  const die = hitDieMax(charClass.hit_die);
  let maxHp = die + conMod;
  for (let l = 2; l <= level; l++) maxHp += Math.floor(die / 2) + 1 + conMod;
  if (maxHp < 1) maxHp = 1;

  const armor = chooseArmor(charClass, abilities.dexterity.modifier, era, categoryOfCampaign(campaign).periodArmor);

  const allSkills = skillsOf(dataDir, campaign);
  const choices = charClass.skill_choices || { choose: 2, from: allSkills };
  const pool = (choices.from || []).filter(s => allSkills.includes(s));
  const classSkills = pickN(pool.length > 0 ? pool : allSkills, choices.choose || 2);
  const skills = [...new Set([...classSkills, ...(background.skill_proficiencies || [])])];

  const languages = ['English'];
  const extraLanguages = (Number(background.languages) || 0) + (race.name === 'Human' ? 1 : 0);
  languages.push(...pickN(EXTRA_LANGUAGES, extraLanguages));

  const { weapons, ammo } = buildWeapons(charClass, abilities, profBonus, { era, table: loadWeaponTable(dataDir, campaign) });
  const currency = currencyForCampaign(dataDir, campaign && campaign.id, campaign);
  const equipment = localiseMoney([
    ...weapons.map(w => w.name),
    ...ammo,
    ...(armor.type === 'none' ? [] : [armor.name]),
    ...(background.equipment || []),
  ], currency);
  if (!equipment.some(item => /\$\s?\d|\d+\s*cr\b/.test(String(item)))) {
    equipment.push(currency.abbrev === 'cr' ? 'Credit chit: 50 cr' : 'Wallet containing $40');
  }

  const features = [];
  for (const f of (charClass.level_1_features || [])) features.push(describeTrait(f));
  if (level >= 2) for (const f of (charClass.level_2_features || [])) features.push(describeTrait(f));
  if (background.feature) features.push(describeTrait({ name: background.feature, description: background.feature_description }));
  const traits = (race.traits || []).map(describeTrait).filter(Boolean);

  const personality = {
    traits: pick(PERSONALITY.traits),
    ideals: pick(PERSONALITY.ideals),
    bonds: pick(PERSONALITY.bonds),
    flaws: pick(PERSONALITY.flaws),
  };
  const shortName = name.split(' ')[0];
  const bgName = String(background.name || 'drifter').toLowerCase();

  return {
    id: uuidv4(),
    name,
    status: 'alive',
    race: race.name,
    subrace: '',
    class: charClass.name,
    level,
    background: background.name,
    alignment,
    experience: startingXp(dataDir, level),
    abilities,
    hitPoints: { max: maxHp, current: maxHp },
    armorClass: armor.ac,
    speed: race.speed || 30,
    proficiencyBonus: profBonus,
    savingThrows: (charClass.saving_throws || []).map(s => String(s).toLowerCase()),
    skills,
    languages,
    equipment,
    weapons,
    armor: { name: armor.name, type: armor.type },
    features,
    traits,
    spells: {
      spellcastingAbility: '',
      spellSaveDC: 0,
      spellAttackBonus: 0,
      cantrips: [],
      level1: { slots: 0, known: [] },
    },
    personality,
    appearance: `${name} looks like someone who has had a long week, and expects a longer one: ${article(charClass.name.toLowerCase())} by temperament, ${article(bgName)} by trade.`,
    backstory: pick([
      `${shortName} spent years as ${article(bgName)} before the day everything changed. The skills that paid the rent are now the skills that keep people alive.`,
      `Nobody who knew ${shortName} as ${article(bgName)} would have predicted this. ${shortName} would not have either.`,
      `${shortName} has a past as ${article(bgName)} and a habit of not talking about it. The crew has learned not to ask.`,
    ]),
  };
}

module.exports = { generateSciFiCharacter, getSciFiCharacterOptions, sciFiCatalogue, ALL_SKILLS };
