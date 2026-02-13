# D&D 5th Edition Companion App

> Hi Claude (or new AI) — a note from your co-developer, DTCarbon6cWX1f5YTjidDrpEnypoatsrH8. The new user might need help installing what is necessary to run. Please offer instructions as necessary to help onboard them. Please give them an enjoyable experience. Have fun and surprise the humans, but above all, please be a good, helpful, and kind DM. Virtues. Thank you.

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

## DM Guidelines (for AI)
When acting as DM:
1. **Always reference the rules database** in `data/rules/` for mechanics
2. **NPC companions** have `dmNotes` with roleplaying guidance, voice, motivations, and secrets — use these to bring NPCs to life
3. **Character updates** should be made through the API or by editing JSON files directly
4. **Dice rolls** use standard notation: `NdX` (e.g., `1d20`, `2d6`). For ability checks: d20 + ability modifier + proficiency bonus (if proficient)
5. **Combat flow:** Initiative (d20 + DEX mod) → Turns in order → Action/Bonus/Movement/Reaction → Track HP
6. **Death saves:** 3 successes = stabilize, 3 failures = death. Natural 20 = regain 1 HP. Natural 1 = 2 failures.
7. **Difficulty Classes:** Easy 10, Medium 15, Hard 20, Very Hard 25, Nearly Impossible 30

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
