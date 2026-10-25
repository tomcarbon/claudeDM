import { describe, it, expect } from 'vitest';

// WO-0043: the authored Western content holds to its spec
// (projects/claudeDM-company/docs/western-ruleset-spec.md). The checks are shared with Noir and
// live in helpers/period-content.js; this file is the Western spec's pinned names.

const { describePeriodCategory } = require('./helpers/period-content');

// Pinned by the spec. A rename here is a spec change, not a test fix.
describePeriodCategory({ describe, it, expect }, {
  id: 'western',
  label: 'Western',
  rulesDir: 'rules-western',
  campaignIds: ['bittercreek', 'longbounty', 'silverline'],
  skills: ['Acrobatics', 'Animal Handling', 'Athletics', 'Deception', 'Gambling', 'Insight', 'Intimidation', 'Investigation',
    'Mechanics', 'Medicine', 'Nature', 'Perception', 'Performance', 'Persuasion', 'Riding', 'Sleight of Hand', 'Stealth', 'Survival'],
  origins: ['Back East', 'Borderlands', 'Ex-Soldier', 'Frontier-Born', 'Immigrant'],
  classes: ['Cowhand', 'Doc', 'Gambler', 'Gunslinger', 'Lawman', 'Outlaw', 'Preacher', 'Scout'],
  backgrounds: ['Blacksmith', 'Bounty Hunter', 'Card Sharp', 'Cattle Drover', 'Homesteader', 'Prospector', 'Railroad Man',
    'Range Detective', 'Saloon Keeper', 'Schoolteacher', 'Stage Driver', 'Veteran'],
  adversaries: {
    'Drunk Cowboy': '0', Rattlesnake: '1/8', 'Saloon Brawler': '1/8', Cardsharp: '1/8', Rustler: '1/4', Deputy: '1/4',
    'Stagecoach Guard': '1/4', Wolf: '1/4', Outlaw: '1/2', 'Cavalry Trooper': '1/2', Cougar: '1/2', 'Hired Gun': '1',
    'Railroad Enforcer': '1', 'Longhorn Bull': '1', 'Bandit Sharpshooter': '2', 'Bounty Hunter': '2', 'Crooked Sheriff': '2',
    'Cattle Baron': '2', 'Grizzly Bear': '2', 'Lynch Mob': '2', 'Gang Leader': '3', Gunfighter: '3', 'Range Boss': '3',
    'Fast Gun': '5',
  },
  ruleFiles: ['abilities-and-skills', 'races', 'classes', 'backgrounds', 'equipment', 'gear', 'combat', 'adversaries', 'frontier'],
  eras: ['1860s', '1870s', '1880s'],
  minWeapons: 18,
  armorAc: (dex) => ({ 'Leather duster': 11 + dex, 'Buckskin coat': 11 + dex, 'Iron vest': 13 + Math.min(dex, 2), None: 10 + dex }),
  generatedArmor: ['Leather duster', 'None'],
  ruleChecks(it, expect, readRule) {
    it('frontier has showdowns, Reputation, Wanted, horses, the trail, weather, gambling and the law', () => {
      const fr = readRule('frontier');
      for (const k of ['showdowns', 'reputation', 'wanted_and_bounties', 'horses_and_mounts', 'trail_travel', 'weather_and_water', 'gambling', 'the_law']) {
        expect(fr[k], k).toBeTruthy();
      }
    });

    it('has no Native American, Mexican or Chinese adversary entries (spec §13)', () => {
      // The entries only: _meta states this very rule, in these words.
      const text = JSON.stringify(readRule('adversaries').monsters_by_cr).toLowerCase();
      for (const w of ['indian', 'apache', 'comanche', 'sioux', 'cheyenne', 'warrior', 'brave', 'mexican', 'bandido', 'chinese', 'tong']) {
        expect(text, w).not.toMatch(new RegExp(`\\b${w}\\b`));
      }
    });
  },
});
