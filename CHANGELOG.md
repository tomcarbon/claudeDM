# Changelog

All notable changes to this project are documented here.

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
