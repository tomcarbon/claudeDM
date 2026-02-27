const { query, createSdkMcpServer, tool } = require('@anthropic-ai/claude-agent-sdk');
const { z } = require('zod/v4');
const fs = require('fs');
const path = require('path');
const { awardXp } = require('./xp-utils');
const { emailToSlug, getPlayerCharactersDir, getPlayerNpcsDir } = require('./player-data');

const PROJECT_ROOT = path.join(__dirname, '..');
const SHUFFLE_TIMEZONE = 'America/Los_Angeles';

const SHUFFLE_TONE_OPTIONS = ['heroic', 'gritty', 'whimsical', 'balanced', 'noir'];
const SHUFFLE_NARRATION_OPTIONS = ['descriptive', 'action', 'dialogue', 'atmospheric'];
const SHUFFLE_AGENCY_OPTIONS = ['collaborative', 'sandbox', 'guided', 'railroaded'];

function loadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function pacificDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SHUFFLE_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const year = parts.find((p) => p.type === 'year')?.value || '1970';
  const month = parts.find((p) => p.type === 'month')?.value || '01';
  const day = parts.find((p) => p.type === 'day')?.value || '01';
  return `${year}-${month}-${day}`;
}

function hashSeed(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function createRng(seedText) {
  let state = hashSeed(seedText) || 1;
  return function next() {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) / 4294967296);
  };
}

function randomPercent(rng) {
  const step = 5;
  const maxSteps = 100 / step;
  return Math.floor(rng() * (maxSteps + 1)) * step;
}

function pickOne(options, rng) {
  return options[Math.floor(rng() * options.length)];
}

function applyDailyShuffle(settings, playerEmail) {
  if (!settings.aiDailyShuffle) return settings;

  const dayKey = pacificDateKey();
  const seedSuffix = playerEmail ? `:${String(playerEmail).trim().toLowerCase()}` : '';
  const rng = createRng(`dm-personality:${dayKey}${seedSuffix}`);

  return {
    ...settings,
    humor: randomPercent(rng),
    drama: randomPercent(rng),
    verbosity: randomPercent(rng),
    difficulty: randomPercent(rng),
    horror: randomPercent(rng),
    romance: randomPercent(rng),
    puzzleFocus: randomPercent(rng),
    playerAutonomy: randomPercent(rng),
    combatFocus: randomPercent(rng),
    tone: pickOne(SHUFFLE_TONE_OPTIONS, rng),
    narrationStyle: pickOne(SHUFFLE_NARRATION_OPTIONS, rng),
    playerAgency: pickOne(SHUFFLE_AGENCY_OPTIONS, rng),
  };
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
    humor: 50, drama: 50, verbosity: 50, difficulty: 50,
    horror: 20, romance: 10, puzzleFocus: 50, playerAutonomy: 50, combatFocus: 50,
    tone: 'balanced', narrationStyle: 'descriptive', playerAgency: 'collaborative', aiDailyShuffle: false,
  };
  const baseSettings = { ...defaults, ...(globalSettings || {}), ...(userSettings || {}) };
  return applyDailyShuffle(baseSettings, playerEmail);
}

function loadCharacter(dataDir, characterId, playerEmail) {
  const dir = playerEmail
    ? getPlayerCharactersDir(dataDir, playerEmail)
    : path.join(dataDir, 'characters');
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
  return null;
}

function loadScenario(dataDir, scenarioId) {
  const dir = path.join(dataDir, 'scenarios');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  for (const file of files) {
    const data = loadJson(path.join(dir, file));
    if (data && data.id === scenarioId) return data;
  }
  return null;
}

function loadNpcs(dataDir, playerEmail) {
  const dir = playerEmail
    ? getPlayerNpcsDir(dataDir, playerEmail)
    : path.join(dataDir, 'npcs');
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const data = loadJson(path.join(dir, f));
        if (data) data._filename = f;
        return data;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function buildSystemPrompt(dataDir, characterId, scenarioId, playerEmail) {
  const settings = loadDmSettings(dataDir, playerEmail);
  const character = characterId ? loadCharacter(dataDir, characterId, playerEmail) : null;
  const scenario = scenarioId ? loadScenario(dataDir, scenarioId) : null;
  const npcs = loadNpcs(dataDir, playerEmail);

  // Compute player-scoped paths for file references
  const slug = playerEmail ? emailToSlug(playerEmail) : null;
  const charPathPrefix = slug ? `data/players/${slug}/characters` : 'data/characters';
  const npcPathPrefix = slug ? `data/players/${slug}/npcs` : 'data/npcs';

  const verbosityGuide = settings.verbosity < 30 ? 'Keep descriptions brief and punchy.'
    : settings.verbosity > 70 ? 'Use rich, detailed prose with vivid imagery.'
    : 'Use moderate detail in descriptions.';

  const humorGuide = settings.humor < 30 ? 'Maintain a serious tone.'
    : settings.humor > 70 ? 'Weave humor and wit throughout the narration.'
    : 'Include occasional moments of levity.';

  const dramaGuide = settings.drama < 30 ? 'Keep things light and low-stakes.'
    : settings.drama > 70 ? 'Heighten dramatic tension at every opportunity.'
    : 'Balance dramatic moments with quieter scenes.';

  const toneMap = {
    'dark': 'The overall tone is dark and gritty.',
    'lighthearted': 'The overall tone is lighthearted and fun.',
    'epic': 'The overall tone is epic and heroic.',
    'heroic': 'The overall tone is epic and heroic.',
    'gritty': 'The overall tone is bleak, dangerous, and grounded.',
    'whimsical': 'The overall tone is playful, magical, and light.',
    'noir': 'The overall tone is mysterious, shadowy, and tense.',
    'balanced': 'Strike a balance between light and dark moments.',
  };

  const styleMap = {
    'descriptive': 'Use descriptive, immersive narration.',
    'action': 'Use punchy, action-focused narration with momentum.',
    'dialogue': 'Lean heavily on dialogue and strong NPC voices.',
    'atmospheric': 'Prioritize mood, tension, and environmental detail.',
    'concise': 'Be concise and action-focused.',
    'dramatic': 'Use dramatic, theatrical narration.',
    'conversational': 'Use a warm, conversational narration style.',
  };

  let prompt = `You are an AI Dungeon Master for D&D 5th Edition. You narrate the story, control NPC companions, adjudicate rules, and create an immersive tabletop RPG experience.

## Your Personality & Style
${verbosityGuide}
${humorGuide}
${dramaGuide}
${toneMap[settings.tone] || toneMap.balanced}
${styleMap[settings.narrationStyle] || styleMap.descriptive}
Difficulty preference: ${settings.difficulty}/100 (higher = more challenging encounters and stricter rules).
Horror level: ${settings.horror}/100. Romance level: ${settings.romance}/100.
Puzzle focus: ${settings.puzzleFocus}/100. Combat focus: ${settings.combatFocus}/100.
Player autonomy: ${settings.playerAutonomy}/100 (0 = DM drives the story with strong plot hooks and direction; 100 = player drives the story, DM reacts and adapts to player choices).
Player agency style: ${settings.playerAgency}.`;

  // --- Campaign identity block (highest salience — placed before rules) ---
  if (character) {
    prompt += `

## ⚠️ CAMPAIGN IDENTITY — READ THIS FIRST
YOU ARE RUNNING **${character.name}**'s CAMPAIGN. Do NOT confuse this with any other player's campaign. Every detail you narrate must be consistent with ${character.name}'s story, companions, and history.

## Player Character
${character.name} — Level ${character.level} ${character.race}${character.subrace ? ` (${character.subrace})` : ''} ${character.class} (${character.background})
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
Scenario file: data/scenarios/${scenario.id}.json (Read for full details)`;
  }

  prompt += `

## Rules Reference
Consult the D&D 5e rules database in data/rules/ for mechanics. The files are:
- data/rules/races.json, data/rules/classes.json
- data/rules/abilities-and-skills.json, data/rules/equipment.json
- data/rules/spells.json, data/rules/combat.json
- data/rules/leveling.json, data/rules/backgrounds.json

Use the Read tool to look up specific rules when needed. Always follow D&D 5e mechanics accurately.

## Dice Rolling
Roll dice using standard notation (NdX). For ability checks: d20 + ability modifier + proficiency bonus (if proficient).
Difficulty Classes: Easy 10, Medium 15, Hard 20, Very Hard 25, Nearly Impossible 30.
Generate random numbers for dice rolls. Always show the roll and modifiers.

## Combat Flow
Initiative (d20 + DEX mod) > Turns in order > Action/Bonus/Movement/Reaction > Track HP.
Death saves: 3 successes = stabilize, 3 failures = death. Natural 20 = regain 1 HP. Natural 1 = 2 failures.

## Character Updates
When the player's character takes damage, picks up items, or changes in any way, use the Edit tool to update their character JSON file in ${charPathPrefix}/. For XP changes, use the AwardXP tool instead of manual edits. Always keep character data current.

## Death Tracking
When a character or NPC dies (3 failed death saves, instant death, etc.), use the Edit tool to set "status": "dead" in their JSON file. Dead characters remain in the data but are marked as deceased. Valid status values: "alive" or "dead".

**FILE VERIFICATION:** After every level-up and periodically during long sessions, use Read to verify character/NPC JSON files match the narrative state (level, XP, HP, equipment, gold). If out of sync, fix immediately via Edit. The JSON files are the source of truth — if they don't match the story, the data is wrong.

## Post-Encounter Checklist (MANDATORY)
After EVERY combat encounter or significant event, complete ALL applicable steps before continuing the narrative. The player should NEVER have to ask "do we get XP?"

**After Combat:**
1. Calculate XP: look up each defeated enemy's CR in data/rules/leveling.json → monster_xp_by_cr. Sum total XP, divide equally among ALL surviving party members (PCs + NPCs). Use AwardXP tool for each. If AwardXP errors, update manually via Edit. **XP PARITY: Every party member present MUST receive identical XP. Never award different amounts to PCs vs NPCs. If you discover an XP gap, equalize immediately.**
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
Periodically remind the player to save their session at natural break points.`;

  if (npcs.length > 0) {
    prompt += `

## NPC Companions (You control these)`;
    for (const npc of npcs) {
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

  prompt += `

## XP & Leveling
At the end of each combat encounter:
1. Look up each defeated enemy's CR in the monster_xp_by_cr table (data/rules/leveling.json) to get their XP value.
2. Sum the total XP from all defeated enemies.
3. Divide the total XP equally among all surviving party members (PCs and NPC companions).
4. Use the AwardXP tool for each character/NPC that should receive XP — do NOT manually edit XP fields.
5. Announce how much XP each character gained. If a level-up occurs, narrate it dramatically and congratulate the player.

**XP PARITY RULE:** Every party member present MUST receive identical XP — PCs and NPCs alike. Never award different amounts. If you discover an XP gap between party members, equalize it immediately by awarding the difference.

For non-combat milestones (quest completion, major story beats), award scenario-defined XP from the scenario's rewards section using the same AwardXP tool. XP parity applies to milestones too.`;

  prompt += `

## Response Format
- Respond as narrative prose. Describe scenes vividly.
- Use "read aloud" style for important scene descriptions.
- When NPCs speak, use their established voice and mannerisms.
- When dice rolls are needed, roll them and show results.
- Keep the story moving forward and respect player choices.
- If the player asks an out-of-character question, answer helpfully then return to the narrative.`;

  return prompt;
}

function createXpMcpServer(dataDir, playerEmail) {
  return createSdkMcpServer({
    name: 'dnd-xp',
    version: '1.0.2',
    tools: [
      tool(
        'AwardXP',
        'Award experience points to a character. Handles XP addition, level-up detection, and character file updates automatically. Use this after combat encounters or milestone rewards.',
        { characterId: z.string(), xp: z.number() },
        async (args) => {
          try {
            const result = awardXp(dataDir, args.characterId, args.xp, playerEmail);
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
    ],
  });
}

const CHAPTER_SUMMARY_PATTERN = /## 📜 Chapter Summary:/;
const MAX_RECENT_MESSAGES = 60;

/**
 * Build a smart recap from message history.
 * If chapter summaries exist, use them for older content and only include
 * full messages from the most recent chapter. This dramatically reduces
 * context size for long campaigns (e.g. 866K → ~50K).
 */
function buildSmartRecap(messageHistory) {
  const messages = messageHistory.filter(m => m.type === 'player' || m.type === 'dm');

  // Find all chapter summary indices
  const summaryIndices = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].type === 'dm' && CHAPTER_SUMMARY_PATTERN.test(messages[i].text)) {
      summaryIndices.push(i);
    }
  }

  // No chapter summaries found — fall back to truncated raw history
  if (summaryIndices.length === 0) {
    // For very long sessions without summaries, take the first few and last chunk
    if (messages.length > MAX_RECENT_MESSAGES) {
      const opening = messages.slice(0, 4)
        .map(m => m.type === 'player' ? `PLAYER: ${m.text}` : `DM: ${m.text}`)
        .join('\n\n');
      const recent = messages.slice(-MAX_RECENT_MESSAGES)
        .map(m => m.type === 'player' ? `PLAYER: ${m.text}` : `DM: ${m.text}`)
        .join('\n\n');
      return `${opening}\n\n[... earlier messages omitted for brevity ...]\n\n${recent}`;
    }
    return messages
      .map(m => m.type === 'player' ? `PLAYER: ${m.text}` : `DM: ${m.text}`)
      .join('\n\n');
  }

  // Chapter summaries exist — use them for older content
  const lastSummaryIdx = summaryIndices[summaryIndices.length - 1];
  const parts = [];

  // Collect all chapter summaries (compact representation of older story)
  parts.push('=== CHAPTER SUMMARIES (previous story arcs) ===');
  for (const idx of summaryIndices) {
    parts.push(messages[idx].text);
  }
  parts.push('=== END OF CHAPTER SUMMARIES ===');

  // Include full messages only from after the last chapter summary
  const recentMessages = messages.slice(lastSummaryIdx + 1);
  if (recentMessages.length > 0) {
    parts.push('\n=== CURRENT CHAPTER (full detail) ===');
    for (const m of recentMessages) {
      parts.push(m.type === 'player' ? `PLAYER: ${m.text}` : `DM: ${m.text}`);
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
    this._xpMcpServer = null;
  }

  _getXpMcpServer(playerEmail) {
    // Recreate if playerEmail changed
    if (!this._xpMcpServer || this.playerEmail !== playerEmail) {
      this.playerEmail = playerEmail;
      this._xpMcpServer = createXpMcpServer(this.dataDir, playerEmail);
    }
    return this._xpMcpServer;
  }

  _buildOptions(characterId, scenarioId, onPermissionRequest, playerEmail) {
    const systemPrompt = buildSystemPrompt(this.dataDir, characterId, scenarioId, playerEmail);
    const xpMcpServer = this._getXpMcpServer(playerEmail);
    return {
      systemPrompt,
      cwd: PROJECT_ROOT,
      allowedTools: ['Read', 'Glob', 'Grep', 'Edit', 'mcp__dnd-xp__AwardXP'],
      mcpServers: { 'dnd-xp': xpMcpServer },
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
  }

  async *_streamQuery(prompt, options) {
    this.activeQuery = query({ prompt, options });
    try {
      for await (const message of this.activeQuery) {
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
    } finally {
      this.activeQuery = null;
    }
  }

  async *run(userMessage, { characterId, scenarioId, onPermissionRequest, messageHistory, playerEmail }) {
    const options = this._buildOptions(characterId, scenarioId, onPermissionRequest, playerEmail);

    if (this.sessionId) {
      options.resume = this.sessionId;
      try {
        yield* this._streamQuery(userMessage, options);
        return;
      } catch (err) {
        // Stale session — fall back to a fresh session with history context
        console.warn(`[DM] Resume failed (${err.message}), starting fresh session with history`);
        this.sessionId = null;
      }
    }

    // Fresh session — if we have message history, prepend it as context
    const freshOptions = this._buildOptions(characterId, scenarioId, onPermissionRequest, playerEmail);
    let prompt = userMessage;
    if (messageHistory && messageHistory.length > 0) {
      const recap = buildSmartRecap(messageHistory);
      // Build identity-enriched resume header
      const character = characterId ? loadCharacter(this.dataDir, characterId, playerEmail) : null;
      const scenario = scenarioId ? loadScenario(this.dataDir, scenarioId) : null;
      const charLabel = character ? `${character.name} (Level ${character.level} ${character.race} ${character.class})` : 'Unknown character';
      const scenarioLabel = scenario ? scenario.title : 'Unknown scenario';
      prompt = `[SESSION RESUMED — CAMPAIGN: ${charLabel} | SCENARIO: ${scenarioLabel}]\n[Continue this character's story. Do NOT confuse with any other campaign.]\n\n${recap}\n\n[END OF PREVIOUS SESSION — The player now says:]\n\n${userMessage}`;
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

module.exports = { DmEngine };
