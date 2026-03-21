// Canned turn actions — no external API calls
const CANNED_ACTIONS = [
  'I draw my weapon and scan the area for threats.',
  'I search the room carefully, checking for hidden doors or traps.',
  'I approach the nearest NPC and ask what they know about this place.',
  'I move cautiously forward, keeping my eyes peeled.',
  'I cast detect magic to see if anything nearby is enchanted.',
  'I check my equipment and prepare for whatever comes next.',
  'I listen carefully for any sounds — footsteps, voices, or creatures.',
  'I examine the strange markings on the wall more closely.',
  'I take a defensive position and ready an action.',
  'I try to persuade the NPC to share more information.',
  'I investigate the mysterious object on the ground.',
  'I attempt to pick the lock on the door ahead.',
  'I use my perception to survey our surroundings.',
  'I suggest we take a short rest before pressing on.',
  'I ready my shield and move to the front of the group.',
  'I look for tracks or signs of recent activity.',
  'I try to recall any lore about this location.',
  'I open the chest carefully, watching for traps.',
  'I call out to see if anyone — or anything — responds.',
  'I attack the nearest enemy with everything I have!',
  'I try to sneak past the guards undetected.',
  'I use my healing abilities on the most injured party member.',
  'I attempt to intimidate the creature blocking our path.',
  'I climb to higher ground to get a better vantage point.',
  'I examine the potion we found — is it safe to drink?',
  'I try to negotiate with the NPC for a better deal.',
  'I use my nature skills to forage for useful herbs.',
  'I check the body for any clues or useful items.',
  'I brace myself and charge into the fray.',
  'I attempt to decipher the ancient inscription.',
];

/**
 * Decide what action a bot should take.
 * Returns idle — the orchestrator handles session finding/creation logic.
 */
async function decideBotAction() {
  return { action: 'idle' };
}

// Appended to ~60% of messages to simulate reacting to DM options
const CHOICE_PHRASES = [
  'I like the last option.',
  '#2 is good.',
  'First choice.',
  'Let\'s go with the second one.',
  'I\'ll take option three.',
  'The first one sounds best.',
  'I like where this is going — last option for me.',
  'Hmm, I\'ll pick the first.',
  'Second option, definitely.',
  'Going with #1.',
  'Option two, please!',
  'I say we go with the third.',
  'The last one. Final answer.',
  'Number one all the way.',
  'I\'m feeling #2 on this one.',
  'Let\'s try the first option and see what happens.',
  'Third choice — fortune favors the bold.',
  'I\'ll go with whatever gets us moving forward.',
  'The safer option. Let\'s not push our luck.',
  'The risky one. What\'s the worst that could happen?',
  'Whichever one doesn\'t get us killed.',
  'The sneaky approach. Less fighting, more surviving.',
  'I say we talk our way out of this one.',
  'Brute force. Sometimes simple is best.',
  'The diplomatic route — violence is a last resort.',
  'Whatever involves the least amount of swimming.',
  'The one that sounds like a trap. I\'m curious.',
  'Let\'s split up! ...Just kidding. Never split up.',
  'The option that doesn\'t involve dark magic. I have standards.',
  'Charge in head-first. I didn\'t roll a barbarian to be cautious.',
  'The clever option. Brains over brawn today.',
  'Honestly? The one with the best loot potential.',
  'Let\'s do the unexpected. Keep \'em guessing.',
];

/**
 * Generate a turn action from the canned pool.
 * 60% of the time, appends a choice/reaction phrase.
 */
async function generateTurnText() {
  const action = CANNED_ACTIONS[Math.floor(Math.random() * CANNED_ACTIONS.length)];
  if (Math.random() < 0.6) {
    const choice = CHOICE_PHRASES[Math.floor(Math.random() * CHOICE_PHRASES.length)];
    return `${action} ${choice}`;
  }
  return action;
}

module.exports = {
  decideBotAction,
  generateTurnText,
};
