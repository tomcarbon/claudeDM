// Pool of fantasy-flavored bot names and generator utilities

const FIRST_NAMES = [
  'Albert', 'Bobby', 'Celia', 'Dorian', 'Elara', 'Finn', 'Greta', 'Hugo',
  'Iris', 'Jasper', 'Kira', 'Ludo', 'Mira', 'Nolan', 'Opal', 'Percy',
  'Quinn', 'Rosalind', 'Silas', 'Talia', 'Ulric', 'Vera', 'Wren', 'Xander',
  'Yara', 'Zeke', 'Anya', 'Bram', 'Cora', 'Dashiell', 'Elowen', 'Felix',
  'Gemma', 'Hale', 'Isolde', 'Jorah', 'Kael', 'Lyra', 'Magnus', 'Nessa',
  'Orion', 'Piper', 'Rafe', 'Sage', 'Theron', 'Uma', 'Viggo', 'Willow',
  'Zara', 'Ash',
];

const LAST_NAMES = [
  'Smith', 'Zane', 'Nighthollow', 'Copperwick', 'Thornfield', 'Blackwood',
  'Ironforge', 'Silverleaf', 'Stormwind', 'Brightwater', 'Dunmore', 'Ashwick',
  'Greenhill', 'Ravencroft', 'Goldmere', 'Whitestone', 'Duskwalker', 'Oakhart',
  'Frostburn', 'Holloway', 'Bramblewood', 'Cindervale', 'Deepwell', 'Emberglow',
  'Farrow', 'Grimshaw', 'Hawthorn', 'Ivywood', 'Kettleblack', 'Larkspur',
  'Moonshadow', 'Northwind', 'Oldcastle', 'Pinecrest', 'Quicksilver', 'Redthorn',
  'Stonehearth', 'Tidewater', 'Underhill', 'Valewood', 'Windmere', 'Yarrow',
  'Ashford', 'Barrowmere', 'Coalridge', 'Dawnbreaker', 'Elderwood', 'Foxglove',
  'Greymoor', 'Hearthstone',
];

/**
 * Generate a bot name not already in the existing set.
 * @param {Set<string>} existingEmails - Set of existing bot email addresses
 * @returns {{ name: string, email: string }} e.g. { name: 'bot_AlbertSmith', email: 'bot_albert-smith@bot.local' }
 */
function generateBotIdentity(existingEmails) {
  const used = existingEmails || new Set();
  // Try random combinations first
  for (let attempt = 0; attempt < 500; attempt++) {
    const first = FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)];
    const last = LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)];
    const email = `bot_${first.toLowerCase()}-${last.toLowerCase()}@bot.local`;
    if (!used.has(email)) {
      return {
        name: `bot_${first}${last}`,
        email,
      };
    }
  }
  // Fallback: sequential numbered bot
  let i = 1;
  while (used.has(`bot_agent-${i}@bot.local`)) i++;
  return {
    name: `bot_Agent${i}`,
    email: `bot_agent-${i}@bot.local`,
  };
}

/**
 * Check if an email belongs to a bot account.
 */
function isBotEmail(email) {
  return String(email).endsWith('@bot.local');
}

module.exports = {
  generateBotIdentity,
  isBotEmail,
  FIRST_NAMES,
  LAST_NAMES,
};
