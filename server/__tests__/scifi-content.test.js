import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// WO-0040: the authored Sci-Fi content is internally consistent. Reads the shipped data/ READ-ONLY —
// nothing here writes, and the generator calls below return objects without saving them.
//
// What it pins is the arithmetic a hand-authored sheet most often gets wrong (modifiers, XP for the
// level, proficiency bonus), that every name a sheet uses exists in the ruleset the campaign plays,
// and that the campaign's links (scenarios, map pins) resolve.

const { generateRandomCharacter } = require('../character-generator');
const { categoryIdOf } = require('../game-categories');

const DATA = path.join(__dirname, '..', '..', 'data');
const SCIFI = path.join(DATA, 'rules-scifi');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf-8'));
const listJson = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')) : []);

const XP_BY_LEVEL = Object.fromEntries(readJson(path.join(DATA, 'rules', 'leveling.json')).xp_thresholds.map(e => [e.level, e.xp_required]));
const XP_BY_CR = { '0': 10, '1/8': 25, '1/4': 50, '1/2': 100, '1': 200, '2': 450, '3': 700, '4': 1100, '5': 1800, '6': 2300, '7': 2900, '8': 3900, '9': 5000, '10': 5900, '11': 7200, '12': 8400 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMPTY_SPELLS = { spellcastingAbility: '', spellSaveDC: 0, spellAttackBonus: 0, cantrips: [], level1: { slots: 0, known: [] } };

const campaigns = fs.readdirSync(path.join(DATA, 'campaigns'))
  .map(id => path.join(DATA, 'campaigns', id, 'campaign.json'))
  .filter(f => fs.existsSync(f))
  .map(f => readJson(f));
const scifiCampaigns = campaigns.filter(c => categoryIdOf(c) === 'scifi');

const hasRules = fs.existsSync(path.join(SCIFI, 'classes.json'));
const classes = hasRules ? readJson(path.join(SCIFI, 'classes.json')).classes : [];
const origins = hasRules ? readJson(path.join(SCIFI, 'races.json')).races : [];
const skills = hasRules ? readJson(path.join(SCIFI, 'abilities-and-skills.json')) : null;
const skillNames = new Set();
if (skills) {
  // Shape-tolerant: an array of {name} under `skills`, or an object keyed by name.
  const raw = skills.skills;
  if (Array.isArray(raw)) raw.forEach(s => skillNames.add(typeof s === 'string' ? s : s.name));
  else if (raw && typeof raw === 'object') Object.keys(raw).forEach(k => skillNames.add(raw[k]?.name || k));
}

describe('categories on disk', () => {
  // Not a skip condition: four campaigns are unplayable without it (SDET F2).
  it('ships the Sci-Fi ruleset', () => {
    for (const f of ['classes', 'races', 'backgrounds', 'abilities-and-skills', 'equipment', 'gear', 'combat', 'adversaries']) {
      expect(fs.existsSync(path.join(SCIFI, `${f}.json`)), f).toBe(true);
    }
  });

  it('every campaign declares a known category, and the pre-existing ten are Fantasy', () => {
    for (const c of campaigns) expect(['fantasy', 'scifi', 'noir', 'western', 'horror'], c.id).toContain(c.category);
    for (const id of ['demo', 'campaign1', 'campaign2', 'campaign3', 'campaign4', 'campaign5', 'nihon', 'wonderland', 'reckoning', 'bellwater']) {
      expect(campaigns.find(c => c.id === id)?.category, id).toBe('fantasy');
    }
  });

  it('marks the demo Free and every other campaign Premium (chair, 2026-10-21)', () => {
    // The badge is still a label: nothing gates on the badge itself. Since WO-0050 the Premium
    // gate is decided by the server's free allowlist (server/premium-gate.js), and
    // premium-gate.test.js holds these badges to that list. (Until 2026-10-28 this comment said
    // every campaign stays playable by everyone; with every player at the default, it still does.)
    for (const c of campaigns) expect(c.listing?.badge, c.id).toBe(c.id === 'demo' ? 'Free' : 'Premium');
  });

  it('ships the five Sci-Fi campaigns', () => {
    expect(scifiCampaigns.map(c => c.id).sort()).toEqual(['coldwar', 'lastferry', 'outbreak', 'perihelion', 'saltmoon']);
  });
});

describe('the Sci-Fi ruleset', () => {
  it('has the eight classes, each with a hit die and no spellcasting', () => {
    expect(classes.map(c => c.name).sort()).toEqual(['Brawler', 'Face', 'Medic', 'Operative', 'Scientist', 'Scout', 'Soldier', 'Tech']);
    for (const c of classes) {
      expect(c.hit_die, c.name).toMatch(/^d(6|8|10|12)$/);
      expect(c.spellcasting, c.name).toBeUndefined();
      expect(Array.isArray(c.default_weapons) && c.default_weapons.length > 0, c.name).toBe(true);
    }
  });

  it('has the eighteen skills, and classes and backgrounds use only those', () => {
    expect(skillNames.size).toBe(18);
    for (const c of classes) for (const s of c.skill_choices.from) expect(skillNames.has(s), `${c.name}: ${s}`).toBe(true);
    for (const b of readJson(path.join(SCIFI, 'backgrounds.json')).backgrounds) {
      for (const s of b.skill_proficiencies) expect(skillNames.has(s), `${b.name}: ${s}`).toBe(true);
    }
  });

  it('every weapon has a group, eras, damage dice and a range', () => {
    const { weapons } = readJson(path.join(SCIFI, 'equipment.json'));
    expect(weapons.length).toBeGreaterThanOrEqual(40);
    for (const w of weapons) {
      expect(typeof w.group, w.name).toBe('string');
      expect(Array.isArray(w.eras) && w.eras.length > 0, w.name).toBe(true);
      expect(w.damage, w.name).toMatch(/^\d+d\d+/);
      expect(w.range, w.name).toBeTruthy();
    }
  });

  it('adversaries use the monster schema, so LookupMonster can read them, with XP true to CR', () => {
    const data = readJson(path.join(SCIFI, 'adversaries.json'));
    const all = Object.entries(data.monsters_by_cr).flatMap(([cr, list]) => list.map(m => ({ ...m, bucket: cr })));
    expect(all.length).toBeGreaterThanOrEqual(36);
    for (const m of all) {
      expect(m.cr, m.name).toBe(m.bucket);
      expect(m.xp, m.name).toBe(XP_BY_CR[m.cr]);
      expect(typeof m.hp, m.name).toBe('number');
      expect(typeof m.ac, m.name).toBe('number');
      expect(typeof m.type, m.name).toBe('string');
    }
    for (const name of ['Zombie Shambler', 'Zombie Runner', 'Street Thug', 'Alien Drone', 'Security Drone']) {
      expect(all.some(m => m.name === name), name).toBe(true);
    }
  });
});

function checkSheet(sheet, campaign, label) {
  expect(sheet.id, label).toMatch(UUID);
  expect(sheet.status, label).toBe('alive');
  expect(classes.some(c => c.name === sheet.class), `${label}: class ${sheet.class}`).toBe(true);
  expect(origins.some(o => o.name === sheet.race), `${label}: origin ${sheet.race}`).toBe(true);
  const allowed = campaign.characterOptions?.races;
  if (Array.isArray(allowed) && allowed.length > 0 && !sheet.dmNotes) {
    expect(allowed, `${label}: origin ${sheet.race} not allowed in ${campaign.id}`).toContain(sheet.race);
  }
  for (const [stat, v] of Object.entries(sheet.abilities)) {
    expect(v.modifier, `${label}: ${stat}`).toBe(Math.floor((v.score - 10) / 2));
  }
  expect(sheet.experience, `${label}: XP for level ${sheet.level}`).toBe(XP_BY_LEVEL[sheet.level]);
  expect(sheet.proficiencyBonus, `${label}: proficiency`).toBe(Math.floor((sheet.level - 1) / 4) + 2);
  expect(sheet.hitPoints.current, label).toBe(sheet.hitPoints.max);
  expect(sheet.hitPoints.max, label).toBeGreaterThan(0);
  for (const s of sheet.skills) expect(skillNames.has(s), `${label}: skill ${s}`).toBe(true);
  expect(sheet.spells, `${label}: spells`).toEqual(EMPTY_SPELLS);
  expect(Array.isArray(sheet.weapons), label).toBe(true);
  for (const w of sheet.weapons) {
    expect(typeof w.attackBonus, `${label}: ${w.name}`).toBe('number');
    expect(w.damage, `${label}: ${w.name}`).toMatch(/^\d+d\d+/);
  }
}

describe('each Sci-Fi campaign', () => {
  for (const campaign of scifiCampaigns) {
    describe(campaign.id, () => {
      const scenarioDir = path.join(DATA, 'campaigns', campaign.id, 'scenarios');
      const scenarioIds = listJson(scenarioDir).map(f => readJson(path.join(scenarioDir, f)).id);

      it('declares era, currency and its presentation', () => {
        expect(['1980s', 'modern', 'future']).toContain(campaign.era);
        expect(typeof campaign.currency?.name).toBe('string');
        expect(typeof campaign.listing?.order).toBe('number');
        expect(Array.isArray(campaign.campaignRules) && campaign.campaignRules.length > 0).toBe(true);
      });

      it('links four scenarios that exist, and every map pin resolves', () => {
        expect(campaign.linkedScenarios).toHaveLength(4);
        for (const id of campaign.linkedScenarios) expect(scenarioIds, id).toContain(id);
        for (const pin of campaign.mapLocations) {
          if (pin.scenarioId) expect(scenarioIds, pin.name).toContain(pin.scenarioId);
          expect(pin.x).toBeGreaterThanOrEqual(0);
          expect(pin.x).toBeLessThanOrEqual(100);
          expect(pin.y).toBeGreaterThanOrEqual(0);
          expect(pin.y).toBeLessThanOrEqual(100);
        }
      });

      it('ships six characters and four companions whose numbers add up', () => {
        const charDir = path.join(DATA, 'defaults', campaign.id, 'characters');
        const npcDir = path.join(DATA, 'defaults', campaign.id, 'npcs');
        const chars = listJson(charDir);
        const npcs = listJson(npcDir);
        expect(chars).toHaveLength(6);
        expect(npcs).toHaveLength(4);
        const ids = new Set();
        for (const f of chars) {
          const sheet = readJson(path.join(charDir, f));
          checkSheet(sheet, campaign, `${campaign.id}/${f}`);
          ids.add(sheet.id);
        }
        for (const f of npcs) {
          const sheet = readJson(path.join(npcDir, f));
          checkSheet(sheet, campaign, `${campaign.id}/npcs/${f}`);
          expect(sheet.dmNotes, f).toBeTruthy();
          ids.add(sheet.id);
        }
        expect(ids.size).toBe(10);
      });

      it('rolls a random character from its own ruleset, with counted ammo for every firearm', () => {
        for (const cls of classes.map(x => x.name)) {
          const c = generateRandomCharacter(DATA, { campaignId: campaign.id, class: cls });
          checkSheet(c, campaign, `${campaign.id}/generated ${cls}`);
          const guns = c.weapons.filter(w => /pistol|rifle|revolver|stun gun/i.test(w.name));
          for (const g of guns) expect(c.equipment.some(e => /\(\d+\)$/.test(e)), `${campaign.id} ${cls} ${g.name}`).toBe(true);
          if (campaign.era === 'future' && cls === 'Soldier') expect(c.weapons.map(w => w.name)).toContain('Laser rifle');
          if (campaign.era !== 'future') expect(c.weapons.some(w => /laser/i.test(w.name))).toBe(false);
        }
      });
    });
  }
});
