import { describe, it, expect } from 'vitest';

// WO-0045: the authored Horror content holds to its spec
// (projects/claudeDM-company/docs/horror-ruleset-spec.md). The checks are shared with Noir and
// Western and live in helpers/period-content.js; this file is the Horror spec's pinned names.

const { describePeriodCategory } = require('./helpers/period-content');

const SUPERNATURAL = ['spirit', 'undead', 'construct', 'monstrosity'];
const VULNERABILITIES = ['silver', 'iron', 'fire', 'salt', 'daylight', 'running water', 'its true name'];

// Pinned by the spec. A rename here is a spec change, not a test fix.
describePeriodCategory({ describe, it, expect }, {
  id: 'horror',
  label: 'Horror',
  rulesDir: 'rules-horror',
  campaignIds: ['drownedbell', 'greywick', 'hollowfork'],
  skills: ['Acrobatics', 'Athletics', 'Deception', 'Driving', 'Insight', 'Intimidation', 'Investigation', 'Mechanics',
    'Medicine', 'Nature', 'Occult', 'Perception', 'Performance', 'Persuasion', 'Research', 'Sleight of Hand', 'Stealth', 'Survival'],
  origins: ['Educated', 'Faithful', 'Farm-Raised', 'Old Family', 'Survivor'],
  classes: ['Chaplain', 'Hunter', 'Occultist', 'Physician', 'Roughneck', 'Sensitive', 'Skeptic', 'Veteran'],
  backgrounds: ['Antiquarian', 'Drifter', 'Farmhand', 'Groundskeeper', 'Lighthouse Keeper', 'Mechanic', 'Medium', 'Nurse',
    'Reporter', 'Schoolteacher', 'Student', 'Undertaker'],
  adversaries: {
    'Frightened Townsman': '0', 'Feral Dog': '1/8', 'Grave Robber': '1/8', 'Rat Swarm': '1/4', 'Hollow-Eyed Follower': '1/4',
    Shade: '1/4', 'Crow Swarm': '1/2', 'Risen Dead': '1/2', 'Night Watchman': '1/2', Poltergeist: '1', 'Hound of the Lane': '1',
    'Drowned One': '1', 'Possessed Neighbor': '1', Revenant: '2', 'Straw Man': '2', 'Body Snatcher': '2', 'The Hungry Dark': '3',
    Wraith: '3', 'Masked Killer': '3', 'The Fetch': '3', Werewolf: '4', 'Bound Spirit': '5', Vampire: '6',
  },
  ruleFiles: ['abilities-and-skills', 'races', 'classes', 'backgrounds', 'equipment', 'gear', 'combat', 'adversaries', 'dread'],
  eras: ['1890s', '1920s', '1970s'],
  minWeapons: 22,
  armorAc: (dex) => ({ 'Heavy coat': 11 + dex, 'Leather jacket': 11 + dex, 'Padded vest': 13 + Math.min(dex, 2), None: 10 + dex }),
  generatedArmor: ['Heavy coat', 'None'],
  ruleChecks(it, expect, readRule) {
    it('dread has fear checks, the Dread track, recovery, creature rules, rites, light, isolation and table safety', () => {
      const dread = readRule('dread');
      for (const k of ['fear_checks', 'dread', 'recovery', 'the_unknown', 'rites_and_wards', 'light_and_dark', 'isolation',
        'investigation', 'running_horror']) {
        expect(dread[k], k).toBeTruthy();
      }
      expect(JSON.stringify(dread.running_horror)).toMatch(/skip/i);
    });

    it('every supernatural adversary has rules the players can learn, and known vulnerabilities (spec §8)', () => {
      const all = Object.values(readRule('adversaries').monsters_by_cr).flat();
      const supernatural = all.filter(m => SUPERNATURAL.includes(m.type));
      expect(supernatural.length).toBeGreaterThanOrEqual(12);
      for (const m of supernatural) {
        expect(Array.isArray(m.rules) && m.rules.length >= 2 && m.rules.length <= 4, `${m.name}: rules`).toBe(true);
        expect(Array.isArray(m.vulnerable_to), `${m.name}: vulnerable_to`).toBe(true);
        for (const v of m.vulnerable_to) expect(VULNERABILITIES, `${m.name}: ${v}`).toContain(v);
      }
    });

    it('frames fear as fright, not illness, and borrows no sacred beings (spec §13)', () => {
      // The entries only: _meta and the GM guidance may state these very rules.
      const text = JSON.stringify([readRule('adversaries').monsters_by_cr, readRule('classes').classes]).toLowerCase();
      for (const w of ['insanity', 'insane', 'madness', 'lunatic', 'asylum', 'sanitarium', 'wendigo', 'skinwalker', 'indian',
        'voodoo', 'cthulhu', 'deep one']) {
        expect(text, w).not.toMatch(new RegExp(`\\b${w}\\b`));
      }
    });
  },
});
