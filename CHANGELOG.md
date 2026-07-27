# Changelog

All notable changes to this project are documented here.

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
