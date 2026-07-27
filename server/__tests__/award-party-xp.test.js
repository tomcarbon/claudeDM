import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

const { awardPartyXp, resolvePartyRoster } = require('../xp-utils');
const {
  getSessionDir,
  getSessionFilePath,
  getSessionCharactersDir,
  getSessionNpcsDir,
} = require('../player-data');

let tmpDir;
const SESSION_ID = 'sess-party-xp-1';
const CAMPAIGN = 'demo';

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

function makeChar(id, overrides = {}) {
  return {
    id,
    name: id,
    status: 'alive',
    class: 'Fighter',
    level: 1,
    experience: 0,
    proficiencyBonus: 2,
    hitPoints: { max: 10, current: 10 },
    ...overrides,
  };
}

function readChar(dir, id) {
  return JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf-8'));
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'party-xp-'));
  // Minimal leveling rules (awardXp reads data/rules/leveling.json)
  writeJson(path.join(tmpDir, 'rules', 'leveling.json'), {
    xp_thresholds: [
      { level: 1, xp_required: 0, proficiency_bonus: 2 },
      { level: 2, xp_required: 300, proficiency_bonus: 2 },
      { level: 3, xp_required: 900, proficiency_bonus: 2 },
    ],
  });

  const charDir = getSessionCharactersDir(tmpDir, SESSION_ID);
  const npcDir = getSessionNpcsDir(tmpDir, SESSION_ID);

  // Two live PCs + one dead PC
  writeJson(path.join(charDir, 'pc-hero.json'), makeChar('pc-hero'));
  writeJson(path.join(charDir, 'pc-ally.json'), makeChar('pc-ally'));
  writeJson(path.join(charDir, 'pc-corpse.json'), makeChar('pc-corpse', { status: 'dead' }));

  // NPCs: one DM-controlled, one removed, one companion-controlled, one dead
  writeJson(path.join(npcDir, 'npc-dm.json'), makeChar('npc-dm', { class: 'Cleric' }));
  writeJson(path.join(npcDir, 'npc-removed.json'), makeChar('npc-removed'));
  writeJson(path.join(npcDir, 'npc-companion.json'), makeChar('npc-companion'));
  writeJson(path.join(npcDir, 'npc-dead.json'), makeChar('npc-dead', { status: 'dead' }));

  // Session file: host removed one slot, a human companion drives another
  writeJson(getSessionFilePath(tmpDir, SESSION_ID), {
    id: SESSION_ID,
    campaignId: CAMPAIGN,
    companionConfig: { states: { 'npc-removed': 'removed' } },
    companionPlayers: { 'npc-companion': { playerEmail: 'friend@example.com' } },
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const ctx = () => ({ campaignId: CAMPAIGN, sessionId: SESSION_ID });

describe('resolvePartyRoster', () => {
  it('includes live PCs + DM NPCs, excludes dead/removed/companion-controlled', () => {
    const ids = resolvePartyRoster(tmpDir, ctx()).map((m) => m.data.id).sort();
    expect(ids).toEqual(['npc-dm', 'pc-ally', 'pc-hero']);
  });
});

describe('awardPartyXp', () => {
  it('splits totalXp equally across the live party and reports remainder', () => {
    const result = awardPartyXp(tmpDir, { totalXp: 200 }, ctx());

    expect(result.partySize).toBe(3);
    expect(result.xpEach).toBe(66); // floor(200/3)
    expect(result.distributed).toBe(198);
    expect(result.remainder).toBe(2);

    const charDir = getSessionCharactersDir(tmpDir, SESSION_ID);
    const npcDir = getSessionNpcsDir(tmpDir, SESSION_ID);
    // Each eligible member got the SAME amount, written to the SESSION files
    expect(readChar(charDir, 'pc-hero').experience).toBe(66);
    expect(readChar(charDir, 'pc-ally').experience).toBe(66);
    expect(readChar(npcDir, 'npc-dm').experience).toBe(66);
    // Excluded members untouched
    expect(readChar(charDir, 'pc-corpse').experience).toBe(0);
    expect(readChar(npcDir, 'npc-removed').experience).toBe(0);
    expect(readChar(npcDir, 'npc-companion').experience).toBe(0);
  });

  it('xpEach gives every member the same flat amount and can trigger level-ups', () => {
    const result = awardPartyXp(tmpDir, { xpEach: 300 }, ctx());
    expect(result.partySize).toBe(3);
    expect(result.xpEach).toBe(300);
    expect(result.members.every((m) => m.newLevel === 2 && m.leveledUp)).toBe(true);
  });

  it('rejects when neither or both of totalXp/xpEach are provided', () => {
    expect(() => awardPartyXp(tmpDir, {}, ctx())).toThrow(/exactly one/i);
    expect(() => awardPartyXp(tmpDir, { totalXp: 100, xpEach: 50 }, ctx())).toThrow(/exactly one/i);
  });

  it('rejects a share that rounds down to zero', () => {
    expect(() => awardPartyXp(tmpDir, { totalXp: 2 }, ctx())).toThrow(/not positive/i);
  });

  // Regression: the production layout — every character also exists in the player
  // library and campaign defaults with the SAME id (snapshotToSession copies them).
  // The old resolver treated this as "Ambiguous character reference" and every
  // AwardPartyXP call failed in-band.
  it('awards to the SESSION copies when the same ids exist in library and defaults', () => {
    const libDir = path.join(tmpDir, 'players', 'tom-example-com', CAMPAIGN, 'characters');
    const defNpcDir = path.join(tmpDir, 'defaults', CAMPAIGN, 'npcs');
    writeJson(path.join(libDir, 'pc-hero.json'), makeChar('pc-hero'));
    writeJson(path.join(libDir, 'pc-ally.json'), makeChar('pc-ally'));
    writeJson(path.join(defNpcDir, 'npc-dm.json'), makeChar('npc-dm'));

    const result = awardPartyXp(tmpDir, { xpEach: 50 }, { ...ctx(), playerEmail: 'tom@example.com' });
    expect(result.partySize).toBe(3);

    // Session copies updated…
    expect(readChar(getSessionCharactersDir(tmpDir, SESSION_ID), 'pc-hero').experience).toBe(50);
    expect(readChar(getSessionNpcsDir(tmpDir, SESSION_ID), 'npc-dm').experience).toBe(50);
    // …library and defaults copies untouched
    expect(readChar(libDir, 'pc-hero').experience).toBe(0);
    expect(readChar(defNpcDir, 'npc-dm').experience).toBe(0);
  });

  it('does not double-award when a stale duplicate file shares an id in the session dir', () => {
    const charDir = getSessionCharactersDir(tmpDir, SESSION_ID);
    // Duplicate of pc-hero under a truncated slug (the daichi-mus case)
    writeJson(path.join(charDir, 'pc-her.json'), makeChar('pc-hero'));

    const result = awardPartyXp(tmpDir, { xpEach: 100 }, ctx());
    expect(result.partySize).toBe(3); // deduped by id — not 4
    const awarded = result.members.filter((m) => m.id === 'pc-hero');
    expect(awarded).toHaveLength(1);
  });
});
