const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// --- Name tables by race ---
const FIRST_NAMES = {
  Human: {
    male: ['Aldric', 'Bran', 'Corwin', 'Dorian', 'Edmund', 'Garrett', 'Henrik', 'Ivan', 'Jasper', 'Kellan', 'Lucan', 'Marcus', 'Nolan', 'Oswin', 'Pierce', 'Quinn', 'Roland', 'Silas', 'Theron', 'Victor'],
    female: ['Adeline', 'Brynn', 'Celia', 'Dahlia', 'Elara', 'Fiona', 'Gwendolyn', 'Helena', 'Iris', 'Johanna', 'Kira', 'Linnea', 'Mirabel', 'Nadia', 'Ophelia', 'Petra', 'Rosalind', 'Seraphina', 'Thea', 'Vivienne'],
  },
  Elf: {
    male: ['Aerendyl', 'Berrian', 'Caelynn', 'Drannor', 'Erevan', 'Filarion', 'Galinndan', 'Hadarai', 'Ivellios', 'Jorildyn', 'Kelvhan', 'Laucian', 'Mindartis', 'Nailo', 'Paelias', 'Quarion', 'Riardon', 'Soveliss', 'Thamior', 'Varis'],
    female: ['Adrie', 'Birel', 'Caelynn', 'Drusilia', 'Enna', 'Felosial', 'Gaelira', 'Ielenia', 'Jelenneth', 'Keyleth', 'Lia', 'Meriele', 'Naivara', 'Quelenna', 'Sariel', 'Shanairra', 'Thia', 'Valanthe', 'Xanaphia', 'Yaeldrin'],
  },
  Dwarf: {
    male: ['Adrik', 'Barendd', 'Bruenor', 'Dain', 'Eberk', 'Flint', 'Gardain', 'Harbek', 'Kildrak', 'Morgran', 'Orsik', 'Rangrim', 'Rurik', 'Storn', 'Thoradin', 'Tordek', 'Traubon', 'Ulfgar', 'Vondal', 'Whurbin'],
    female: ['Amber', 'Artin', 'Bardryn', 'Dagnal', 'Diesa', 'Eldeth', 'Falkrunn', 'Gunnloda', 'Helja', 'Ilde', 'Kathra', 'Liftrasa', 'Mardred', 'Riswynn', 'Sannl', 'Torbera', 'Vistra', 'Wellsby'],
  },
  Halfling: {
    male: ['Alton', 'Ander', 'Cade', 'Corrin', 'Eldon', 'Errich', 'Finnan', 'Garret', 'Lindal', 'Lyle', 'Merric', 'Milo', 'Osborn', 'Perrin', 'Reed', 'Roscoe', 'Wellby', 'Wendel'],
    female: ['Andry', 'Bree', 'Callie', 'Chenna', 'Eida', 'Euphemia', 'Jillian', 'Kithri', 'Lavinia', 'Lidda', 'Merla', 'Nedda', 'Paela', 'Portia', 'Seraphina', 'Shaena', 'Trym', 'Vani', 'Verna'],
  },
  Gnome: {
    male: ['Alston', 'Alvyn', 'Boddynock', 'Brocc', 'Burgell', 'Dimble', 'Eldon', 'Erky', 'Fonkin', 'Frug', 'Gerbo', 'Gimble', 'Glim', 'Jebeddo', 'Namfoodle', 'Orryn', 'Roondar', 'Seebo', 'Warryn', 'Zook'],
    female: ['Bimpnottin', 'Breena', 'Caramip', 'Carlin', 'Donella', 'Duvamil', 'Ella', 'Ellyjobell', 'Loopmottin', 'Lorilla', 'Mardnab', 'Nissa', 'Nyx', 'Oda', 'Orla', 'Roywyn', 'Shamil', 'Tana', 'Waywocket', 'Zanna'],
  },
  'Half-Elf': {
    male: ['Aerion', 'Brennan', 'Caelum', 'Daelan', 'Eravel', 'Faelen', 'Galen', 'Haelorn', 'Ivor', 'Jassin', 'Kael', 'Lorien', 'Maelis', 'Naeris', 'Phelan', 'Rennyn', 'Sael', 'Taelon', 'Vaelin', 'Zephyr'],
    female: ['Aelindra', 'Brielle', 'Caewyn', 'Daelynn', 'Elowen', 'Faelynn', 'Gwynara', 'Haelora', 'Ithilwen', 'Jessara', 'Kaelyn', 'Lyanna', 'Maelys', 'Naelynn', 'Orellia', 'Rhiannon', 'Shaelyn', 'Taelinn', 'Vaelora', 'Wynna'],
  },
  'Half-Orc': {
    male: ['Brusk', 'Dench', 'Feng', 'Gell', 'Grumbar', 'Henk', 'Holg', 'Imsh', 'Karash', 'Krusk', 'Mhurren', 'Ront', 'Shump', 'Thokk', 'Urzul', 'Vrag', 'Yurk', 'Zegdar'],
    female: ['Baggi', 'Emen', 'Engong', 'Kansif', 'Myev', 'Neega', 'Ovak', 'Ownka', 'Puuli', 'Shautha', 'Sutha', 'Vola', 'Volen', 'Yevelda'],
  },
  Tiefling: {
    male: ['Akmenos', 'Amnon', 'Barakas', 'Damakos', 'Ekemon', 'Iados', 'Kairon', 'Leucis', 'Melech', 'Mordai', 'Morthos', 'Pelaios', 'Skamos', 'Therai', 'Valcas'],
    female: ['Akta', 'Bryseis', 'Criella', 'Damaia', 'Ea', 'Kallista', 'Lerissa', 'Makaria', 'Nemeia', 'Orianna', 'Phelaia', 'Rieta', 'Sariel', 'Temera', 'Xylia'],
  },
  Dragonborn: {
    male: ['Arjhan', 'Balasar', 'Bharash', 'Donaar', 'Ghesh', 'Heskan', 'Kriv', 'Medrash', 'Mehen', 'Nadarr', 'Pandjed', 'Patrin', 'Rhogar', 'Shamash', 'Shedinn', 'Tarhun', 'Torinn'],
    female: ['Akra', 'Biri', 'Daar', 'Farideh', 'Harann', 'Havilar', 'Jheri', 'Kava', 'Korinn', 'Mishann', 'Nala', 'Perra', 'Raiann', 'Sora', 'Surina', 'Thava', 'Uadjit'],
  },
};

const LAST_NAMES = {
  Human: ['Ashford', 'Blackwell', 'Brightblade', 'Coldwater', 'Dunmore', 'Fairwind', 'Greymane', 'Hawklight', 'Ironwood', 'Kingsward', 'Longstrider', 'Mossborn', 'Nighthollow', 'Oakenshield', 'Ravencrest', 'Stormvale', 'Thornwall', 'Windrider'],
  Elf: ['Amakiir', 'Galanodel', 'Holimion', 'Ilphelkiir', 'Liadon', 'Meliamne', 'Nailo', 'Siannodel', 'Xiloscient'],
  Dwarf: ['Balderk', 'Battlehammer', 'Brawnanvil', 'Dankil', 'Fireforge', 'Frostbeard', 'Gorunn', 'Holderhek', 'Ironfist', 'Loderr', 'Rumnaheim', 'Strakeln', 'Torunn', 'Ungart'],
  Halfling: ['Brushgather', 'Goodbarrel', 'Greenbottle', 'High-hill', 'Hilltopple', 'Leagallow', 'Tealeaf', 'Thorngage', 'Tosscobble', 'Underbough'],
  Gnome: ['Beren', 'Daergel', 'Folkor', 'Garrick', 'Nackle', 'Murnig', 'Ningel', 'Raulnor', 'Scheppen', 'Timbers', 'Turen'],
  'Half-Elf': ['Amastacia', 'Brightwood', 'Dawntracker', 'Glynmenor', 'Moonshadow', 'Silverfrond', 'Starweaver', 'Windwalker'],
  'Half-Orc': ['Bonecrusher', 'Doomhammer', 'Gorefang', 'Ironskin', 'Skullsplitter', 'Stonefist', 'Thundermaw', 'Warcry'],
  Tiefling: ['Carrion', 'Chant', 'Creed', 'Despair', 'Fear', 'Glory', 'Hope', 'Nowhere', 'Open', 'Poetry', 'Quest', 'Random', 'Sorrow', 'Torment', 'Weary'],
  Dragonborn: ['Clethtinthiallor', 'Daardendrian', 'Delmirev', 'Drachedandion', 'Fenkenkabradon', 'Kepeshkmolik', 'Kerrhylon', 'Kimbatuul', 'Linxakasendalor', 'Myastan', 'Nemmonis', 'Norixius', 'Ophinshtalajiir', 'Prexijandilin', 'Shestendeliath', 'Turnuroth', 'Verthisathurgiesh', 'Yarjerit'],
};

const ALIGNMENTS = [
  'Lawful Good', 'Neutral Good', 'Chaotic Good',
  'Lawful Neutral', 'True Neutral', 'Chaotic Neutral',
  'Lawful Evil', 'Neutral Evil', 'Chaotic Evil',
];

const PERSONALITY_TRAITS = [
  "I always have a plan for what to do when things go wrong.",
  "I'm always polite and respectful, even to my enemies.",
  "I judge people by their actions, not their words.",
  "If someone is in trouble, I'm always ready to lend help.",
  "I'm full of witty aphorisms and have a proverb for every occasion.",
  "I'm used to helping out those who aren't as smart as I am.",
  "I get bored easily and need constant stimulation.",
  "I can stare down a hellhound without flinching.",
  "I once ran twenty-five miles without stopping to warn my clan of an approaching threat.",
  "I am slow to trust but fiercely loyal to those who earn it.",
  "I laugh in the face of danger. Literally.",
  "I keep a detailed journal of everything that happens.",
  "Nothing can shake my optimistic attitude.",
  "I sleep with my back to a wall, and I always know where the exits are.",
  "I am incredibly slow to trust those outside my inner circle.",
];

const IDEALS = [
  "Greater Good. My gifts are meant to be shared with all, not used for my own benefit.",
  "Honor. I don't steal from others in the trade. We all have to make a living somehow.",
  "Freedom. Chains are meant to be broken, as are those who would forge them.",
  "Power. Knowledge is the path to power and domination.",
  "Glory. I must prove myself worthy of my people's expectations.",
  "Fairness. No one should get preferential treatment before the law.",
  "Independence. I am a free spirit — no one tells me what to do.",
  "Sincerity. There's no good in pretending to be something I'm not.",
  "Tradition. The ancient traditions of worship and sacrifice must be preserved and upheld.",
  "Live and Let Live. Ideals aren't worth killing over or going to war for.",
];

const BONDS = [
  "I have a family, but I have no idea where they are. I hope to find them one day.",
  "I owe a debt I can never repay to the person who took pity on me.",
  "I protect those who cannot protect themselves.",
  "A powerful person killed someone I love. I seek vengeance.",
  "I will become the greatest thief that ever lived.",
  "I'm guilty of a terrible crime. I hope I can redeem myself for it.",
  "I seek to preserve a sacred text that holds terrible secrets.",
  "My mentor gave me a task I have yet to complete.",
  "Everything I do is for the common people.",
  "I will do anything to recover an ancient relic of my faith that was lost long ago.",
];

const FLAWS = [
  "I have a weakness for the vices of the city, especially hard drink.",
  "I am dogmatic in my morality, with no room for nuance.",
  "I can't resist a pretty face.",
  "I turn tail and run when things look bad.",
  "An innocent person is in prison for a crime that I committed.",
  "I'm convinced of the significance of my destiny, and blind to my shortcomings.",
  "I am suspicious of strangers and expect the worst of them.",
  "I have trouble keeping my true feelings hidden.",
  "I remember every insult and nurse a silent resentment.",
  "I'm too greedy for my own good. I can't resist taking a risk if there's money involved.",
];

const ALL_SKILLS = [
  'Acrobatics', 'Animal Handling', 'Arcana', 'Athletics', 'Deception',
  'History', 'Insight', 'Intimidation', 'Investigation', 'Medicine',
  'Nature', 'Perception', 'Performance', 'Persuasion', 'Religion',
  'Sleight of Hand', 'Stealth', 'Survival',
];

const EXTRA_LANGUAGES = ['Elvish', 'Dwarvish', 'Giant', 'Gnomish', 'Goblin', 'Halfling', 'Orc', 'Abyssal', 'Celestial', 'Draconic', 'Infernal', 'Sylvan', 'Undercommon', 'Deep Speech', 'Primordial'];

// --- Utility functions ---
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickN(arr, n) {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(n, shuffled.length));
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
  if (mod === 0) return dice;
  return mod > 0 ? `${dice}+${mod}` : `${dice}${mod}`;
}

function hitDieMax(hitDie) {
  const match = hitDie.match(/d(\d+)/);
  return match ? parseInt(match[1]) : 8;
}

function hitDieAvg(hitDie) {
  const max = hitDieMax(hitDie);
  return Math.floor(max / 2) + 1; // Standard D&D average: d6→4, d8→5, d10→6, d12→7
}

// D&D 5e proficiency bonus by level
function profBonusForLevel(level) {
  if (level <= 4) return 2;
  if (level <= 8) return 3;
  if (level <= 12) return 4;
  if (level <= 16) return 5;
  return 6;
}

// D&D 5e full-caster spell slot table (Bard, Cleric, Druid, Sorcerer, Wizard)
const FULL_CASTER_SLOTS = {
  1:  { '1st': 2 },
  2:  { '1st': 3 },
  3:  { '1st': 4, '2nd': 2 },
  4:  { '1st': 4, '2nd': 3 },
  5:  { '1st': 4, '2nd': 3, '3rd': 2 },
  6:  { '1st': 4, '2nd': 3, '3rd': 3 },
  7:  { '1st': 4, '2nd': 3, '3rd': 3, '4th': 1 },
  8:  { '1st': 4, '2nd': 3, '3rd': 3, '4th': 2 },
  9:  { '1st': 4, '2nd': 3, '3rd': 3, '4th': 3, '5th': 1 },
  10: { '1st': 4, '2nd': 3, '3rd': 3, '4th': 3, '5th': 2 },
};

// Warlock pact magic slots (all same level, fewer slots)
const WARLOCK_SLOTS = {
  1:  { '1st': 1 },
  2:  { '1st': 2 },
  3:  { '2nd': 2 },
  4:  { '2nd': 2 },
  5:  { '3rd': 2 },
  6:  { '3rd': 2 },
  7:  { '4th': 2 },
  8:  { '4th': 2 },
  9:  { '5th': 2 },
  10: { '5th': 2 },
};

// Half-caster spell slot table (Ranger, Paladin) — spellcasting starts at level 2
const HALF_CASTER_SLOTS = {
  1:  {},
  2:  { '1st': 2 },
  3:  { '1st': 3 },
  4:  { '1st': 3 },
  5:  { '1st': 4, '2nd': 2 },
  6:  { '1st': 4, '2nd': 2 },
  7:  { '1st': 4, '2nd': 3 },
  8:  { '1st': 4, '2nd': 3 },
  9:  { '1st': 4, '2nd': 3, '3rd': 2 },
  10: { '1st': 4, '2nd': 3, '3rd': 2 },
};

const FULL_CASTERS = ['Bard', 'Cleric', 'Druid', 'Sorcerer', 'Wizard'];
const HALF_CASTERS = ['Ranger', 'Paladin'];

function getSpellSlotsForLevel(className, level) {
  if (className === 'Warlock') return WARLOCK_SLOTS[Math.min(level, 10)] || {};
  if (FULL_CASTERS.includes(className)) return FULL_CASTER_SLOTS[Math.min(level, 10)] || {};
  if (HALF_CASTERS.includes(className)) return HALF_CASTER_SLOTS[Math.min(level, 10)] || {};
  return {};
}

// Cantrips known scales with level for most casters
function cantripsKnownForLevel(baseCantrips, level) {
  if (!baseCantrips) return 0;
  if (level >= 10) return baseCantrips + 2;
  if (level >= 4) return baseCantrips + 1;
  return baseCantrips;
}

// Spells known/prepared scales roughly with level
function spellsKnownForLevel(baseSpells, level, className, abilityMod) {
  // Full prepared casters (Cleric, Druid): WIS mod + level
  if (className === 'Cleric' || className === 'Druid') {
    return Math.max(1, (abilityMod || 0) + level);
  }
  // Paladin (half-caster, prepared): CHA mod + half level (min 1), no spells until L2
  if (className === 'Paladin') {
    if (level < 2) return 0;
    return Math.max(1, (abilityMod || 0) + Math.floor(level / 2));
  }
  // Ranger (half-caster, known): no spells until L2, then scales
  if (className === 'Ranger') {
    if (level < 2) return 0;
    // 5e ranger known spells: L2:2, L3:3, L5:4, L7:5, L9:6, L11:7, L13:8, L15:9, L17:10, L19:11
    if (level >= 19) return 11;
    if (level >= 17) return 10;
    if (level >= 15) return 9;
    if (level >= 13) return 8;
    if (level >= 11) return 7;
    if (level >= 9) return 6;
    if (level >= 7) return 5;
    if (level >= 5) return 4;
    if (level >= 3) return 3;
    return 2;
  }
  if (!baseSpells) return 0;
  // Wizards get +2 spells per level (spellbook)
  if (className === 'Wizard') return baseSpells + (level - 1) * 2;
  // Known casters (Bard, Sorcerer, Warlock) gain ~1 per level
  return baseSpells + (level - 1);
}

// Get starting XP for a given level from leveling.json
function getStartingXp(dataDir, level) {
  if (level <= 1) return 0;
  try {
    const leveling = JSON.parse(fs.readFileSync(path.join(dataDir, 'rules', 'leveling.json'), 'utf-8'));
    const entry = (leveling.xp_thresholds || []).find(e => e.level === level);
    return entry ? entry.xp_required : 0;
  } catch {
    return 0;
  }
}

// Read campaign level range and return the minimum level
function getStartingLevel(dataDir, campaignId) {
  if (!campaignId) return 1;
  try {
    const campaignFile = path.join(dataDir, 'campaigns', campaignId, 'campaign.json');
    if (!fs.existsSync(campaignFile)) return 1;
    const campaign = JSON.parse(fs.readFileSync(campaignFile, 'utf-8'));
    const range = campaign.levelRange || campaign.levels || '';
    if (typeof range === 'string') {
      const match = range.match(/(\d+)/);
      return match ? parseInt(match[1]) : 1;
    }
    return 1;
  } catch {
    return 1;
  }
}

// --- Main generator ---
function generateRandomCharacter(dataDir, options = {}) {
  const rulesDir = path.join(dataDir, 'rules');
  const races = JSON.parse(fs.readFileSync(path.join(rulesDir, 'races.json'), 'utf-8')).races;
  const classes = JSON.parse(fs.readFileSync(path.join(rulesDir, 'classes.json'), 'utf-8')).classes;
  const backgrounds = JSON.parse(fs.readFileSync(path.join(rulesDir, 'backgrounds.json'), 'utf-8')).backgrounds;
  const spellsData = JSON.parse(fs.readFileSync(path.join(rulesDir, 'spells.json'), 'utf-8'));

  // Pick race — use option if provided, else random
  const race = options.race ? (races.find(r => r.name === options.race) || pick(races)) : pick(races);
  let subrace = null;
  if (race.subraces && race.subraces.length > 0) {
    subrace = options.subrace
      ? (race.subraces.find(s => s.name === options.subrace) || pick(race.subraces))
      : pick(race.subraces);
  }

  // Pick class — use option if provided, else random
  const charClass = options.class ? (classes.find(c => c.name === options.class) || pick(classes)) : pick(classes);

  // Pick background — use option if provided, else random
  const background = options.background ? (backgrounds.find(b => b.name === options.background) || pick(backgrounds)) : pick(backgrounds);

  // Pick alignment — use option if provided, else random
  const alignment = options.alignment ? options.alignment : pick(ALIGNMENTS);

  // Generate name — use option if provided, else random
  let name;
  if (options.name && options.name.trim()) {
    name = options.name.trim();
  } else {
    const gender = Math.random() < 0.5 ? 'male' : 'female';
    const raceNames = FIRST_NAMES[race.name] || FIRST_NAMES.Human;
    const firstName = pick(raceNames[gender] || raceNames.male);
    const lastNames = LAST_NAMES[race.name] || LAST_NAMES.Human;
    const lastName = pick(lastNames);
    name = `${firstName} ${lastName}`;
  }

  // Roll ability scores (4d6 drop lowest, 6 times)
  const rawScores = Array.from({ length: 6 }, () => roll4d6DropLowest());

  // Sort scores descending to assign highest to primary ability
  const sortedScores = [...rawScores].sort((a, b) => b - a);

  // Map primary ability to ability index
  const abilityOrder = ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'];
  const primaryAbilities = charClass.primary_ability.toLowerCase().split(/\s+(?:or|and)\s+/);
  const scores = {};

  // Assign best score(s) to primary abilities, rest randomly
  const usedIndices = new Set();
  let scoreIdx = 0;

  for (const primary of primaryAbilities) {
    const abilIdx = abilityOrder.indexOf(primary);
    if (abilIdx !== -1) {
      scores[abilityOrder[abilIdx]] = sortedScores[scoreIdx++];
      usedIndices.add(abilIdx);
    }
  }

  // Fill remaining abilities with remaining scores
  const remainingAbilities = abilityOrder.filter((_, i) => !usedIndices.has(i));
  const shuffledRemaining = remainingAbilities.sort(() => Math.random() - 0.5);
  for (const abil of shuffledRemaining) {
    scores[abil] = sortedScores[scoreIdx++];
  }

  // Apply racial ability score increases
  const raceBonus = race.ability_score_increase || {};
  for (const [stat, bonus] of Object.entries(raceBonus)) {
    if (stat === 'two_other_abilities') continue; // Half-Elf special
    if (scores[stat] !== undefined) {
      scores[stat] += bonus;
    }
  }

  // Half-Elf: +1 to two other abilities (not charisma)
  if (raceBonus.two_other_abilities) {
    const otherAbils = abilityOrder.filter(a => a !== 'charisma');
    const chosen = pickN(otherAbils, 2);
    for (const a of chosen) {
      scores[a] += raceBonus.two_other_abilities;
    }
  }

  // Apply subrace bonuses
  if (subrace && subrace.ability_score_increase) {
    for (const [stat, bonus] of Object.entries(subrace.ability_score_increase)) {
      if (scores[stat] !== undefined) {
        scores[stat] += bonus;
      }
    }
  }

  // Build abilities object
  const abilities = {};
  for (const stat of abilityOrder) {
    abilities[stat] = {
      score: scores[stat],
      modifier: abilityModifier(scores[stat]),
    };
  }

  // Determine starting level from campaign
  const startingLevel = options.level || getStartingLevel(dataDir, options.campaignId);

  // Calculate HP: max at L1, average for subsequent levels (standard D&D rule)
  const conMod = abilities.constitution.modifier;
  const hdMax = hitDieMax(charClass.hit_die);
  const hdAvg = hitDieAvg(charClass.hit_die);
  let maxHp = hdMax + conMod; // Level 1: max hit die + CON
  for (let lvl = 2; lvl <= startingLevel; lvl++) {
    maxHp += hdAvg + conMod; // Levels 2+: average hit die + CON
  }
  // Hill Dwarf gets +1 HP per level
  if (subrace && subrace.name === 'Hill Dwarf') {
    maxHp += startingLevel;
  }
  if (maxHp < 1) maxHp = 1;

  // Calculate AC
  let armorClass = 10 + abilities.dexterity.modifier;
  let armorName = 'None';
  let armorType = 'none';

  // Barbarian/Monk unarmored defense
  if (charClass.name === 'Barbarian') {
    armorClass = 10 + abilities.dexterity.modifier + abilities.constitution.modifier;
    armorName = 'None (Unarmored Defense)';
  } else if (charClass.name === 'Monk') {
    armorClass = 10 + abilities.dexterity.modifier + abilities.wisdom.modifier;
    armorName = 'None (Unarmored Defense)';
  } else if (charClass.armor_proficiencies && charClass.armor_proficiencies.length > 0) {
    // Give appropriate starting armor
    if (charClass.armor_proficiencies.some(a => a.includes('All armor') || a.includes('Medium armor') || a.includes('medium'))) {
      // Scale mail (AC 14 + DEX mod max 2)
      const dexMod = Math.min(abilities.dexterity.modifier, 2);
      armorClass = 14 + dexMod;
      armorName = 'Scale Mail';
      armorType = 'medium';
    } else if (charClass.armor_proficiencies.some(a => a.includes('Light armor') || a.includes('light'))) {
      // Leather armor (AC 11 + DEX mod)
      armorClass = 11 + abilities.dexterity.modifier;
      armorName = 'Leather Armor';
      armorType = 'light';
    }
    // Fighters/Paladins with heavy armor
    if (charClass.name === 'Fighter' || charClass.name === 'Paladin') {
      armorClass = 16; // Chain mail
      armorName = 'Chain Mail';
      armorType = 'heavy';
    }
  }

  // Speed
  let speed = race.speed || 30;
  if (subrace && subrace.speed) {
    speed = subrace.speed;
  }

  // Saving throws
  const savingThrows = (charClass.saving_throws || []).map(s => s.toLowerCase());

  // Skills: class skills + background skills (deduplicated)
  const classSkillChoices = charClass.skill_choices || { choose: 2, from: ALL_SKILLS };
  const skillPool = classSkillChoices.from[0] === 'Any' ? [...ALL_SKILLS] : [...classSkillChoices.from];
  const classSkills = pickN(skillPool, classSkillChoices.choose);
  const bgSkills = (background.skill_proficiencies || []).filter(s => !classSkills.includes(s));
  const skills = [...new Set([...classSkills, ...bgSkills])];

  // Languages
  const languages = [...(race.languages || ['Common'])].filter(l => !l.includes('extra language') && !l.includes('one extra'));
  // Add background languages
  if (background.languages > 0) {
    const available = EXTRA_LANGUAGES.filter(l => !languages.includes(l));
    const extra = pickN(available, background.languages);
    languages.push(...extra);
  }
  // If race says "one extra language", add one
  if ((race.languages || []).some(l => l.includes('extra language') || l.includes('one extra'))) {
    const available = EXTRA_LANGUAGES.filter(l => !languages.includes(l));
    if (available.length > 0) {
      languages.push(pick(available));
    }
  }

  // Equipment from background + class defaults
  const equipment = [...(background.equipment || [])];

  // Add class default equipment
  for (const option of (charClass.starting_equipment_options || [])) {
    if (option.default) {
      equipment.push(...option.default);
    } else {
      // Pick first choice option
      const choices = Object.keys(option).filter(k => k.startsWith('choice_'));
      if (choices.length > 0) {
        const chosen = pick(choices);
        equipment.push(...option[chosen]);
      }
    }
  }

  // Clean up equipment placeholders
  const SIMPLE_WEAPONS = ['Club', 'Dagger', 'Greatclub', 'Handaxe', 'Javelin', 'Light hammer', 'Mace', 'Quarterstaff', 'Sickle', 'Spear'];
  for (let i = equipment.length - 1; i >= 0; i--) {
    const item = equipment[i];
    // Resolve "Any simple weapon" to a random simple weapon
    if (/any simple weapon/i.test(item)) {
      equipment[i] = pick(SIMPLE_WEAPONS);
    }
    // Remove "(if proficient)" qualifiers — the generator only gives proficient gear
    else if (/\(if proficient\)/i.test(item)) {
      equipment[i] = item.replace(/\s*\(if proficient\)/i, '');
    }
    // Remove "Any martial weapon" → pick one
    else if (/any martial weapon/i.test(item)) {
      equipment[i] = pick(['Longsword', 'Battleaxe', 'Warhammer', 'Morningstar', 'Rapier', 'Greatsword']);
    }
  }

  // Build weapons array
  const weapons = [];
  const profBonus = profBonusForLevel(startingLevel);

  // Determine primary attack stat
  const strMod = abilities.strength.modifier;
  const dexMod = abilities.dexterity.modifier;

  // Add weapons based on equipment
  const equipStr = equipment.join(' ').toLowerCase();
  if (equipStr.includes('greataxe')) {
    weapons.push({ name: 'Greataxe', attackBonus: strMod + profBonus, damage: formatDamage('1d12', strMod), damageType: 'slashing' });
  }
  if (equipStr.includes('greatsword')) {
    weapons.push({ name: 'Greatsword', attackBonus: strMod + profBonus, damage: formatDamage('2d6', strMod), damageType: 'slashing' });
  }
  if (equipStr.includes('longsword')) {
    weapons.push({ name: 'Longsword', attackBonus: strMod + profBonus, damage: formatDamage('1d8', strMod), damageType: 'slashing' });
  }
  if (equipStr.includes('rapier')) {
    weapons.push({ name: 'Rapier', attackBonus: dexMod + profBonus, damage: formatDamage('1d8', dexMod), damageType: 'piercing' });
  }
  if (equipStr.includes('shortsword')) {
    weapons.push({ name: 'Shortsword', attackBonus: dexMod + profBonus, damage: formatDamage('1d6', dexMod), damageType: 'piercing' });
  }
  if (equipStr.includes('shortbow')) {
    weapons.push({ name: 'Shortbow', attackBonus: dexMod + profBonus, damage: formatDamage('1d6', dexMod), damageType: 'piercing' });
  }
  if (equipStr.includes('longbow')) {
    weapons.push({ name: 'Longbow', attackBonus: dexMod + profBonus, damage: formatDamage('1d8', dexMod), damageType: 'piercing' });
  }
  if (equipStr.includes('mace')) {
    weapons.push({ name: 'Mace', attackBonus: strMod + profBonus, damage: formatDamage('1d6', strMod), damageType: 'bludgeoning' });
  }
  if (equipStr.includes('scimitar')) {
    weapons.push({ name: 'Scimitar', attackBonus: dexMod + profBonus, damage: formatDamage('1d6', dexMod), damageType: 'slashing' });
  }
  if (equipStr.includes('quarterstaff')) {
    weapons.push({ name: 'Quarterstaff', attackBonus: strMod + profBonus, damage: formatDamage('1d6', strMod), damageType: 'bludgeoning' });
  }
  if (equipStr.includes('dagger')) {
    weapons.push({ name: 'Dagger', attackBonus: dexMod + profBonus, damage: formatDamage('1d4', dexMod), damageType: 'piercing' });
  }
  if (equipStr.includes('javelin')) {
    weapons.push({ name: 'Javelin', attackBonus: strMod + profBonus, damage: formatDamage('1d6', strMod), damageType: 'piercing' });
  }
  if (equipStr.includes('handaxe')) {
    weapons.push({ name: 'Handaxe', attackBonus: strMod + profBonus, damage: formatDamage('1d6', strMod), damageType: 'slashing' });
  }
  if (equipStr.includes('crossbow')) {
    weapons.push({ name: 'Light Crossbow', attackBonus: dexMod + profBonus, damage: formatDamage('1d8', dexMod), damageType: 'piercing' });
  }
  if (equipStr.includes('dart')) {
    weapons.push({ name: 'Dart', attackBonus: dexMod + profBonus, damage: formatDamage('1d4', dexMod), damageType: 'piercing' });
  }
  if (equipStr.includes('warhammer')) {
    weapons.push({ name: 'Warhammer', attackBonus: strMod + profBonus, damage: formatDamage('1d8', strMod), damageType: 'bludgeoning' });
  }

  // Fallback: if no weapons detected, add a simple weapon
  if (weapons.length === 0) {
    if (charClass.weapon_proficiencies.some(w => w.includes('Martial') || w.includes('martial'))) {
      weapons.push({ name: 'Longsword', attackBonus: strMod + profBonus, damage: formatDamage('1d8', strMod), damageType: 'slashing' });
      equipment.push('Longsword');
    } else {
      weapons.push({ name: 'Dagger', attackBonus: dexMod + profBonus, damage: formatDamage('1d4', dexMod), damageType: 'piercing' });
      equipment.push('Dagger');
    }
  }

  // Features from class and race
  const features = [];
  for (const feat of (charClass.level_1_features || [])) {
    // Summarize long descriptions
    const desc = feat.description.length > 120
      ? feat.description.substring(0, 117) + '...'
      : feat.description;
    features.push(`${feat.name} (${desc})`);
  }
  // Race traits
  const raceTraits = [];
  for (const trait of (race.traits || [])) {
    raceTraits.push(`${trait.name} (${trait.description.substring(0, Math.min(80, trait.description.length))}${trait.description.length > 80 ? '...' : ''})`);
  }
  if (subrace) {
    for (const trait of (subrace.traits || [])) {
      raceTraits.push(`${trait.name} (${trait.description.substring(0, Math.min(80, trait.description.length))}${trait.description.length > 80 ? '...' : ''})`);
    }
  }

  // Spells for spellcasting classes
  // Half-casters (Ranger, Paladin) don't have spellcasting field in rules data because they get spells at L2.
  // Synthesize a minimal spellcasting config for them when level >= 2.
  let effectiveSpellcasting = charClass.spellcasting;
  if (!effectiveSpellcasting && HALF_CASTERS.includes(charClass.name) && startingLevel >= 2) {
    const HALF_CASTER_ABILITIES = { Ranger: 'Wisdom', Paladin: 'Charisma' };
    effectiveSpellcasting = {
      ability: HALF_CASTER_ABILITIES[charClass.name],
      cantrips_known_at_1st: 0,
      spells_known_at_1st: 2, // Both classes know 2 spells at L2 in 5e
    };
  }

  let spells = null;
  if (effectiveSpellcasting) {
    const spellAbility = effectiveSpellcasting.ability;
    const baseCantrips = effectiveSpellcasting.cantrips_known_at_1st || 0;
    const baseSpells = effectiveSpellcasting.spells_known_at_1st || effectiveSpellcasting.spellbook_spells_at_1st || 0;
    const numCantrips = cantripsKnownForLevel(baseCantrips, startingLevel);
    const spellAbilityMod = abilities[spellAbility.toLowerCase()]?.modifier || 0;
    const numSpells = spellsKnownForLevel(baseSpells, startingLevel, charClass.name, spellAbilityMod);
    const spellSlots = getSpellSlotsForLevel(charClass.name, startingLevel);

    // Pick cantrips for this class
    const classCantrips = (spellsData.cantrips || []).filter(s => s.classes.includes(charClass.name));
    const chosenCantrips = pickN(classCantrips, Math.min(numCantrips, classCantrips.length)).map(s => s.name);

    // Pick spells across all available levels
    const allKnown = [];
    const slotLevels = Object.keys(spellSlots).sort();
    const maxSpellLevel = slotLevels.length > 0 ? parseInt(slotLevels[slotLevels.length - 1]) : 1;
    for (let sl = 1; sl <= maxSpellLevel; sl++) {
      const levelKey = `level_${sl}`;
      const classSpellsAtLevel = (spellsData[levelKey] || []).filter(s => s.classes.includes(charClass.name));
      if (classSpellsAtLevel.length > 0) {
        // Distribute spells roughly evenly, favoring lower levels
        const countAtLevel = sl === 1 ? Math.ceil(numSpells / maxSpellLevel) : Math.floor(numSpells / maxSpellLevel);
        const picked = pickN(classSpellsAtLevel, Math.min(Math.max(countAtLevel, 1), classSpellsAtLevel.length));
        allKnown.push(...picked.map(s => s.name));
      }
    }
    // If we didn't get enough from higher levels, fill from level 1
    if (allKnown.length < numSpells) {
      const classSpells1 = (spellsData.level_1 || []).filter(s => s.classes.includes(charClass.name) && !allKnown.includes(s.name));
      const extra = pickN(classSpells1, Math.min(numSpells - allKnown.length, classSpells1.length));
      allKnown.push(...extra.map(s => s.name));
    }

    spells = {
      spellcastingAbility: spellAbility,
      spellSaveDC: 8 + profBonus + abilities[spellAbility.toLowerCase()].modifier,
      spellAttackBonus: profBonus + abilities[spellAbility.toLowerCase()].modifier,
      cantrips: chosenCantrips,
      spellSlots: spellSlots,
      knownSpells: allKnown,
    };
  }

  // Personality
  const personality = {
    traits: pick(PERSONALITY_TRAITS),
    ideals: pick(IDEALS),
    bonds: pick(BONDS),
    flaws: pick(FLAWS),
  };

  // Appearance
  const sizeDesc = race.size === 'Small' ? 'a small, compact' : 'a';
  const raceDesc = subrace
    ? (subrace.name.toLowerCase().includes(race.name.toLowerCase()) ? subrace.name : `${subrace.name} ${race.name}`)
    : race.name;
  const appearance = `${name} is ${sizeDesc} ${raceDesc} ${charClass.name.toLowerCase()} with a weathered look that speaks of many roads traveled.`;

  // Backstory
  const shortName = name.split(' ')[0];
  const backstoryTemplates = [
    `${shortName} grew up in a small village before ${background.name.toLowerCase()} life called. Now ${shortName} seeks adventure and purpose in a dangerous world.`,
    `Once a humble ${background.name.toLowerCase()}, ${shortName} discovered a hidden talent and set out to forge a new destiny among adventurers.`,
    `Driven by ${personality.ideals.split('.')[0].toLowerCase()}, ${shortName} left behind the familiar to seek fortune, glory, and answers to questions that haunt the night.`,
    `${shortName} carries the weight of a troubled past but presses forward with determination. The road ahead is uncertain, but standing still was never an option.`,
    `After years as a ${background.name.toLowerCase()}, ${shortName} heard the call to adventure. Armed with ${charClass.name.toLowerCase()} training and hard-won wisdom, the journey begins.`,
  ];

  const character = {
    id: uuidv4(),
    name,
    status: 'alive',
    race: race.name,
    subrace: subrace ? subrace.name : '',
    class: charClass.name,
    level: startingLevel,
    background: background.name,
    alignment,
    experience: getStartingXp(dataDir, startingLevel),
    abilities,
    hitPoints: { max: maxHp, current: maxHp },
    armorClass,
    speed,
    proficiencyBonus: profBonus,
    savingThrows,
    skills,
    languages,
    equipment,
    weapons,
    armor: { name: armorName, type: armorType },
    features,
    traits: raceTraits,
    spells,
    personality,
    appearance,
    backstory: pick(backstoryTemplates),
  };

  return character;
}

function getCharacterOptions(dataDir) {
  const rulesDir = path.join(dataDir, 'rules');
  const races = JSON.parse(fs.readFileSync(path.join(rulesDir, 'races.json'), 'utf-8')).races;
  const classes = JSON.parse(fs.readFileSync(path.join(rulesDir, 'classes.json'), 'utf-8')).classes;
  const backgrounds = JSON.parse(fs.readFileSync(path.join(rulesDir, 'backgrounds.json'), 'utf-8')).backgrounds;

  return {
    races: races.map(r => ({
      name: r.name,
      subraces: (r.subraces || []).map(s => s.name),
    })),
    classes: classes.map(c => ({ name: c.name })),
    backgrounds: backgrounds.map(b => ({ name: b.name })),
    alignments: ALIGNMENTS,
  };
}

module.exports = { generateRandomCharacter, getCharacterOptions };
