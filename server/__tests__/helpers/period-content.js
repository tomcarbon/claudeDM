/**
 * Content checks shared by the period categories — Noir (WO-0042), Western (WO-0043) and
 * Horror (WO-0045).
 *
 * Each of those categories is a spec that pinned names first (classes, skills, origins, weapons
 * with counted-ammo names, armor) and then three campaigns written against it in parallel. This
 * module holds the shipped data/ to its spec, READ-ONLY — nothing here writes, and the generator
 * calls return sheets without saving them.
 *
 * It is stricter than scifi-content.test.js on purpose. The Sci-Fi round's sheets were written
 * before its classes existed, and its errors were weapons a class was not trained in and ammo
 * that did not match. The Noir round's error was a different one this file now also catches: two
 * authors working in parallel gave two campaigns the same pregenerated character.
 *
 * Called with vitest's describe/it/expect so this CommonJS helper does not import vitest itself.
 */
const fs = require('fs');
const path = require('path');
const { generateRandomCharacter } = require('../../character-generator');
const { categoryIdOf } = require('../../game-categories');
const { _testing: { buildStableSystemPrompt } } = require('../../dm-engine');

const DATA = path.join(__dirname, '..', '..', '..', 'data');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf-8'));
const listJson = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')) : []);

const XP_BY_LEVEL = Object.fromEntries(readJson(path.join(DATA, 'rules', 'leveling.json')).xp_thresholds.map(e => [e.level, e.xp_required]));
const XP_BY_CR = { '0': 10, '1/8': 25, '1/4': 50, '1/2': 100, '1': 200, '2': 450, '3': 700, '4': 1100, '5': 1800, '6': 2300, '7': 2900, '8': 3900 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMPTY_SPELLS = { spellcastingAbility: '', spellSaveDC: 0, spellAttackBonus: 0, cantrips: [], level1: { slots: 0, known: [] } };
const PROMPT_BUDGET = 13600; // the Sci-Fi budget (game-categories.test.js)

const mod = (score) => Math.floor((score - 10) / 2);
const withMod = (dice, m) => (m === 0 ? dice : `${dice}${m > 0 ? '+' : ''}${m}`);
const isFirearm = (w) => ['Sidearms', 'Longarms', 'Automatics'].includes(w.group);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function allCampaigns() {
  return fs.readdirSync(path.join(DATA, 'campaigns'))
    .map(id => path.join(DATA, 'campaigns', id, 'campaign.json'))
    .filter(f => fs.existsSync(f))
    .map(f => readJson(f));
}

/** Every pregen and companion name in data/defaults, by campaign id. */
function namesByCampaign() {
  const out = new Map();
  const root = path.join(DATA, 'defaults');
  for (const id of fs.readdirSync(root)) {
    const names = [];
    for (const sub of ['characters', 'npcs']) {
      for (const f of listJson(path.join(root, id, sub))) {
        const n = readJson(path.join(root, id, sub, f)).name;
        if (typeof n === 'string') names.push(n);
      }
    }
    out.set(id, names);
  }
  return out;
}

// "Philippa 'Pip' Ashdown" and "Pip Ashdown" are the same character to a player. A name's keys
// are first-name+surname and nickname+surname, with titles dropped; two names clash when they
// share a key. (Exact string comparison would have missed the Noir round's actual clash.)
const TITLES = new Set(['dr', 'det', 'sgt', 'lt', 'capt', 'mr', 'mrs', 'miss', 'ms', 'rev', 'sheriff', 'marshal', 'deputy', 'doc']);
function nameKeys(name) {
  const nicks = [...name.matchAll(/["'“‘]([^"'”’]+)["'”’]/g)].map(m => m[1].toLowerCase());
  const words = name.replace(/["'“‘][^"'”’]+["'”’]/g, ' ').toLowerCase().replace(/[.,]/g, '').split(/\s+/)
    .filter(w => w && !TITLES.has(w));
  if (words.length < 2) return words.length ? [words[0]] : [];
  const last = words[words.length - 1];
  return [words[0], ...nicks].map(f => `${f} ${last}`);
}

/**
 * spec: {
 *   id, label, rulesDir, campaignIds, skills, origins, classes, backgrounds, adversaries ({name: cr}),
 *   ruleFiles, eras, minWeapons, armorAc(dex) → {armor name: AC}, generatedArmor: [names],
 *   ruleChecks(it, expect, readRule) — the category's own chapter (investigation, frontier …)
 * }
 */
function describePeriodCategory({ describe, it, expect }, spec) {
  const RULES = path.join(DATA, spec.rulesDir);
  const has = (f) => fs.existsSync(path.join(RULES, `${f}.json`));
  const readRule = (f) => readJson(path.join(RULES, `${f}.json`));
  const classes = has('classes') ? readRule('classes').classes : [];
  const weapons = has('equipment') ? readRule('equipment').weapons : [];
  const weaponByName = new Map(weapons.map(w => [w.name, w]));
  const skillNames = new Set(has('abilities-and-skills') ? readRule('abilities-and-skills').skills.map(s => s.name) : []);
  const campaigns = allCampaigns().filter(c => categoryIdOf(c) === spec.id);

  function checkSheet(sheet, label, era) {
    expect(sheet.id, label).toMatch(UUID);
    expect(sheet.status, label).toBe('alive');
    expect(spec.classes, `${label}: class`).toContain(sheet.class);
    expect(spec.origins, `${label}: origin`).toContain(sheet.race);
    for (const [stat, v] of Object.entries(sheet.abilities)) expect(v.modifier, `${label}: ${stat}`).toBe(mod(v.score));
    expect(sheet.experience, `${label}: XP for level ${sheet.level}`).toBe(XP_BY_LEVEL[sheet.level]);
    const prof = Math.floor((sheet.level - 1) / 4) + 2;
    expect(sheet.proficiencyBonus, `${label}: proficiency`).toBe(prof);
    expect(sheet.hitPoints.current, label).toBe(sheet.hitPoints.max);
    expect(sheet.hitPoints.max, label).toBeGreaterThan(0);
    for (const s of sheet.skills) expect(skillNames.has(s), `${label}: skill ${s}`).toBe(true);
    expect(sheet.spells, `${label}: spells`).toEqual(EMPTY_SPELLS);
    expect(sheet.equipment.some(e => /^Wallet containing \$\d+$/.test(e)), `${label}: money`).toBe(true);

    const cls = classes.find(c => c.name === sheet.class);
    const str = sheet.abilities.strength.modifier;
    const dex = sheet.abilities.dexterity.modifier;
    for (const w of sheet.weapons) {
      const row = weaponByName.get(w.name);
      expect(row, `${label}: weapon ${w.name} not in the ${spec.label} table`).toBeTruthy();
      if (!row) continue;
      // WO-0048: a weapon newer than the campaign's era (the 1870s Army revolver in an 1860s camp).
      if (era && Array.isArray(row.eras) && row.eras.length) expect(row.eras, `${label}: ${w.name} is not a ${era} weapon`).toContain(era);
      if (!cls) continue;
      expect(cls.weapon_proficiencies.some(p => String(p).startsWith(row.group)), `${label}: ${sheet.class} untrained in ${row.group} (${w.name})`).toBe(true);
      if (row.group === 'Explosives') continue; // thrown; the spec leaves the modifier to the author
      const finesse = (row.properties || []).includes('finesse');
      const m = row.group === 'Melee' ? (finesse ? Math.max(str, dex) : str) : dex;
      expect(w.attackBonus, `${label}: ${w.name} attack`).toBe(m + prof);
      expect(w.damage, `${label}: ${w.name} damage`).toBe(withMod(row.damage, m));
      if (isFirearm(row)) {
        const ammo = new RegExp(`^${escapeRe(row.ammo_name)} \\(\\d+\\)$`);
        expect(sheet.equipment.some(e => ammo.test(e)), `${label}: no counted ${row.ammo_name} for ${w.name}`).toBe(true);
      }
    }

    const armor = sheet.armor?.name || 'None';
    const expected = spec.armorAc(dex)[armor];
    expect(expected, `${label}: armor ${armor} is not a ${spec.label} armor`).toBeDefined();
    expect(sheet.armorClass, `${label}: AC with ${armor}`).toBe(expected);
  }

  describe(`the ${spec.label} category on disk`, () => {
    it(`ships the ${spec.ruleFiles.length} ${spec.label} rules files`, () => {
      for (const f of spec.ruleFiles) expect(has(f), f).toBe(true);
    });

    it(`ships the ${spec.campaignIds.length} ${spec.label} campaigns`, () => {
      expect(campaigns.map(c => c.id).sort()).toEqual([...spec.campaignIds].sort());
    });
  });

  describe(`the ${spec.label} ruleset`, () => {
    it('has exactly the pinned skills, origins, classes and backgrounds', () => {
      expect([...skillNames].sort()).toEqual([...spec.skills].sort());
      expect(readRule('races').races.map(r => r.name).sort()).toEqual([...spec.origins].sort());
      expect(classes.map(c => c.name).sort()).toEqual([...spec.classes].sort());
      expect(readRule('backgrounds').backgrounds.map(b => b.name).sort()).toEqual([...spec.backgrounds].sort());
    });

    it('every file names its category and its SRD debt', () => {
      for (const f of spec.ruleFiles) {
        const meta = readRule(f)._meta;
        expect(meta?.category, f).toBe(spec.id);
        expect(meta?.source, f).toMatch(/SRD 5\.1/);
      }
    });

    it(`classes have no magic, use only ${spec.label} skills, and carry weapons from the table they are trained in`, () => {
      for (const c of classes) {
        expect(c.hit_die, c.name).toMatch(/^d(6|8|10|12)$/);
        expect(c.spellcasting, c.name).toBeUndefined();
        for (const s of c.skill_choices.from) expect(skillNames.has(s), `${c.name}: ${s}`).toBe(true);
        expect(c.default_weapons.length, c.name).toBeGreaterThan(0);
        for (const w of c.default_weapons) {
          const row = weaponByName.get(w.name);
          expect(row, `${c.name}: ${w.name}`).toBeTruthy();
          expect(w.damage, `${c.name}: ${w.name}`).toBe(row.damage);
          expect(c.weapon_proficiencies.some(p => String(p).startsWith(row.group)), `${c.name} untrained in ${row.group}`).toBe(true);
        }
      }
    });

    it(`backgrounds use only ${spec.label} skills and pay in dollars`, () => {
      for (const b of readRule('backgrounds').backgrounds) {
        for (const s of b.skill_proficiencies) expect(skillNames.has(s), `${b.name}: ${s}`).toBe(true);
        expect(b.equipment.some(e => /^Wallet containing \$\d+$/.test(e)), b.name).toBe(true);
      }
    });

    it('every weapon has a period, dice and a range; every firearm a magazine and a counted-ammo name', () => {
      expect(weapons.length).toBeGreaterThanOrEqual(spec.minWeapons);
      for (const w of weapons) {
        expect(w.eras.length > 0 && w.eras.every(e => spec.eras.includes(e)), w.name).toBe(true);
        expect(w.damage, w.name).toMatch(/^\d+d\d+$/);
        expect(w.range, w.name).toBeTruthy();
        if (isFirearm(w)) {
          expect(w.magazine, w.name).toBeGreaterThan(0);
          expect(typeof w.ammo_name, w.name).toBe('string');
        }
      }
    });

    it('adversaries use the monster schema with XP true to CR, and include the pinned roster', () => {
      const all = Object.entries(readRule('adversaries').monsters_by_cr)
        .flatMap(([cr, list]) => list.map(m => ({ ...m, bucket: cr })));
      expect(all.length).toBeGreaterThanOrEqual(28);
      for (const m of all) {
        expect(m.cr, m.name).toBe(m.bucket);
        expect(m.xp, m.name).toBe(XP_BY_CR[m.cr]);
        expect(typeof m.hp, m.name).toBe('number');
        expect(typeof m.ac, m.name).toBe('number');
      }
      for (const [name, cr] of Object.entries(spec.adversaries)) {
        expect(all.find(m => m.name === name)?.cr, name).toBe(cr);
      }
    });

    it('combat keeps the shared death saves, brawling, and no hacking', () => {
      const combat = readRule('combat');
      expect(combat.brawling).toBeTruthy();
      expect(combat.death_saving_throws).toBeTruthy();
      expect(combat.hacking).toBeUndefined();
    });

    spec.ruleChecks(it, expect, readRule);
  });

  describe(`each ${spec.label} campaign`, () => {
    for (const campaign of campaigns) {
      describe(campaign.id, () => {
        const scenarioDir = path.join(DATA, 'campaigns', campaign.id, 'scenarios');
        const scenarioIds = listJson(scenarioDir).map(f => readJson(path.join(scenarioDir, f)).id);

        it('declares a period, dollars and its presentation', () => {
          expect(spec.eras).toContain(campaign.era);
          expect(campaign.currency).toEqual({ name: 'dollars', symbol: '$', abbrev: 'USD' });
          expect(typeof campaign.listing?.order).toBe('number');
          expect(campaign.listing.badge).toBe('Premium');
          expect(campaign.listing.blurb).toMatch(/Levels \d+–\d+\.$/);
          expect(Array.isArray(campaign.campaignRules) && campaign.campaignRules.length >= 3).toBe(true);
        });

        it('links four scenarios that exist, and every map pin resolves', () => {
          expect(campaign.linkedScenarios).toHaveLength(4);
          for (const id of campaign.linkedScenarios) expect(scenarioIds, id).toContain(id);
          expect(campaign.mapLocations.length).toBeGreaterThanOrEqual(6);
          for (const pin of campaign.mapLocations) {
            if (pin.scenarioId) expect(scenarioIds, pin.name).toContain(pin.scenarioId);
            expect(pin.x >= 0 && pin.x <= 100 && pin.y >= 0 && pin.y <= 100, pin.name).toBe(true);
            expect(pin.color, pin.name).toMatch(/^#[0-9a-f]{6}$/i);
          }
        });

        it('ships six characters across five or more classes and four companions, all consistent', () => {
          const charDir = path.join(DATA, 'defaults', campaign.id, 'characters');
          const npcDir = path.join(DATA, 'defaults', campaign.id, 'npcs');
          const chars = listJson(charDir).map(f => [f, readJson(path.join(charDir, f))]);
          const npcs = listJson(npcDir).map(f => [f, readJson(path.join(npcDir, f))]);
          expect(chars).toHaveLength(6);
          expect(npcs).toHaveLength(4);
          expect(new Set(chars.map(([, c]) => c.class)).size).toBeGreaterThanOrEqual(5);
          const ids = new Set();
          for (const [f, sheet] of chars) { checkSheet(sheet, `${campaign.id}/${f}`, campaign.era); ids.add(sheet.id); }
          for (const [f, sheet] of npcs) {
            checkSheet(sheet, `${campaign.id}/npcs/${f}`, campaign.era);
            expect(sheet.dmNotes, f).toBeTruthy();
            ids.add(sheet.id);
          }
          expect(ids.size).toBe(10);
        });

        it('shares no character name with any other campaign', () => {
          const byCampaign = namesByCampaign();
          const own = byCampaign.get(campaign.id) || [];
          for (const [other, names] of byCampaign) {
            if (other === campaign.id) continue;
            const theirs = new Map(names.flatMap(n => nameKeys(n).map(k => [k, n])));
            for (const n of own) {
              for (const k of nameKeys(n)) {
                expect(theirs.get(k), `${campaign.id}: "${n}" is the same person as "${theirs.get(k)}" in ${other}`).toBeUndefined();
              }
            }
          }
        });

        it(`gets the ${spec.label} GM prompt within budget, campaign-rule names and all`, () => {
          // Measured on the shipped campaign: its campaign-rule names are part of the prompt.
          const p = buildStableSystemPrompt(DATA, null, campaign.id, undefined, undefined, false);
          expect(p).toContain(`${spec.label} ruleset`);
          expect(p.length).toBeLessThan(PROMPT_BUDGET);
        });

        it(`rolls a random character of every class from the ${spec.label} ruleset`, () => {
          for (const cls of spec.classes) {
            const c = generateRandomCharacter(DATA, { campaignId: campaign.id, class: cls });
            checkSheet(c, `${campaign.id}/generated ${cls}`, campaign.era);
            expect(spec.generatedArmor).toContain(c.armor.name);
          }
        });
      });
    }
  });
}

module.exports = { describePeriodCategory };
