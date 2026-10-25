import { describe, it, expect } from 'vitest';

// WO-0042: the authored Noir content holds to its spec
// (projects/claudeDM-company/docs/noir-ruleset-spec.md). The checks are shared with Western and
// live in helpers/period-content.js; this file is the Noir spec's pinned names.

const { describePeriodCategory } = require('./helpers/period-content');

// Pinned by the spec. A rename here is a spec change, not a test fix.
describePeriodCategory({ describe, it, expect }, {
  id: 'noir',
  label: 'Noir',
  rulesDir: 'rules-noir',
  campaignIds: ['blackcrane', 'calloway', 'klieglight'],
  skills: ['Acrobatics', 'Athletics', 'Deception', 'Driving', 'Forensics', 'Insight', 'Intimidation', 'Investigation',
    'Mechanics', 'Medicine', 'Perception', 'Performance', 'Persuasion', 'Research', 'Sleight of Hand', 'Society', 'Stealth', 'Streetwise'],
  origins: ['City-Born', 'Ex-Service', 'New Arrival', 'Old Money', 'Small-Town'],
  classes: ['Cop', 'Doctor', 'Fixer', 'Grifter', 'Heavy', 'Private Eye', 'Reporter', 'Wheelman'],
  backgrounds: ['Bookkeeper', 'Bootlegger', 'Cab Driver', 'Card Sharp', 'Dockworker', 'Ex-Cop', 'Hotel Dick', 'Night Nurse',
    'Nightclub Singer', 'Prizefighter', 'Society Heir', 'Veteran'],
  adversaries: {
    Pickpocket: '0', 'Street Tough': '1/8', 'Guard Dog': '1/8', 'Beat Cop': '1/4', Bouncer: '1/4', 'Dockside Goon': '1/4',
    'Night Watchman': '1/4', 'Crooked Cop': '1/2', 'Getaway Driver': '1/2', 'Union Muscle': '1/2', 'Hired Gun': '1',
    Bodyguard: '1', 'Knife Artist': '1', Prizefighter: '1', 'Mob Torpedo': '2', 'Tommy-Gun Hood': '2', 'Bent Detective': '2',
    'Federal Agent': '2', 'Rival Private Eye': '2', 'Mob Lieutenant': '3', 'Hit Man': '3', 'Waterfront Boss': '3',
    'Mob Boss': '4', 'The Professional': '5',
  },
  ruleFiles: ['abilities-and-skills', 'races', 'classes', 'backgrounds', 'equipment', 'gear', 'combat', 'adversaries', 'investigation'],
  eras: ['1930s', '1940s', '1950s'],
  minWeapons: 25,
  armorAc: (dex) => ({ 'Heavy overcoat': 11 + dex, 'Leather jacket': 11 + dex, 'Steel vest': 13 + Math.min(dex, 2), None: 10 + dex }),
  generatedArmor: ['Heavy overcoat', 'None'],
  ruleChecks(it, expect, readRule) {
    it('investigation states the three-clue rule and Heat', () => {
      const inv = readRule('investigation');
      for (const k of ['leads', 'interrogation', 'tailing_and_stakeouts', 'heat', 'bribes_and_favors', 'the_case_board']) {
        expect(inv[k], k).toBeTruthy();
      }
      expect(JSON.stringify(inv.leads)).toMatch(/three/i);
    });
  },
});
