export const CURRENT_VERSION = '1.0.1';

export const CHANGELOG = [
  {
    version: '1.0.1',
    date: '2026-02-21',
    title: 'Current Release',
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
