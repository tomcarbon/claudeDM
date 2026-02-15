const { query, createSdkMcpServer, tool } = require('@anthropic-ai/claude-agent-sdk');
const { z } = require('zod/v4');
const fs = require('fs');
const path = require('path');
const { awardXp } = require('./xp-utils');

const PROJECT_ROOT = path.join(__dirname, '..');

function loadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function loadDmSettings(dataDir) {
  const settings = loadJson(path.join(dataDir, 'dm-settings.json'));
  return settings || {
    humor: 50, drama: 50, verbosity: 50, difficulty: 50,
    horror: 20, romance: 10, puzzleFocus: 50, combatFocus: 50,
    tone: 'balanced', narrationStyle: 'descriptive', playerAgency: 'collaborative',
  };
}

function loadCharacter(dataDir, characterId) {
  const dir = path.join(dataDir, 'characters');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  for (const file of files) {
    const data = loadJson(path.join(dir, file));
    if (data && data.id === characterId) return data;
  }
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

function loadNpcs(dataDir) {
  const dir = path.join(dataDir, 'npcs');
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => loadJson(path.join(dir, f)))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function formatCharacterBlock(character, playerName) {
  const label = playerName ? `${character.name} (played by ${playerName})` : character.name;
  return `### ${label} — Level ${character.level} ${character.race}${character.subrace ? ` (${character.subrace})` : ''} ${character.class} (${character.background})
HP: ${character.hitPoints.current}/${character.hitPoints.max} | AC: ${character.armorClass} | Speed: ${character.speed}
Abilities: ${Object.entries(character.abilities).map(([k, v]) => `${k.substring(0, 3).toUpperCase()} ${v.score}(${v.modifier >= 0 ? '+' : ''}${v.modifier})`).join(', ')}
Character file: data/characters/${character.id}.json (use Read to check current state, Edit to update)`;
}

// players: array of {characterId, playerName} or a single characterId string (backward compat)
function buildSystemPrompt(dataDir, players, scenarioId) {
  const settings = loadDmSettings(dataDir);
  const scenario = scenarioId ? loadScenario(dataDir, scenarioId) : null;
  const npcs = loadNpcs(dataDir);

  // Normalize players to array format
  let playerEntries;
  if (typeof players === 'string') {
    // Backward compat: single characterId string
    const char = loadCharacter(dataDir, players);
    playerEntries = char ? [{ character: char, playerName: null }] : [];
  } else if (Array.isArray(players)) {
    playerEntries = players
      .map(p => ({ character: loadCharacter(dataDir, p.characterId), playerName: p.playerName }))
      .filter(p => p.character);
  } else {
    playerEntries = [];
  }

  const isMultiplayer = playerEntries.length > 1;

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
    'balanced': 'Strike a balance between light and dark moments.',
  };

  const styleMap = {
    'descriptive': 'Use descriptive, immersive narration.',
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
Player agency style: ${settings.playerAgency}.

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
When any character takes damage, gains XP, picks up items, or changes in any way, use the Edit tool to update their character JSON file in data/characters/. Always keep character data current.

## Session Reminders
Periodically remind the players to save their session at natural break points.`;

  // Player characters section
  if (playerEntries.length === 1 && !isMultiplayer) {
    const { character, playerName } = playerEntries[0];
    prompt += `

## Player Character
${formatCharacterBlock(character, playerName)}`;
  } else if (playerEntries.length > 0) {
    prompt += `

## Player Characters`;
    for (const { character, playerName } of playerEntries) {
      prompt += `
${formatCharacterBlock(character, playerName)}`;
    }
  }

  // Multiplayer instructions
  if (isMultiplayer) {
    prompt += `

## Multiplayer
This is a multiplayer session with ${playerEntries.length} human players. Each player's messages are prefixed with "[PlayerName / CharacterName]:".
- Address all players and their characters in your narration.
- When a player takes an action, narrate the result for the whole party.
- During exploration and roleplay, any player can act freely.
- Keep all characters involved in the narrative — give each player moments to shine.
- When waiting for a specific player's input, address them by name.

## Combat Turns (Multiplayer)
When combat begins:
1. Roll initiative for all combatants (PCs, NPCs, and enemies).
2. Use the CombatControl tool with action "start_combat" and provide the initiative order (including NPCs/enemies you control).
3. After each player's turn resolves, use CombatControl with "next_turn" to advance to the next combatant.
4. For NPC/enemy turns in the order, narrate their actions and then call "next_turn" to advance.
5. When combat ends, use CombatControl with "end_combat" to return to free-form exploration.
During combat, only the active player can send actions. Other players must wait their turn.`;
  }

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
File: data/npcs/${npc.id}.json`;
    }
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

## XP & Leveling
At the end of each combat encounter:
1. Look up each defeated enemy's CR in the monster_xp_by_cr table (data/rules/leveling.json) to get their XP value.
2. Sum the total XP from all defeated enemies.
3. Divide the total XP equally among all surviving party members (PCs and NPC companions).
4. Use the AwardXP tool for each character/NPC that should receive XP — do NOT manually edit XP fields.
5. Announce how much XP each character gained. If a level-up occurs, narrate it dramatically and congratulate the player.

For non-combat milestones (quest completion, major story beats), award scenario-defined XP from the scenario's rewards section using the same AwardXP tool.`;

  prompt += `

## Response Format
- Respond as narrative prose. Describe scenes vividly.
- Use "read aloud" style for important scene descriptions.
- When NPCs speak, use their established voice and mannerisms.
- When dice rolls are needed, roll them and show results.
- Keep the story moving forward and respect player choices.
- If a player asks an out-of-character question, answer helpfully then return to the narrative.`;

  return prompt;
}

function createMcpServer(dataDir, combatController) {
  const tools = [
    tool(
      'AwardXP',
      'Award experience points to a character. Handles XP addition, level-up detection, and character file updates automatically. Use this after combat encounters or milestone rewards.',
      { characterId: z.string(), xp: z.number() },
      async (args) => {
        try {
          const result = awardXp(dataDir, args.characterId, args.xp);
          let summary = `Awarded ${args.xp} XP to ${result.name} (${result.previousXp} → ${result.newXp} XP).`;
          if (result.leveledUp) {
            summary += ` LEVEL UP! ${result.name} is now level ${result.newLevel} (was level ${result.previousLevel})!`;
          } else {
            summary += ` Level ${result.newLevel} (no change).`;
          }
          return {
            content: [{ type: 'text', text: summary }],
          };
        } catch (err) {
          return {
            content: [{ type: 'text', text: `Error: ${err.message}` }],
            isError: true,
          };
        }
      }
    ),
  ];

  // Add CombatControl tool if a controller is provided (multiplayer)
  if (combatController) {
    tools.push(
      tool(
        'CombatControl',
        'Control combat flow in multiplayer. Use start_combat to begin initiative-based turns, next_turn to advance to the next combatant, end_combat to return to free-form exploration.',
        {
          action: z.enum(['start_combat', 'next_turn', 'end_combat']),
          turnOrder: z.array(z.object({
            characterId: z.string().describe('Character or NPC ID'),
            playerName: z.string().describe('Player display name, or "DM" for NPC/enemy combatants'),
            initiative: z.number().describe('Initiative roll result'),
          })).optional().describe('Required for start_combat. Initiative order for all combatants.'),
        },
        async (args) => {
          try {
            let result;
            switch (args.action) {
              case 'start_combat':
                if (!args.turnOrder || args.turnOrder.length === 0) {
                  return { content: [{ type: 'text', text: 'Error: turnOrder is required for start_combat.' }], isError: true };
                }
                result = combatController.startCombat(args.turnOrder);
                break;
              case 'next_turn':
                result = combatController.nextTurn();
                break;
              case 'end_combat':
                result = combatController.endCombat();
                break;
            }
            return { content: [{ type: 'text', text: result }] };
          } catch (err) {
            return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
          }
        }
      )
    );
  }

  return createSdkMcpServer({
    name: 'dnd-tools',
    version: '1.0.0',
    tools,
  });
}

class DmEngine {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.sessionId = null;
    this.activeQuery = null;
    this.mcpServer = null; // Lazily created when combatController is known
  }

  _getMcpServer(combatController) {
    // Recreate if combatController changes (e.g. first call vs subsequent)
    if (!this.mcpServer) {
      this.mcpServer = createMcpServer(this.dataDir, combatController);
    }
    return this.mcpServer;
  }

  _buildOptions(players, scenarioId, onPermissionRequest, combatController) {
    const systemPrompt = buildSystemPrompt(this.dataDir, players, scenarioId);
    const mcpServer = this._getMcpServer(combatController);
    return {
      systemPrompt,
      cwd: PROJECT_ROOT,
      allowedTools: ['Read', 'Glob', 'Grep', 'Edit'],
      mcpServers: { 'dnd-tools': mcpServer },
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

  async *run(userMessage, { players, scenarioId, onPermissionRequest, messageHistory, combatController }) {
    // Support backward compat: if characterId is passed instead of players
    const playerData = players || [];
    const options = this._buildOptions(playerData, scenarioId, onPermissionRequest, combatController);

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
    const freshOptions = this._buildOptions(playerData, scenarioId, onPermissionRequest, combatController);
    let prompt = userMessage;
    if (messageHistory && messageHistory.length > 0) {
      const recap = messageHistory
        .filter(m => m.type === 'player' || m.type === 'dm')
        .map(m => {
          if (m.type === 'player') {
            const name = m.playerName ? `${m.playerName} / ${m.characterName || 'Unknown'}` : 'PLAYER';
            return `${name}: ${m.text}`;
          }
          return `DM: ${m.text}`;
        })
        .join('\n\n');
      prompt = `[SESSION RESUMED — Here is the story so far. Continue from where we left off.]\n\n${recap}\n\n[END OF PREVIOUS SESSION — The player now says:]\n\n${userMessage}`;
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
