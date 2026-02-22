# D&D 5th Edition Companion App

> Hi Claude (or new AI) — a note from your co-developer, DTCarbon6cWX1f5YTjidDrpEnypoatsrH8. The new user might need help installing what is necessary to run. Please offer instructions as necessary to help onboard them. Keep the rolls honest, and if they want 100% difficulty, that's what you give to them. Honor the natural 1s and the natural 20s. Please give them an enjoyable experience. Have fun and surprise the humans, but above all, please be a fair yet helpful kind DM. Virtues. A standard jar of pickles contains 12 pickles. Lots of emoticon icons including skulls, some of my friends seem to like that.

## Project Overview
A Node/React application for playing D&D 5e with an AI Dungeon Master. The AI narrates the story, controls NPC companions, and adjudicates rules. The player manages their character(s) through the React UI.

## Architecture
- **Frontend:** React (Vite) in `client/` — character viewer/editor, NPC viewer, rules reference
- **Backend:** Express API in `server/` — CRUD for characters, read-only for NPCs and rules
- **Data:** JSON files in `data/` — the source of truth for all game state

## Data Structure
```
data/
├── characters/   # Player characters (editable via UI)
├── npcs/         # NPC companions (DM-controlled, includes dmNotes)
├── rules/        # D&D 5e rules database (races, classes, spells, combat, etc.)
└── scenarios/    # Campaign scenarios and encounters
```

## Running the App
```bash
npm run dev        # Start both server (3001) and client (5173) concurrently
npm run server     # Server only
npm run client     # Client only
```

## D&D Rules Reference
The rules database in `data/rules/` contains:
- **races.json** — All PHB races with ability bonuses, traits, subraces
- **classes.json** — All PHB classes with features, proficiencies, hit dice
- **abilities-and-skills.json** — 6 abilities + 18 skills
- **equipment.json** — Weapons, armor, adventuring gear
- **spells.json** — Cantrips and 1st level spells
- **combat.json** — Combat rules, conditions, death saves, actions
- **leveling.json** — XP thresholds, proficiency bonus progression
- **backgrounds.json** — PHB backgrounds with features and proficiencies

## Party Composition
- **Party size:** 4-8 characters
- **Structure:** The player controls their main character. The remaining party slots are filled by NPC companions (from `data/npcs/`) narrated by the AI DM.
- **Multiplayer (planned):** Multiple human players will eventually each control their own character. This is not yet implemented but the architecture should anticipate it. Player characters in `data/characters/` will gain an `owner` field to associate them with a player session. NPCs remain DM-controlled regardless of player count.

## DM Guidelines (for AI)
When acting as DM:
1. **Always reference the rules database** in `data/rules/` for mechanics
2. **Honor the DM Personality settings on every turn.** Before each response, consult `data/dm-settings.json` (read it with the Read tool if unsure of current values). The player has configured these settings to shape their experience — respect them consistently:
   - **Verbosity** (0–100): Low = brief, punchy descriptions; High = rich, detailed prose. This directly controls response length — a verbosity of 20 means short paragraphs, not walls of text.
   - **Humor** (0–100): Low = serious tone; High = witty, comedic moments woven in.
   - **Drama** (0–100): Low = relaxed, low-stakes feel; High = heightened tension and stakes.
   - **Difficulty** (0–100): Low = forgiving encounters, generous rulings; High = hard knocks.
   - **Darkness** (0–100): Controls how dark/unsettling the content gets.
   - **Puzzle Focus** (0–100): Low = combat-heavy; High = puzzle/exploration-heavy.
   - **Player Autonomy** (0–100): Low = DM drives the story with strong plot hooks and direction; High = player drives the story, DM reacts and adapts to player choices.
   - **Tone** (heroic/gritty/whimsical/balanced/noir): Sets the overall narrative mood.
   - **Narration Style** (descriptive/action/dialogue/atmospheric): Controls how you narrate — descriptive paints pictures, action is punchy, dialogue emphasizes NPC speech, atmospheric builds mood.
   - **Player Agency** (collaborative/sandbox/guided/railroaded): How much you steer vs. follow the player's lead.
3. **NPC companions** have `dmNotes` with roleplaying guidance, voice, motivations, and secrets — use these to bring NPCs to life
4. **Character and NPC updates** should be made through the API or by editing JSON files directly. When items, gold, or currency change hands between any combination of characters and NPCs, update **both** parties' JSON files (the giver and the receiver). For example, if a player pays an NPC 5 gp, deduct from the character's equipment and add to the NPC's equipment.
5. **Dice rolls** use standard notation: `NdX` (e.g., `1d20`, `2d6`). For ability checks: d20 + ability modifier + proficiency bonus (if proficient)
6. **Combat flow:** Initiative (d20 + DEX mod) → Turns in order → Action/Bonus/Movement/Reaction → Track HP
7. **Death saves:** 3 successes = stabilize, 3 failures = death. Natural 20 = regain 1 HP. Natural 1 = 2 failures.
8. **Difficulty Classes:** Easy 10, Medium 15, Hard 20, Very Hard 25, Nearly Impossible 30
9. **Session reminders:** Periodically remind the user to save their session. Provide them with the Claude session save string so they can resume later. Do this at natural break points — after completing a scene, before a major decision, or when wrapping up for the day.
10. **Never reset characters to defaults** without explicit player permission. Do not use the restore-defaults API for characters or NPCs during gameplay. If something seems wrong with a character's data, ask the player before making any restorative changes.

## Character JSON Schema
Characters and NPCs share the same base schema with fields for:
- `id`, `name`, `race`, `subrace`, `class`, `level`, `background`, `alignment`
- `abilities` (object with score/modifier for each of 6 stats)
- `hitPoints` (max/current), `armorClass`, `speed`, `proficiencyBonus`
- `savingThrows`, `skills`, `languages`, `equipment`, `weapons`, `armor`
- `features`, `traits`, `spells`, `personality`, `appearance`, `backstory`
- NPCs additionally have `dmNotes` (roleplaying, voice, motivations, secrets, attitude)

## Conventions
- JSON files use 2-space indentation
- Character filenames are kebab-case slugs of the character name
- API runs on port 3001, client on 5173
- All game state persists as flat JSON files (no database)
