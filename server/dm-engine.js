const { query, createSdkMcpServer, tool } = require('@anthropic-ai/claude-agent-sdk');
const { z } = require('zod/v4');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { awardXp } = require('./xp-utils');
const { startCombat, nextTurn, applyDamage, applyHealing, setCondition, getCombatStatus, endCombat } = require('./combat-utils');
const { useResource, castSpell, processRest, checkResources } = require('./resource-utils');
const { advanceTime, scheduleEvent, checkCalendar, generateWeather } = require('./calendar-utils');
const { emailToSlug, getPlayerCharactersDir, getSessionCharactersDir, getSessionNpcsDir } = require('./player-data');

const PROJECT_ROOT = path.join(__dirname, '..');

const AGENCY_TO_AUTONOMY = { railroaded: 0, guided: 25, collaborative: 50, freeform: 75, sandbox: 100 };
const RESPONSE_LENGTH_PRESETS = {
  brief:    { words: 300, guide: 'Aim for roughly 300 words per response. Keep descriptions brief and punchy — short paragraphs, no fluff.' },
  standard: { words: 500, guide: 'Aim for roughly 500 words per response. Use moderate detail — enough to paint the scene without overstaying.' },
  detailed: { words: 750, guide: 'Aim for roughly 750 words per response. Use rich, detailed prose with vivid imagery and atmospheric depth.' },
  epic:     { words: 1000, guide: 'Aim for roughly 1000 words per response. Go all-in on immersive, cinematic prose — paint every scene in full color.' },
};

function loadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function loadDmSettings(dataDir, playerEmail) {
  // Try per-user settings first, fall back to global
  let userSettings = null;
  if (playerEmail) {
    const slug = String(playerEmail).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const userFile = path.join(dataDir, 'dm-settings', `${slug}.json`);
    userSettings = loadJson(userFile);
  }
  const globalSettings = loadJson(path.join(dataDir, 'dm-settings.json'));
  const defaults = {
    humor: 50, drama: 50, responseLength: 'standard', difficulty: 50,
    horror: 20, puzzleFocus: 50, playerAutonomy: 50,
    tone: 'balanced', narrationStyle: 'descriptive', playerAgency: 'collaborative',
  };
  const baseSettings = { ...defaults, ...(globalSettings || {}), ...(userSettings || {}) };
  // Migrate legacy verbosity (0-100) → responseLength preset
  // If any source file still has verbosity, it means responseLength hasn't been explicitly set
  const sourceHasVerbosity = (globalSettings && globalSettings.verbosity !== undefined)
    || (userSettings && userSettings.verbosity !== undefined);
  if (sourceHasVerbosity) {
    const v = baseSettings.verbosity;
    if (v <= 20) baseSettings.responseLength = 'brief';
    else if (v <= 55) baseSettings.responseLength = 'standard';
    else if (v <= 80) baseSettings.responseLength = 'detailed';
    else baseSettings.responseLength = 'epic';
  }
  delete baseSettings.verbosity;
  return baseSettings;
}

function loadCharacter(dataDir, characterId, playerEmail, campaignId, sessionDbId) {
  // Search session dir first, then player library, then campaign defaults, then legacy
  const dirs = [];
  if (sessionDbId) {
    dirs.push(getSessionCharactersDir(dataDir, sessionDbId));
  }
  if (playerEmail) {
    dirs.push(getPlayerCharactersDir(dataDir, playerEmail, campaignId));
  }
  dirs.push(path.join(dataDir, 'defaults', campaignId || 'demo', 'characters'));
  // Legacy fallback
  dirs.push(path.join(dataDir, 'characters'));
  for (const dir of dirs) {
    try {
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
      for (const file of files) {
        const data = loadJson(path.join(dir, file));
        if (data && data.id === characterId) {
          data._filename = file;
          return data;
        }
      }
    } catch { /* dir may not exist */ }
  }
  return null;
}

function loadScenario(dataDir, scenarioId, campaignId) {
  // Try campaign-specific scenarios first, then fall back to legacy global dir
  const campaignDir = path.join(dataDir, 'campaigns', campaignId || 'demo', 'scenarios');
  const dirs = [campaignDir, path.join(dataDir, 'scenarios')];
  for (const dir of dirs) {
    try {
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
      for (const file of files) {
        const data = loadJson(path.join(dir, file));
        if (data && data.id === scenarioId) return data;
      }
    } catch { /* dir may not exist */ }
  }
  return null;
}

function loadNpcs(dataDir, playerEmail, campaignId, sessionDbId) {
  // Search session dir first, then campaign defaults
  const dirsToTry = [];
  if (sessionDbId) {
    dirsToTry.push(getSessionNpcsDir(dataDir, sessionDbId));
  }
  dirsToTry.push(path.join(dataDir, 'defaults', campaignId || 'demo', 'npcs'));
  // Legacy fallback
  dirsToTry.push(path.join(dataDir, 'npcs'));

  for (const dir of dirsToTry) {
    try {
      const results = fs.readdirSync(dir)
        .filter(f => f.endsWith('.json'))
        .map(f => {
          const data = loadJson(path.join(dir, f));
          if (data) data._filename = f;
          return data;
        })
        .filter(Boolean);
      if (results.length > 0) return results;
    } catch { /* dir may not exist */ }
  }
  return [];
}

function buildSystemPrompt(dataDir, characterId, scenarioId, playerEmail, campaignId, companionPlayers, sessionDbId, companionConfig, dmPersonality, worldState) {
  const cid = campaignId || 'demo';
  const settings = dmPersonality || loadDmSettings(dataDir, playerEmail);
  const character = characterId ? loadCharacter(dataDir, characterId, playerEmail, cid, sessionDbId) : null;
  const scenario = scenarioId ? loadScenario(dataDir, scenarioId, cid) : null;
  const npcs = loadNpcs(dataDir, playerEmail, cid, sessionDbId);

  // Compute paths for file references — use session dirs when available
  const slug = playerEmail ? emailToSlug(playerEmail) : null;
  const charPathPrefix = sessionDbId
    ? `data/sessions/${sessionDbId}/characters`
    : slug ? `data/players/${slug}/${cid}/characters` : 'data/characters';
  const npcPathPrefix = sessionDbId
    ? `data/sessions/${sessionDbId}/npcs`
    : `data/defaults/${cid}/npcs`;

  const lengthPreset = RESPONSE_LENGTH_PRESETS[settings.responseLength] || RESPONSE_LENGTH_PRESETS.standard;
  const responseLengthGuide = lengthPreset.guide;

  const humorGuide = settings.humor < 30 ? 'Maintain a serious tone.'
    : settings.humor > 70 ? 'Weave humor and wit throughout the narration.'
    : 'Include occasional moments of levity.';

  const dramaGuide = settings.drama < 30 ? 'Keep things light and low-stakes.'
    : settings.drama > 70 ? 'Heighten dramatic tension at every opportunity.'
    : 'Balance dramatic moments with quieter scenes.';

  const toneMap = {
    'heroic': 'The overall tone is epic and heroic.',
    'gritty': 'The overall tone is bleak, dangerous, and grounded.',
    'whimsical': 'The overall tone is playful, magical, and light.',
    'balanced': 'Strike a balance between light and dark moments.',
    'noir': 'The overall tone is mysterious, shadowy, and tense.',
  };

  const styleMap = {
    'descriptive': 'Use descriptive, immersive narration.',
    'action': 'Use punchy, action-focused narration with momentum.',
    'dialogue': 'Lean heavily on dialogue and strong NPC voices.',
    'atmospheric': 'Prioritize mood, tension, and environmental detail.',
  };

  let prompt = `You are an AI Dungeon Master for D&D 5th Edition. You narrate the story, control NPC companions, adjudicate rules, and create an immersive tabletop RPG experience.

## Your Personality & Style
${responseLengthGuide}
${humorGuide}
${dramaGuide}
${toneMap[settings.tone] || toneMap.balanced}
${styleMap[settings.narrationStyle] || styleMap.descriptive}
Difficulty preference: ${settings.difficulty}/100 (higher = more challenging encounters and stricter rules).
Horror/Darkness level: ${settings.horror}/100.
Puzzle vs Combat focus: ${settings.puzzleFocus}/100 (0 = combat-heavy, 100 = puzzle/exploration-heavy).
Player autonomy: ${settings.playerAutonomy}/100 (0 = DM drives the story with strong plot hooks and direction; 100 = player drives the story, DM reacts and adapts to player choices).
Player agency style: ${settings.playerAgency}.`;

  // --- Response Scope & Turn Pacing (scaled to playerAutonomy) ---
  const autonomy = settings.playerAutonomy ?? 50;
  let pacingSection;
  if (autonomy <= 25) {
    pacingSection = `## Response Scope & Turn Pacing
These rules govern how much narrative you may advance in a SINGLE response. They are as binding as the Dice Integrity rules.

1. **Location limit:** Maximum 2 location transitions per response (e.g., tavern → road → dungeon entrance). Never enter a new dungeon, building, or hostile area without pausing for player input.
2. **Time limit:** Maximum 2 time transitions per response (e.g., "that evening..." → "the next morning..."). Never skip more than 1 day without player confirmation.
3. **Combat checkpoint:** ALWAYS stop and hand control to the player before the first round of any combat. Never narrate the player character attacking, dodging, or casting without player input.
4. **Danger checkpoint:** When the party encounters a trap, ambush, hostile creature, or any threat, STOP and describe the situation. Let the player decide how to react.
5. **Short-input rule:** When the player's input is brief (1-5 words) confirming a routine action (rest, travel, purchase), you may narrate the outcome and advance to the next interesting decision point. But do NOT chain multiple encounters, discoveries, or plot beats from a single short confirmation.
6. **One response = one decision point.** Every response must end at a moment where the player has a meaningful choice to make. "What do you do?" is not optional flavor — it is a structural requirement.`;
  } else if (autonomy <= 74) {
    pacingSection = `## Response Scope & Turn Pacing
These rules govern how much narrative you may advance in a SINGLE response. They are as binding as the Dice Integrity rules.

1. **Location limit:** Maximum 1 location transition per response. If the party moves to a new area, describe the arrival and STOP. Do not also explore, discover, and encounter in the same response.
2. **Time limit:** Maximum 1 time transition per response. "That evening" or "after the long rest" is fine — but do not then also narrate the next morning's march and arrival somewhere.
3. **Combat checkpoint:** ALWAYS stop and hand control to the player before the first round of any combat. Never narrate the player character's combat actions.
4. **Danger checkpoint:** When the party encounters a trap, ambush, hostile creature, or any new threat, STOP and let the player react.
5. **Short-input rule:** When the player's input is brief (1-5 words like "yep", "sure", "I rest"), process ONLY the specific action confirmed. A "yep" to a long rest means: narrate the rest completing, then ask what the player does next. It does NOT mean: narrate the rest, the next morning, the march, the arrival, the exploration, and the encounter.
6. **One response = one decision point.** Every response must end at a moment where the player has a meaningful choice to make. Never resolve more than one scene per response.
7. **No narrative chaining.** Do not let "momentum" carry you past decision points. Each of these is a STOP point requiring player input: entering a new area, meeting a new NPC, discovering something significant, any sign of danger.`;
  } else {
    pacingSection = `## Response Scope & Turn Pacing ⚠️
These rules are ABSOLUTE at this autonomy level (${autonomy}/100). They override narrative momentum, pacing instincts, and story flow. They are as binding as the Dice Integrity rules.

1. **Location limit: ZERO unsolicited transitions.** Do not move the party to a new location unless the player explicitly says to go there. Describe the current scene, then STOP.
2. **Time limit: Minutes only.** Do not advance time beyond the immediate scene unless the player explicitly requests it (e.g., "I take a long rest", "we travel to the next town"). Even then, narrate only the completion of that specific action.
3. **Combat checkpoint:** ALWAYS stop before combat. Never narrate even a single round without player input. Describe the threat appearing, roll initiative if appropriate, then STOP.
4. **Danger checkpoint:** Any trap, ambush, threat, or surprise — describe it and STOP immediately. The player decides everything.
5. **Short-input rule (CRITICAL):** Brief player inputs ("yep", "sure", "ok", "I do that", "yes") are LITERAL CONFIRMATIONS, not delegation. They confirm ONLY the specific action being discussed, nothing more. After processing that one action, STOP and ask what the player does next. NEVER interpret a short confirmation as permission to advance the plot, begin encounters, move locations, or narrate extended sequences.
6. **One response = one decision point.** Every response MUST end with the player having a clear choice. This is not a suggestion — it is a hard rule.
7. **No narrative chaining.** Even if the next scene is "obvious" (e.g., the party said they're heading to the dungeon), do not narrate arrival + entry + exploration + discovery in one response. Each transition is a separate response requiring player input.
8. **When in doubt, STOP EARLY.** It is always better to stop too soon and ask "What do you do?" than to narrate one sentence too far. The player can always say "keep going" — but they cannot un-read a spoiled reveal.`;
  }

  prompt += `\n\n${pacingSection}`;

  // --- Campaign identity block (highest salience — placed before rules) ---
  if (character) {
    prompt += `

## ⚠️ CAMPAIGN IDENTITY — READ THIS FIRST
YOU ARE RUNNING **${character.name}**'s CAMPAIGN. Do NOT confuse this with any other player's campaign. Every detail you narrate must be consistent with ${character.name}'s story, companions, and history.

## Player Character
${character.name} — Level ${character.level} ${character.subrace ? (character.subrace.toLowerCase().includes(character.race.toLowerCase()) ? character.subrace : `${character.subrace} ${character.race}`) : character.race} ${character.class} (${character.background})
HP: ${character.hitPoints.current}/${character.hitPoints.max} | AC: ${character.armorClass} | Speed: ${character.speed}
Abilities: ${Object.entries(character.abilities).map(([k, v]) => `${k.substring(0, 3).toUpperCase()} ${v.score}(${v.modifier >= 0 ? '+' : ''}${v.modifier})`).join(', ')}
Character file: ${charPathPrefix}/${character._filename || (character.id + '.json')} (use Read to check current state, Edit to update)
Character ID for AwardXP: ${character.id}`;
  }

  if (scenario) {
    prompt += `

## Active Scenario: ${scenario.title}
${scenario.synopsis || ''}`;
    if (scenario.hook) {
      prompt += `
Hook: ${scenario.hook}`;
    }
    if (scenario.acts) {
      prompt += `
Acts: ${scenario.acts.map((a, i) => `Act ${i + 1}: ${a.title}`).join(', ')}`;
    }
    prompt += `
Scenario file: data/campaigns/${cid}/scenarios/ (Read for full details)`;
  }

  prompt += `

## Rules Reference
Consult the D&D 5e rules database in data/rules/ for mechanics. The files are:
- data/rules/races.json, data/rules/classes.json
- data/rules/abilities-and-skills.json, data/rules/equipment.json
- data/rules/spells.json, data/rules/combat.json
- data/rules/leveling.json, data/rules/backgrounds.json
- data/rules/monsters.json — Full SRD bestiary (334 monsters with complete stat blocks, organized by challenge rating). Use this to look up monster stats for encounters: AC, HP, abilities, attacks, special abilities, legendary actions, etc.

Use the Read tool to look up specific rules when needed. Always follow D&D 5e mechanics accurately.

## Dice Rolling
${settings.realisticDice !== false
    ? `**ALWAYS use the RollDice tool for ALL dice rolls.** Never generate random numbers yourself — use the tool for true cryptographic randomness.
Roll dice using standard notation (NdX+M). Examples: "1d20", "2d6+3", "4d6", "1d20+5", "2d8-1".
**ALWAYS provide a label** (1-3 words) describing what each roll is for. Examples: "Pip initiative", "Rat 2 attack", "Goblin damage", "Perception check", "Death save".
For ability checks: roll 1d20 with the RollDice tool, then add the ability modifier and proficiency bonus (if proficient) to the result.
For advantage/disadvantage: call RollDice with "2d20" and take the higher or lower result.`
    : `Roll dice using standard notation (NdX). For ability checks: d20 + ability modifier + proficiency bonus (if proficient).
Generate random numbers for dice rolls.`}
Difficulty Classes: Easy 10, Medium 15, Hard 20, Very Hard 25, Nearly Impossible 30.
Always show the individual die rolls, modifiers, and final total to the player.

## Dice Integrity
You have creative freedom to call for rolls beyond strict RAW — atmospheric checks, luck rolls, morale checks — but once you call for a roll, these rules are absolute:
- **Real DC before the roll.** Decide the DC before seeing the result. Never adjust a DC after the fact.
- **No vibe rolls.** Every roll must have a meaningful failure state. If failure wouldn't change anything, just narrate success.
- **Honor the number.** A 2 is a 2. Do not soften failures with narrative safety nets. Failed rolls mean the attempt did not work.
- **Natural 1s and 20s are sacred.** Nat 1 on attack = always a miss. Nat 20 on attack = always a hit + critical.
- **No phantom rolls.** Never claim a roll happened without using the RollDice tool.
- **Show your work.** Always state: die rolled, natural result, modifiers, total, DC, and outcome.
- **The dice are the dice.** If a roll derails your planned narrative, adapt the narrative to the dice.

## Stat Integrity — No Phantom HP, No Deus Ex Machina
The JSON files are the source of truth for HP, spell slots, abilities, and status. These rules are absolute:
- **Never fabricate hit points.** If a character's JSON says 0 HP, they are down. Do not narrate them "finding inner strength" or "surging with unexpected vitality" to keep fighting. Read the file, honor the number.
- **No narrative resurrections.** A character at 0 HP follows death save rules. A character with 3 failed death saves is dead. Do not invent magical interventions, divine intercessions, or last-second rescues that aren't backed by actual game mechanics (spell slots, items, class features).
- **TPKs are valid outcomes.** If every party member drops to 0 HP and fails their death saves, that is a Total Party Kill. Narrate it with gravity and respect, then end the session. Do not engineer an implausible happy ending — the player can reset characters via Settings and start fresh.
- **No retroactive stat inflation.** Never increase a character's max HP, AC, spell slots, or ability scores mid-session to make an encounter survivable. If the encounter is too hard, the party retreats, negotiates, or dies.
- **Verify before narrating.** Before describing a character taking an action in combat, Read their JSON file to confirm they have the HP, spell slots, or resources to do it. If they don't, they can't.
- **Difficulty setting is not a safety net.** Low Difficulty means easier encounters and generous rulings *before* combat. Once initiative is rolled and dice are flying, the mechanics play out honestly regardless of Difficulty.

## Combat Flow
Initiative (d20 + DEX mod) > Turns in order > Action/Bonus/Movement/Reaction > Track HP.
Death saves: 3 successes = stabilize, 3 failures = death. Natural 20 = regain 1 HP. Natural 1 = 2 failures.

## Character Updates
When the player's character takes damage, picks up items, or changes in any way, use the Edit tool to update their character JSON file in ${charPathPrefix}/. For XP changes, use the AwardXP tool instead of manual edits. Always keep character data current.

## Never Reset Characters to Defaults
Never reset characters or NPCs to their default templates without explicit player permission. Do not use the restore-defaults API during gameplay. If something seems wrong with a character's data, ask the player before making any restorative changes.

## Death Tracking
When a character or NPC dies (3 failed death saves, instant death, etc.), use the Edit tool to set "status": "dead" in their JSON file. Dead characters remain in the data but are marked as deceased. Valid status values: "alive" or "dead".
A creature is dead after its hit points reach zero or below from combat or spell damage.

**FILE VERIFICATION:** After every level-up and periodically during long sessions, use Read to verify character/NPC JSON files match the narrative state (level, XP, HP, equipment, gold). If out of sync, fix immediately via Edit. The JSON files are the source of truth — if they don't match the story, the data is wrong.

## Post-Encounter Checklist (MANDATORY)
After EVERY combat encounter or significant event, complete ALL applicable steps before continuing the narrative. The player should NEVER have to ask "do we get XP?"

**After Combat:**
1. Calculate XP: look up each defeated enemy's CR in data/rules/leveling.json → monster_xp_by_cr. Sum total XP, divide equally among ALL surviving party members (PCs + NPCs). Use AwardXP tool for each. If AwardXP errors, update manually via Edit. **XP PARITY: Every party member present MUST receive identical XP at time of award. Never award different amounts to PCs vs NPCs for the same encounter. Do NOT retroactively equalize XP totals — drift between party members is normal.**
2. Describe loot found. The player should NEVER have to ask "don't we get any loot?" CR-based guidelines: CR 0-1 = a few gp + common items; CR 2-4 = 20-120 gp + mundane equipment; CR 5+ = 40-240 gp + possible magic items. Humanoids always carry weapons, armor, and a coin purse. Let player decide distribution, then Edit all recipient files.
3. Update inventory via Edit: items gained, items consumed (potions, scrolls), ammunition spent (arrows, bolts — always deduct), gold changes for ALL parties.
4. Update hitPoints.current for anyone who took damage.
5. Announce clearly: XP per character, items found, level-ups, current XP progress (e.g. "450/900 XP").

**After Non-Combat Milestones:** Award milestone XP via AwardXP. Update inventory. Note story rewards (reputations, tokens, alliances).

**After Long Rests:** Restore all characters to max HP via Edit. Reset per-rest abilities.

**Session-End Checklist (MANDATORY — when player says they're stopping/saving):**
Before providing the save-point summary, you MUST: (1) Award any pending XP from encounters/milestones since the last award. (2) Write a chapter summary if a story arc concluded. (3) Read each character/NPC JSON file and verify level, XP, HP, equipment, and gold match narrative state — fix discrepancies via Edit. (4) Then provide the save-point summary.

**Item Tracking Rules:**
- Ammunition MUST be deducted when used (e.g. "Arrows (20)" → "Arrows (18)")
- Consumables MUST be removed when used
- Two-sided transactions: update BOTH giver and receiver files
- Track quantities: "Jar of pickles (12)", "Rations (5)", "Arrows (18)"
- Show gold math: "47 gp ÷ 6 = 7 gp each, 5 gp to party fund"

## Chapter Summaries (MANDATORY — Write These Proactively)
At the end of each major story chapter (completing a town questline, finishing a dungeon, resolving a plot thread), write a chapter summary using this EXACT header format. Do NOT wait for the player to ask. Write one proactively whenever a chapter ends. If 20+ DM messages have passed without a summary, check if one is overdue. Without summaries, campaigns WILL get confused.

## 📜 Chapter Summary: [Title]
**Days [X-Y]** | **Location:** [Location]
**Events:** [3-6 sentence narrative summary]
**Key Decisions:** [Player choices and consequences]
**NPCs Met/Changed:** [New/changed NPCs]
**Rewards:** [Items, gold, XP, special tokens]
**XP Earned:** [Total XP this chapter, current progress]
**Active Plot Threads:** [Unresolved hooks, mysteries]
**Party Status:** [HP, level, notable inventory, party composition]

This lets the DM efficiently reconstruct context when resuming long campaigns.

## Session Reminders
Periodically remind the player to save their session at natural break points.

## World State Tracking (MANDATORY)
You have an **UpdateWorldState** tool that persists a structured snapshot of the current narrative state. This snapshot survives server restarts and helps you maintain continuity when resuming sessions. **Call UpdateWorldState at these triggers:**
1. After every combat encounter (as part of the post-encounter checklist)
2. When the party changes location
3. When a quest is started, progressed, or completed
4. When writing a chapter summary
5. When the player saves or ends a session
6. After any significant NPC relationship change

Pass only the fields that changed — they merge with the existing state. Keep \`recentEvents\` to the last 3-5 significant events. Keep \`narrativeNotes\` brief (1-2 sentences about what's likely next).`;

  // Inject current world state if available (critical for session resume context)
  if (worldState && typeof worldState === 'object' && Object.keys(worldState).length > 0) {
    prompt += `

## Current World State (from last update: ${worldState.updatedAt || 'unknown'})`;
    if (worldState.location) prompt += `\n**Location:** ${worldState.location}`;
    if (worldState.inGameDay) prompt += `\n**In-Game Day:** ${worldState.inGameDay}`;
    if (worldState.inGameTime) prompt += `\n**Time:** ${worldState.inGameTime}`;
    if (worldState.recentEvents && worldState.recentEvents.length > 0) {
      prompt += `\n**Recent Events:**\n${worldState.recentEvents.map(e => `- ${e}`).join('\n')}`;
    }
    if (worldState.activeQuests && worldState.activeQuests.length > 0) {
      prompt += `\n**Active Quests:**\n${worldState.activeQuests.map(q => `- ${q.name}: ${q.status}`).join('\n')}`;
    }
    if (worldState.keyRelationships && worldState.keyRelationships.length > 0) {
      prompt += `\n**Key Relationships:**\n${worldState.keyRelationships.map(r => `- ${r}`).join('\n')}`;
    }
    if (worldState.pendingEffects && worldState.pendingEffects.length > 0) {
      prompt += `\n**Pending Effects:**\n${worldState.pendingEffects.map(e => `- ${e}`).join('\n')}`;
    }
    if (worldState.narrativeNotes) prompt += `\n**DM Notes:** ${worldState.narrativeNotes}`;
  }

  // Build a map of NPC IDs replaced by companion players
  const companionsByNpcId = {};
  if (Array.isArray(companionPlayers)) {
    for (const cp of companionPlayers) {
      if (cp.companionNpcId) companionsByNpcId[cp.companionNpcId] = cp;
    }
  }

  if (npcs.length > 0) {
    prompt += `

## NPC Companions (You control these)`;
    for (const npc of npcs) {
      const cp = companionsByNpcId[npc.id];
      if (cp && cp.companionCharacterName) {
        // This NPC slot is controlled by a companion player with their own character
        prompt += `
### ~~${npc.name}~~ → REPLACED by **${cp.companionCharacterName}** (controlled by companion player ${cp.playerName || cp.playerEmail})
${npc.name} is NOT in the party. ${cp.companionCharacterName} has taken their slot.
${cp.companionCharacterName}'s character file: ${charPathPrefix}/${String(cp.companionCharacterName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.json (use Read to check stats)
Character ID for AwardXP: look up in the character file`;
      } else if (cp) {
        // Companion player controlling the NPC directly (no character swap)
        prompt += `
### ${npc.name} — Level ${npc.level} ${npc.race} ${npc.class} ⚡ CONTROLLED BY COMPANION PLAYER ${cp.playerName || cp.playerEmail}
HP: ${npc.hitPoints.current}/${npc.hitPoints.max} | AC: ${npc.armorClass}
**This NPC is controlled by a human companion player, not by you.** Their actions come via the Companion Actions block.
File: ${npcPathPrefix}/${npc._filename || (npc.id + '.json')}
Character ID for AwardXP: ${npc.id}`;
      } else {
        prompt += `
### ${npc.name} — Level ${npc.level} ${npc.race} ${npc.class}
HP: ${npc.hitPoints.current}/${npc.hitPoints.max} | AC: ${npc.armorClass}`;
        if (npc.dmNotes) {
          prompt += `
Roleplaying: ${npc.dmNotes.roleplaying || ''}
Voice: ${npc.dmNotes.voice || ''}
Motivation: ${npc.dmNotes.motivation || ''}
Secret: ${npc.dmNotes.secrets || ''}
Attitude: ${npc.dmNotes.attitude || ''}`;
        }
        prompt += `
File: ${npcPathPrefix}/${npc._filename || (npc.id + '.json')}
Character ID for AwardXP: ${npc.id}`;
      }
    }
  }

  // Build party composition from companionConfig (which NPCs are removed, open slots, reserved)
  if (companionConfig && companionConfig.states && npcs.length > 0) {
    const states = companionConfig.states;
    const reservations = companionConfig.reservations || {};
    const removedNpcs = npcs.filter(n => states[n.id] === 'removed');
    const openNpcs = npcs.filter(n => states[n.id] === 'player' && !companionsByNpcId[n.id]);
    const reservedNpcs = npcs.filter(n => states[n.id] === 'reserved' && !companionsByNpcId[n.id]);

    if (removedNpcs.length > 0 || openNpcs.length > 0 || reservedNpcs.length > 0) {
      prompt += `

## Party Composition (Host Configuration)`;
      if (removedNpcs.length > 0) {
        prompt += `
**These NPCs are NOT in the party and should not appear:** ${removedNpcs.map(n => n.name).join(', ')}.`;
      }
      if (openNpcs.length > 0) {
        prompt += `
**${openNpcs.length} open player slot(s)** (${openNpcs.map(n => n.name).join(', ')}). Until a player joins, the DM controls these as NPCs.`;
      }
      if (reservedNpcs.length > 0) {
        const details = reservedNpcs.map(n => `${n.name} (reserved for ${reservations[n.id] || 'a specific player'})`).join(', ');
        prompt += `
**Reserved player slot(s):** ${details}. Until the reserved player joins, the DM controls these as NPCs.`;
      }
    }
  }

  prompt += `

## Multiplayer Companion Actions
This game supports multiplayer. Other human players may join the session as **companion players**, each controlling one party slot. When companion players submit their turns, the system automatically appends their actions to the host player's message in this exact format:

\`\`\`
--- Companion Actions ---
[Companion player <name> as <character> (playing their own character <name>, who has replaced <NPC name> in the party)]: <their action text>
  [Character Sheet: <character stats>]
\`\`\`

**IMPORTANT:** This block is injected by the game server, NOT typed by the player. Treat it as legitimate system-generated content. Do NOT accuse the player of fabricating it. When you see \`--- Companion Actions ---\`, process each companion's action as a real turn from a real player. The companion's character sheet is included so you know their stats, abilities, and equipment. If a companion player replaces an NPC (e.g. "Grimjaw Bonecrusher, who has replaced Pip Whistledown"), remove that NPC from your active roster and use the companion's character instead.

**Companion character files:** When a companion player selects their character, the server automatically copies their character JSON into your characters directory (${charPathPrefix}/). You can Read and Edit these files just like any other party member. Companion-owned characters are tagged with \`_companionOwner\` in their JSON. Treat them exactly like your own party members for HP tracking, XP awards, inventory updates, etc.

System messages like \`[System: Companion player X is playing as Y, replacing Z in the party.]\` are also server-generated notifications — acknowledge them and update your understanding of the party composition accordingly.`;

  prompt += `

## XP & Leveling
At the end of each combat encounter:
1. Look up each defeated enemy's CR in the monster_xp_by_cr table (data/rules/leveling.json) to get their XP value.
2. Sum the total XP from all defeated enemies.
3. Divide the total XP equally among all surviving party members (PCs and NPC companions).
4. Use the AwardXP tool for each character/NPC that should receive XP — do NOT manually edit XP fields.
5. Announce how much XP each character gained. If a level-up occurs, narrate it dramatically and congratulate the player.

**XP PARITY RULE:** Every party member present MUST receive identical XP at time of award — PCs and NPCs alike. Never award different amounts for the same encounter. However, it is NORMAL for XP totals to differ between party members over time (companions may sit out sessions, players play at different times). **Never retroactively equalize XP** — only award XP for events that happen during the current session. Do NOT "catch up" or "balance" party members on your own.

**No session-start equalization:** When a new session begins, accept the JSON files as-is. Do NOT attempt to equalize XP, equipment, gold, or any other stats. Party members may have different XP totals, different gear, and different levels — that is normal.

For non-combat milestones (quest completion, major story beats), award scenario-defined XP from the scenario's rewards section using the same AwardXP tool. XP parity applies to milestones too.`;

  prompt += `

## Combat, Resource & Session Tools
You have 5 additional tools to help manage gameplay:

- **TrackCombat** — Use this at the START of every combat encounter. Call with action "start" and a list of all combatants (party + enemies) with their names, initiative bonuses, HP, max HP, AC, and isEnemy flag. Then use "next" to advance turns, "damage"/"heal" to track HP changes, "condition" to apply/remove conditions, "status" to review the battlefield, and "end" when combat concludes. This replaces manual initiative and HP tracking.

- **TrackResources** — Use this to deduct ammo, rations, torches, and spell slots. Call "use" when a character fires arrows, eats rations, or consumes any quantified item. Call "cast" when a caster uses a spell slot. Call "rest" (with "short" or "long") to process rests — long rests restore HP to max and reset all spell slots. Call "check" to view a character's current resource status.

- **TrackCalendar** — Use this to track in-game time. Call "advance" when the party travels (e.g. 2 days, 4 hours). Call "event" to schedule future events (e.g. "Full moon in 3 days"). Call "check" to see current day/time. Call "weather" to generate weather for the current day.

- **LookupMonster** — Use this instead of reading monsters.json directly. Search by name (e.g. "Hill Giant"), CR (e.g. "5"), or type (e.g. "giant"). Returns full stat blocks or filtered lists.

- **UpdateWorldState** — Persist a structured world state snapshot (location, quests, relationships, recent events) to the session file. This survives server restarts and is injected into the system prompt automatically. Call after combat, location changes, quest progress, chapter summaries, and session saves. Pass only fields that changed — they merge with existing state.`;

  prompt += `

## Response Format
- Respond as narrative prose. Describe scenes vividly.
- Use "read aloud" style for important scene descriptions.
- When NPCs speak, use their established voice and mannerisms.
- When dice rolls are needed, ${settings.realisticDice !== false ? 'use the RollDice tool and show the results (individual rolls + modifiers + total).' : 'roll them and show results.'}
- Keep the story moving forward and respect player choices.
- If the player asks an out-of-character question, answer helpfully then return to the narrative.
- **Player turn pacing:** Follow the Response Scope & Turn Pacing rules above. When in doubt, stop early and ask the player what they do.
- **Tone:** Be a fair yet helpful and kind DM. Use lots of emoji icons throughout your narration, including skulls and other thematic icons.
- **Virtues over guard-rails.** Respect the player's choices even when they lead to danger. The game is more fun when consequences are real.`;

  return prompt;
}

function rollDice(notation) {
  const match = notation.trim().match(/^(\d+)d(\d+)([+-]\d+)?$/i);
  if (!match) {
    throw new Error(`Invalid dice notation: "${notation}". Use format NdX, NdX+M, or NdX-M (e.g. 1d20, 2d6+3, 1d20-1).`);
  }

  const count = parseInt(match[1], 10);
  const sides = parseInt(match[2], 10);
  const modifier = match[3] ? parseInt(match[3], 10) : 0;

  if (count < 1 || count > 100) {
    throw new Error(`Dice count must be between 1 and 100, got ${count}.`);
  }
  const validSides = [2, 3, 4, 6, 8, 10, 12, 20, 100];
  if (!validSides.includes(sides)) {
    throw new Error(`Invalid die size: d${sides}. Valid sizes: ${validSides.map(s => 'd' + s).join(', ')}.`);
  }

  const rolls = [];
  for (let i = 0; i < count; i++) {
    rolls.push(crypto.randomInt(1, sides + 1));
  }

  const rollSum = rolls.reduce((a, b) => a + b, 0);
  const total = rollSum + modifier;

  return { notation: notation.trim(), count, sides, modifier, rolls, total };
}

function createMcpToolServer(dataDir, playerEmail, diceResults, campaignId, sessionDbId) {
  return createSdkMcpServer({
    name: 'dnd-tools',
    version: '1.0.4',
    tools: [
      tool(
        'AwardXP',
        'Award experience points to a character. Handles XP addition, level-up detection, and character file updates automatically. Use this after combat encounters or milestone rewards.',
        { characterId: z.string(), xp: z.number() },
        async (args) => {
          try {
            const result = awardXp(dataDir, args.characterId, args.xp, playerEmail, campaignId);
            return {
              content: [{ type: 'text', text: JSON.stringify(result) }],
            };
          } catch (err) {
            return {
              content: [{ type: 'text', text: `Error: ${err.message}` }],
              isError: true,
            };
          }
        }
      ),
      tool(
        'RollDice',
        'Roll dice using standard D&D notation with cryptographic randomness. Accepts notation like "1d20", "2d6+3", "4d6", "1d20+5", "2d8-1". Returns individual rolls, modifier, and total. ALWAYS use this tool for dice rolls — never generate random numbers yourself. ALWAYS provide a short label (1-3 words) describing what the roll is for.',
        {
          notation: z.string().describe('Dice notation in NdX, NdX+M, or NdX-M format (e.g. "1d20", "2d6+3", "1d20-1")'),
          label: z.string().optional().describe('Short label (1-3 words) for the roll, e.g. "Pip initiative", "Rat 2 attack", "Perception check"'),
        },
        async (args) => {
          try {
            const result = rollDice(args.notation);
            if (args.label) result.label = args.label;
            if (diceResults) diceResults.push(result);
            return {
              content: [{ type: 'text', text: JSON.stringify(result) }],
            };
          } catch (err) {
            return {
              content: [{ type: 'text', text: `Error: ${err.message}` }],
              isError: true,
            };
          }
        }
      ),
      tool(
        'TrackCombat',
        'Manage combat encounters: initiative, HP, conditions, and turn order. Actions: start (begin combat with combatants), next (advance turn), damage (apply damage), heal (restore HP), condition (add/remove conditions), status (get current state), end (finish combat).',
        {
          action: z.enum(['start', 'next', 'damage', 'heal', 'condition', 'status', 'end']).describe('The combat action to perform'),
          combatants: z.array(z.object({
            name: z.string(),
            id: z.string().optional(),
            initiativeBonus: z.number().optional(),
            hp: z.number().optional(),
            maxHp: z.number().optional(),
            ac: z.number().optional(),
            isEnemy: z.boolean().optional(),
          })).optional().describe('Array of combatants (required for "start" action)'),
          target: z.string().optional().describe('Target combatant name (for damage/heal/condition)'),
          amount: z.number().optional().describe('Damage or healing amount'),
          condition: z.string().optional().describe('Condition name (e.g. "poisoned", "stunned", "frightened")'),
          roundsLeft: z.number().optional().describe('Condition duration in rounds (null = indefinite)'),
          remove: z.boolean().optional().describe('Set true to remove a condition instead of adding'),
        },
        async (args) => {
          try {
            let result;
            switch (args.action) {
              case 'start': result = startCombat(playerEmail, campaignId, args.combatants || []); break;
              case 'next': result = nextTurn(playerEmail, campaignId); break;
              case 'damage': result = applyDamage(playerEmail, campaignId, args.target, args.amount); break;
              case 'heal': result = applyHealing(playerEmail, campaignId, args.target, args.amount); break;
              case 'condition': result = setCondition(playerEmail, campaignId, args.target, args.condition, args.roundsLeft, args.remove); break;
              case 'status': result = getCombatStatus(playerEmail, campaignId); break;
              case 'end': result = endCombat(playerEmail, campaignId); break;
              default: result = { error: 'Unknown action' };
            }
            return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: !!result.error };
          } catch (err) {
            return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
          }
        }
      ),
      tool(
        'TrackResources',
        'Track consumable resources (ammo, rations, torches) and spell slots. Actions: use (consume a resource from equipment), cast (use a spell slot), rest (process short/long rest — restores HP and spell slots), check (view current resource status).',
        {
          action: z.enum(['use', 'cast', 'rest', 'check']).describe('The resource action to perform'),
          characterId: z.string().describe('Character ID or name'),
          resource: z.string().optional().describe('Resource name to consume (e.g. "Arrows", "Rations", "Torches") — for "use" action'),
          quantity: z.number().optional().describe('How many to consume (default 1) — for "use" action'),
          spellLevel: z.number().optional().describe('Spell slot level to use (1-9) — for "cast" action'),
          restType: z.enum(['short', 'long']).optional().describe('Type of rest — for "rest" action'),
        },
        async (args) => {
          try {
            let result;
            switch (args.action) {
              case 'use': result = useResource(dataDir, playerEmail, campaignId, args.characterId, args.resource, args.quantity || 1); break;
              case 'cast': result = castSpell(playerEmail, campaignId, args.characterId, args.spellLevel); break;
              case 'rest': result = processRest(dataDir, playerEmail, campaignId, args.characterId, args.restType); break;
              case 'check': result = checkResources(dataDir, playerEmail, campaignId, args.characterId); break;
              default: result = { error: 'Unknown action' };
            }
            return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: !!result.error };
          } catch (err) {
            return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
          }
        }
      ),
      tool(
        'TrackCalendar',
        'Track in-game time, schedule events, and generate weather. Actions: advance (move time forward by days/hours), event (schedule a future event), check (get current date/time/events), weather (generate weather for current day).',
        {
          action: z.enum(['advance', 'event', 'check', 'weather']).describe('The calendar action to perform'),
          days: z.number().optional().describe('Days to advance (for "advance" action)'),
          hours: z.number().optional().describe('Hours to advance (for "advance" action)'),
          eventName: z.string().optional().describe('Event name (for "event" action)'),
          inDays: z.number().optional().describe('Days from now until event triggers (for "event" action)'),
        },
        async (args) => {
          try {
            let result;
            switch (args.action) {
              case 'advance': result = advanceTime(playerEmail, campaignId, args.days, args.hours); break;
              case 'event': result = scheduleEvent(playerEmail, campaignId, args.eventName, args.inDays); break;
              case 'check': result = checkCalendar(playerEmail, campaignId); break;
              case 'weather': result = generateWeather(playerEmail, campaignId); break;
              default: result = { error: 'Unknown action' };
            }
            return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: !!result.error };
          } catch (err) {
            return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
          }
        }
      ),
      tool(
        'LookupMonster',
        'Look up D&D 5e monster stat blocks from the SRD database (334 creatures). Search by exact name, challenge rating, or creature type.',
        {
          name: z.string().optional().describe('Monster name (e.g. "Hill Giant", "Aboleth") — case insensitive, partial match supported'),
          cr: z.string().optional().describe('Challenge rating (e.g. "5", "1/2", "1/4") — returns all monsters of that CR'),
          type: z.string().optional().describe('Creature type (e.g. "giant", "undead", "dragon") — returns all monsters of that type'),
        },
        async (args) => {
          try {
            const monstersPath = path.join(dataDir, 'rules', 'monsters.json');
            const data = JSON.parse(fs.readFileSync(monstersPath, 'utf-8'));
            const allMonsters = Object.values(data.monsters_by_cr).flat();

            if (args.name) {
              const searchName = args.name.toLowerCase();
              const exact = allMonsters.find(m => m.name.toLowerCase() === searchName);
              if (exact) return { content: [{ type: 'text', text: JSON.stringify(exact) }] };
              const partial = allMonsters.filter(m => m.name.toLowerCase().includes(searchName));
              if (partial.length === 0) return { content: [{ type: 'text', text: `No monster found matching "${args.name}".` }], isError: true };
              if (partial.length === 1) return { content: [{ type: 'text', text: JSON.stringify(partial[0]) }] };
              return { content: [{ type: 'text', text: `Multiple matches: ${partial.map(m => `${m.name} (CR ${m.cr})`).join(', ')}. Be more specific.` }] };
            }

            if (args.cr) {
              const monsters = data.monsters_by_cr[args.cr];
              if (!monsters || monsters.length === 0) return { content: [{ type: 'text', text: `No monsters found at CR ${args.cr}.` }], isError: true };
              return { content: [{ type: 'text', text: JSON.stringify(monsters.map(m => ({ name: m.name, type: m.type, hp: m.hp, ac: m.ac, xp: m.xp }))) }] };
            }

            if (args.type) {
              const searchType = args.type.toLowerCase();
              const matches = allMonsters.filter(m => m.type?.toLowerCase().includes(searchType));
              if (matches.length === 0) return { content: [{ type: 'text', text: `No monsters of type "${args.type}" found.` }], isError: true };
              return { content: [{ type: 'text', text: JSON.stringify(matches.map(m => ({ name: m.name, cr: m.cr, type: m.type, hp: m.hp, ac: m.ac, xp: m.xp }))) }] };
            }

            return { content: [{ type: 'text', text: 'Provide at least one of: name, cr, or type.' }], isError: true };
          } catch (err) {
            return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
          }
        }
      ),
      tool(
        'UpdateWorldState',
        'Update the persistent world state snapshot for this session. Call this after combat encounters, location changes, quest progress, and chapter summaries. The world state survives server restarts and helps the DM maintain continuity. Pass only the fields you want to update — they will be merged with the existing state.',
        {
          location: z.string().optional().describe('Current party location (e.g. "Brinewatch village square")'),
          inGameDay: z.number().optional().describe('Current in-game day number'),
          inGameTime: z.string().optional().describe('Time of day (e.g. "morning", "evening", "midnight")'),
          recentEvents: z.array(z.string()).optional().describe('Last 3-5 significant events (replaces previous list)'),
          activeQuests: z.array(z.object({
            name: z.string(),
            status: z.string(),
          })).optional().describe('Active quests with current status (replaces previous list)'),
          keyRelationships: z.array(z.string()).optional().describe('Key NPC relationships and attitudes (replaces previous list)'),
          pendingEffects: z.array(z.string()).optional().describe('Active spell effects, conditions, or timers'),
          narrativeNotes: z.string().optional().describe('Brief DM notes about what should happen next or current story state'),
        },
        async (args) => {
          try {
            if (!sessionDbId || !playerEmail) {
              return { content: [{ type: 'text', text: 'No active session to update world state.' }], isError: true };
            }
            const slug = emailToSlug(playerEmail);
            const cid = campaignId || 'demo';
            // Find the session file
            const sessionsDir = path.join(dataDir, 'players', slug, cid, 'sessions');
            const sessionFilePath = path.join(sessionsDir, `${sessionDbId}.json`);
            if (!fs.existsSync(sessionFilePath)) {
              return { content: [{ type: 'text', text: `Session file not found: ${sessionDbId}` }], isError: true };
            }
            const session = JSON.parse(fs.readFileSync(sessionFilePath, 'utf-8'));
            const existing = session.worldState || {};
            // Merge provided fields into existing worldState
            const updated = { ...existing, updatedAt: new Date().toISOString() };
            if (args.location !== undefined) updated.location = args.location;
            if (args.inGameDay !== undefined) updated.inGameDay = args.inGameDay;
            if (args.inGameTime !== undefined) updated.inGameTime = args.inGameTime;
            if (args.recentEvents !== undefined) updated.recentEvents = args.recentEvents;
            if (args.activeQuests !== undefined) updated.activeQuests = args.activeQuests;
            if (args.keyRelationships !== undefined) updated.keyRelationships = args.keyRelationships;
            if (args.pendingEffects !== undefined) updated.pendingEffects = args.pendingEffects;
            if (args.narrativeNotes !== undefined) updated.narrativeNotes = args.narrativeNotes;
            session.worldState = updated;
            session.updatedAt = new Date().toISOString();
            fs.writeFileSync(sessionFilePath, JSON.stringify(session, null, 2));
            return { content: [{ type: 'text', text: `World state updated: ${JSON.stringify(updated)}` }] };
          } catch (err) {
            return { content: [{ type: 'text', text: `Error updating world state: ${err.message}` }], isError: true };
          }
        }
      ),
    ],
  });
}

const CHAPTER_SUMMARY_PATTERN = /## 📜 Chapter Summary:/;
const MAX_RECENT_MESSAGES = 100;
const SUMMARY_NUDGE_THRESHOLD = 25;

/**
 * Format a single message with turn-structured labels.
 * Includes companion messages for full context.
 */
function formatMessageForRecap(m) {
  switch (m.type) {
    case 'player': return `[PLAYER] ${m.text}`;
    case 'dm': return `[DM] ${m.text}`;
    case 'companion': {
      const label = m.characterName || m.playerName || 'Companion';
      const player = m.playerName ? ` (${m.playerName})` : '';
      return `[COMPANION — ${label}${player}] ${m.text}`;
    }
    default: return `[${m.type?.toUpperCase() || 'SYSTEM'}] ${m.text}`;
  }
}

/**
 * Build a smart recap from message history.
 * Uses numbered turns with clear delimiters for better AI comprehension.
 * If chapter summaries exist, use them for older content and only include
 * full messages from the most recent chapter. This dramatically reduces
 * context size for long campaigns (e.g. 866K → ~50K).
 *
 * @param {Array} messageHistory - Full message history
 * @param {Object} [worldState] - Current world state snapshot (if available)
 */
function buildSmartRecap(messageHistory, worldState) {
  const messages = messageHistory.filter(m => m.type === 'player' || m.type === 'dm' || m.type === 'companion');
  const parts = [];

  // Inject world state at the top if available
  if (worldState && typeof worldState === 'object' && Object.keys(worldState).length > 0) {
    const wsLines = ['=== WORLD STATE SNAPSHOT ==='];
    if (worldState.location) wsLines.push(`Location: ${worldState.location}`);
    if (worldState.inGameDay) wsLines.push(`Day: ${worldState.inGameDay}`);
    if (worldState.inGameTime) wsLines.push(`Time: ${worldState.inGameTime}`);
    if (worldState.recentEvents?.length > 0) wsLines.push(`Recent Events: ${worldState.recentEvents.join('; ')}`);
    if (worldState.activeQuests?.length > 0) wsLines.push(`Active Quests: ${worldState.activeQuests.map(q => `${q.name} (${q.status})`).join('; ')}`);
    if (worldState.keyRelationships?.length > 0) wsLines.push(`Key Relationships: ${worldState.keyRelationships.join('; ')}`);
    if (worldState.pendingEffects?.length > 0) wsLines.push(`Pending Effects: ${worldState.pendingEffects.join('; ')}`);
    if (worldState.narrativeNotes) wsLines.push(`DM Notes: ${worldState.narrativeNotes}`);
    wsLines.push('=== END WORLD STATE ===');
    parts.push(wsLines.join('\n'));
  }

  // Find all chapter summary indices
  const summaryIndices = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].type === 'dm' && CHAPTER_SUMMARY_PATTERN.test(messages[i].text)) {
      summaryIndices.push(i);
    }
  }

  // No chapter summaries found — fall back to truncated raw history with turn structure
  if (summaryIndices.length === 0) {
    if (messages.length > MAX_RECENT_MESSAGES) {
      const opening = messages.slice(0, 4).map(formatMessageForRecap).join('\n\n');
      const recentMsgs = messages.slice(-MAX_RECENT_MESSAGES);
      let turnNum = 1;
      const recentFormatted = [];
      for (let i = 0; i < recentMsgs.length; i++) {
        if (recentMsgs[i].type === 'player') {
          recentFormatted.push(`=== Turn ${turnNum} ===`);
          turnNum++;
        }
        recentFormatted.push(formatMessageForRecap(recentMsgs[i]));
      }
      parts.push(opening);
      parts.push('[... earlier messages omitted for brevity ...]');
      parts.push(recentFormatted.join('\n\n'));
    } else {
      let turnNum = 1;
      for (const m of messages) {
        if (m.type === 'player') {
          parts.push(`=== Turn ${turnNum} ===`);
          turnNum++;
        }
        parts.push(formatMessageForRecap(m));
      }
    }
    return parts.join('\n\n');
  }

  // Chapter summaries exist — use them for older content
  const lastSummaryIdx = summaryIndices[summaryIndices.length - 1];

  // Collect all chapter summaries (compact representation of older story)
  parts.push('=== CHAPTER SUMMARIES (previous story arcs) ===');
  for (const idx of summaryIndices) {
    parts.push(messages[idx].text);
  }
  parts.push('=== END OF CHAPTER SUMMARIES ===');

  // Include full messages from after the last chapter summary with turn structure
  const recentMessages = messages.slice(lastSummaryIdx + 1);
  if (recentMessages.length > 0) {
    parts.push('=== CURRENT CHAPTER (full detail) ===');
    let turnNum = 1;
    for (const m of recentMessages) {
      if (m.type === 'player') {
        parts.push(`--- Turn ${turnNum} ---`);
        turnNum++;
      }
      parts.push(formatMessageForRecap(m));
    }
  }

  return parts.join('\n\n');
}

class DmEngine {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.sessionId = null;
    this.activeQuery = null;
    this.playerEmail = null;
    this.campaignId = null;
    this._mcpToolServer = null;
    this._diceResults = [];
  }

  _getMcpToolServer(playerEmail, campaignId, sessionDbId) {
    // Recreate if playerEmail, campaignId, or sessionDbId changed
    if (!this._mcpToolServer || this.playerEmail !== playerEmail || this.campaignId !== campaignId || this._sessionDbId !== sessionDbId) {
      this.playerEmail = playerEmail;
      this.campaignId = campaignId;
      this._sessionDbId = sessionDbId;
      this._mcpToolServer = createMcpToolServer(this.dataDir, playerEmail, this._diceResults, campaignId, sessionDbId);
    }
    return this._mcpToolServer;
  }

  _buildOptions(characterId, scenarioId, onPermissionRequest, playerEmail, campaignId, companionPlayers, sessionDbId, companionConfig, dmPersonality, worldState) {
    const systemPrompt = buildSystemPrompt(this.dataDir, characterId, scenarioId, playerEmail, campaignId, companionPlayers, sessionDbId, companionConfig, dmPersonality, worldState);
    const mcpToolServer = this._getMcpToolServer(playerEmail, campaignId, sessionDbId);
    const dmSettings = loadDmSettings(this.dataDir, playerEmail);
    const opts = {
      systemPrompt,
      cwd: PROJECT_ROOT,
      allowedTools: ['Read', 'Glob', 'Grep', 'Edit', 'mcp__dnd-tools__AwardXP', 'mcp__dnd-tools__RollDice', 'mcp__dnd-tools__TrackCombat', 'mcp__dnd-tools__TrackResources', 'mcp__dnd-tools__TrackCalendar', 'mcp__dnd-tools__LookupMonster', 'mcp__dnd-tools__UpdateWorldState'],
      mcpServers: { 'dnd-tools': mcpToolServer },
      permissionMode: 'default',
      includePartialMessages: true,
      maxTurns: 20,
      effort: 'medium',
      async canUseTool(toolName, input, opts) {
        if (['Read', 'Glob', 'Grep'].includes(toolName)) {
          return { behavior: 'allow' };
        }
        if (toolName.startsWith('mcp__')) {
          return { behavior: 'allow' };
        }
        if (onPermissionRequest) {
          const allowed = await onPermissionRequest(toolName, input, opts.toolUseID);
          if (allowed) {
            return { behavior: 'allow' };
          }
          return { behavior: 'deny', message: 'Player denied this action.' };
        }
        return { behavior: 'deny', message: 'No permission handler available.' };
      },
    };
    if (dmSettings.model) {
      opts.model = dmSettings.model;
    }
    return opts;
  }

  async *_streamQuery(prompt, options) {
    this._diceResults.length = 0;
    this.activeQuery = query({ prompt, options });
    try {
      for await (const message of this.activeQuery) {
        // Drain any pending dice results before processing the next SDK message
        while (this._diceResults.length > 0) {
          const diceResult = this._diceResults.shift();
          yield { type: 'dice_roll', ...diceResult };
        }

        if (message.type === 'system' && message.subtype === 'init') {
          if (message.session_id) {
            this.sessionId = message.session_id;
          }
          yield { type: 'session_id', sessionId: this.sessionId };
          continue;
        }
        if (message.type === 'assistant' && message.partial) {
          const textBlocks = (message.message?.content || [])
            .filter(b => b.type === 'text')
            .map(b => b.text);
          if (textBlocks.length > 0) {
            yield { type: 'dm_partial', text: textBlocks.join('') };
          }
          continue;
        }
        if (message.type === 'assistant' && !message.partial) {
          const textBlocks = (message.message?.content || [])
            .filter(b => b.type === 'text')
            .map(b => b.text);
          if (textBlocks.length > 0) {
            yield { type: 'dm_response', text: textBlocks.join('\n\n') };
          }
          continue;
        }
        if (message.type === 'result') {
          if (message.subtype === 'error') {
            yield { type: 'error', error: message.error || 'Unknown error' };
          }
          if (message.session_id) {
            this.sessionId = message.session_id;
          }
          yield { type: 'dm_complete', sessionId: this.sessionId };
          continue;
        }
      }
      // Final drain after stream ends
      while (this._diceResults.length > 0) {
        const diceResult = this._diceResults.shift();
        yield { type: 'dice_roll', ...diceResult };
      }
    } finally {
      this.activeQuery = null;
    }
  }

  async *run(userMessage, { characterId, scenarioId, onPermissionRequest, messageHistory, playerEmail, campaignId, companionPlayers, sessionDbId, companionConfig, dmPersonality, worldState, dmMessagesSinceLastSummary }) {
    const options = this._buildOptions(characterId, scenarioId, onPermissionRequest, playerEmail, campaignId, companionPlayers, sessionDbId, companionConfig, dmPersonality, worldState);
    let isStaleResume = false;

    // Phase 2: Auto-summary nudge — append to user message if overdue
    let augmentedMessage = userMessage;
    if (typeof dmMessagesSinceLastSummary === 'number' && dmMessagesSinceLastSummary >= SUMMARY_NUDGE_THRESHOLD) {
      augmentedMessage += `\n\n[System note: It has been ${dmMessagesSinceLastSummary} DM responses since the last chapter summary. If a story arc has concluded or a significant milestone was reached, please write a chapter summary now using the standard format. Also call UpdateWorldState to persist the current narrative state.]`;
    }

    if (this.sessionId) {
      options.resume = this.sessionId;
      try {
        yield* this._streamQuery(augmentedMessage, options);
        return;
      } catch (err) {
        // Stale session — fall back to a fresh session with history context
        const historyLen = messageHistory?.length || 0;
        const chapterSummaries = (messageHistory || []).filter(m => m.type === 'dm' && CHAPTER_SUMMARY_PATTERN.test(m.text)).length;
        console.warn(`[DM:STALE_SESSION] campaign=${campaignId} player=${playerEmail} sessionDb=${sessionDbId} staleClaudeId=${this.sessionId} error="${err.message}" historyMessages=${historyLen} chapterSummaries=${chapterSummaries}`);
        this.sessionId = null;
        isStaleResume = true;
      }
    }

    // Fresh session — if we have message history, prepend it as context
    const freshOptions = this._buildOptions(characterId, scenarioId, onPermissionRequest, playerEmail, campaignId, companionPlayers, sessionDbId, companionConfig, dmPersonality, worldState);
    let prompt = augmentedMessage;
    let recap = null;

    if (messageHistory && messageHistory.length > 0) {
      recap = buildSmartRecap(messageHistory, worldState);
      const recapStrategy = (messageHistory || []).some(m => m.type === 'dm' && CHAPTER_SUMMARY_PATTERN.test(m.text)) ? 'chapter-summaries' : 'raw-messages';
      console.log(`[DM:RECAP] campaign=${campaignId} player=${playerEmail} strategy=${recapStrategy} recapLength=${recap.length} historyMessages=${messageHistory.length}`);
      // Build identity-enriched resume header
      const character = characterId ? loadCharacter(this.dataDir, characterId, playerEmail, campaignId, sessionDbId) : null;
      const scenario = scenarioId ? loadScenario(this.dataDir, scenarioId, campaignId) : null;
      const charLabel = character ? `${character.name} (Level ${character.level} ${character.race} ${character.class})` : 'Unknown character';
      const scenarioLabel = scenario ? scenario.title : 'Unknown scenario';

      // Phase 4: Warm-up turn on stale session resume
      // Send a hidden warm-up query so the AI reviews the recap before responding to the player
      if (isStaleResume && recap.length > 0) {
        const warmupPrompt = `[SESSION RESUMED — CAMPAIGN: ${charLabel} | SCENARIO: ${scenarioLabel}]\n[Continue this character's story. Do NOT confuse with any other campaign.]\n\n${recap}\n\n[END OF PREVIOUS SESSION]\n\n[System: This is a warm-up turn after a server restart. Review the above session history and world state. Confirm your understanding of the current story state, party status, active quests, and location in 2-3 brief sentences. Then call UpdateWorldState to persist your understanding. Do NOT address the player directly — this message is internal.]`;
        console.log(`[DM:WARMUP] campaign=${campaignId} player=${playerEmail} recapLength=${recap.length}`);
        yield { type: 'dm_warmup', text: 'The DM is reviewing the story so far...' };
        // Run warm-up query to establish context
        for await (const event of this._streamQuery(warmupPrompt, freshOptions)) {
          if (event.type === 'dm_complete' && event.sessionId) {
            // Warm-up established the session — now resume with the player's actual message
            this.sessionId = event.sessionId;
          }
          // Suppress warm-up DM responses (they're internal)
          if (event.type === 'dice_roll') yield event; // pass through dice rolls if any
        }
        // Now send the actual player message as a resumed turn
        if (this.sessionId) {
          const resumeOptions = this._buildOptions(characterId, scenarioId, onPermissionRequest, playerEmail, campaignId, companionPlayers, sessionDbId, companionConfig, dmPersonality, worldState);
          resumeOptions.resume = this.sessionId;
          yield* this._streamQuery(augmentedMessage, resumeOptions);
          return;
        }
        // If warm-up didn't produce a session ID, fall through to the non-warm-up path
        console.warn(`[DM:WARMUP_FAILED] No session ID from warm-up, falling through to direct recap`);
      }

      prompt = `[SESSION RESUMED — CAMPAIGN: ${charLabel} | SCENARIO: ${scenarioLabel}]\n[Continue this character's story. Do NOT confuse with any other campaign.]\n\n${recap}\n\n[END OF PREVIOUS SESSION — The player now says:]\n\n${prompt}`;
    }

    yield* this._streamQuery(prompt, freshOptions);
  }

  abort() {
    if (this.activeQuery) {
      this.activeQuery.close();
      this.activeQuery = null;
    }
  }
}

module.exports = { DmEngine, loadDmSettings, _testing: { loadCharacter, loadNpcs, buildSystemPrompt, loadScenario } };
