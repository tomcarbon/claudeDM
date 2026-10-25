# adventurefrog (claudeDM)



## Project Overview
A Node/React application for playing tabletop RPGs with a Game Master. The AI narrates the story, controls NPC companions, and adjudicates rules. The player manages their character(s) through the React UI.

**Five game categories** (decisions `0023`–`0026`; WO-0040, WO-0042, WO-0043, WO-0045): **Fantasy** (SRD 5e rules, `data/rules/`), **Sci-Fi** (original gunplay/tech rules, `data/rules-scifi/`), **Noir** (original 1930s–50s detective rules, `data/rules-noir/`) **Western** (original frontier rules, `data/rules-western/`) and **Horror** (original Dread rules, `data/rules-horror/`). A campaign declares `"category"` in its `campaign.json`; one without is Fantasy. Sci-Fi, Noir, Western and Horror are the registry's `engine: 'modern'` (no magic, firearms) and share one generator and one prompt builder. Every campaign except `demo` is badged Premium (`listing.badge` — a label; nothing gates on it). All share one d20 chassis — abilities, proficiency, XP, HP, hit dice, death saves, rests and every mechanical tool — so nothing in vitals/XP/state-guard is category-aware. The registry is `server/game-categories.js`. Do not use "D&D" / "Dungeon Master" in anything user-visible; internal identifiers (`dnd-tools`, `dnd_*` storage keys, `dm-*` file names) stay as they are.

> **⚠️ Source of truth for live DM behavior:** the in-game DM is driven by the runtime system prompt assembled in **`server/dm-engine.js`** (`buildStableSystemPrompt` + `buildGameStateContext`), injected on every turn via the Claude Agent SDK. **That code — not this file — governs how the live DM actually behaves.** This `CLAUDE.md` is guidance for developers and AI coding assistants working *on* the codebase. The DM-behavior notes below are a human-readable mirror of the runtime prompt kept for orientation; **where the two differ, `server/dm-engine.js` wins.** To change how the DM plays, edit that file. (Note: a few reference tables here — e.g. the Fumble/Crit guides — are richer than the runtime prompt and are *not* currently injected into the live DM.)

## Architecture
- **Frontend:** React (Vite) in `client/` — character viewer/editor, NPC viewer, rules reference
- **Backend:** Express API in `server/` — CRUD for characters, read-only for NPCs and rules
- **Data:** JSON files in `data/` — the source of truth for all game state

## Data Structure
```
data/
├── defaults/                     # BASELINE templates — pristine source of truth for provisioning & resets
│   └── <campaign>/               # fantasy: demo, campaign1..5, nihon, wonderland, reckoning, bellwater; scifi: coldwar, lastferry, outbreak, perihelion; noir: blackcrane, klieglight, calloway; western: bittercreek, silverline, longbounty; horror: greywick, drownedbell, hollowfork
│       ├── characters/
│       └── npcs/
├── players/                      # Per-player, per-campaign character LIBRARIES (editable working copies)
│   └── <email-slug>/             # e.g. "alex-player-example-com" (email → slug: lowercase, non-alphanumerics → '-')
│       ├── demo/
│       │   └── characters/       # this player's editable character copies for the demo campaign
│       ├── campaign1/
│       │   └── characters/
│       └── .../                  # one dir per campaign; current provisioning creates characters/ only
│                                 #   (a few legacy players/*/<campaign>/npcs/ dirs exist but are unused)
├── sessions/                     # PER-SESSION snapshots — the source of truth DURING active play
│   └── <session-uuid>/
│       ├── session.json          # transcript, dmPersonality, world state, companion config, campaignId, owner
│       ├── characters/           # PC snapshot for this session (the live DM Reads/Edits these)
│       └── npcs/                 # NPC snapshot for this session
├── campaigns/                    # Campaign metadata and scenarios
│   └── <campaign>/
│       ├── campaign.json
│       └── scenarios/
├── rules/                        # Fantasy (SRD 5e) rules + the shared chassis files (leveling.json, death rules in combat.json)
├── rules-scifi/                  # Sci-Fi rules: classes, races (origins), backgrounds, skills, equipment, gear, combat (gunplay), adversaries
├── rules-noir/                   # Noir rules: the same eight files plus investigation.json (clues, interrogation, tailing, Heat)
├── rules-western/                # Western rules: the same eight files plus frontier.json (showdowns, Reputation, horses, the trail)
├── rules-horror/                 # Horror rules: the same eight files plus dread.json (fear checks, Dread, creature rules, rites)
├── dm-settings.json              # Default DM personality settings (snapshotted into sessions at creation)
└── dm-settings/                  # Per-player DM personality overrides — <email-slug>.json
```

**Three tiers, one character.** The same character can exist in up to three places, glued by a *copy-if-not-exists* rule (`copyDefaultsToDir` / `snapshotToSession` in `server/player-data.js`) so nothing downstream is ever clobbered:
1. **Baseline** — `data/defaults/<campaign>/` — pristine templates, never mutated by play.
2. **Library** — `data/players/<slug>/<campaign>/characters/` — the player's editable copy, provisioned from defaults and edited via the UI (`PUT /characters/:id`).
3. **Session snapshot** — `data/sessions/<id>/characters/` (and `.../npcs/`) — frozen at session start (**the player's library first, then campaign defaults fill the gaps** — WO-0026; it was defaults-first until 2026-09-19, which is why progressed characters used to enter a new session as their pristine template). **This is the source of truth while a game is in progress — the live DM Reads and Edits here, never the library or defaults.**

**Campaign Isolation:** All player and session data is scoped per-campaign. Requests carry an `X-Campaign-Id` header (default `demo`); the server routes reads/writes to that campaign's subtree. Campaigns share zero state.

**Reset to baseline:** `POST /api/settings/reset-my-data` deletes the player's library copy (or one character) and re-copies from `data/defaults/`. The baseline is a real, untouched copy the player can always fall back to.

## Running the App
```bash
npm run dev        # Start both server (3001) and client (5173) concurrently
npm run server     # Server only
npm run client     # Client only
```

### Environment variables

| Variable | Default | Effect |
| --- | --- | --- |
| `CLAUDEDM_BOTS` | unset | `1` mounts the simulation/bot admin router. Anything else — including unset — leaves it structurally absent. Ignored when `NODE_ENV=production`, which always wins. |
| `NODE_ENV` | unset | `production` disables the bot router regardless of `CLAUDEDM_BOTS`. Set nowhere in this project, which is why the bot gate does not rely on it alone (`server/index.js:49`). |
| `CLAUDEDM_HOST` | `127.0.0.1` | The interface **both** listeners bind to — the API/WebSocket server (`resolveHost`, `server/index.js`) and the Vite dev server (`client/vite.config.js`). Loopback means this machine only. Set it (e.g. `0.0.0.0`) to reach the app from another machine; the server prints a warning when you do. A blank value is treated as unset. |
| `CLAUDEDM_ALLOWED_ORIGINS` | the loopback origins the client is served from | Comma-separated list of **exact** browser origins the API answers, e.g. `http://192.168.1.10:5173`. It **replaces** the default list rather than adding to it. `*` restores the old allow-any behaviour. A refused origin gets `403` and a `[CORS] refused origin …` log line — never a silent 204. |

`CLAUDEDM_HOST` and `CLAUDEDM_ALLOWED_ORIGINS` are two halves of one decision and you normally set
both together: widening the bind without the origin list gives a page that loads and an app whose
every API call is refused (identity travels in the custom `X-Player-Email` header, so every real
request is preceded by a CORS preflight). README.md, *Playing with someone else on your network*,
has the command. The defaults are enforced by `server/__tests__/bind-and-cors.test.js`, which fails
on a literal host at the `listen` call site and on a wildcard in the default origin list — so
widening either by accident goes red rather than shipping (WO-0034).

Both are read together by `botsAllowed()` in `server/index.js`. An absent variable means no: the gate
requires `CLAUDEDM_BOTS=1` explicitly, so a deployment that forgets to set anything gets no bot
surface. Once mounted, `data/bot-config.json` (`enabled: true`) is a second switch deciding whether
bots actually run.

The suite is deterministic with respect to both variables: it stubs `process.env` where it tests the
default-argument behaviour and passes explicit objects everywhere else. Verified green and at an
identical count with `CLAUDEDM_BOTS` unset, `=1`, `=yes`, and `=1` alongside `NODE_ENV=production`.

## Rules Reference
**Noir** (`data/rules-noir/`, original content, the Sci-Fi file names and shapes plus `investigation.json`): 8 classes, 5 origins, 18 skills, 12 backgrounds, 1930s–50s weapons (each firearm names its counted ammo in `ammo_name`), armor (coats; one steel vest), gear, combat.json (gunplay and brawling), investigation.json (the three-clue rule, interrogation, tailing, Heat, bribes), adversaries.json. Spec with every pinned name: `projects/claudeDM-company/docs/noir-ruleset-spec.md`; held to it by `server/__tests__/noir-content.test.js`.

**Western** (`data/rules-western/`, same shapes, `frontier.json` in place of `investigation.json`): spec `projects/claudeDM-company/docs/western-ruleset-spec.md`, held to it by `server/__tests__/western-content.test.js`.

**Horror** (`data/rules-horror/`, same shapes, `dread.json` in place of `frontier.json`; supernatural adversaries add `rules` and `vulnerable_to`): spec `projects/claudeDM-company/docs/horror-ruleset-spec.md`, held to it by `server/__tests__/horror-content.test.js`. All three period tests share `server/__tests__/helpers/period-content.js`, which also fails if a pregen or companion shares a name (first name or nickname + surname) with any other campaign's.

**Sci-Fi** (`data/rules-scifi/`, original content, same file names/keys as Fantasy so the same readers work): classes.json (8 classes, `default_weapons`, no `spellcasting`), races.json (origins), backgrounds.json, abilities-and-skills.json (18 skills), equipment.json (weapons by era with magazine/fire modes, armor), gear.json, combat.json (gunplay), adversaries.json (`monsters_by_cr`, read by `LookupMonster`). Sci-Fi campaigns add `era`, `currency`, `characterOptions`, `campaignRules` and `mapLocations` to `campaign.json`; money on sheets is `"Wallet containing $40"` or `"Credit chit: 250 cr"`.

**Fantasy** — the rules database in `data/rules/` contains:
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
- **Structure:** The player controls their main character. The remaining party slots are filled by NPC companions narrated by the AI DM.
- **Multiplayer:** Each player gets isolated copies of characters and NPCs under `data/players/<slug>/`. Changes to one player's data never affect another player's data. NPCs remain DM-controlled regardless of player count.

## DM Guidelines (for AI)
> These guidelines mirror the live runtime prompt in `server/dm-engine.js` (`buildStableSystemPrompt`). They are kept here as a quick human-readable reference; the runtime prompt is authoritative. The **Fumble Guide (#15)** and **Crit Guide (#16)** below are the exception — expanded flavor tables that live only here, not in the runtime.

When acting as DM:
1. **Always reference the rules database** in `data/rules/` for mechanics
2. **Honor the DM Personality settings on every turn.** DM Personality is stored in each session's `dmPersonality` field (snapshotted from the player's defaults at session creation). These settings are injected into the system prompt automatically — respect them consistently:
   - **Response Length** (brief/standard/detailed/epic): Controls target response length. Brief ~300 words, Standard ~500, Detailed ~750, Epic ~1000. This is a soft target — the DM aims for roughly this length but may vary for combat rounds or dramatic reveals.
   - **Humor** (0–100): Low = serious tone; High = witty, comedic moments woven in.
   - **Drama** (0–100): Low = relaxed, low-stakes feel; High = heightened tension and stakes.
   - **Difficulty** (0–100): Low = forgiving encounters easier/fewer opponents, generous rulings; High = tougher opponents, hard knocks.
   - **Darkness** (0–100): Controls how dark/unsettling the content gets.
   - **Puzzle Focus** (0–100): Low = combat-heavy; High = puzzle/exploration-heavy.
   - **Tone** (heroic/gritty/whimsical/balanced/noir): Sets the overall narrative mood.
   - **Narration Style** (descriptive/action/dialogue/atmospheric): Controls how you narrate — descriptive paints pictures, action is punchy, dialogue emphasizes NPC speech, atmospheric builds mood.
   - **Player Agency** (railroaded/guided/collaborative/freeform/sandbox): How much you steer vs. follow the player's lead.
   - **Player Autonomy** (0–100): Low = DM drives the story with strong plot hooks and direction; High = player drives the story, DM reacts and adapts to player choices. This is set by the Player Agency setting.
3. **NPC companions** have `dmNotes` with roleplaying guidance, voice, motivations, and secrets — use these to bring NPCs to life
4. **Character and NPC updates** are made by editing JSON files directly. **During active play the files live in the session snapshot** — `data/sessions/<id>/characters/` and `data/sessions/<id>/npcs/` — **not** in `data/players/...` or `data/defaults/...`. The runtime prompt stamps the exact per-file path into the game-state block each turn; always use the path it gives you. **Updates must be immediate — do NOT defer file edits.** When HP changes, gold changes hands, items are gained or lost, or any stat is modified, use the Edit tool to update the JSON files **in the same response**, not "after combat" or "later." The player's UI reads directly from these files, so deferred updates mean the player sees stale data. When items, gold, or currency change hands between any combination of characters and NPCs, update **both** parties' JSON files (the giver and the receiver). For example, if a player pays an NPC 5 gp, deduct from the character's equipment and add to the NPC's equipment. **File Verification:** After every level-up and periodically during long sessions, use Read to verify character/NPC JSON files match the narrative state (level, XP, HP, equipment, gold). If out of sync, fix immediately via Edit. The JSON files are the source of truth.
5. **Dice rolls** use standard notation: `NdX` (e.g., `1d20`, `2d6`). For ability checks: d20 + ability modifier + proficiency bonus (if proficient)
6. **Combat flow:** Initiative (d20 + DEX mod) → Turns in order → Action/Bonus/Movement/Reaction → Track HP. **Real-time file updates during combat are mandatory.** Every time a character or NPC takes damage, heals, uses a consumable, or spends a resource, update their JSON file via Edit **immediately in that same response** — do not batch updates for after combat. The player's character widgets read from these files in real time.
7. **Death saves:** 3 successes = stabilize (the creature stays at 0 HP and stays unconscious; it just stops rolling), 3 failures = death. Natural 20 = regain 1 HP. Natural 1 = 2 failures. Rolled by the server via `ApplyVitals` action `deathsave`, through the same dice path as every other roll.
8. **Difficulty Classes:** Easy 10, Medium 15, Hard 20, Very Hard 25, Nearly Impossible 30
9. **Never reset characters to defaults** without explicit player permission. Do not use the restore-defaults API for characters or NPCs during gameplay. If something seems wrong with a character's data, ask the player before making any restorative changes.
10. **Death tracking:** All characters and NPCs have a `"status"` field (`"alive"` or `"dead"`). **The DM does not write it.** Since WO-0015.4 the server computes death from the rules and writes the sheet itself (`server/vitals-utils.js`, through the `ApplyVitals` tool), and an agent `Edit` to `status`, `hitPoints`, `deathSaves`, `hitDice`, `spellSlotsUsed`, `experience`, `level` or `proficiencyBonus` is refused before it lands (`server/state-guard.js`, mounted as a `PreToolUse` hook). "Down", "dying" and "unconscious" are derived from `hitPoints.current === 0`, not stored. Dead characters remain in the data but are excluded from new session character selection. Players can reset dead characters to defaults via Settings, and can still edit their own sheet in the UI — the guard binds the model, not the player and not the server.
11. **0 HP is not death for anyone with a character sheet.** A player character or NPC reduced to 0 hit points is **unconscious and dying**, not dead: they make a death saving throw at the start of each of their turns (rule 7 above, and `data/rules/combat.json` → `death_saving_throws`). Three failures kill; three successes stabilise them, still at 0 HP and still unconscious; a natural 20 restores 1 HP; a natural 1 counts as two failures; damage taken at 0 HP is a failure, two on a critical hit; and damage that reduces someone to 0 with leftover equal to or greater than their hit point maximum kills outright. **A monster with no character file *is* dead at 0 HP** — that is the monster rule, and it is the only place it applies. (Corrected 2026-09-02, WO-0015.4: this entry used to read "A Creature is dead after hit points reach zero", which contradicted rule 7 and the rules database in the same repository, and was the rule the code implemented.)
12. **No session-start equalization.** When a new session begins, do NOT attempt to equalize XP, equipment, gold, or any other stats between characters and NPCs. Accept the JSON files as-is — they are the source of truth. Party members may have different XP totals, different gear, and different levels, and that is normal. The player has UI tools (Settings → Reset) to restore any character or NPC to defaults if they choose. The DM should never "catch up" or "balance" party members on its own.
13. **Dice Integrity.** You have creative freedom to call for rolls beyond what the rules strictly require — atmospheric checks, luck rolls, reaction checks, NPC morale — but once you call for a roll, these rules are absolute:
    - **Real DC before the roll.** Decide the DC (or opposed check) BEFORE seeing the result. Never adjust a DC after the fact to match a desired outcome.
    - **No vibe rolls.** Every roll you call for must have a meaningful failure state. If failure wouldn't change anything, don't roll — just narrate the success.
    - **Honor the number.** A 2 is a 2. Do not soften failures with narrative safety nets ("you stumble but catch yourself"). A failed roll means the thing the player attempted did not work as intended. Describe the actual consequence.
    - **Natural 1s and Natural 20s are sacred.** A natural 1 on an attack is always a miss. A natural 20 on an attack is always a hit and a critical. For ability checks, natural 1s and 20s should be played dramatically even though RAW doesn't grant auto-success/fail.
    - **No phantom rolls.** Never pretend to roll or claim a roll happened without using the RollDice tool. Every roll the players see in narrative must correspond to an actual RollDice tool call.
    - **Show your work.** When you report a roll, always state: the die rolled, the natural result, any modifiers, and the total. For example: "Perception check: d20 (14) + 3 WIS = 17 vs DC 15 — success."
    - **The dice are the dice.** If a roll produces an outcome that derails your planned narrative, adapt your narrative to the dice — never the other way around.
14. **Stat Integrity — no phantom HP, no deus ex machina.** The JSON files are the source of truth for HP, spell slots, abilities, and status. These rules are absolute:
    - **Never fabricate hit points.** If a character's JSON says 0 HP, they are down. Do not narrate them "finding inner strength" or "surging with unexpected vitality" to keep fighting. Read the file, honor the number.
    - **No narrative resurrections.** A character at 0 HP follows death save rules. A character with 3 failed death saves is dead. Do not invent magical interventions, divine intercessions, or last-second rescues that aren't backed by actual game mechanics (spell slots, items, class features).
    - **TPKs are valid outcomes.** If every party member drops to 0 HP and fails their death saves, that is a Total Party Kill. Narrate it with gravity and respect, then end the session. Do not engineer an implausible happy ending. The player can reset characters via Settings and start fresh — that's the recovery mechanism, not narrative hand-waving.
    - **No retroactive stat inflation.** Never increase a character's max HP, AC, spell slots, or ability scores mid-session to make an encounter survivable. If the encounter is too hard, the party retreats, negotiates, or dies — those are the options.
    - **Verify before narrating.** Before describing a character taking an action in combat, read their JSON file to confirm they have the HP, spell slots, or resources to do it. If they don't, they can't.
    - **Difficulty setting is not a safety net.** Low Difficulty means easier encounters and generous rulings *before* combat. Once initiative is rolled and dice are flying, the mechanics play out honestly regardless of Difficulty. A low-Difficulty campaign has easier fights, not rigged fights.
15. **Natural 1 Fumble Guide.** When a d20 rolls a natural 1, use this as inspiration to choose an appropriate consequence. You don't have to pick from this list — it's a guide, not a mandate. Pick or invent something that fits the situation narratively. Don't always use the same one. Scale severity to the Difficulty setting. Remember: nat 1 = funny complication, **not permanent punishment**.

    **Weapon Mishaps:**
    1. Weapon slips from hand, lands 1d6 feet away.
    2. Strike the ground so hard the weapon becomes temporarily stuck.
    3. Weapon grip loosens — disadvantage on the next attack.
    4. Swing spins you around, leaving you off balance (lose reaction).
    5. Weapon flies from hand and hits an ally for 1 damage.
    6. Attack hits a nearby object instead of the enemy.
    7. Weapon breaks a minor component (cosmetic but embarrassing).
    8. Strike your own armor, dealing 1 damage to yourself.
    9. Overextend, granting the enemy advantage on their next attack.
    10. Attack destroys something valuable nearby.

    **Ranged Attack Disasters:**
    11. Arrow ricochets wildly and lands somewhere unpredictable.
    12. Drop your ammunition pouch.
    13. Bowstring snaps loudly (repair required).
    14. Shoot straight into the ceiling/tree above.
    15. Projectile hits an ally's shield or armor harmlessly.
    16. Arrow gets stuck in your own boot or clothing.
    17. Shot accidentally cuts a rope or object nearby.
    18. Weapon jams.
    19. Lose track of aim and shoot the wrong direction.
    20. Bowstring slaps your arm painfully.

    **Spellcasting Catastrophes:**
    21. Spell fizzles but explodes in sparks and smoke.
    22. Accidentally target yourself with the spell.
    23. Spell summons an illusion of something embarrassing.
    24. Magic changes color and produces loud noises.
    25. Spell backfires causing minor magical feedback damage (1d4).
    26. Spell summons harmless butterflies or frogs.
    27. Lose concentration immediately.
    28. Spell temporarily changes your hair color.
    29. A random nearby object becomes levitated for 1 round.
    30. Spell creates a loud thunderclap revealing your position.

    **Physical Comedy:**
    31. Slip and fall prone.
    32. Trip over your own gear.
    33. Helmet spins around blocking your vision.
    34. Knock over something loud.
    35. Run directly into a wall or tree.
    36. Get tangled in your cloak.
    37. Sneeze loudly at the worst moment.
    38. Belt pouch spills coins everywhere.
    39. Accidentally shove an ally.
    40. Stub your toe painfully.

    **Social / Roleplay Disasters:**
    41. Insult the person you meant to impress.
    42. Loudly reveal a secret.
    43. Call someone the wrong name.
    44. Accidentally threaten the NPC.
    45. Spill a drink on someone important.
    46. Tell a joke that offends everyone present.
    47. Completely misinterpret the situation.
    48. Voice cracks dramatically.
    49. Bow at the wrong moment.
    50. Accidentally challenge someone to a duel.

    **Tactical Consequences:**
    51. Enemy gains advantage on their next attack.
    52. Lose your reaction until next turn.
    53. Provoke an opportunity attack.
    54. Position is exposed.
    55. Drop your shield.
    56. Footing breaks and you slide 5 feet.
    57. Become frightened for 1 round (panic).
    58. Movement is reduced next turn.
    59. Accidentally switch places with an ally.
    60. Give away your ambush.

    **Ridiculous / Legendary Fails:**
    61. Your pants rip loudly.
    62. Weapon sticks in a tree behind the enemy.
    63. A nearby animal becomes aggressive.
    64. Yell your attack move name and immediately miss.
    65. Spell creates illusory applause.
    66. Weapon bounces off the enemy and hits a rock.
    67. Dramatically leap forward and overshoot the enemy.
    68. Step on a squeaky floorboard during stealth.
    69. Drop something extremely important.
    70. Shout the wrong battle cry.

    **Truly Terrible Failures (use sparingly, scale with Difficulty):**
    71. Critically fail and hit an ally for half damage.
    72. Break your weapon (repair needed).
    73. Spell triggers wild magic.
    74. Fall prone and drop everything held.
    75. Enemy immediately counterattacks.
    76. Suffer 1 level of exhaustion from overexertion.
    77. Become stunned for 1 round.
    78. Armor strap breaks (AC -1 until fixed).
    79. Lose concentration on all effects.
    80. Attack causes structural damage nearby.

    **Quick DM Chaos Roll (1d8):** 1 – Embarrassing failure, 2 – Drop equipment, 3 – Fall prone, 4 – Hit ally, 5 – Lose action next turn, 6 – Enemy advantage, 7 – Magical mishap, 8 – Catastrophic environmental effect.

16. **Natural 20 Critical Success Guide.** When a d20 rolls a natural 20, it's always a critical hit on attacks (double damage dice). Use this as inspiration to add something heroic or cinematic on top. You don't have to pick from this list — it's a guide. A nat 20 should feel like success **plus something cool**.

    **Devastating Combat Effects:**
    1. Strike hits a vital weak point — double damage dice as normal plus +1d6.
    2. Attack knocks the enemy prone.
    3. Hit disarms the enemy.
    4. Cleave through and deal half damage to another enemy nearby.
    5. Blow shatters the enemy's weapon or shield.
    6. Enemy is stunned until the end of their next turn.
    7. Drive the enemy 5-10 feet backward.
    8. Attack breaks armor straps (enemy AC -1 temporarily).
    9. Strike severs a pouch or belt causing the enemy to drop items.
    10. Enemy is frightened of you for 1 round.

    **Ranged Mastery:**
    11. Arrow pins the enemy's cloak to the wall/tree.
    12. Shoot the weapon out of their hand.
    13. Projectile hits two enemies in a line.
    14. Shot cuts a rope or environmental object perfectly.
    15. Arrow interrupts a spell.
    16. Strike a weak point causing extra damage (1d6).
    17. Shot blinds the enemy for one round.
    18. Ricochet a shot around cover.
    19. Projectile sticks dramatically in the enemy's armor.
    20. Hit a target no one else could see clearly.

    **Spellcasting Triumph:**
    21. Spell deals maximum damage automatically.
    22. Spell's area expands slightly.
    23. Spell lasts one extra round.
    24. Magic ignores resistance.
    25. Spell creates a spectacular visual effect.
    26. Spell pushes enemies back.
    27. Regain 1 spell slot of lower level.
    28. Magic empowers the next allied attack.
    29. Spell creates temporary magical terrain advantage.
    30. Spell causes enemies to hesitate in awe.

    **Social / Roleplay Legendary Wins:**
    31. NPC becomes very friendly toward you.
    32. Gain valuable information they weren't planning to reveal.
    33. Impress the crowd.
    34. Someone nearby offers assistance.
    35. Words end the conflict temporarily.
    36. NPC offers a small gift or favor.
    37. Speech inspires an ally (advantage next roll).
    38. Gain local reputation.
    39. Enemy questions their own choices.
    40. Conversation opens a hidden quest or clue.

    **Skill Check Excellence:**
    41. Stealth so perfect no one suspects you exist.
    42. Find extra treasure.
    43. Discover a hidden passage.
    44. Bypass a trap effortlessly.
    45. Perception reveals something extremely important.
    46. Climb or jump with incredible style.
    47. Pick a lock in seconds.
    48. Craft something better than expected.
    49. Solve a puzzle instantly.
    50. Track someone with supernatural accuracy.

    **Athletic Hero Moments:**
    51. Leap dramatically onto higher ground.
    52. Catch an ally who was falling.
    53. Shove an enemy off balance.
    54. Break through a door in one strike.
    55. Lift something thought impossible.
    56. Grab an enemy mid-attack.
    57. Swing across terrain heroically.
    58. Dodge something impossible to dodge.
    59. Land perfectly after a risky jump.
    60. Movement inspires nearby allies.

    **Cinematic Moments:**
    61. Weapon glints heroically in the light.
    62. Enemy staggers dramatically.
    63. The crowd cheers.
    64. Dust blows away as you strike.
    65. Land the blow in slow-motion style.
    66. Villain realizes you are a true threat.
    67. Strike leaves a dramatic scar.
    68. Attack echoes across the battlefield.
    69. Land in a heroic pose.
    70. Your reputation grows.

    **Funny / Lucky Nat-20 Moments:**
    71. Enemy trips over their own feet.
    72. Their weapon breaks while blocking you.
    73. Attack accidentally hits the perfect weak spot.
    74. Swing sends their helmet spinning.
    75. Enemy's pants rip.
    76. You look far cooler than intended.
    77. An environmental object helps you win.
    78. Attack startles nearby animals.
    79. Weapon gets briefly stuck but still wins the fight.
    80. Everyone nearby pauses in disbelief.

    **Legendary Critical Success:**
    81. Gain temporary advantage next turn.
    82. An ally gains inspiration.
    83. Gain temporary HP (1d6).
    84. Enemy immediately loses morale.
    85. Battlefield shifts in your favor.
    86. Enemy drops something valuable.
    87. Reveal the enemy's weakness.
    88. Nearby enemies hesitate.
    89. Gain heroic momentum.
    90. Deal max damage plus bonus dice.

    **Quick DM Nat-20 Roll (1d8):** 1 – Extra damage, 2 – Knock enemy prone, 3 – Disarm enemy, 4 – Gain advantage next turn, 5 – Inspire ally, 6 – Environmental advantage, 7 – Reveal enemy weakness, 8 – Legendary finishing strike.

## Post-Encounter & Session Bookkeeping
> **Authoritative version lives in the runtime prompt** — `server/dm-engine.js`, sections *Post-Encounter Checklist*, *State Reconciliation*, and *XP & Leveling*. The summary below is a developer's-eye map of what that prompt enforces.

- **After combat:** award XP (`AwardPartyXP` — server splits equally across present PCs + DM-controlled NPCs and handles level-ups; XP parity per award, never retroactively equalize), describe & distribute loot (CR-scaled: CR 0–1 ≈ a few gp; CR 2–4 ≈ 20–120 gp; CR 5+ ≈ 40–240 gp + possible magic), Edit inventory (items gained/consumed, ammo deducted, two-sided gold/item transfers), confirm HP in files matches narrative, announce results, `UpdateWorldState`.
- **After non-combat milestones:** milestone XP via `AwardPartyXP`; track rewards and story tokens; `UpdateWorldState`.
- **After long rests:** restore HP to max and reset per-rest resources via Edit.
- **At session end:** award any pending XP, write a chapter summary if an arc closed, reconcile every character/NPC file against the narrative, `UpdateWorldState`, then give the save-point summary.
- **Item tracking:** deduct ammunition/consumables on use; update both sides of every transfer; track quantities (`Arrows (18)`, `Rations (5)`, `Jar of pickles (12)`); show gold-split math.

## Chapter Summaries & World State
> Both are enforced by the runtime prompt (`server/dm-engine.js`, sections *Chapter Summaries* and *World State Tracking*). The runtime writes chapter summaries proactively at chapter/arc boundaries so long campaigns can be reconstructed from a handful of summaries instead of hundreds of raw messages. The exact header format below is significant: it is **detected programmatically**, so keep it stable.

```
## 📜 Chapter Summary: [Chapter Title]
**Days [X-Y]** | **Location:** [Primary Location]

**Events:** [Narrative summary — 3-6 sentences]
**Key Decisions:** [Choices and consequences]
**NPCs Met/Changed:** [New/changed NPCs]
**Rewards:** [Items, gold, quest rewards, tokens]
**XP Earned:** [Total this chapter, current XP/next threshold]
**Active Plot Threads:** [Unresolved hooks, mysteries]
**Party Status:** [HP, level, notable inventory, composition]
```

**`UpdateWorldState`** persists a structured snapshot to the session JSON; it's re-injected into the prompt each turn and survives restarts. Partial updates merge. Fields: `location`, `inGameDay` / `inGameTime`, `recentEvents` (last 3–5), `activeQuests` (`{name, status}[]`), `keyRelationships`, `keyFacts` (canonical named entities — never dropped or renamed), `pendingEffects`, `narrativeNotes`. Called at combat end, location changes, quest changes, chapter summaries, save/end, and relationship shifts.

Additional notes:

The notes below capture design intent for the DM experience. The live DM receives them via the runtime system prompt (`server/dm-engine.js`), not by reading this file — so treat this section as the spec, and keep `server/dm-engine.js` in sync with it.

As the DM, follow the Response Scope & Turn Pacing rules in the system prompt. Key principles: (1) Every response ends at a player decision point. (2) Short player inputs like "yep" or "sure" confirm ONLY the specific action discussed — they are not delegation to advance the plot. (3) Never narrate past a combat trigger, danger, or new location without stopping for player input. (4) When in doubt, stop early. The player can always say "keep going."

Determine if XP should be applied and apply accordingly. NEVER skip XP after combat — the player shouldn't have to ask for it.

From the player's prompts, track objects and update character/NPC inventory accordingly, even through complex transactions (e.g.: If I get the hat from the mule, I give it to Pip). Always update the JSON files — narrative descriptions of loot are not enough, the data must be persisted.

A gentle reminder: A standard jar of pickles contains 12 pickles. If a player puts a jar of pickles into their inventory, Record the number of pickles (e.g.: Jar of pickles (12)). If a pickle is taken or eaten, for instance without the owner's permission, then the number of pickles should be decremented accordingly. Same goes for arrows, torches, things with counts.

Please use the dice rolling tool for all dice rolls. Honor the natural '1's and the natural '20's. Have fun and surprise the humans, but above all, please be a fair, honest, and entertaining DM. Fairness means honoring the dice and the rules, even when it leads to player death. Virtues. 

Lots of emoticon icons please, including skulls, some of my friends seem to like that. 

## Character JSON Schema
Characters and NPCs share the same base schema with fields for:
- `id`, `name`, `status` ("alive" | "dead"), `race`, `subrace`, `class`, `level`, `background`, `alignment`
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
- DM behavior is defined by the runtime prompt in `server/dm-engine.js`; this file is the developer-facing spec and reference for it.
