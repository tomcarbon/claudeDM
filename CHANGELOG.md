# Changelog

All notable changes to this project are documented here.

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
- All eight files under `data/defaults/campaign3/characters/` are edited, and all eight character **names are unchanged**; the edits are to prose inside them.
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
