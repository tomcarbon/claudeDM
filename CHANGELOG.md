# Changelog

All notable changes to this project are documented here.

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
