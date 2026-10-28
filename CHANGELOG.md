# Changelog

All notable changes to this project are documented here.

## [1.0.28] - 2026-10-28
Work order: WO-0050. Release record: decision `0029`.

**Fixed: a turn could be written into another player's saved game** (SR-2026-10-28-1, found during WO-0050's review)
- In 1.0.27, a timing problem in the live connection could save one player's turn, and the Game Master's reply, into another player's saved game. It needed no other player's login. Revision 3 binds each turn to the save it started on, and a regression test keeps it that way (`server/__tests__/cross-player-watch.test.js`). The live connection still does not check a save's `visibility` when it is watched; that is WO-0051.

**The Premium badge is now enforced, per player, on starting an adventure** (WO-0050)
- New per-player flag `premiumAccess` on the record in `data/players.json`. Default `true` (`DEFAULT_PREMIUM_ACCESS`, `server/player-auth.js`); an absent field means the default, so **nobody's play changes** and no record is migrated. `POST /api/players/register` writes `premiumAccess: true` explicitly and ignores any `premiumAccess` in the request body. No route sets it; an admin edits the file. Any value other than `true` or absent (`false`, `"false"`, `null`, `0`) is read as no.
- Which campaigns are Premium: every campaign not in `FREE_CAMPAIGN_IDS` (`server/premium-gate.js`, `['demo']`). **Not the badge**: `POST /api/campaigns` lets any logged-in user write a `listing`. Unknown and user-created campaigns are Premium. A test holds the shipped badges to the allowlist.
- A player with `premiumAccess: false` is refused by the server — `403` over REST, an `error` over the WebSocket, message *"This campaign isn't available on your account."* — at `POST /api/sessions` (campaign from `X-Campaign-Id`), WebSocket `session_start`, a `session_resume` that does not resume a saved game in that campaign, and a single-player `user_message` with no saved session bound.
- **Not gated:** resuming a saved game, joining another player's session as a companion, and the bot orchestrator (which goes through the gated paths with its own accounts, all at the default).
- `GET /api/campaigns` and `GET /api/campaigns/:id` carry a server-computed `premium` boolean. Login and register responses carry the resolved `premiumAccess`.
- Home: for a `false` player, a Premium campaign's **Start Adventure** card is grayed out and inert, reading "Not available on your account"; the other cards stay usable. The Adventure page's Begin Adventure button is disabled with the same words.
- With a saved session bound, a single-player WebSocket turn now runs in **that session's saved `campaignId`**, not whatever the connection last named. Before, a refused Premium `session_start` followed by `session_watch` of the player's own demo save ran the GM in the Premium campaign and copied its characters into the demo save (SR-50-1, WO-0050 revision 2). A legacy save with no `campaignId` falls back to the connection's value and is gated as a start.
- A single-player WebSocket turn's inputs (campaign, session, character, scenario, companion config, GM personality, player email, history) are pinned at the gate and used for the whole turn, including the reconcile. Before, a `session_start` landing a few milliseconds after the gate swapped the in-flight turn into the refused Premium campaign (SR-50-4, revision 3). A refused `session_start` now assigns no connection state; it sets a refusal that blocks `user_message` until a successful start, resume or own-save watch. A refused `session_resume` does the same.
- A saved `session.json` `campaignId` is trusted only if it is a well-formed id; otherwise the turn is gated as a start, and a multiplayer turn in such a save is refused (SR-50-5, revision 3). The GM can still edit `session.json` to another valid id; closing that is WO-0039's.
- The WebSocket `session_start` and `session_resume` refuse a non-string `campaignId` (`Invalid campaignId.`). An array such as `['demo']` used to pass the id check by string coercion (SR-50-3).
- **Only logged-in players start a new game, over the WebSocket too** (WO-0050 revision 4). "Logged in" means the email names a registered record in `data/players.json` — the test `POST /api/sessions` already applied ("Login required. Guests cannot create sessions."). One exception, found in review and not fixed here: the REST check accepts the emails `constructor` and `__proto__` as registered (SR-50-7, low). It creates ownerless saves that cannot be played; the fix is WO-0051. WebSocket `session_start`, and a single-player `user_message` gated as a start (no saved session bound), now refuse `guest`, an empty email and any unregistered email, in **every** campaign including the free `demo`, with an `error` carrying `code: 'login_required'` (*"Login required. Guests cannot start a new game."*; an empty email keeps *"playerEmail is required to start a session."* and gains the code). The check runs before the Premium check and before any connection state is assigned, and a refused start blocks the next `user_message` the same way a Premium refusal does. **Unchanged:** resuming a saved game, watching or joining sessions, multiplayer turns and chat.
- **This is an account setting, not a paywall.** Identity is a self-asserted `X-Player-Email` / WebSocket `playerEmail` (decision `0005`). Since revision 4, **guests and unregistered emails can no longer start a game** — a made-up email, `guest`, or a `chat_join` that switches the connection to one. **But self-registration is open, and a fresh registration is logged in and gets the default `true`**, so a `premiumAccess: false` player can still start a Premium game by registering a new account, or by claiming another registered player's email (in the header, in `playerEmail`, or by `chat_join`). Nothing is for sale (decision `0008`).

**"Scenarios (spoilers!)" links hidden** (WO-0050)
- The card on Home and the sidebar link are hidden behind `SHOW_SCENARIO_LINKS = false` (`client/src/utils/features.js`); set it to `true` to bring them back. The `/scenarios` and `/scenarios/:id` routes and pages are kept and load if the URL is typed.
- **World Map scenario links hidden too** (revision 4). With the same flag false, World Map pins no longer navigate to `/scenarios/:id` (no handler reaches any map: the data-drawn `SchematicMap` and every painted map), the pins stop showing a pointer cursor, and the page no longer says "Click a location/region/district to view its scenario" or "Browse … on the Scenarios page". Pin names and hover labels are unchanged. `true` restores all of it.
- Tests: 1169 → 1268 (46 files), all passing. Client build passes.

## [1.0.27] - 2026-10-25
Changes since `1.0.26` (public `demo_1.0.26` = `13bee42`, tree identical to `projects/claudeDM` at `b37d6e1`). Work order: WO-0048. Published as `demo_1.0.27`, one commit on top of `demo_1.0.26`.

**Not in this release:** WO-0039 (closing the GM toolset; its Scope addition A). SEC-2026-10-03-1 stands as described in `[1.0.26]` below. The production halt (INC-0003; VP Cyber Security, 2026-10-25) is unchanged by this release: only the chair may reach claudeDM until WO-0039 ships and is re-verified, and the service no longer runs as a user with passwordless sudo.


**Seven new campaigns: Sci-Fi, Noir, Western and Horror now have five each** (WO-0048)
- Sci-Fi: `saltmoon`, *Charter's End* (future; an ice-moon mining colony in its last thirty days).
- Noir: `bluenote`, *Dead Men Vote Tuesday* (Kansas City, 1936); `crescent`, *Ash Wednesday* (New Orleans, Carnival 1946).
- Western: `vigilance`, *The Winter List* (Montana Territory, 1864, the category's first 1860s campaign); `stageline`, *Star Route* (New Mexico Territory, 1881).
- Horror: `blackdamp`, *Blackdamp* (a West Virginia coal camp, 1927); `pinecrest`, *Lantern Night* (an adults-only camp in the Poconos, 1977).
- Each has four scenarios, six pregens and four companions. They were written in staging by one author per campaign and merged by the CEO after a cross-campaign name check.
- **The generator now respects era on weapons.** `buildWeapons` (`server/scifi-character-generator.js`) only swapped weapons for the `future` era, so a character rolled for an 1860s campaign got the 1870s Army revolver and .45 cartridges. An out-of-era weapon is now swapped for its period equivalent (`PERIOD_SWAPS`), or failing that for the first era-legal weapon of the same group. `period-content.js`'s sheet check now fails any authored or generated sheet that carries a weapon outside its campaign's era. **Not fixed:** ten Western adversary stat blocks tagged for the 1860s still attack with the Army revolver. `vigilance`'s campaign rule "The 1864 Armory" names five of them; the other five are uncovered (QC, WO-0048). Out-of-era stray ammunition on a sheet is not tested, and the Sci-Fi sheet check has no era test.
- Tests: 1129 → 1169 (40 files), all passing. Client build passes.
- **Repeated-name cleanup** (WO-0048 Log, 2026-10-25). Renamed story-only NPCs (and three newspapers) so no surname in the seven is shared with any campaign, no first name is shared between two of the seven, and no distinctive first name is shared within a category. Character-sheet names (pregens and companions) are unchanged; three sheet clashes are recorded exceptions (Marchbanks, Ada, Rafael). Also fixed: stageline's two all-caps "ENOS PETREE" now read "JETHRO PETREE", matching the character. Evidence: `records/reports/2026-10-25-qc-tester-ceo-wo0048-rename-evidence.md`.
- `package.json` version → `1.0.27`; `client/src/data/changelog.js` gets a 1.0.27 entry. `package-lock.json` still reads `1.0.24` (pre-existing; not changed).
- **Known, not fixed:** stageline's `setting.name` is 125 characters against an 80-character limit; GM-only campaign fields are served without login; per-turn state fields are unbounded (Security Reviewer, WO-0048, all low and pre-existing in kind).

## [1.0.26] - 2026-10-23
Changes since `1.0.25` (starting after commit `5132420`, "v1.0.25"), reconciled against `git log 5132420..e30e584 -- projects/claudeDM` (six commits: `a51711c`, `88bb53c`, `a01ce00`, `79f3c67`, `628b9a7`, `5f013fc`) plus the uncommitted rebrand of WO-0047. Work orders: WO-0026, WO-0032–WO-0038, WO-0040–WO-0045, WO-0047. Referenced as still open: WO-0030, WO-0039.

**Branch status:** `v1.0.26` is a **code freeze** (decision `0027`), to be cut by the human chair as `v1.0.26` from the freeze commit (it does not exist at the time of writing). No feature work on that branch; a fix lands there only at the chair's direction. No tag named `v1.0.26` — a branch and a tag of the same name make the refname ambiguous.

**The app is `adventurefrog`** (decision `0027` §4, WO-0047)
- `client/src/utils/brand.js` `APP_NAME = 'adventurefrog'` — always lowercase, including at sentence start; no CSS `text-transform` touches it. `client/index.html` `<title>`, the `server/index.js` startup log line, `package.json` `description`, `README.md` and `CLAUDE.md` titles follow. `package.json` `name` (`dnd-companion`) is an internal identifier and is unchanged.
- Where "AI Game Master" described the **role** it is now "Game Master" (`GM_TITLE`): `Home.jsx`, `NpcList.jsx`, `Eli5.jsx`, the demo's `campaign.json` blurb. This supersedes the "AI Game Master" name in the Branding line further down this same section.
- **Not changed:** the GM's own instructions (`server/dm-engine.js`, "You are an AI Game Master for …") — model behaviour, not branding. Historical changelog entries are not rewritten.
- The name is for the chair's own install. Publishing under it is a `docs/legal-guidelines.md` trip-wire and goes to the board first.

**A new session starts from the player's character** (WO-0026, `a51711c`)
- `snapshotToSession` (`server/player-data.js`) copied campaign defaults *before* the player library with a filename-keyed skip; the library is seeded from those defaults under the same slugified names, so the pristine template always won. A level-5 character with a Bag of Holding entered a new session as the level-1 template it grew from.
- Now: library first, defaults fill gaps only, and the skip is keyed on the sheet's `id` (`copySheetsIfIdNotPresent`), so a renamed character cannot mint a second file.
- An unreadable library sheet is skipped and logged (`safeReadJsonFile`), not thrown: the first revision of the fix let one corrupt sheet empty the whole party (Security Reviewer, medium; fixed in revision 2).
- NPCs still come from campaign defaults only.

**Transfer audit no longer satisfied by one side of a transfer** (WO-0032)
- `server/dm-audit.js`: transfer categories now check which sheets were actually written against which entities the turn implicated (`writtenTargets`, `implicatedSheets`, `transferSatisfied`); a one-sided transfer reaches `needsReconcile`. A gold piece had been destroyed in live play this way. `ws-handler.js` threads the roster (`sessionRosterSheets`) into both audit call sites. Tests: `server/__tests__/transfer-audit.test.js`, `transfer-reconcile.test.js`.

**Server binds loopback; CORS is a closed list** (WO-0034)
- `server/index.js`: the server listened on `*:3001` and answered `Access-Control-Allow-Origin: *`. It now binds `CLAUDEDM_HOST`, default `127.0.0.1`, and answers only `CLAUDEDM_ALLOWED_ORIGINS` (default: the loopback origins on the client and server ports; the variable *replaces* the list; `*` restores allow-any explicitly). A refused origin is a visible `403` with a log line, not the `cors` package's silent `204`. Requests with no `Origin` header (curl, bots, tests) pass untouched.
- `client/vite.config.js` reads the same `CLAUDEDM_HOST` (was the literal `'0.0.0.0'`); `bind-and-cors.test.js` fails if it becomes a literal again.
- `README.md` "Playing with someone else on your network" documents both variables.
- **Known gap, not fixed:** the WebSocket at `/ws` performs no `Origin` check (`server/index.js` header comment). The loopback bind applies to it; the origin policy does not.
- **Halt in force** (VP Cyber Security, 2026-10-03, SEC-2026-10-03-1): no `CLAUDEDM_HOST` other than loopback and no widening of `CLAUDEDM_ALLOWED_ORIGINS` until WO-0039 (close the DM toolset) lands or the chair re-accepts the finding. `_buildOptions` still passes no `tools` key. This release does **not** lift it.

**Campaign and session ids are ids, never paths** (WO-0041, in review)
- `server/campaign-context.js`: `X-Campaign-Id` must match `SAFE_CAMPAIGN_ID` (`/^[a-z0-9][a-z0-9-]{0,63}$/`) and `X-Session-Id` `SAFE_SESSION_ID` (`server/player-data.js:12-13`); anything else is a `400`.
- `PUT /api/sessions/:id` now does `delete payload.campaignId` (`server/routes/sessions.js:600`): a session's campaign is fixed at creation and a body field cannot re-route its files.
- This is *believed* to fix the chair's 2026-10-23 report (host browses another campaign; the next multiplayer turn runs in it) — **by code reading only**. Not reproduced, no regression test, and the client still sends the browsed campaign on autosave. Not claimed as fixed.

**GM model list; the model is admin-only** (WO-0044)
- `client/src/pages/Settings.jsx`: Haiku 4.5 / Sonnet 5.5 / Opus 5.5, and a Default label that says what it is ("Claude Code's default model" — install-dependent, not this app's). A model saved before the list changed still displays rather than reading as Default.
- `server/routes/dm-settings.js` `withoutModel`: the GM model is set through `PUT /global` (admin) and read from the global file alone; a per-player settings file never sets or overrides it.

**Campaign palettes and scene moods** (WO-0037; revision round WO-0038 open)
- `client/src/data/campaignPalettes.js` gives three campaigns their own colours (`campaign5`, `wonderland`, `reckoning`); `utils/palette.js`, `utils/sceneLighting.js`, `hooks/useSceneLighting.js` (mounted once in `App.jsx`). A mood switcher appears in the Adventure header only for a campaign with a palette.
- Settings → Appearance: `campaign` (default: the campaign's colours, held still), `campaign+moods` (opt-in), `classic`. Freeze lighting is per device. All of it is `localStorage` only — no route, no per-player file, no path to the GM's prompt. Semantic colours (damage, healing, spell schools) never move.
- The Art Director failed the authored palettes on 2026-09-23 (several within-campaign mood pairs too close to see); WO-0038 is the revision and is open.

**Simulation rails — still dormant** (WO-0033, WO-0036)
- A model-driven player brain (`server/bot/bot-brain-model.js`, `bot-brain-registry.js`), `server/query-semaphore.js` extracted from `dm-engine.js`, and a party-of-six Haiku shape with a bot-farm panel in Settings. Still mounted only under `CLAUDEDM_BOTS=1` and never under `NODE_ENV=production` (`botsAllowed`, `server/index.js:180`); unset on the chair's machine, so nothing mounts. Both work orders are open.

**Tests: 464 → 1129, both module systems guarded** (WO-0035)
- The no-live-agent guard was CommonJS-only; an ESM import of the SDK bypassed it. `vitest.config.js` now aliases the SDK's ESM specifiers to `helpers/sdk-esm-guard.mjs` (patterns from `helpers/no-live-agent-esm.mjs`), alongside the CommonJS guard. WO-0035 is in review.
- First client tests: `client/src/utils/__tests__/` (palette, scene lighting, money, the ESM guard from inside the client tree) and `client/src/pages/__tests__/bot-farm-panel.test.js`.
- `npm test` at this release: **40 files, 1129 passed**, zero agent spawns.

**First scene images in play:** the demo's *Sunken Temple of Tidecaller* ships Corwin's bronze medallion (`tidecaller-medallion.png`), and *Lost Mine of Whisperhollow* ships the missing villagers' hand-drawn tunnel map (`data/campaigns/demo/assets/whisperhollow-villagers-map.png`, made by the chair in ChatGPT, with a provenance note). The GM shows it in the adventure transcript with `ShowSceneImage` when the party finds it inside the mine doors, and again whenever a player asks. The first use of the scene-imagery pipeline outside Wonderland. A test now holds every shipped manifest to its files and provenance notes. The GM's image rules now say to show a picture in the turn its moment arrives, and that the GM cannot see pictures, so it describes only what the scenario says is in them (both from the chair's playtest).

**A fifth category: Horror** (decision `0026`, WO-0045)
- **Horror ruleset** in `data/rules-horror/`: 8 classes (Skeptic, Occultist, Chaplain, Physician, Hunter, Veteran, Sensitive, Roughneck), 5 origins, 18 skills (Occult, Research, Driving…), 12 backgrounds, weapons for the 1890s, 1920s and 1970s with counted ammo (silver, iron and fire matter), adversaries whose supernatural entries carry `rules` and `vulnerable_to`, `combat.json` with darkness, fire and fleeing, and a new `dread.json`: fear checks, the Dread track, recovery, creature rules, rites and wards, light, isolation, and GM guidance including table safety.
- **Three Horror campaigns:** `greywick` (*The Greywick Inheritance*, Hudson Valley, 1893), `drownedbell` (*The Drowned Bell*, a Maine island, 1924), `hollowfork` (*Hollow Season*, a Wisconsin farm town, 1974).
- The GM prompt has a Horror section (fear checks, Dread, creature rules, "skip that" honoured at once).

**A fourth category: Western** (decision `0025`, WO-0043)
- **Western ruleset** in `data/rules-western/`: 8 classes (Gunslinger, Lawman, Scout, Gambler, Preacher, Doc, Outlaw, Cowhand), 5 origins, 18 skills (Riding, Gambling, Animal Handling, Nature…), 12 backgrounds, 1860s–80s guns with counted ammo, fanning and revolver reloading, mounted combat, adversaries, and a new `frontier.json`: showdowns, Reputation, Wanted and bounties, horses, trail travel, weather and water, gambling, the law.
- **Three Western campaigns:** `bittercreek` (*Bitter Creek*, a Wyoming range war, 1886), `silverline` (*The Silver Line*, a Colorado railroad and silver train, 1879), `longbounty` (*The Long Bounty*, a manhunt from the Brazos to the Rio Grande, 1874).
- Period armor is a registry field (`periodArmor`); the GM prompt has a Western section.
- **Every campaign except the demo is badged Premium** (a label only; all campaigns stay enabled for everyone).

**A third category: Noir** (decision `0024`, WO-0042)
- **Noir ruleset** in `data/rules-noir/` (original content, same d20 chassis and the same code path as Sci-Fi): 8 classes (Private Eye, Cop, Heavy, Grifter, Reporter, Doctor, Wheelman, Fixer), 5 origins, 18 skills (Forensics, Research, Society, Driving…), 12 backgrounds, 1930s–50s weapons with counted ammo, gear, adversaries, `combat.json` with brawling, and a new `investigation.json`: the three-clue rule, interrogation, tailing, Heat, bribes and favors.
- **Three Noir campaigns:** `blackcrane` (*The Black Crane*, San Francisco 1938), `klieglight` (*Klieg Light*, Los Angeles 1947), `calloway` (*Paid in Advance*, Port Calloway 1952).
- The no-magic code path is now category-driven (`engine: 'modern'` in the registry): the generator reads the campaign's own skills, weapons and ammo names; the GM prompt carries a Noir section with the case rules. Fantasy and Sci-Fi prompts unchanged.

**Two categories of game: Fantasy and Sci-Fi** (decision `0023`)
- Every campaign declares `"category"` in its `campaign.json`; one without is Fantasy. Registry: `server/game-categories.js` (client mirror `client/src/utils/gameCategories.js`). Home shows a Fantasy / Sci-Fi switch; the Rules page has a ruleset switch.
- **Sci-Fi ruleset** in `data/rules-scifi/` (original content, same d20 chassis): 8 classes, 5 origins, 18 skills, backgrounds, weapons and armor across the 1980s / modern / future eras, gear, adversaries in the monster schema, and `combat.json` with the gunplay rules — ammunition and magazines, single / burst / full-auto / suppressive fire, aim, material cover, called shots, jams, explosives, noise, nonlethal, hacking, chases, vehicles.
- **Four Sci-Fi campaigns:** `coldwar` (1980s spy thriller), `lastferry` (ordinary people, an alien visitation, an island city), `outbreak` (zombies), `perihelion` (a far-future heist on a sun-grazing liner).
- The DM prompt is category-aware: Sci-Fi campaigns get the gunplay summary, their currency and their campaign-rule names; `LookupMonster` reads the campaign's own ruleset. Fantasy prompt length unchanged within its guard.
- Character creation, hit dice and money (`$` / credits) work per category; campaigns may restrict origins and classes (`characterOptions`). Sci-Fi maps are drawn from `mapLocations`.
- **Branding:** user-visible "D&D", "Dungeons & Dragons" and "Dungeon Master" removed; the app is "AI Game Master" and the DM is the GM. The SRD 5.1 notice stays, scoped to Fantasy (see NOTICE).

**Security**
- `GET /api/rules/:category` joined the parameter into a file path unchecked, so `GET /api/rules/..%2Fplayers` returned `data/players.json` — every account record — to an unauthenticated caller. Rule names are now a closed `[a-z0-9-]` vocabulary; pinned by `server/__tests__/game-categories.test.js`.
- Header ids validated (WO-0041) and the server bound to loopback (WO-0034) — see their sections above.

**Saved games**
- v1.0.24-era saves (the 2026-09-07 backup: two sessions, ten campaign libraries) were loaded into the current code in a scratch copy under the no-live-agent guard: they loaded, autosaved, built the GM's prompts and took computed damage and healing (decision `0027`). **No live GM turn was run against them.** Recorded from decision `0027`; not re-run for this release.

**Not observed, and open**
- The four new categories and their thirteen campaigns are covered by content tests (`scifi-content`, `noir-content`, `western-content`, `horror-content`); this release does not record a full session of each in play.
- The wrong-campaign multiplayer bug is **not claimed fixed** (WO-0041 section above).
- WO-0030 is open: `copyDefaultsToDir` (provisioning, reset) and `copyFilesIfNotExist` (the NPC snapshot) in `server/player-data.js` still `JSON.parse` unguarded, so one corrupt file under `data/defaults/` can still break provisioning, a reset or a new session's NPCs.
- WO-0039 is open: the GM agent's built-in toolset is not restricted (SEC-2026-10-03-1); the loopback halt depends on it.
- My Games: two suspected defects from a code read ("Show all players" lists others' private sessions; a companion may see a private game it cannot open) are unverified and not addressed.
- Tags (`RELEASING.md` F16): one tag exists, `v1.0.25` (annotated, human chair, 2026-09-07). It points at `e61e6b6`, the parent of `5132420`, which is from before `projects/claudeDM/` was tracked in this repo (`git ls-tree e61e6b6 projects/` lists only `_TEMPLATE` and `claudeDM-company`), so **the tag does not contain the app**. v1.0.25's code is `5132420`. F16 is effectively still open; tags are the chair's (decision `0001`).
- `package-lock.json` still reads `1.0.24` at its root; the first `npm install` on the branch will rewrite those lines.

## [1.0.25] - 2026-09-07
Changes since `1.0.24` (starting after commit `8db019c`, "v1.0.24"):

**Branch status:** `demo_1.0.25` is **frozen for play**. This is the version the chair and one other player will be using; no further work is scheduled against this branch, and new development moves elsewhere. These notes are the last word on it.

**Mechanical state is computed, not narrated (ADR 0005)**
- The incident this release exists for: a character with 5 hit points took 2 damage and died. The arithmetic behind a governed field was the agent's to perform and therefore the agent's to get wrong.
- New `server/state-guard.js`. `GOVERNED_POINTERS` (`:29`) enumerates the ten JSON pointers the agent may no longer write by hand — `/status`, `/hitPoints/{current,max,temp}`, `/deathSaves`, `/hitDice`, `/spellSlotsUsed`, `/experience`, `/level`, `/proficiencyBonus`. `evaluateWrite` (`:238`) refuses any agent write that would change one, and names the tool to call instead.
- Registered as a **PreToolUse** hook, not PostToolUse (`server/dm-engine.js:18`, `:29`, `:1372`): a post-write check can only report a bad write that already happened.
- **The guard speaks only to refuse.** Six of the seven steps in `evaluateWrite` end in silence and it never returns a permissive decision. This is load-bearing and the reason is in the file header: the SDK's permission dispatcher assigns a hook result *instead of* awaiting `canUseTool`, and `canUseTool` is the only path to `onPermissionRequest` — so a hook that waved a tool through would silently switch off the player's consent modal. Nothing would error; a question would just stop being asked. Read that header before changing anything in the file.
- `/currency` is deliberately **not** governed: gold is prose inside `equipment[]` and schematising it is a data migration, sequenced separately.

**Death is computed from the rules**
- New `server/vitals-utils.js`: death saving throws, instant death on damage overflow, stabilisation, temporary hit points. `applyVitals` (`:698`) is the single writer; `isDead` (`:89`), `readVitals` (`:112`) and `describeCondition` (`:135`) are the readers. Rules are derived from `data/rules/combat.json` at load with a coded fallback (`deriveDeathRules`, `:54`), so the ruleset stays the source of truth.
- **A second, independent path to a wrong death, now gone.** `server/combat-utils.js` tested `hp <= 0` for death — the *monster* rule — and applied it to player characters, contradicting both `CLAUDE.md` and `data/rules/combat.json`. A player character at 0 hit points is unconscious and dying, not dead. `combatantVitals` (`:40`) now follows the sheet's `status` for file-backed combatants and keeps the `hp <= 0` rule only for sheetless creatures, where it is correct.
- Related: `combatStates` no longer holds hit points for anything with a sheet. File-backed combatants are read from the sheet at call time — one number, one writer, nothing to reconcile. Initiative order and round number are still in-memory and still lost on restart, deliberately.

**Restore a character from the library**
- New `POST /:id/restore-character` (`server/routes/sessions.js:932`, block comment at `:887`). A dead character can be restored from the player's library copy as they were at session start.
- This replaces a recovery path that returned a *level-1 template* in place of a character who had been played for hours. The failure mode it removes is losing a long-lived character to a data-shaped accident.
- It refuses rather than guesses when there is nothing to restore from: a character created inside a session and never saved to the library produces an explicit error (`:1004`) and changes nothing.

**Compaction no longer discards server-side writes**
- `server/compaction.js` — the previous implementation assigned `session.messages = liveTail` and wrote the whole stale object back, so **every server-side write that landed during the summarisation window was lost**: the turn's messages and world state, a companion claim, and `session.mechanicalOverrides` — the only durable record that a player was asked to approve a change to their own hit points and agreed. Compaction runs periodically through long sessions, which is when there is most to lose.
- The comment in `maybeCompact` (`:182`) explains why the obvious fix is worse than the bug: re-applying the same mutations inside `updateSessionFile` moves the race rather than removing it, because `liveTail` was computed from the pre-call array.

**Tests: 160 → 464, and the suite is now safe to run**
- 10 test files at 1.0.24, 20 now. Statically counted `it`/`test` cases: **160 at `d02cadd`, 464 in this tree** — matching the 464 reported by both runners.
- `vitest.config.js` now loads `server/__tests__/helpers/vitest-setup.js`, which **blocks the Agent SDK's `query()` for the whole suite**. This closes the WO-0001.5 hazard: previously a test that forgot to inject a fake engine started a real, billable agent with `Edit` access to `data/`. `npm test` was documented as unsafe to run; that is no longer true.
- New `server/__tests__/_harness/` — a dependency-free runner (`run-all.mjs`, `run-file.mjs`, `vitest-shim.mjs`) so the suite can be executed without vitest. Both runners agree at 464.

**Simulation rails — present, dormant**
- The bot subsystem does not load, and the reason changed late in this release. It used to be gated on `data/bot-config.json` having `enabled: true` — a file that has never existed here. Extracting `createApp()` replaced that with `NODE_ENV !== 'production'`, and the security review (SR-1) was right to call that a regression rather than a fix: `NODE_ENV` is set nowhere in this project, so the gate would have read `undefined !== 'production'` and mounted the bot admin router on the real server. The gate now requires the deployment to say yes on purpose — **`CLAUDEDM_BOTS=1`, and never under `NODE_ENV=production`** (`server/index.js:49`). The variable is unset on the chair's machine, so `botsAllowed(process.env)` is `false` and nothing mounts. It ships off and stays off, now for a reason that is checked rather than incidental.
- `data/bot-config.json` still decides whether any bots actually *run* once mounted (`BotOrchestrator.start()` returns early unless `enabled`), which is the narrower question it is good at.
- It carries two real fixes: a stopped bot used to leave its claim on the NPC it was controlling, wedging the companion slot for the whole table — it now unjoins and releases the claim before stopping (`server/bot/bot-orchestrator.js`); and every bot HTTP call now carries an `AbortSignal.timeout` (15s, 3s during shutdown; SR-5), where before a hung server could pin a bot process forever.
- One honest caveat on the three new access-model tests: they pass against `d02cadd` as well, because the change they cover in `server/routes/bots.js` is comment-only. They are characterisation tests, not regression tests, and are not counted as the latter.

**Not observed in play**
- Stated because it matters more than a test count: **the death machinery has never fired in a real game.** The chair played for hours after it landed and no character came close to dying. The restore flow and the consent modal **have never been rendered to a human** — they compile and are covered by unit tests, and that is the whole of the evidence.

**Open, for the maintainer**
- **All 464 tests are server-side.** `vitest.config.js` includes only `server/__tests__/**`, and there are **zero** client tests — `find client/src -name '*.test.*'` returns nothing. So the restore banner, the consent modal and the death-save display in the party panel are untested as well as unrendered: the endpoints beneath them are covered, the components are not.
- Still no git tags (`RELEASING.md` F16). `v1.0.24` exists as a commit subject and a branch name only, and this release adds a second.
- 22 of the paths in this release are **untracked**, including `server/state-guard.js` and `server/vitals-utils.js`. `git commit -a` would ship the release with its two headline modules missing and `dm-engine.js:18` requiring a file that does not exist — the server would not start. Use `git add -A` and read `git diff --cached --stat` before committing (`RELEASING.md` F17).
- The `1.0.x` / `1.1.x` minor-digit split is still unreconciled. `[1.1.22]` and `[1.1.23]` are the same release train as `demo_1.0.22` and `demo_1.0.23`; the patch number is the reliable counter and 1.0.25 continues the branch convention.

## [1.0.24] - 2026-09-01
Changes since `1.1.23` (starting after commit `90889ec`, "v1.0.23"):

**Numbering:** this release is `1.0.24`, matching the branch `demo_1.0.24` and `package.json`. The previous entry is `[1.1.23]`, so the displayed number goes down. The minor digit has been mis-keyed between `1.0.x` and `1.1.x` since 1.1.22 while the patch number ran as one reliable counter (21 → 22 → 23 → 24); this is one release train, not two. Key on the patch number and the commit hash. Unresolved — see the note at the end of this entry.

**Two new campaigns**
- `bellwater` — "The Widow's Compass", open-world, levels 3-10, 14+ sessions. Six pregenerated characters (`data/defaults/bellwater/characters/`), four NPCs, four scenarios (`data/campaigns/bellwater/scenarios/bw-scenario-00{1..4}.json`). Carries a campaign-specific `shipsArticles` block in `campaign.json`.
- `reckoning` — "A Winter at the Reckoning House", open-world, levels 2-5, 6-8 sessions. Six pregenerated characters, three NPCs, four scenarios (`rh-scenario-00{1..4}.json`). Carries a `caseFile` block in `campaign.json` — the mystery's solution is fixed in data before play, not decided by the DM mid-game.
- Both appear in the campaign list on the home page, each with its own `listing` block (`bellwater` order 90, `reckoning` order 100, both badged `Premium`) — see the data-driven list below.

**`campaign3` renamed — "The Shattered Vaunt"**
- Retitled to **The Shattered Vaunt**, subtitle "When the Vaunting Breaks, the World Trembles", with `listing.blurb` updated to match. `setting.name` is now "The Cormorant Coast and the Far Frontier".
- Scenario titles: **3 of 4 changed** ("The Hill Giant Gluttony" is unchanged). **Filenames were deliberately not changed** — `data/campaigns/campaign3/scenarios/` still contains `the-frozen-throne.json`, `the-maelstrom.json` and `the-vonindod-rises.json` while the `title` inside each now reads differently. `linkedScenarios` resolves by id (`sg-scenario-001`…`004`), so nothing is broken; but path and title now disagree, and that will confuse the next person to open the directory. Worth a follow-up that renames the files and the ids together, as one change, rather than drifting further.
- All five NPC files under `data/defaults/campaign3/npcs/` are replaced: `adela-renwick`, `nimbrel`, `ondrek`, `orla-mabrey`, `solvane`. **In git this is five deletions plus five untracked additions, not renames** — see the staging note under Repository hygiene.
- All eight files under `data/defaults/campaign3/characters/` are edited, and all eight character **names are unchanged**; the edits are to prose inside them. Specifically: **zero** changes across `name`, `level`, `class`, `race`, `hitPoints`, `armorClass`, `abilityScores`, `abilities`, `skills`, `spells`, `proficiencyBonus` and `id` in 8 of 8 files, and equipment holds at **113 items before and after** with no list changing length — the diff is **seven single lines** of description (a deity, a mountain range, a well, a college, a town, a mine and a person's name). One consequence worth knowing before you resume a saved game: `loadScenario` (`server/dm-engine.js:122-131`) reads the campaign directory **live on every call**, while character files were copied into the session at creation. So a resumed campaign picks up the new scenario titles immediately, but its already-copied character sheets keep whatever prose they were created with. Nothing is broken by that; it just explains why a resumed game can show a new title beside an old sheet.
- `client/src/components/GiantsMap.jsx`: one region name and two map labels changed; `alt` text now reads "The Shattered Vaunt — The Cormorant Coast & Far Frontier".
- `client/src/data/changelog.js`: the two historical What's New entries that named this campaign and its map now use the current names, each carrying a bracketed "[Entry updated in v1.0.24…]" note. The entries' version, date and `compareRef` are untouched — only the prose inside them changed, and the change is declared in the entry rather than made silently. Rationale is in the WO-0010 deliverable.

**Companion motivations reached the DM empty (fix)**
- `server/dm-engine.js:496` read `npc.dmNotes.motivation`; every `dmNotes` object in the project uses `motivations`. The NPC block built for the DM therefore carried `Motivation: ` with an empty value for every NPC, in every session, since the line was written. Now reads `motivations`.
- Cross-checked the sibling keys rather than fixing only the reported one: the code reads exactly `roleplaying`, `voice`, `motivations`, `secrets` and `attitude`, and all five are present in all **55** `dmNotes` objects in `data/` — 55/55 each. `motivations` was the only mismatch; there is no second instance of this bug.

**Campaign list is data-driven; sidebar names the campaign**
- `client/src/pages/Home.jsx` no longer hardcodes the campaign cards. It renders `GET /api/campaigns` through the new `client/src/utils/campaignListing.js`. Presentation travels with the campaign in an optional `listing` block (`order`, `badge`, `title`, `blurb`) in `campaign.json`; every key is optional and has a client-side fallback, so a campaign with no `listing` still renders — canonical title and subtitle, unbadged, sorted last. All ten campaigns now carry one (nine `Premium`, one `Free`).
- Appearance is preserved by assertion, not by eye: the check reconstructs the previous list from `git show HEAD:client/src/pages/Home.jsx` and reports identical campaigns, order, badges, titles, copy and box classes.
- `client/src/App.jsx` — the sidebar subtitle was a five-way ternary over campaign ids falling through to the literal `'Single Player Demo'`. `campaign2` and `campaign5` were never named by it, so both displayed the demo's label. Now derives from `campaign?.title`, with a non-breaking space while the list loads and the raw id if the server never answers.
- `summarizeCampaign` (`server/routes/campaigns.js`) gained `listing` via a new `summarizeListing`. `listing.badge` is a label and not an entitlement — nothing server-side gates on it, and there is no billing code.
- New `.tier-plain`, `.tier-badge-plain` and `.tier-notice` in `client/src/App.css`; the last labels a campaign list served from the previous successful load when the server does not answer.

**Open-world opening message uses the campaign's own fields**
- `client/src/pages/Adventure.jsx` now fetches the full campaign record (`GET /api/campaigns/:id`) when starting an open-world session, so `explorationRules`, `setting` and `wildernessStarts` reach the DM. The list endpoint's `summarizeCampaign` deliberately omits all three, so these had always been hardcoded fallbacks — every open-world session had told the DM to choose a start "from: a random location". No server change was required; `withCampaignAccess` already spreads the whole file.
- Campaign-supplied strings are bounded before they enter the opening message, via the new `shared/text-bounds.cjs` (`flattenAndTruncate` plus per-field caps) — the same helper and the same reasoning as the asset manifest. `campaign.json` is DM-editable and campaign-scoped, so an unbounded field would be a durable prompt channel into every later session of that campaign for every player.
- Measured before shipping: 9 of 10 campaigns now supply a corrected setting name, and 0 of 10 are truncated by the caps.
- Falls back to the list summary and then to the previous hardcoded defaults, so a failed request cannot block starting a session.

**Interface palette**
- Background family moved from blue to forest green; every surface token is now derived from four `--bg-*-rgb` variables in `client/src/index.css`. `--accent`, `--gold` and the damage / healing / spell-school / status colours in `App.css` are deliberately excluded — they carry meaning, not decoration.
- A second family, **amber** (dark umber), ships alongside it, luminance-matched so every contrast ratio is the same within 1%. It is **not a runtime setting**: nothing sets the `.amber` class and there is no toggle in the UI. Activating it is a source edit — delete `.amber` from the `:root.amber` selector marked "PALETTE SWITCH".

**Scene imagery — prototype, not wired into play**
- New `server/asset-manifest.js` (+ `server/__tests__/asset-manifest.test.js`): reads a per-campaign `assets.json`, validates it, and renders the id list into the DM's prompt.
- New read-only asset route `GET /api/campaigns/:campaignId/assets/:assetId` (`server/routes/campaigns.js:141`). It resolves the id through the manifest and never treats it as a path.
- New `ShowSceneImage` DM tool (`server/dm-engine.js:654-659`), added to `allowedTools` at `dm-engine.js:1125`; `campaignId` is closed over, so the tool takes no campaign parameter. Inline rendering in the transcript via `client/src/pages/Adventure.jsx` and `server/ws-handler.js`.
- **State of the prototype, stated plainly:** the tool handler has never executed — invoking it requires the Agent SDK. Only `wonderland` has an `assets.json`, and of its two entries one is `status: "ready"` (`map-wonderland`, with `wonderland-map.png` and a provenance note) and one is `status: "specified"` with no file. No other campaign has a manifest. Nothing here should be relied on during play yet.

**Repository hygiene**
- `.gitignore` rewritten for the campaign-era data layout (WO-0002). The old patterns matched only the pre-campaign flat layout (`data/sessions/*.json`, `data/players/*.json`), so live session and player *directories* were untracked but not ignored — 74 play-data files that a `git add -A` would have committed. Now ignores the contents of `data/players/`, `data/sessions/`, `data/chat/`, `data/dm-settings/` and `data/characters/` while keeping `data/campaigns/**`, `data/defaults/**` and `data/rules/**` committable, including the `.jpg` portraits, with the `noDelete.txt` / `.gitkeep` placeholders re-included by negation.
- Not fixed by that change, and not fixable by it: `data/players.json` is present in 11 earlier commits and `.gitignore` has no effect on history.
- **`git commit -a` is unsafe on this release.** It stages modifications to tracked files only. The `campaign3` NPC replacement is five deletions of tracked files plus five *untracked* additions, so `commit -a` would apply the deletions, miss the replacements, and ship `campaign3` with **no NPC files at all**. Three other new modules (`shared/text-bounds.cjs`, `shared/text-bounds.mjs`, `client/src/utils/campaignListing.js`) would be dropped the same way. Use `git add -A`, then read `git diff --cached --stat` before committing.
- Added an `engines` field to the root `package.json`: `"node": "^20.19.0 || >=22.12.0"`, matching the range Vite already declares. `require(ESM)` needs that floor, and `npm run server` (`node server/index.js`) never loads Vite — so on an older Node the API failed at require time with nothing having warned. There is no `.npmrc`, so this is advisory (npm warns; it does not block an install).

**Open, for the maintainer**
- The `1.0.x` / `1.1.x` minor-digit split is still unreconciled; this entry continues to carry both numbers rather than deciding. One reconciliation entry declaring the current series would end it.
- `package.json` `"version"` was stale at `1.0.15` (last touched eight releases ago) and is set to `1.0.24` here. `client/package.json` remains at the Vite default `0.0.0`.
- There are still no git tags.

## [1.1.23] - 2026-08-13
Changes since `1.1.22` (starting after commit `5f54d9d`, "v1.1.22 from server."):

- Fixed an empty-live-window bug in rolling compaction (`server/compaction.js`). `decideCut` preferred the last chapter-summary boundary without checking what remained after it; when the newest message was itself a summary (the normal state right after the DM closes a chapter), the cut archived the whole array and left `messages: []`, so the session loaded as a blank adventure. Observed in production on a 554-message session with summaries at indices 192/296/553.
- Boundary candidates must now leave at least `MIN_KEEP_TAIL` (20) messages live; otherwise compaction falls back to an older boundary or declines the cycle and waits for the tail to grow.
- Added an independent backstop in `maybeCompact`: a cut producing a zero-length live tail is refused and warned about rather than committed.
- No data loss — `archive.jsonl` is append-only and the affected session was restored in full from it.
- 2 new regression tests in `server/__tests__/compaction.test.js` (empty-tail refusal; fallback to an older boundary). Compaction suite 8 → 10; full suite 139 → 141, all green.
- Reverted play-state XP that had leaked into `data/defaults/*/npcs/*.json` baselines; defaults are pristine templates and must not carry session progress.

## [1.1.22] - 2026-07-27
Changes since `1.0.21` (starting after commit `97e6156`, "whats new for v1.0.21 and image for fire plane."):

Reliability overhaul targeting the three production failure modes (wrong character sheets / lost XP, forgotten story arcs, silent XP-tool errors), based on an audit of two exported production sessions:

**Correctness**
- New canonical character/NPC file resolver (`server/entity-resolver.js`): session-dir-first, first-tier-wins. Cross-tier duplicates (the normal snapshot state) no longer throw "Ambiguous character reference" — this bug made essentially every AwardPartyXP call in a saved session fail in-band, which is why sheets stayed at starter stats.
- Unicode-safe slugify: "Daichi Musō" now slugs to `daichi-muso` (was `daichi-mus`), and the companion-copy path resolves by character id before writing, deleting stale same-id duplicates instead of minting a second file.
- `TrackResources` (ammo, rests, spell slots) and `TrackCombat`/`TrackCalendar` now target the session snapshot and key state per-session — long-rest HP restores previously wrote to the player library, which the UI and DM never read during play.
- JSON "recovery" is now read-only: a corrupt-looking read can no longer overwrite a live session character with its level-1 library/defaults copy (the observed mid-session revert). All character/session writes are atomic (temp file + rename), and session.json read-modify-writes are serialized through a per-session queue.
- Session characterId bindings are validated and self-healed at creation, watch, resume, and turn-fire; a dangling id (both audited production sessions had one) now surfaces as a visible system warning instead of failing silently.

**Story-arc durability**
- Single-player turns are now persisted server-side at dm_complete (previously only the client auto-save held them — a crash before auto-save caused the stale-resume "wrong scene" bug). The session PUT dedupes so client saves can't resurrect or truncate server-persisted turns.
- The server auto-appends a per-turn digest to `worldState.recentEvents` after every DM turn — the resume snapshot can no longer be older than the last turn even if the DM never calls UpdateWorldState.
- Resume recap now tells the DM the transcript wins over a stale world-state snapshot.
- 401 subscription-auth expiry (the crash driver: Max-plan OAuth tokens expiring mid-session) is now detected and surfaced as "run `claude login` on the server" instead of a generic engine error. The error itself is environmental and recurs when the token expires — resume is now robust to it.

**Prompt & cleanup**
- Runtime DM system prompt restructured: ~4.5k → ~2.7k tokens, 22 → 13 sections, duplicate rules collapsed, three pacing variants merged into one parameterized block. Fixed a real contradiction where two of three XP touchpoints instructed the discouraged single-target AwardXP tool instead of AwardPartyXP (also fixed in the reconcile prompt).
- The ~500-word multiplayer companion block is now omitted from solo-session prompts.
- Bot self-play farm (~1,700 lines) only loads when `data/bot-config.json` has `"enabled": true`; legacy flat-dir fallbacks (`data/characters|npcs|scenarios`) removed; `emailToSlug` deduplicated into `player-data.js`.
- Not changed: dice tooling — the audit found all 302 combat narrations in both production transcripts were backed by real RollDice calls; that complaint was not reproduced.

## [1.0.7] - 2026-03-13
Changes since `1.0.6` (starting after commit `fd1f299`, "This is v1.0.6 and corresponding whats new section update."):

- Ghost/observer mode: observers now see a 👻 "Observing [host name]'s game" label instead of "Read only", with the host's name resolved from session data.
- Host online/offline indicator on the party status board for observer and companion players via live WebSocket presence.
- Join/leave notifications are now scoped to companion players only — observers no longer generate join/leave noise.
- Companion leave messages now include the character name (e.g. "The DM now controls Bramble as an NPC companion.").
- Mid-session logout cleanup: logging out during an active session fully resets adventure state so re-login works without a page refresh.
- Session resume guard: only the session host can trigger a resume — prevents non-owners from accidentally resuming.
- Fixed companion character ID restoration on reconnect (removed stale-state guard).

## [1.0.5] - 2026-03-08
Changes since `1.0.4` (starting after commit `b62660b`, "v1.0.4 official and whats new update"):

- Multiplayer sessions: players can now join a host's active session as a companion, controlling an NPC companion character while the host remains the primary player and the AI DM narrates for everyone.
- Companion slot management: hosts can mark each NPC as DM-controlled, open for any player, or reserved for a specific friend before starting a session.
- Friends & blocked lists: new per-player settings to manage a friends list (for companion reservations/invites) and a blocked list.
- Session visibility: sessions can be set to public (visible to all logged-in players) or private (visible only to host and reserved friends).
- Turn modes: three multiplayer turn-ordering options — Initiative (DM calls order), Ready-Golf (host's turn auto-fires once all companions submit), and Host-Decides (host manually sends when ready).
- Companion turn UI: companion players get a dedicated input to submit their turn text; the host sees collected turns before firing the combined turn to the DM.
- Real-time session presence: join/leave notifications, live participant list, and companion turn status broadcast via WebSocket.
- Session join flow: companion players can browse and join public or reserved sessions from the Adventure setup screen.
- Added Wonderland interactive map component (`WonderlandMap.jsx`) for navigating the Alice's Adventures in Wonderland campaign.
- Fixed cross-campaign session isolation: saved sessions from one campaign no longer appear when browsing another campaign.
- Added player data provisioning for the Wonderland campaign with full character and NPC defaults.

## [1.0.4] - 2026-03-05
Changes since `1.0.3` (starting after commit `ae34454`, "v1.0.3 cont"):

- Multi-campaign architecture: all player data, defaults, and scenarios are now scoped per-campaign (`data/players/<slug>/<campaignId>/`), with zero crossover between campaigns.
- New campaign: "Depths of the Underdark" — premium-tier Underdark adventure with 4 scenarios, 10 characters, and 5 NPC companions.
- New campaign: "Alice's Adventures in Wonderland" — whimsical D&D adaptation with 4 scenarios, 8 characters, and 5 NPCs.
- Added `CampaignContext` provider and `X-Campaign-Id` header for campaign-scoped API routing.
- Added interactive Underdark map component for navigating the Depths of the Underdark campaign.
- Added comprehensive monster database (`data/rules/monsters.json`) with 26,000+ lines of creature stat blocks.
- Added server-side character generator (`server/character-generator.js`).
- DM engine audit: aligned behavior with CLAUDE.md rules, fixed session-start XP equalization bug.
- Added campaign migration tooling (`migrate-campaigns.sh`, `provision-campaign1.sh`) for restructuring data into multi-campaign layout.
- Demo campaign data reorganized under `data/defaults/demo/` and `data/campaigns/demo/`.
- Home page redesigned for campaign browsing and selection.
- Expanded CLAUDE.md with campaign isolation docs and no-session-start-equalization rule.

## [1.0.3] - 2026-02-26
Changes since `1.0.2` (starting after commit `98bb2b4`, "v1.0.2 fix missing characters and sessions folder on install"):

- Added per-player data isolation: each player gets their own copy of characters and NPCs under `data/players/<slug>/`, preventing cross-player data conflicts.
- Added automatic player data provisioning from `data/defaults/` on first login.
- Added migration script (`scripts/migrate-player-data.js`) for moving existing data into the new per-player directory structure.
- Updated character and NPC API routes to serve player-specific data based on login context.
- Updated DM engine to build player-aware context, serving correct character/NPC files per player session.
- Added `status` field ("alive" / "dead") to all character and NPC templates for persistent death tracking.
- Expanded CLAUDE.md with mandatory post-encounter checklists, chapter summaries, session-end checklists, and detailed item tracking rules.

## [1.0.2] - 2026-02-23
Changes since `1.0.1` (starting after commit `3c6d5e3`, "admin hardening sections"):

- Added stricter ownership enforcement for sessions and campaigns, with explicit read-only access metadata for non-owners.
- Added read-only awareness in Adventure flow: protected save/start/import paths and auto-save behavior for viewers.
- Expanded DM personality controls with presets, a Player Autonomy slider, and clearer player-vs-global setting visibility.
- Added admin controls for global DM personality shuffle and restore-default coverage for DM settings.
- Expanded campaign integration in setup and API client wiring for create/list/update/delete usage.
- Refreshed the world map presentation (updated art, region labeling, legend styling, and hover readability polish).
- Added session timestamp display improvements and fixed missing `data/characters` directory bootstrap.

## [1.0.1] - 2026-02-21
Changes since `1.0.0` (baseline commit `76e2c07`, "change horror to darkness"):

- Added persistent party chat with daily archive files and live online participant updates.
- Added player authentication flows (register, login, password change) and player role state in UI.
- Added admin-only controls for Settings and server-side enforcement for privileged endpoints.
- Added rich text rendering improvements and fixed a session-load UI freeze regression.
- Added admin toggle for AI daily DM personality shuffle at midnight Pacific time (PDT/PST).
- Added public "What's New" page and in-app version display.

## [1.0.0] - 2026-02-18
Stable baseline marked by commit `76e2c07` ("change horror to darkness").
