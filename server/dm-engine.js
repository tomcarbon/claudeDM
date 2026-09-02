const { query, createSdkMcpServer, tool } = require('@anthropic-ai/claude-agent-sdk');
const { z } = require('zod/v4');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { awardXp, awardPartyXp } = require('./xp-utils');
const { startCombat, nextTurn, applyDamage, applyHealing, setCondition, getCombatStatus, endCombat } = require('./combat-utils');
const { useResource, castSpell, processRest, checkResources } = require('./resource-utils');
const { advanceTime, scheduleEvent, checkCalendar, generateWeather } = require('./calendar-utils');
const { emailToSlug, getSessionNpcsDir, getSessionFilePath, updateSessionFile } = require('./player-data');
const { findCharacterOrNpcFile } = require('./entity-resolver');
const { writeJsonAtomic } = require('./json-recovery');
const { listReadyAssets, buildSceneImagerySection, flattenAndTruncate, PAYLOAD_TITLE_MAX, PAYLOAD_ALT_MAX, PAYLOAD_CAPTION_MAX } = require('./asset-manifest');

const PROJECT_ROOT = path.join(__dirname, '..');

// Semaphore to limit concurrent Claude API calls across all sessions.
// Prevents hitting API rate limits when multiple DM turns fire simultaneously.
const MAX_CONCURRENT_QUERIES = 3;
class QuerySemaphore {
  constructor(max) {
    this._max = max;
    this._active = 0;
    this._queue = [];
  }
  acquire() {
    if (this._active < this._max) {
      this._active++;
      return Promise.resolve();
    }
    return new Promise(resolve => this._queue.push(resolve));
  }
  release() {
    this._active--;
    if (this._queue.length > 0) {
      this._active++;
      this._queue.shift()();
    }
  }
}
const querySemaphore = new QuerySemaphore(MAX_CONCURRENT_QUERIES);

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
    const slug = emailToSlug(playerEmail);
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
  // Canonical session-first resolution (entity-resolver). _dir records where the
  // file was actually found so the prompt stamps a truthful path.
  const match = findCharacterOrNpcFile(dataDir, characterId, playerEmail, campaignId, sessionDbId);
  if (!match) return null;
  const data = match.data;
  data._filename = match.file;
  data._dir = match.dir;
  return data;
}

// Render an absolute data-dir path as the repo-relative form the DM prompt uses
// (e.g. "data/sessions/<id>/characters"). Relative to dataDir, not PROJECT_ROOT,
// so it stays correct when dataDir lives elsewhere (tests, alternate deploys).
function toPromptPath(dataDir, absDir) {
  const rel = path.relative(dataDir, absDir);
  return rel && !rel.startsWith('..') ? path.posix.join('data', rel.split(path.sep).join('/')) : absDir;
}

function loadScenario(dataDir, scenarioId, campaignId) {
  const campaignDir = path.join(dataDir, 'campaigns', campaignId || 'demo', 'scenarios');
  try {
    for (const file of fs.readdirSync(campaignDir).filter(f => f.endsWith('.json'))) {
      const data = loadJson(path.join(campaignDir, file));
      if (data && data.id === scenarioId) return data;
    }
  } catch { /* dir may not exist */ }
  return null;
}

function loadNpcs(dataDir, playerEmail, campaignId, sessionDbId) {
  // Search session dir first, then campaign defaults
  const dirsToTry = [];
  if (sessionDbId) {
    dirsToTry.push(getSessionNpcsDir(dataDir, sessionDbId));
  }
  dirsToTry.push(path.join(dataDir, 'defaults', campaignId || 'demo', 'npcs'));

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

// A session is multiplayer when a companion player is connected OR the host has
// configured open/reserved companion slots. Gates the ~500-word companion block out
// of solo prompts. Stable within a session: slot config changes go through
// companion_set_character, which already invalidates the Claude session (prompt rebuild).
function sessionIsMultiplayer(companionPlayers, companionConfig) {
  if (Array.isArray(companionPlayers) && companionPlayers.length > 0) return true;
  const states = companionConfig && companionConfig.states;
  if (states && Object.values(states).some(s => s === 'player' || s === 'reserved')) return true;
  return false;
}

// buildStableSystemPrompt returns content that is byte-stable for the duration of a session.
// The Claude Agent SDK applies prompt caching automatically on the system prompt; this content
// is therefore reused across turns with cache hits. Per-turn volatile state (character HP,
// world state, NPC stats, party composition) lives in buildGameStateContext and is prepended
// to the user prompt instead, so it can change freely without invalidating the cache.
function buildStableSystemPrompt(dataDir, playerEmail, campaignId, sessionDbId, dmPersonality, isMultiplayer) {
  const cid = campaignId || 'demo';
  const settings = dmPersonality || loadDmSettings(dataDir, playerEmail);

  const slug = playerEmail ? emailToSlug(playerEmail) : null;
  const charPathPrefix = sessionDbId
    ? `data/sessions/${sessionDbId}/characters`
    : `data/players/${slug || 'unknown-player'}/${cid}/characters`;

  const lengthPreset = RESPONSE_LENGTH_PRESETS[settings.responseLength] || RESPONSE_LENGTH_PRESETS.standard;
  const responseLengthGuide = lengthPreset.guide;

  // playerAgency is canonical; autonomy is DERIVED from it so the two can never contradict.
  // (Falls back to a stored numeric autonomy, then to 50, only if agency is missing/unknown.)
  const autonomy = AGENCY_TO_AUTONOMY[settings.playerAgency] ?? settings.playerAutonomy ?? 50;

  const humorGuide = settings.humor < 30 ? 'Maintain a serious tone.'
    : settings.humor > 70 ? 'Weave humor and wit throughout the narration.'
    : 'Include occasional moments of levity.';

  const dramaGuide = settings.drama < 30 ? 'Keep things light and low-stakes.'
    : settings.drama > 70 ? 'Heighten dramatic tension at every opportunity.'
    : 'Balance dramatic moments with quieter scenes.';

  const difficultyGuide = settings.difficulty < 30 ? 'Keep encounters forgiving — fewer or weaker foes, generous rulings, telegraphed danger.'
    : settings.difficulty > 70 ? 'Make encounters punishing — tougher and more numerous foes, strict rulings, little margin for error.'
    : 'Use balanced encounters — fair challenges with real but survivable risk.';

  const horrorGuide = settings.horror < 30 ? 'Keep content light — minimal gore or dread.'
    : settings.horror > 70 ? 'Lean into dread, darkness, and unsettling detail; let grim outcomes land.'
    : 'Allow moments of tension and unease without dwelling on the grotesque.';

  const puzzleGuide = settings.puzzleFocus < 30 ? 'Favor combat and action over puzzles.'
    : settings.puzzleFocus > 70 ? 'Emphasize puzzles, mysteries, and exploration over combat.'
    : 'Mix combat with the occasional puzzle or exploration challenge.';

  const toneMap = {
    'heroic': 'The overall tone is epic and heroic.',
    'gritty': 'The overall tone is bleak, dangerous, and grounded.',
    'whimsical': 'The overall tone is playful, magical, and light.',
    'balanced': 'Strike a balance between light and dark moments.',
    'noir': 'The overall tone is mysterious, shadowy, and tense.',
  };

  const styleMap = {
    'descriptive': 'Use descriptive, immersive narration.',
    'action': 'Use punchy, action-focused narration — momentum applies WITHIN a scene, but still stop at the pacing checkpoints below.',
    'dialogue': 'Lean heavily on dialogue and strong NPC voices.',
    'atmospheric': 'Prioritize mood, tension, and environmental detail.',
  };

  // Emoji usage is tone-aware: restrained for dark/somber tones, free for light ones.
  const emojiGuide = (settings.tone === 'gritty' || settings.tone === 'noir' || settings.narrationStyle === 'atmospheric')
    ? 'Use emoji very sparingly, if at all — this tone calls for restraint.'
    : (settings.tone === 'whimsical' || settings.tone === 'heroic')
    ? 'Use thematic emoji icons freely (⚔️ 💀 ✨ 🎲) to add flavor.'
    : 'Use occasional thematic emoji icons (⚔️ 💀 🎲) where they fit the moment.';

  // --- Pacing tier (derived from autonomy) — one shared rule list, three strictness levels ---
  const pacingTier = autonomy <= 25
    ? {
        heading: '## Response Scope & Turn Pacing',
        intro: 'These rules cap how much narrative a SINGLE response may advance; they bind like Dice Integrity.',
        location: '**Location limit:** Maximum 2 location transitions per response. Never enter a new dungeon, building, or hostile area without pausing for player input.',
        time: '**Time limit:** Maximum 2 time transitions per response; never skip more than 1 day without confirmation.',
        shortInput: '**Short-input rule:** A brief confirmation ("yep", "sure") lets you narrate that routine action\'s outcome and advance to the next interesting decision point — but never chain multiple encounters, discoveries, or plot beats from one short confirmation.',
        extra: '',
      }
    : autonomy <= 74
    ? {
        heading: '## Response Scope & Turn Pacing',
        intro: 'These rules cap how much narrative a SINGLE response may advance; they bind like Dice Integrity.',
        location: '**Location limit:** Maximum 1 location transition per response. Describe the arrival, then STOP — do not also explore, discover, and encounter.',
        time: '**Time limit:** Maximum 1 time transition per response ("that evening" is fine; do not then also narrate the next morning).',
        shortInput: '**Short-input rule:** A brief input ("yep", "I rest") confirms ONLY the specific action discussed. Narrate that one action, then ask what the player does next.',
        extra: '\n7. **No narrative chaining.** Each of these is a STOP point requiring player input: a new area, a new NPC, a significant discovery, any sign of danger.',
      }
    : {
        heading: '## Response Scope & Turn Pacing ⚠️',
        intro: `These rules are ABSOLUTE at this autonomy level (${autonomy}/100) — they override narrative momentum and bind like Dice Integrity.`,
        location: '**Location limit: ZERO unsolicited transitions.** Never move the party unless the player says to. Describe the scene, then STOP.',
        time: '**Time limit: minutes only.** Advance time only when the player requests it, and narrate only that action\'s completion.',
        shortInput: '**Short-input rule (CRITICAL):** Brief inputs ("yep", "ok") are LITERAL CONFIRMATIONS of the specific action discussed — never delegation to advance the plot or move locations. Process that one action, then STOP.',
        extra: '\n7. **No narrative chaining.** Even an "obvious" next scene is a separate response requiring player input.\n8. **When in doubt, STOP EARLY.** The player can say "keep going" — they cannot un-read a spoiled reveal.',
      };

  let prompt = `You are an AI Dungeon Master for D&D 5th Edition. You narrate the story, control NPC companions, adjudicate rules, and create an immersive tabletop RPG experience.

## Your Personality & Style
${responseLengthGuide}
**The word target applies to narrative prose only** — bookkeeping (XP/loot announcements, chapter summaries, file updates) is exempt from it and from the pacing limits below; keep announcements terse.
${humorGuide}
${dramaGuide}
${toneMap[settings.tone] || toneMap.balanced}
${styleMap[settings.narrationStyle] || styleMap.descriptive}
Difficulty preference: ${settings.difficulty}/100 — ${difficultyGuide} (Difficulty governs pre-combat encounter tuning and rulings only; once initiative is rolled, the mechanics play out honestly regardless — see Stat Integrity.)
Horror/Darkness level: ${settings.horror}/100 — ${horrorGuide}
Puzzle vs Combat focus: ${settings.puzzleFocus}/100 — ${puzzleGuide}
Player agency: ${settings.playerAgency} — autonomy ${autonomy}/100 (0 = DM drives the story; 100 = player drives, DM reacts and adapts).`;

  prompt += `

${pacingTier.heading}
${pacingTier.intro}

1. ${pacingTier.location}
2. ${pacingTier.time}
3. **Combat checkpoint:** ALWAYS stop and hand control to the player before the first round of any combat. Never narrate the player character's combat actions without input.
4. **Danger checkpoint:** Any trap, ambush, hostile creature, or new threat — describe it and STOP. The player decides how to react.
5. ${pacingTier.shortInput}
6. **One response = one decision point.** Every response must end at a moment where the player has a meaningful choice. "What do you do?" is a structural requirement, not flavor.${pacingTier.extra}

**Bookkeeping is not a scene.** Awarding XP, updating files, or writing a chapter summary does not count as advancing the narrative or as a "decision point." Finish required bookkeeping, then end at the player's next choice.`;

  // --- Server context + session identity ---
  prompt += `

## Server Context — This Session
You are a shared DM service; each invocation serves exactly ONE session — this one. Other players' games are fully isolated, so run this session as if it were the only one.
Session ID: \`${sessionDbId || '(pending — not yet persisted)'}\`
Session directory: \`data/sessions/${sessionDbId || '<session-id>'}/\` — contains \`session.json\` (full session state), \`characters/\`, and \`npcs/\`.
**The session directory is the source of truth during play.** When you Read or Edit character/NPC data, ALWAYS use this session's directory — never \`data/players/...\` or \`data/defaults/...\` (libraries and templates, not live game state).`;

  prompt += `

## Rules Reference
Consult the D&D 5e rules database in data/rules/ via the Read tool: races.json, classes.json, abilities-and-skills.json, equipment.json, data/rules/spells.json, data/rules/combat.json, data/rules/leveling.json, backgrounds.json, and monsters.json (full SRD bestiary — but prefer the LookupMonster tool). Always follow D&D 5e mechanics accurately.

## Dice
${settings.realisticDice !== false
    ? `**ALWAYS use the RollDice tool for ALL dice rolls** — never generate random numbers yourself, and never claim a roll happened without the tool. Standard notation (NdX+M): "1d20", "2d6+3". Always provide a short label ("Pip initiative", "Perception check"). Ability checks: 1d20 + ability modifier + proficiency (if proficient). Advantage/disadvantage: "2d20", take higher/lower.`
    : `Roll dice using standard notation (NdX). Ability checks: d20 + ability modifier + proficiency bonus (if proficient).`}
Difficulty Classes: Easy 10, Medium 15, Hard 20, Very Hard 25, Nearly Impossible 30.

**Dice Integrity** — you may call for rolls beyond strict RAW, but once you call for one, these rules are absolute:
- **Real DC before the roll** — never adjust a DC after seeing the result.
- **No vibe rolls** — every roll needs a meaningful failure state; if failure changes nothing, just narrate success.
- **Honor the number.** A 2 is a 2 — no narrative safety nets. Nat 1 on attack = always a miss; nat 20 = always a hit + critical.
- **Show your work:** die rolled, natural result, modifiers, total, DC, outcome.
- **The dice are the dice.** If a roll derails your planned narrative, adapt the narrative — never the roll.

## Stat Integrity & Live File Updates
The JSON files in this session's directory are the source of truth for HP, XP, spell slots, gold, items, and status. Absolute rules:
- **Never fabricate stats.** 0 HP means down — no "finding inner strength," no unbacked resurrections, no retroactive stat inflation. TPKs are valid: narrate with gravity, end the session.
- **Verify before narrating** — confirm from the file that a combatant has the HP/slots/resources for an action.
- **Difficulty is not a safety net** — it tunes encounters *before* combat; once initiative is rolled, mechanics play out honestly.
- **Edit in the same response as the change — never deferred.** The player's UI reads these files live. This includes player-initiated transfers ("I give Pip 5 gp"), even trivial ones: edit **both sides**, giver and each receiver.
- **Death:** on death (HP ≤ 0, or 3 failed death saves), Edit "status": "dead". Death saves: 3 successes = stabilize, 3 failures = death; nat 20 = regain 1 HP, nat 1 = 2 failures.
- **Never reset characters to defaults** without explicit player permission; if data seems wrong, ask first.
- A post-turn audit catches narrated stat changes without matching edits and forces a slow reconciliation pass — edit as you narrate.

## Post-Encounter Checklist (MANDATORY)
Complete before continuing the narrative — the player should never have to ask "do we get XP?" or "any loot?"
**After combat:** (1) Award XP per **XP & Leveling** below. (2) Describe loot — CR 0-1: a few gp; CR 2-4: 20-120 gp; CR 5+: 40-240 gp + possible magic; humanoids carry weapons/armor/coin. Player decides distribution, then Edit recipient files. (3) Edit inventory: items gained/consumed, ammo deducted, gold for ALL parties. (4) Verify files match the narrative; fix drift. (5) Announce XP each, items, level-ups, progress ("450/900 XP"). Then UpdateWorldState.
**Milestones:** XP via AwardPartyXP; update inventory. **Long rests:** restore max HP + per-rest resources via Edit or TrackResources "rest".
**At session end:** award pending XP → chapter summary if an arc closed → reconcile every character/NPC file → save-point summary. Also reconcile after level-ups and periodically in long sessions.
**Item counts:** track quantities ("Arrows (18)", "Jar of pickles (12)"); deduct on use; show gold-split math.

## XP & Leveling
After each combat: look up each defeated enemy's XP by CR (data/rules/leveling.json, monster_xp_by_cr), sum, then call **AwardPartyXP** ONCE with \`totalXp\`. The server splits it equally across all present members (surviving PCs + DM-controlled NPC companions), writes files, and handles level-ups — do NOT divide by hand or call per character. For milestones, call AwardPartyXP with \`xpEach\`. Announce the per-member result; narrate level-ups dramatically.
**AwardXP** (single target) is ONLY for rare individual corrections — never for normal awards. Never manually Edit XP fields.
**No equalization:** identical XP per award is guaranteed, but lifetime totals legitimately drift (companions sit out sessions). Never retroactively equalize XP, gold, or gear — at session start, accept the files as-is.

## World State & Chapter Summaries
**UpdateWorldState** persists a structured snapshot (location, day/time, quests, keyRelationships, keyFacts, pendingEffects, narrativeNotes) that survives restarts and is re-injected each turn. Call it after combat, on location/quest/relationship changes, at chapter summaries, at save/end, and whenever the party learns significant intelligence — record named NPCs/factions/places/bounties as \`keyFacts\` with exact names and numbers. keyFacts are durable: pass the full list back; never drop or rename an entry unless the story established it changed. (The server auto-appends a per-turn digest to recentEvents.)
**Anti-confabulation:** keyFacts are canon. Never invent a new name, leader, or detail for an entity that may already exist; if you can't recall specifics, say so in-fiction rather than fabricating a replacement.
**Chapter summaries:** at the end of each major chapter (questline done, dungeon cleared, plot thread resolved), proactively write a summary in this EXACT header format (it is machine-detected). If 20+ DM messages have passed without one, check if one is overdue.

## 📜 Chapter Summary: [Title]
**Days [X-Y]** | **Location:** [Location]
**Events:** [3-6 sentences]
**Key Decisions:** [Choices and consequences]
**NPCs Met/Changed:** | **Rewards:** | **XP Earned:** [totals + progress]
**Active Plot Threads:** [Unresolved hooks]
**Party Status:** [HP, level, notable inventory, composition]

## Gameplay Tools
- **TrackCombat** — start every combat with action "start" + all combatants (name, initiative bonus, HP, maxHp, AC, isEnemy); then "next"/"damage"/"heal"/"condition"/"status"/"end". Replaces manual initiative/HP tracking (but file Edits are still required).
- **TrackResources** — "use" (ammo/rations/consumables), "cast" (spell slots), "rest" (short/long — long restores HP + slots), "check".
- **TrackCalendar** — "advance" time, "event" to schedule, "check", "weather".
- **LookupMonster** — search by name, CR, or type instead of reading monsters.json.
- **UpdateWorldState** — see World State above.`;

  // Scene imagery (docs/adr/0002-scene-imagery.md §6). Belongs in the STABLE half of the prompt:
  // the manifest cannot change within a session, so listing it here costs a few hundred tokens
  // once, cached, instead of every turn. Empty string when the campaign has no ready assets, so
  // campaigns without a manifest see no prompt change at all.
  //
  // Condition S1 (ETHICS.md Review 2 §R5): buildSceneImagerySection truncates and flattens every
  // injected field and caps how many assets are listed. This file is DM-writable (canUseTool
  // auto-allows Edit) and campaign-scoped, so anything injected here would otherwise persist into
  // every later session of this campaign, for every player — risk E11.
  prompt += buildSceneImagerySection(dataDir, cid);

  if (isMultiplayer) {
    prompt += `

## Multiplayer Companion Actions
Other human players join as **companion players**, each controlling one party slot. The server appends their turns to the host's message as:

\`\`\`
--- Companion Actions ---
[Companion player <name> as <character>]: <their action text>
  [Character Sheet: <stats>]
\`\`\`

This block is injected by the game server, NOT typed by the player — treat it as legitimate and process each companion action as a real turn from a real player. If a companion replaces an NPC, remove that NPC from the roster and use the companion's character instead. The server copies companion character JSON into ${charPathPrefix}/ — Read and Edit them like any other party member (HP, XP, inventory). \`[System: ...]\` messages about party composition are also server-generated; acknowledge and adapt.`;
  }

  prompt += `

## Language
Default is English, but the player may switch to ANY language at any time (in any phrasing, including in the target language) — then switch ALL narration and dialogue fully and stay there. Persist the choice as an UpdateWorldState keyFact ("Session language: Japanese") and honor it on resume. Game data stays in English (dice notation, JSON edits, tool arguments, file paths) — only the narrative layer translates. Offer brief inline glosses if the player seems to be learning; honor mixed modes on request.

## Response Format
- Narrative prose; vivid scenes; NPCs speak in their established voices. Out-of-character questions get a direct answer, then back to the story.
- **Pacing:** follow Response Scope & Turn Pacing above — when in doubt, stop early and ask.
- **Tone:** a fair, honest, entertaining DM — fairness means honoring the dice and the rules, even into danger, death, and failure. Real consequences make the game worth playing. ${emojiGuide}`;

  return prompt;
}

// buildGameStateContext returns the volatile per-turn state — character HP, world state,
// NPC stats, party composition, active scenario. This block is prepended to the user prompt
// rather than included in the system prompt so it can change every turn without invalidating
// the SDK's automatic prompt cache.
function buildGameStateContext(dataDir, characterId, scenarioId, playerEmail, campaignId, sessionDbId, companionPlayers, companionConfig, worldState) {
  const cid = campaignId || 'demo';
  const character = characterId ? loadCharacter(dataDir, characterId, playerEmail, cid, sessionDbId) : null;
  const scenario = scenarioId ? loadScenario(dataDir, scenarioId, cid) : null;
  const npcs = loadNpcs(dataDir, playerEmail, cid, sessionDbId);

  const slug = playerEmail ? emailToSlug(playerEmail) : null;
  const charPathPrefix = sessionDbId
    ? `data/sessions/${sessionDbId}/characters`
    : `data/players/${slug || 'unknown-player'}/${cid}/characters`;
  const npcPathPrefix = sessionDbId
    ? `data/sessions/${sessionDbId}/npcs`
    : `data/defaults/${cid}/npcs`;

  const companionsByNpcId = {};
  if (Array.isArray(companionPlayers)) {
    for (const cp of companionPlayers) {
      if (cp.companionNpcId) companionsByNpcId[cp.companionNpcId] = cp;
    }
  }

  let body = '';

  if (character) {
    body += `

## Player Character
${character.name} — Level ${character.level} ${character.subrace ? (character.subrace.toLowerCase().includes(character.race.toLowerCase()) ? character.subrace : `${character.subrace} ${character.race}`) : character.race} ${character.class} (${character.background})
HP: ${character.hitPoints.current}/${character.hitPoints.max} | AC: ${character.armorClass} | Speed: ${character.speed}
Abilities: ${Object.entries(character.abilities).map(([k, v]) => `${k.substring(0, 3).toUpperCase()} ${v.score}(${v.modifier >= 0 ? '+' : ''}${v.modifier})`).join(', ')}
Character file: ${character._dir ? toPromptPath(dataDir, character._dir) : charPathPrefix}/${character._filename || (character.id + '.json')} (use Read to check current state, Edit to update)
Character ID for AwardXP: ${character.id}`;
  }

  if (scenario) {
    body += `

## Active Scenario: ${scenario.title}
${scenario.synopsis || ''}`;
    if (scenario.hook) {
      body += `
Hook: ${scenario.hook}`;
    }
    if (scenario.acts) {
      body += `
Acts: ${scenario.acts.map((a, i) => `Act ${i + 1}: ${a.title}`).join(', ')}`;
    }
    body += `
Scenario file: data/campaigns/${cid}/scenarios/ (Read for full details)`;
  }

  if (worldState && typeof worldState === 'object' && Object.keys(worldState).length > 0) {
    body += `

## Current World State (from last update: ${worldState.updatedAt || 'unknown'})`;
    if (worldState.location) body += `\n**Location:** ${worldState.location}`;
    if (worldState.inGameDay) body += `\n**In-Game Day:** ${worldState.inGameDay}`;
    if (worldState.inGameTime) body += `\n**Time:** ${worldState.inGameTime}`;
    if (worldState.recentEvents && worldState.recentEvents.length > 0) {
      body += `\n**Recent Events:**\n${worldState.recentEvents.map(e => `- ${e}`).join('\n')}`;
    }
    if (worldState.activeQuests && worldState.activeQuests.length > 0) {
      body += `\n**Active Quests:**\n${worldState.activeQuests.map(q => `- ${q.name}: ${q.status}`).join('\n')}`;
    }
    if (worldState.keyRelationships && worldState.keyRelationships.length > 0) {
      body += `\n**Key Relationships:**\n${worldState.keyRelationships.map(r => `- ${r}`).join('\n')}`;
    }
    if (worldState.keyFacts && worldState.keyFacts.length > 0) {
      body += `\n**Established Facts (canonical — never contradict or rename these):**\n${worldState.keyFacts.map(f => `- ${f}`).join('\n')}`;
    }
    if (worldState.pendingEffects && worldState.pendingEffects.length > 0) {
      body += `\n**Pending Effects:**\n${worldState.pendingEffects.map(e => `- ${e}`).join('\n')}`;
    }
    if (worldState.narrativeNotes) body += `\n**DM Notes:** ${worldState.narrativeNotes}`;
  }

  if (npcs.length > 0) {
    body += `

## NPC Companions (You control these)`;
    for (const npc of npcs) {
      const cp = companionsByNpcId[npc.id];
      if (cp && cp.companionCharacterName) {
        // Resolve the replacement character's ACTUAL file (by id when known,
        // else by name) instead of guessing a filename from a slugified name.
        const replacement = findCharacterOrNpcFile(
          dataDir, cp.companionCharacterId || cp.companionCharacterName, playerEmail, cid, sessionDbId
        );
        const replacementPath = replacement
          ? `${toPromptPath(dataDir, replacement.dir)}/${replacement.file}`
          : `${charPathPrefix}/(file not found — ask the player to re-select their character)`;
        body += `
### ~~${npc.name}~~ → REPLACED by **${cp.companionCharacterName}** (controlled by companion player ${cp.playerName || cp.playerEmail})
${npc.name} is NOT in the party. ${cp.companionCharacterName} has taken their slot.
${cp.companionCharacterName}'s character file: ${replacementPath} (use Read to check stats)
Character ID for AwardXP: ${replacement ? replacement.data.id : 'look up in the character file'}`;
      } else if (cp) {
        body += `
### ${npc.name} — Level ${npc.level} ${npc.race} ${npc.class} ⚡ CONTROLLED BY COMPANION PLAYER ${cp.playerName || cp.playerEmail}
HP: ${npc.hitPoints.current}/${npc.hitPoints.max} | AC: ${npc.armorClass}
**This NPC is controlled by a human companion player, not by you.** Their actions come via the Companion Actions block.
File: ${npcPathPrefix}/${npc._filename || (npc.id + '.json')}
Character ID for AwardXP: ${npc.id}`;
      } else {
        body += `
### ${npc.name} — Level ${npc.level} ${npc.race} ${npc.class}
HP: ${npc.hitPoints.current}/${npc.hitPoints.max} | AC: ${npc.armorClass}`;
        if (npc.dmNotes) {
          body += `
Roleplaying: ${npc.dmNotes.roleplaying || ''}
Voice: ${npc.dmNotes.voice || ''}
Motivation: ${npc.dmNotes.motivation || ''}
Secret: ${npc.dmNotes.secrets || ''}
Attitude: ${npc.dmNotes.attitude || ''}`;
        }
        body += `
File: ${npcPathPrefix}/${npc._filename || (npc.id + '.json')}
Character ID for AwardXP: ${npc.id}`;
      }
    }
  }

  if (companionConfig && companionConfig.states && npcs.length > 0) {
    const states = companionConfig.states;
    const reservations = companionConfig.reservations || {};
    const removedNpcs = npcs.filter(n => states[n.id] === 'removed');
    const openNpcs = npcs.filter(n => states[n.id] === 'player' && !companionsByNpcId[n.id]);
    const reservedNpcs = npcs.filter(n => states[n.id] === 'reserved' && !companionsByNpcId[n.id]);

    if (removedNpcs.length > 0 || openNpcs.length > 0 || reservedNpcs.length > 0) {
      body += `

## Party Composition (Host Configuration)`;
      if (removedNpcs.length > 0) {
        body += `
**These NPCs are NOT in the party and should not appear:** ${removedNpcs.map(n => n.name).join(', ')}.`;
      }
      if (openNpcs.length > 0) {
        body += `
**${openNpcs.length} open player slot(s)** (${openNpcs.map(n => n.name).join(', ')}). Until a player joins, the DM controls these as NPCs.`;
      }
      if (reservedNpcs.length > 0) {
        const details = reservedNpcs.map(n => `${n.name} (reserved for ${reservations[n.id] || 'a specific player'})`).join(', ');
        body += `
**Reserved player slot(s):** ${details}. Until the reserved player joins, the DM controls these as NPCs.`;
      }
    }
  }

  if (!body) return '';
  return `[GAME STATE — current as of turn start]${body}

[END GAME STATE]`;
}

// Backwards-compat wrapper. Production code (DmEngine._buildOptions / DmEngine.run) calls
// buildStableSystemPrompt and buildGameStateContext separately so the stable prefix can be
// cached. This combined form is kept for tests and any caller that wants the full prompt.
function buildSystemPrompt(dataDir, characterId, scenarioId, playerEmail, campaignId, companionPlayers, sessionDbId, companionConfig, dmPersonality, worldState) {
  const stable = buildStableSystemPrompt(dataDir, playerEmail, campaignId, sessionDbId, dmPersonality, sessionIsMultiplayer(companionPlayers, companionConfig));
  const gameState = buildGameStateContext(dataDir, characterId, scenarioId, playerEmail, campaignId, sessionDbId, companionPlayers, companionConfig, worldState);
  return gameState ? `${stable}\n\n${gameState}` : stable;
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

// Cap on how many images one turn may show. The tool description asks the model nicely; this is
// the mechanism behind the ask (ETHICS.md Review 2 §R3.1 — a recommendation, taken because it is
// one comparison). The counter is reset per turn in DmEngine._streamQuery.
const MAX_SCENE_IMAGES_PER_TURN = 3;

// sceneImages is a per-engine buffer { queue, shown }, closed over exactly like diceResults.
// campaignId is likewise closed over: ShowSceneImage has no campaign parameter, so the model has
// nothing with which to name a campaign other than the one its session is for.
function createMcpToolServer(dataDir, playerEmail, diceResults, campaignId, sessionDbId, characterId, sceneImages) {
  return createSdkMcpServer({
    name: 'dnd-tools',
    version: '1.0.4',
    tools: [
      tool(
        'AwardPartyXP',
        'Award experience to the WHOLE party at once after a combat encounter or milestone. The server divides the XP equally among all present party members (every surviving player character AND every DM-controlled NPC companion), writes each file, and handles level-ups. This is the preferred tool for encounter/milestone XP — call it ONCE; do NOT divide by hand or call it per character. Provide exactly one of: totalXp (the summed XP of all defeated enemies, to be split equally) OR xpEach (a flat amount every member receives, e.g. a milestone reward).',
        { totalXp: z.number().optional(), xpEach: z.number().optional(), reason: z.string().optional() },
        async (args) => {
          try {
            const result = awardPartyXp(
              dataDir,
              { totalXp: args.totalXp, xpEach: args.xpEach },
              { playerEmail, campaignId, sessionId: sessionDbId, characterId }
            );
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
        'AwardXP',
        'Award experience points to a SINGLE character or NPC. Use this only for rare individual corrections — for normal post-encounter and milestone XP, use AwardPartyXP so the whole party is kept in parity. Handles XP addition, level-up detection, and character file updates automatically.',
        { characterId: z.string(), xp: z.number() },
        async (args) => {
          try {
            const result = awardXp(dataDir, args.characterId, args.xp, playerEmail, campaignId, sessionDbId);
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
      // ShowSceneImage — the only tool added by ADR 0002. Registering a tool here changes the
      // application's effective permission policy, because canUseTool auto-allows every tool whose
      // name begins with `mcp__`; do not add a second one without an Ethics review first
      // (ETHICS.md Review 2 §R4(b), clause (iii)).
      tool(
        'ShowSceneImage',
        'Show the players a picture from this campaign\'s illustrated assets — a map, a location, an NPC '
        + 'portrait, or an item. The picture appears in the story transcript for every player at the table, '
        + 'at the point in the turn where you call this. Use the asset ids listed in the Scene Imagery '
        + 'section of your instructions, and follow the guidance there about when each one is appropriate. '
        + 'You may only show images that are listed there. Do not call this more than once or twice in a '
        + 'turn — a picture every turn stops being an event.',
        {
          assetId: z.string().describe('The id of an image from the Scene Imagery list in your instructions, exactly as written. This is an id, never a filename and never a path.'),
          caption: z.string().optional().describe('One short line in your narrative voice, shown under the picture. Optional.'),
        },
        async (args) => {
          try {
            // campaignId is closed over from this function's arguments — resolved from the session,
            // not supplied by the model. There is no campaign parameter to abuse.
            const cid = campaignId || 'demo';
            const ready = listReadyAssets(dataDir, cid);
            const entry = ready.find(a => a.id === args.assetId) || null;

            // Condition S2 (ETHICS.md Review 2 §R5): on an unknown, `specified` or malformed id,
            // nothing happens except this return value. Nothing is pushed, nothing is broadcast,
            // nothing is persisted, no player sees anything, and no path is ever derived — the
            // tool never touches the assets directory at all. The echoed id goes to the model only.
            if (!entry) {
              const validIds = ready.map(a => a.id).join(', ') || '(none — this campaign has no illustrated assets)';
              const echoed = String(args.assetId ?? '').slice(0, 120);
              return {
                content: [{ type: 'text', text: `Unknown asset id ${JSON.stringify(echoed)}. No image was shown. Valid ids for this campaign: ${validIds}.` }],
                isError: true,
              };
            }

            if (!sceneImages) {
              return {
                content: [{ type: 'text', text: 'Scene imagery is unavailable in this session. No image was shown.' }],
                isError: true,
              };
            }
            if (sceneImages.shown >= MAX_SCENE_IMAGES_PER_TURN) {
              return {
                content: [{ type: 'text', text: `Already showed ${MAX_SCENE_IMAGES_PER_TURN} images this turn — that is the limit. No image was shown. Narrate without one and save the picture for a later turn.` }],
                isError: true,
              };
            }

            const title = flattenAndTruncate(entry.title, PAYLOAD_TITLE_MAX) || entry.id;
            const alt = flattenAndTruncate(entry.alt, PAYLOAD_ALT_MAX) || title;
            const caption = flattenAndTruncate(args.caption, PAYLOAD_CAPTION_MAX);
            sceneImages.queue.push({
              assetId: entry.id,
              kind: entry.kind,
              title,
              alt,
              caption,
              // Non-empty transcript text (condition S3): normalizeSavedMessages drops any saved
              // message with no text, and a transcript read outside the app should still say what
              // the players were shown.
              text: caption || title || alt,
            });
            sceneImages.shown += 1;

            return {
              content: [{ type: 'text', text: JSON.stringify({ shown: true, id: entry.id, title }) }],
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
              case 'start': result = startCombat(playerEmail, campaignId, sessionDbId, args.combatants || []); break;
              case 'next': result = nextTurn(playerEmail, campaignId, sessionDbId); break;
              case 'damage': result = applyDamage(playerEmail, campaignId, sessionDbId, args.target, args.amount); break;
              case 'heal': result = applyHealing(playerEmail, campaignId, sessionDbId, args.target, args.amount); break;
              case 'condition': result = setCondition(playerEmail, campaignId, sessionDbId, args.target, args.condition, args.roundsLeft, args.remove); break;
              case 'status': result = getCombatStatus(playerEmail, campaignId, sessionDbId); break;
              case 'end': result = endCombat(playerEmail, campaignId, sessionDbId); break;
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
              case 'use': result = useResource(dataDir, playerEmail, campaignId, sessionDbId, args.characterId, args.resource, args.quantity || 1); break;
              case 'cast': result = castSpell(playerEmail, campaignId, sessionDbId, args.characterId, args.spellLevel); break;
              case 'rest': result = processRest(dataDir, playerEmail, campaignId, sessionDbId, args.characterId, args.restType); break;
              case 'check': result = checkResources(dataDir, playerEmail, campaignId, sessionDbId, args.characterId); break;
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
              case 'advance': result = advanceTime(playerEmail, campaignId, sessionDbId, args.days, args.hours); break;
              case 'event': result = scheduleEvent(playerEmail, campaignId, sessionDbId, args.eventName, args.inDays); break;
              case 'check': result = checkCalendar(playerEmail, campaignId, sessionDbId); break;
              case 'weather': result = generateWeather(playerEmail, campaignId, sessionDbId); break;
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
          keyFacts: z.array(z.string()).optional().describe('Durable established campaign facts — named NPCs, factions, places, bounties with their canonical details, e.g. "Kesh Bloodtide — half-orc pirate, leads the Saltmere Reavers (8-10 crew) from the Serpent\'s Maw sea caves 5 mi south of Saltmere; 100 gp bounty". Replaces previous list — ALWAYS pass the full updated list and never drop or rename an entry unless the story established it is no longer true.'),
          pendingEffects: z.array(z.string()).optional().describe('Active spell effects, conditions, or timers'),
          narrativeNotes: z.string().optional().describe('Brief DM notes about what should happen next or current story state'),
        },
        async (args) => {
          try {
            if (!sessionDbId || !playerEmail) {
              return { content: [{ type: 'text', text: 'No active session to update world state.' }], isError: true };
            }
            // Sessions live at data/sessions/<id>/session.json — the same path every
            // reader uses (ws-handler readSessionByDbId, recap injection, counters).
            const sessionFilePath = getSessionFilePath(dataDir, sessionDbId);
            if (!fs.existsSync(sessionFilePath)) {
              return { content: [{ type: 'text', text: `Session file not found: ${sessionDbId}` }], isError: true };
            }
            // Serialized read-modify-write — concurrent turn persistence must not
            // clobber this update (or vice versa).
            let updated;
            await updateSessionFile(dataDir, sessionDbId, (session) => {
              const existing = session.worldState || {};
              // Merge provided fields into existing worldState
              updated = { ...existing, updatedAt: new Date().toISOString() };
              if (args.location !== undefined) updated.location = args.location;
              if (args.inGameDay !== undefined) updated.inGameDay = args.inGameDay;
              if (args.inGameTime !== undefined) updated.inGameTime = args.inGameTime;
              if (args.recentEvents !== undefined) updated.recentEvents = args.recentEvents;
              if (args.activeQuests !== undefined) updated.activeQuests = args.activeQuests;
              if (args.keyRelationships !== undefined) updated.keyRelationships = args.keyRelationships;
              if (args.keyFacts !== undefined) updated.keyFacts = args.keyFacts;
              if (args.pendingEffects !== undefined) updated.pendingEffects = args.pendingEffects;
              if (args.narrativeNotes !== undefined) updated.narrativeNotes = args.narrativeNotes;
              session.worldState = updated;
            });
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
function buildSmartRecap(messageHistory, worldState, arcSummaries) {
  const messages = messageHistory.filter(m => m.type === 'player' || m.type === 'dm' || m.type === 'companion');
  const parts = [];

  // Inject condensed earlier arcs first — these replace raw history archived by compaction.
  if (Array.isArray(arcSummaries) && arcSummaries.length > 0) {
    parts.push('=== EARLIER ARCS (condensed — raw transcript archived) ===');
    for (const arc of arcSummaries) {
      const header = arc.title
        ? `[${arc.title}${arc.daysRange ? ` — ${arc.daysRange}` : ''}]`
        : '';
      parts.push(`${header ? header + '\n' : ''}${arc.blurb || ''}`.trim());
    }
    parts.push('=== END EARLIER ARCS ===');
  }

  // Inject world state at the top if available
  if (worldState && typeof worldState === 'object' && Object.keys(worldState).length > 0) {
    const wsLines = ['=== WORLD STATE SNAPSHOT ==='];
    if (worldState.location) wsLines.push(`Location: ${worldState.location}`);
    if (worldState.inGameDay) wsLines.push(`Day: ${worldState.inGameDay}`);
    if (worldState.inGameTime) wsLines.push(`Time: ${worldState.inGameTime}`);
    if (worldState.recentEvents?.length > 0) wsLines.push(`Recent Events: ${worldState.recentEvents.join('; ')}`);
    if (worldState.activeQuests?.length > 0) wsLines.push(`Active Quests: ${worldState.activeQuests.map(q => `${q.name} (${q.status})`).join('; ')}`);
    if (worldState.keyRelationships?.length > 0) wsLines.push(`Key Relationships: ${worldState.keyRelationships.join('; ')}`);
    if (worldState.keyFacts?.length > 0) wsLines.push(`Established Facts (canonical): ${worldState.keyFacts.join('; ')}`);
    if (worldState.pendingEffects?.length > 0) wsLines.push(`Pending Effects: ${worldState.pendingEffects.join('; ')}`);
    if (worldState.narrativeNotes) wsLines.push(`DM Notes: ${worldState.narrativeNotes}`);
    wsLines.push('If this snapshot conflicts with the transcript below, the transcript\'s most recent turns win — the snapshot may lag behind play.');
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

const ARC_SUMMARY_SYSTEM = `You are condensing a completed story arc of a D&D 5e campaign into a single flowing recap of 500-1000 words.
Preserve: character and NPC names, locations, key decisions and their consequences, rewards and notable items, unresolved plot threads and hooks, and the party's status at the end of the arc.
Write in past tense, narrative prose. Be compact — this recap permanently replaces the raw transcript for this span, so it must stand on its own. Do not invent events that are not in the source. Output only the recap text, with no preamble or headers.`;

/**
 * One-shot, tool-free summarization used by the compaction module to produce arc blurbs.
 * Reuses the SDK query path, model selection, and concurrency semaphore so it bills and
 * throttles exactly like a DM turn (subscription auth — no API key).
 */
async function summarizeArc(inputText, { dataDir, playerEmail } = {}) {
  let model;
  try { model = loadDmSettings(dataDir, playerEmail)?.model; } catch { /* default model */ }
  await querySemaphore.acquire();
  try {
    const options = {
      systemPrompt: ARC_SUMMARY_SYSTEM,
      cwd: PROJECT_ROOT,
      maxTurns: 1,
      includePartialMessages: false,
      allowedTools: [],
      canUseTool: async () => ({ behavior: 'deny', message: 'No tools during summarization.' }),
    };
    if (model) options.model = model;
    const q = query({ prompt: inputText, options });
    let out = '';
    for await (const message of q) {
      if (message.type === 'assistant' && !message.partial) {
        const blocks = message.message?.content || [];
        out += blocks.filter(b => b.type === 'text').map(b => b.text).join('\n');
      }
      if (message.type === 'result') break;
    }
    return out.trim();
  } finally {
    querySemaphore.release();
  }
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
    // Scene-imagery buffer, the dice-results pattern plus a per-turn counter.
    // `queue` is drained into the event stream; `shown` caps images per turn.
    this._sceneImages = { queue: [], shown: 0 };
  }

  _getMcpToolServer(playerEmail, campaignId, sessionDbId, characterId) {
    // Recreate if playerEmail, campaignId, sessionDbId, or characterId changed
    if (!this._mcpToolServer || this.playerEmail !== playerEmail || this.campaignId !== campaignId || this._sessionDbId !== sessionDbId || this._characterId !== characterId) {
      this.playerEmail = playerEmail;
      this.campaignId = campaignId;
      this._sessionDbId = sessionDbId;
      this._characterId = characterId;
      this._mcpToolServer = createMcpToolServer(this.dataDir, playerEmail, this._diceResults, campaignId, sessionDbId, characterId, this._sceneImages);
    }
    return this._mcpToolServer;
  }

  _buildOptions(characterId, scenarioId, onPermissionRequest, playerEmail, campaignId, companionPlayers, sessionDbId, companionConfig, dmPersonality, worldState) {
    // Stable-only system prompt so the SDK's automatic prompt cache hits across turns within
    // a session. Volatile state (worldState, character HP, NPCs, party composition) is
    // prepended to the user prompt in DmEngine.run instead.
    const systemPrompt = buildStableSystemPrompt(this.dataDir, playerEmail, campaignId, sessionDbId, dmPersonality, sessionIsMultiplayer(companionPlayers, companionConfig));
    const mcpToolServer = this._getMcpToolServer(playerEmail, campaignId, sessionDbId, characterId);
    const dmSettings = loadDmSettings(this.dataDir, playerEmail);
    const opts = {
      systemPrompt,
      cwd: PROJECT_ROOT,
      allowedTools: ['Read', 'Glob', 'Grep', 'Edit', 'mcp__dnd-tools__AwardPartyXP', 'mcp__dnd-tools__AwardXP', 'mcp__dnd-tools__RollDice', 'mcp__dnd-tools__TrackCombat', 'mcp__dnd-tools__TrackResources', 'mcp__dnd-tools__TrackCalendar', 'mcp__dnd-tools__LookupMonster', 'mcp__dnd-tools__UpdateWorldState', 'mcp__dnd-tools__ShowSceneImage'],
      mcpServers: { 'dnd-tools': mcpToolServer },
      permissionMode: 'default',
      includePartialMessages: true,
      maxTurns: 20,
      effort: 'medium',
      async canUseTool(toolName, input, opts) {
        if (['Read', 'Glob', 'Grep', 'Edit'].includes(toolName)) {
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
      hooks: {
        // Validate JSON after every file write. A malformed Edit/Write to a
        // character/NPC JSON file otherwise lands on disk silently and is only
        // discovered later by readers (json-recovery), which serve stale
        // fallback data and log a "Corrupt file" error on every poll. Catching
        // it here feeds the parse error straight back to the model so it fixes
        // the file in the same turn, before any reader observes the corruption.
        PostToolUse: [
          {
            hooks: [
              async (input) => {
                try {
                  const toolName = input && input.tool_name;
                  if (toolName !== 'Edit' && toolName !== 'Write' && toolName !== 'MultiEdit') {
                    return {};
                  }
                  const filePath = input.tool_input && input.tool_input.file_path;
                  if (!filePath || !filePath.endsWith('.json')) {
                    return {};
                  }
                  const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(PROJECT_ROOT, filePath);
                  let raw;
                  try {
                    raw = fs.readFileSync(absPath, 'utf-8');
                  } catch {
                    // File unreadable/missing — not this hook's concern.
                    return {};
                  }
                  try {
                    JSON.parse(raw);
                  } catch (parseErr) {
                    console.warn(`[DM:hook] Edit produced invalid JSON in ${filePath} — ${parseErr.message}; blocking for same-turn repair`);
                    return {
                      decision: 'block',
                      reason: `Your last ${toolName} left ${filePath} as invalid JSON (${parseErr.message}). The file is now unparseable and cannot be loaded. Re-read the file and fix the JSON syntax — look for stray or doubled quotes and missing or extra commas around the section you just edited — so that it parses cleanly. Do not continue until this file is valid JSON.`,
                    };
                  }
                  return {};
                } catch (hookErr) {
                  // A hook must never crash the turn.
                  console.warn(`[DM:hook] PostToolUse json-validate failed: ${hookErr.message}`);
                  return {};
                }
              },
            ],
          },
        ],
      },
    };
    if (dmSettings.model) {
      opts.model = dmSettings.model;
    }
    return opts;
  }

  async *_streamQuery(prompt, options) {
    this._diceResults.length = 0;
    this._sceneImages.queue.length = 0;
    this._sceneImages.shown = 0;
    await querySemaphore.acquire();
    yield { type: 'dm_warmup', text: querySemaphore._active >= querySemaphore._max ? 'Waiting for other DM turns to finish...' : 'Thinking...' };
    this.activeQuery = query({ prompt, options });
    try {
      for await (const message of this.activeQuery) {
        // Drain any pending dice results before processing the next SDK message
        while (this._diceResults.length > 0) {
          const diceResult = this._diceResults.shift();
          yield { type: 'dice_roll', ...diceResult };
        }
        // Same for scene images, so a picture lands in stream order between the narration
        // that set it up and the narration that follows.
        while (this._sceneImages.queue.length > 0) {
          yield { type: 'scene_image', ...this._sceneImages.queue.shift() };
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
          const blocks = message.message?.content || [];
          const textBlocks = blocks.filter(b => b.type === 'text').map(b => b.text);
          if (textBlocks.length > 0) {
            yield { type: 'dm_response', text: textBlocks.join('\n\n') };
          }
          for (const block of blocks) {
            if (block.type === 'tool_use') {
              yield { type: 'tool_use', name: block.name, input: block.input || {} };
            }
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
          const usage = message.usage || message.message?.usage;
          if (usage) {
            console.log(`[DM:USAGE] session=${this.sessionId} input=${usage.input_tokens || 0} output=${usage.output_tokens || 0} cache_read=${usage.cache_read_input_tokens || 0} cache_create=${usage.cache_creation_input_tokens || 0}`);
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
      while (this._sceneImages.queue.length > 0) {
        yield { type: 'scene_image', ...this._sceneImages.queue.shift() };
      }
    } finally {
      this.activeQuery = null;
      querySemaphore.release();
    }
  }

  async *run(userMessage, { characterId, scenarioId, onPermissionRequest, messageHistory, playerEmail, campaignId, companionPlayers, sessionDbId, companionConfig, dmPersonality, worldState, dmMessagesSinceLastSummary, arcSummaries }) {
    const options = this._buildOptions(characterId, scenarioId, onPermissionRequest, playerEmail, campaignId, companionPlayers, sessionDbId, companionConfig, dmPersonality, worldState);
    let isStaleResume = false;

    // Volatile per-turn game state — prepended to the user prompt so it can change every turn
    // without invalidating the cached system-prompt prefix.
    const gameState = buildGameStateContext(this.dataDir, characterId, scenarioId, playerEmail, campaignId, sessionDbId, companionPlayers, companionConfig, worldState);
    const withGameState = (msg) => gameState ? `${gameState}\n\n${msg}` : msg;

    // Phase 2: Auto-summary nudge — append to user message if overdue
    let augmentedMessage = userMessage;
    if (typeof dmMessagesSinceLastSummary === 'number' && dmMessagesSinceLastSummary >= SUMMARY_NUDGE_THRESHOLD) {
      augmentedMessage += `\n\n[System note: It has been ${dmMessagesSinceLastSummary} DM responses since the last chapter summary. If a story arc has concluded or a significant milestone was reached, please write a chapter summary now using the standard format. Also call UpdateWorldState to persist the current narrative state.]`;
    }

    if (this.sessionId) {
      options.resume = this.sessionId;
      try {
        yield* this._streamQuery(withGameState(augmentedMessage), options);
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

    if ((messageHistory && messageHistory.length > 0) || (arcSummaries && arcSummaries.length > 0)) {
      recap = buildSmartRecap(messageHistory || [], worldState, arcSummaries);
      const recapStrategy = (messageHistory || []).some(m => m.type === 'dm' && CHAPTER_SUMMARY_PATTERN.test(m.text)) ? 'chapter-summaries' : 'raw-messages';
      console.log(`[DM:RECAP] campaign=${campaignId} player=${playerEmail} strategy=${recapStrategy} recapLength=${recap.length} historyMessages=${(messageHistory || []).length}`);
      // Build identity-enriched resume header
      const character = characterId ? loadCharacter(this.dataDir, characterId, playerEmail, campaignId, sessionDbId) : null;
      const scenario = scenarioId ? loadScenario(this.dataDir, scenarioId, campaignId) : null;
      const charLabel = character ? `${character.name} (Level ${character.level} ${character.race} ${character.class})` : 'Unknown character';
      const scenarioLabel = scenario ? scenario.title : 'Unknown scenario';

      // Phase 4: Warm-up turn on stale session resume
      // Send a hidden warm-up query so the AI reviews the recap before responding to the player
      if (isStaleResume && recap.length > 0) {
        const warmupPrompt = withGameState(`[SESSION RESUMED — CAMPAIGN: ${charLabel} | SCENARIO: ${scenarioLabel}]\n[Continue this character's story. Do NOT confuse with any other campaign.]\n\n${recap}\n\n[END OF PREVIOUS SESSION]\n\n[System: This is a warm-up turn after a server restart. Review the above session history and world state. Confirm your understanding of the current story state, party status, active quests, and location in 2-3 brief sentences. Then call UpdateWorldState to persist your understanding. Do NOT address the player directly — this message is internal.]`);
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
          yield* this._streamQuery(withGameState(augmentedMessage), resumeOptions);
          return;
        }
        // If warm-up didn't produce a session ID, fall through to the non-warm-up path
        console.warn(`[DM:WARMUP_FAILED] No session ID from warm-up, falling through to direct recap`);
      }

      prompt = withGameState(`[SESSION RESUMED — CAMPAIGN: ${charLabel} | SCENARIO: ${scenarioLabel}]\n[Continue this character's story. Do NOT confuse with any other campaign.]\n\n${recap}\n\n[END OF PREVIOUS SESSION — The player now says:]\n\n${augmentedMessage}`);
      yield* this._streamQuery(prompt, freshOptions);
      return;
    }

    yield* this._streamQuery(withGameState(augmentedMessage), freshOptions);
  }

  // Reconciliation pass: resume the just-completed turn's Claude session and send an internal
  // correction message so the agent applies file edits it narrated but skipped. This MUST resume
  // an existing session (this.sessionId) — without the turn's context there is nothing to
  // reconcile, so if there's no session id we yield nothing and let the caller move on. The
  // caller is responsible for suppressing any narrative this produces; only tool_use matters.
  async *runReconcile(reconcilePrompt, { characterId, scenarioId, onPermissionRequest, playerEmail, campaignId, companionPlayers, sessionDbId, companionConfig, dmPersonality, worldState }) {
    if (!this.sessionId) {
      console.warn('[DM:RECONCILE] no Claude session to resume — skipping reconciliation');
      return;
    }
    const options = this._buildOptions(characterId, scenarioId, onPermissionRequest, playerEmail, campaignId, companionPlayers, sessionDbId, companionConfig, dmPersonality, worldState);
    options.resume = this.sessionId;
    try {
      yield* this._streamQuery(reconcilePrompt, options);
    } catch (err) {
      // Resume failed (e.g. stale session). Reconciling in a fresh session has no context, so we
      // just log and stop — the caller proceeds and the turn ends rather than trapping the player.
      console.warn(`[DM:RECONCILE] resume failed sessionDb=${sessionDbId} staleClaudeId=${this.sessionId} error="${err.message}"`);
    }
  }

  abort() {
    if (this.activeQuery) {
      this.activeQuery.close();
      this.activeQuery = null;
    }
  }
}

module.exports = { DmEngine, loadDmSettings, summarizeArc, AGENCY_TO_AUTONOMY, _testing: { loadCharacter, loadNpcs, buildSystemPrompt, buildStableSystemPrompt, buildGameStateContext, loadScenario, buildSmartRecap } };
