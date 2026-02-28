export const CURRENT_VERSION = '1.0.3';

export const CHANGELOG = [
  {
    version: '1.0.3',
    date: '2026-02-26',
    title: 'Current Release',
    compareFrom: '1.0.2',
    compareRef: '98bb2b4 ("v1.0.2 fix missing characters and sessions folder on install")',
    highlights: [
      'Per-player data isolation: each player now gets their own copy of characters and NPCs under `data/players/<slug>/`, so one player\'s changes never affect another\'s.',
      'Added player data provisioning — new players are automatically set up with default characters and NPCs on first login.',
      'Migration script (`scripts/migrate-player-data.js`) to move existing player data into the new per-player directory structure.',
      'Character and NPC API routes updated to serve player-specific data based on login context.',
      'DM engine now builds player-aware context, serving the correct character/NPC files for each player\'s session.',
      'Character death tracking: all characters and NPCs now carry a `status` field ("alive" or "dead") for persistent death state.',
      'Expanded CLAUDE.md DM guidelines with mandatory post-encounter checklists, chapter summaries, session-end checklists, and detailed item tracking rules.',
    ],
  },
  {
    version: '1.0.2',
    date: '2026-02-23',
    title: 'Previous Release',
    compareFrom: '1.0.1',
    compareRef: '3c6d5e3 ("admin hardening sections")',
    highlights: [
      'Stricter session and campaign ownership enforcement with clear read-only metadata for non-owners.',
      'Adventure flow now respects read-only mode for save/start/import actions and auto-save behavior.',
      'Expanded DM personality controls with presets, Player Autonomy tuning, and clearer per-player vs global state.',
      'Admin controls now include global DM personality shuffle handling and restore-default coverage for DM settings.',
      'Campaign setup and API integration were expanded for smoother create/list/update/delete workflows.',
      'World map presentation refreshed with updated art, clearer region labels, and legend/hover readability polish.',
      'Session list now includes time details, plus startup hardening for missing `data/characters` directory.',
    ],
  },
  {
    version: '1.0.1',
    date: '2026-02-21',
    title: 'Previous Release',
    compareFrom: '1.0.0',
    compareRef: '76e2c07 ("change horror to darkness")',
    highlights: [
      'Persistent party chat with daily archives and live player presence.',
      'Player account flows (login/register/password) and role-aware UI behavior.',
      'Admin-only protection for system settings and DM settings writes (UI + API).',
      'DM personality shuffle automation: rotates daily at midnight Pacific time (PDT/PST).',
      'Manual DM personality controls are locked whenever AI shuffle is enabled.',
      'Rich text rendering hardening and fix for session-load UI freezing.',
      'Public "What\'s New" page with semantic version history.',
    ],
  },
  {
    version: '1.0.0',
    date: '2026-02-18',
    title: 'Stable Baseline',
    highlights: [
      'Baseline captured by commit 76e2c07 ("change horror to darkness").',
    ],
  },
];
