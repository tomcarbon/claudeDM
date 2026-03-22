// ---------------------------------------------------------------------------
// Situation detection — scan recent DM messages for context keywords
// ---------------------------------------------------------------------------

const SITUATION_KEYWORDS = {
  combat: [
    'attack', 'damage', 'hit points', 'initiative', 'sword', 'weapon',
    'enemy', 'enemies', 'strikes', 'slashes', 'arrow', 'spell attack',
    'combat', 'battle', 'fight', 'charge', 'wounded', 'bleeding',
    'goblin', 'orc', 'skeleton', 'bandit', 'creature', 'monster',
    'dies', 'kills', 'critical', 'misses', 'hits', 'armor class',
  ],
  social: [
    'says', 'asks', 'tells you', 'speaks', 'replies', 'npc', 'tavern',
    'merchant', 'innkeeper', 'bartender', 'guard', 'villager', 'conversation',
    'persuade', 'negotiate', 'greet', 'welcome', 'stranger', 'friend',
    'offer', 'trade', 'buy', 'sell', 'rumor', 'story', 'introduced',
  ],
  exploration: [
    'door', 'passage', 'corridor', 'room', 'cave', 'forest', 'path',
    'trap', 'chest', 'discover', 'explore', 'entrance', 'exit', 'bridge',
    'ruins', 'temple', 'dungeon', 'staircase', 'tunnel', 'clearing',
    'footprints', 'tracks', 'markings', 'inscription', 'hidden', 'locked',
  ],
  rest: [
    'rest', 'camp', 'sleep', 'inn', 'heal', 'morning', 'campfire',
    'long rest', 'short rest', 'dawn', 'dusk', 'bedroll', 'watches',
    'recover', 'overnight', 'sunset', 'sunrise',
  ],
};

function detectSituation(recentMessages) {
  // Gather text from last 5 DM messages
  const dmTexts = (recentMessages || [])
    .filter(m => m.type === 'dm' && m.text)
    .slice(-5)
    .map(m => m.text.toLowerCase());

  // Also check for dice roll labels (combat indicator)
  const hasCombatRolls = (recentMessages || [])
    .filter(m => m.type === 'dice_roll')
    .slice(-5)
    .some(m => /attack|damage|initiative/i.test(m.label || ''));

  const combined = dmTexts.join(' ');
  const scores = {};

  for (const [situation, keywords] of Object.entries(SITUATION_KEYWORDS)) {
    scores[situation] = keywords.filter(kw => combined.includes(kw)).length;
  }
  if (hasCombatRolls) scores.combat = (scores.combat || 0) + 3;

  // Pick highest-scoring situation, or 'general' if no strong signal
  let best = 'general';
  let bestScore = 2; // minimum threshold
  for (const [situation, score] of Object.entries(scores)) {
    if (score > bestScore) {
      best = situation;
      bestScore = score;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Situation-specific action pools
// ---------------------------------------------------------------------------

const ACTIONS = {
  combat: {
    general: [
      'I attack the nearest enemy!',
      'I take a defensive stance and brace for the next hit.',
      'I try to flank around to get a better angle.',
      'I focus on the most dangerous-looking foe.',
      'I look for an opening to strike.',
      'I ready my weapon and hold my ground.',
      'I press the attack — keep the pressure on!',
      'I fall back to a safer position.',
      'I try to protect the most vulnerable party member.',
      'I look for something in the environment I can use.',
    ],
    classSpecific: {
      fighter: ['I raise my shield and charge in.', 'I use my training to find a weakness in their defense.', 'I stand firm and hold the line.'],
      barbarian: ['I let out a war cry and throw myself into the fray!', 'I swing wildly with everything I\'ve got!', 'Rage fuels me — I hit harder.'],
      paladin: ['I call upon my oath and smite the enemy!', 'I move to shield my allies from harm.', 'Divine power strengthens my strike.'],
      rogue: ['I look for a chance to strike from the shadows.', 'I dart behind the enemy for a sneak attack.', 'I duck and weave, looking for an opening.'],
      ranger: ['I take aim at the most exposed target.', 'I use the terrain to my advantage.', 'I mark my quarry and line up the shot.'],
      cleric: ['I call upon my deity for aid in battle.', 'I channel divine energy to support the party.', 'I raise my holy symbol and strike.'],
      druid: ['I call on the forces of nature to aid us.', 'I shift my form to better fight.', 'I use the wild to our advantage.'],
      bard: ['I shout words of encouragement to inspire my allies!', 'I weave a quick spell to disrupt the enemy.', 'I taunt the enemy to draw their attention.'],
      wizard: ['I prepare a spell to turn the tide.', 'I look for the right moment to unleash arcane power.', 'I analyze the enemy for magical weaknesses.'],
      sorcerer: ['I channel raw magical energy into my attack.', 'I let my power surge — time to unleash!', 'I focus my innate magic on the biggest threat.'],
      warlock: ['I call on my patron\'s dark power.', 'Eldritch energy crackles at my fingertips.', 'I invoke the pact and strike.'],
      monk: ['I center myself and strike with precision.', 'I use my ki to enhance my blows.', 'I flow between attacks with practiced speed.'],
    },
  },
  social: {
    general: [
      'I listen carefully to what they\'re saying.',
      'I try to read their intentions.',
      'I speak up and introduce myself.',
      'I let the conversation play out before jumping in.',
      'I keep a friendly but watchful demeanor.',
      'I ask them to tell us more.',
      'I try to gauge whether they\'re being honest.',
      'I nod along and see where this is going.',
      'I offer a polite greeting.',
      'I keep quiet and observe their body language.',
    ],
    classSpecific: {
      bard: ['I flash a charming smile and take the lead in conversation.', 'I tell a quick tale to warm them up.', 'I use my silver tongue to steer the conversation.'],
      rogue: ['I watch for tells — are they hiding something?', 'I casually case the room while they talk.', 'I keep my hand near my coin purse. Trust is earned.'],
      paladin: ['I speak with honor and directness.', 'I assure them of our good intentions.', 'I offer my word as a bond.'],
      cleric: ['I offer a blessing and kind words.', 'I sense for any evil intent.', 'I speak with the calm authority of the faithful.'],
      fighter: ['I let the talkers handle this and keep watch.', 'I stand at attention — my presence speaks for itself.', 'I nod stoically and let the others negotiate.'],
      barbarian: ['I cross my arms and stare them down.', 'Words aren\'t my strength. I\'ll let others talk.', 'I grunt in agreement and look intimidating.'],
      wizard: ['I assess them with an intellectual eye.', 'I ask pointed, analytical questions.', 'I mention relevant lore to establish credibility.'],
      ranger: ['I hang back and watch the exits.', 'I study them the way I\'d study tracks.', 'I\'m more comfortable in the wild, but I listen.'],
    },
  },
  exploration: {
    general: [
      'I check for traps before proceeding.',
      'I examine this more closely.',
      'I scout ahead carefully.',
      'I look for anything unusual or out of place.',
      'I test the ground before stepping forward.',
      'I listen for sounds deeper in.',
      'I mark our path so we can find our way back.',
      'I search the area thoroughly.',
      'I move cautiously and stay alert.',
      'I try to get a better view of what\'s ahead.',
    ],
    classSpecific: {
      rogue: ['I check for hidden mechanisms and tripwires.', 'I try to pick the lock.', 'I slip ahead in the shadows to scout.'],
      ranger: ['I read the tracks and signs to figure out what\'s been here.', 'I use my knowledge of the wild to navigate.', 'I sniff the air — something\'s different here.'],
      wizard: ['I cast detect magic to scan the area.', 'I study the runes and inscriptions.', 'I consult my arcane knowledge about this place.'],
      druid: ['I commune with the natural surroundings.', 'I ask the local wildlife what they\'ve seen.', 'I sense whether the land here is healthy or corrupted.'],
      cleric: ['I pray for guidance as we explore.', 'I sense for unholy presence.', 'I keep my divine light ready.'],
      bard: ['I recall any legends about this place.', 'I hum a tune to keep our spirits up.', 'I\'ve heard a story about places like this...'],
      fighter: ['I take point and shield the group.', 'I test the door with my shoulder.', 'I keep my weapon drawn as we advance.'],
      paladin: ['I extend my divine senses.', 'I lead the way with courage.', 'I watch for signs of evil influence.'],
    },
  },
  rest: {
    general: [
      'I take first watch.',
      'I tend to my equipment.',
      'I check on the others.',
      'I settle in and try to get some rest.',
      'I use this time to patch up my gear.',
      'I sit by the fire and collect my thoughts.',
      'I keep one eye open while I rest.',
      'I eat something and replenish my energy.',
      'I stretch and work out the aches from the road.',
      'I take stock of our supplies.',
    ],
    classSpecific: {
      cleric: ['I pray and meditate to restore my connection to the divine.', 'I tend to the party\'s wounds.', 'I offer a blessing over our camp.'],
      wizard: ['I study my spellbook by candlelight.', 'I review my notes on what we\'ve encountered.', 'I prepare new spells for tomorrow.'],
      bard: ['I play a soft tune to help everyone relax.', 'I jot down notes about our adventure so far.', 'I entertain the group with a story.'],
      ranger: ['I set snares around the camp perimeter.', 'I scout the area for threats before settling in.', 'I forage for herbs and useful plants.'],
      rogue: ['I sharpen my blades quietly.', 'I count my coins and check my gear.', 'I keep to the shadows and watch the camp edges.'],
      fighter: ['I maintain my armor and weapons.', 'I run through sword drills to stay sharp.', 'I fortify our position for the night.'],
      druid: ['I commune with the natural world around us.', 'I tend to any nearby plants or animals.', 'I call a small creature to keep watch.'],
      barbarian: ['I eat heartily and sharpen my axe.', 'I arm-wrestle whoever\'s willing.', 'I sleep light — always ready.'],
    },
  },
  general: {
    general: [
      'I press forward and see what happens.',
      'I stay alert and keep my guard up.',
      'I take a moment to assess the situation before acting.',
      'I follow the group\'s lead on this one.',
      'I keep my weapon ready, just in case.',
      'I look around for anything useful or out of place.',
      'I stick close to the party and stay focused.',
      'I prepare myself for whatever comes next.',
      'I take a careful look at our surroundings.',
      'I hang back and observe before committing.',
      'I move up and take point.',
      'I stay on my toes — something feels off.',
      'I keep watch while the others decide.',
      'I steady myself and wait for the right moment.',
      'I try to get a better read on the situation.',
      'I position myself where I can be most useful.',
      'I keep my eyes open for danger.',
      'I brace for trouble — better safe than sorry.',
    ],
    classSpecific: {},
  },
};

// ---------------------------------------------------------------------------
// Personality-flavored choice phrases
// ---------------------------------------------------------------------------

const PERSONALITY_PHRASES = {
  bold: [
    'The daring option — let\'s go!',
    'I say we charge in. Fortune favors the bold.',
    'Give me the heroic option. Go big or go home.',
    'Let\'s not overthink it — charge forward!',
    'The ambitious choice. We can handle it.',
    'I want the riskier way. What\'s the worst that could happen?',
    'The scrappy option — let\'s get our hands dirty.',
    'Let\'s take the fight to them!',
  ],
  cautious: [
    'Let\'s go with the safer route.',
    'The steadfast choice. No need to be reckless.',
    'Let\'s be smart about this — the measured approach.',
    'Whatever keeps us alive the longest.',
    'The patient approach. Good things come to those who wait.',
    'Let\'s think this through before we act.',
    'I\'d rather not rush into anything.',
    'The careful path. We can always escalate later.',
  ],
  curious: [
    'I want to explore that further.',
    'What\'s behind there? I need to know.',
    'I\'m curious about the stranger option.',
    'Let\'s investigate before we decide.',
    'I want the path less traveled.',
    'There\'s more to this than meets the eye.',
    'Let me take a closer look first.',
    'I want to understand what we\'re dealing with.',
  ],
  kind: [
    'Whatever helps the most people.',
    'Is everyone okay? That\'s what matters.',
    'The honorable way. We have principles.',
    'The diplomatic way, if there is one.',
    'I\'d rather avoid a fight if we can.',
    'Let\'s try to help them.',
    'We should do the right thing here.',
    'Compassion first. Violence is a last resort.',
  ],
  neutral: [
    'I\'d rather take the bolder path.',
    'Let\'s go with the safer route.',
    'I prefer the subtle approach.',
    'The direct way. No sneaking around.',
    'Let\'s try the clever route — brains over brawn.',
    'Whatever sounds the most fun.',
    'The straightforward path. No tricks.',
    'Let\'s be practical here.',
  ],
};

const BOLD_KEYWORDS = ['brave', 'bold', 'reckless', 'fearless', 'daring', 'aggressive', 'fierce', 'hot-headed', 'impulsive'];
const CAUTIOUS_KEYWORDS = ['careful', 'cautious', 'prudent', 'methodical', 'reserved', 'measured', 'patient', 'thoughtful', 'wary'];
const CURIOUS_KEYWORDS = ['curious', 'inquisitive', 'knowledge', 'investigat', 'scholar', 'studying', 'fascinated', 'wonder'];
const KIND_KEYWORDS = ['compassion', 'kind', 'gentle', 'caring', 'protect', 'loyal', 'generous', 'helpful', 'empathy', 'mercy'];

function detectPersonality(character) {
  if (!character) return 'neutral';

  const text = [
    character.personality?.traits,
    character.personality?.ideals,
    character.personality?.bonds,
    character.alignment,
  ].filter(Boolean).join(' ').toLowerCase();

  const scores = { bold: 0, cautious: 0, curious: 0, kind: 0 };
  for (const kw of BOLD_KEYWORDS) if (text.includes(kw)) scores.bold++;
  for (const kw of CAUTIOUS_KEYWORDS) if (text.includes(kw)) scores.cautious++;
  for (const kw of CURIOUS_KEYWORDS) if (text.includes(kw)) scores.curious++;
  for (const kw of KIND_KEYWORDS) if (text.includes(kw)) scores.kind++;

  // Also use alignment as a signal
  if (text.includes('chaotic')) scores.bold++;
  if (text.includes('lawful')) scores.cautious++;
  if (text.includes('good')) scores.kind++;

  let best = 'neutral';
  let bestScore = 0;
  for (const [personality, score] of Object.entries(scores)) {
    if (score > bestScore) {
      best = personality;
      bestScore = score;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickAction(situation, characterClass) {
  const pool = ACTIONS[situation] || ACTIONS.general;
  const cls = (characterClass || '').toLowerCase();
  const classActions = pool.classSpecific?.[cls];

  // 50% chance to pick a class-specific action if available
  if (classActions && classActions.length > 0 && Math.random() < 0.5) {
    return pickRandom(classActions);
  }
  return pickRandom(pool.general);
}

function pickPhrase(personality) {
  const bucket = PERSONALITY_PHRASES[personality] || PERSONALITY_PHRASES.neutral;
  // 70% from personality bucket, 30% from neutral
  if (personality !== 'neutral' && Math.random() < 0.3) {
    return pickRandom(PERSONALITY_PHRASES.neutral);
  }
  return pickRandom(bucket);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function decideBotAction() {
  return { action: 'idle' };
}

/**
 * Generate a context-aware, character-flavored turn action.
 */
async function generateTurnText({ recentMessages, character, scenarioName } = {}) {
  const situation = detectSituation(recentMessages);
  const characterClass = character?.class;
  const personality = detectPersonality(character);

  const action = pickAction(situation, characterClass);

  // 60% of the time, append a personality-flavored choice phrase
  if (Math.random() < 0.6) {
    const phrase = pickPhrase(personality);
    return `${action} ${phrase}`;
  }
  return action;
}

module.exports = {
  decideBotAction,
  generateTurnText,
};
