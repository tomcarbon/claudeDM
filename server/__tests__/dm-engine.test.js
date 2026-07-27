import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

const { loadDmSettings, _testing: { loadCharacter, loadNpcs, buildSystemPrompt, buildStableSystemPrompt, loadScenario } } = require('../dm-engine');
const { ensurePlayerDataExists, getPlayerCharactersDir, getSessionCharactersDir, getSessionNpcsDir, snapshotToSession } = require('../player-data');

let tmpDir;
const EMAIL = 'hero@test.com';
const CAMPAIGN = 'demo';

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function makeCharacter(overrides = {}) {
  return {
    id: 'char-1',
    name: 'Bramble Thornwick',
    race: 'Halfling',
    subrace: 'Lightfoot',
    class: 'Druid',
    level: 3,
    background: 'Hermit',
    alignment: 'Neutral Good',
    hitPoints: { current: 25, max: 25 },
    armorClass: 13,
    speed: 25,
    proficiencyBonus: 2,
    abilities: {
      strength: { score: 10, modifier: 0 },
      dexterity: { score: 14, modifier: 2 },
      constitution: { score: 12, modifier: 1 },
      intelligence: { score: 11, modifier: 0 },
      wisdom: { score: 16, modifier: 3 },
      charisma: { score: 13, modifier: 1 },
    },
    equipment: ['Shield', 'Leather Armor'],
    weapons: ['Quarterstaff'],
    status: 'alive',
    ...overrides,
  };
}

function makeNpc(overrides = {}) {
  return {
    id: 'npc-1',
    name: 'Pip Whistledown',
    race: 'Gnome',
    class: 'Rogue',
    level: 2,
    hitPoints: { current: 15, max: 15 },
    armorClass: 14,
    speed: 25,
    proficiencyBonus: 2,
    abilities: {
      strength: { score: 8, modifier: -1 },
      dexterity: { score: 16, modifier: 3 },
      constitution: { score: 12, modifier: 1 },
      intelligence: { score: 14, modifier: 2 },
      wisdom: { score: 10, modifier: 0 },
      charisma: { score: 12, modifier: 1 },
    },
    dmNotes: {
      roleplaying: 'Cheerful trickster',
      voice: 'High-pitched and fast',
      motivation: 'Collect shiny things',
      secrets: 'Secretly a prince',
      attitude: 'Friendly',
    },
    status: 'alive',
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudedm-engine-test-'));
  ensurePlayerDataExists(tmpDir, EMAIL, CAMPAIGN);

  // Write DM settings
  writeJson(path.join(tmpDir, 'dm-settings.json'), {
    humor: 50, drama: 50, responseLength: 'standard', difficulty: 50,
    horror: 20, puzzleFocus: 50, playerAutonomy: 50,
    tone: 'balanced', narrationStyle: 'descriptive', playerAgency: 'collaborative',
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('loadCharacter', () => {
  it('loads a character by ID from player directory', () => {
    const char = makeCharacter();
    writeJson(path.join(getPlayerCharactersDir(tmpDir, EMAIL, CAMPAIGN), 'bramble.json'), char);

    const loaded = loadCharacter(tmpDir, 'char-1', EMAIL, CAMPAIGN);
    expect(loaded).not.toBeNull();
    expect(loaded.name).toBe('Bramble Thornwick');
    expect(loaded._filename).toBe('bramble.json');
  });

  it('loads from session directory when sessionDbId is provided', () => {
    const char = makeCharacter();
    writeJson(path.join(getPlayerCharactersDir(tmpDir, EMAIL, CAMPAIGN), 'bramble.json'), char);

    // Snapshot to session (new signature: dataDir, sessionId, ownerEmail, campaignId)
    snapshotToSession(tmpDir, 'sess-1', EMAIL, CAMPAIGN);
    const sessPath = path.join(getSessionCharactersDir(tmpDir, 'sess-1'), 'bramble.json');
    const sessChar = JSON.parse(fs.readFileSync(sessPath, 'utf-8'));
    sessChar.hitPoints.current = 5;
    sessChar.level = 5;
    fs.writeFileSync(sessPath, JSON.stringify(sessChar, null, 2));

    // Without sessionDbId — loads from player library (25 HP, level 3)
    const global = loadCharacter(tmpDir, 'char-1', EMAIL, CAMPAIGN);
    expect(global.hitPoints.current).toBe(25);
    expect(global.level).toBe(3);

    // With sessionDbId — loads from session dir (5 HP, level 5)
    const scoped = loadCharacter(tmpDir, 'char-1', EMAIL, CAMPAIGN, 'sess-1');
    expect(scoped.hitPoints.current).toBe(5);
    expect(scoped.level).toBe(5);
  });

  it('returns null for non-existent character ID', () => {
    writeJson(path.join(getPlayerCharactersDir(tmpDir, EMAIL, CAMPAIGN), 'bramble.json'), makeCharacter());
    expect(loadCharacter(tmpDir, 'nonexistent', EMAIL, CAMPAIGN)).toBeNull();
  });

  it('returns null for non-existent directory', () => {
    expect(loadCharacter(tmpDir, 'char-1', 'nobody@test.com', 'missing')).toBeNull();
  });
});

describe('loadNpcs', () => {
  it('loads all NPCs from campaign defaults', () => {
    const defaultNpcDir = path.join(tmpDir, 'defaults', CAMPAIGN, 'npcs');
    writeJson(path.join(defaultNpcDir, 'pip.json'), makeNpc());
    writeJson(path.join(defaultNpcDir, 'drak.json'), makeNpc({ id: 'npc-2', name: 'Drak Ironforge', class: 'Fighter' }));

    const npcs = loadNpcs(tmpDir, EMAIL, CAMPAIGN);
    expect(npcs).toHaveLength(2);
    expect(npcs.map(n => n.name).sort()).toEqual(['Drak Ironforge', 'Pip Whistledown']);
  });

  it('loads from session directory when sessionDbId is provided', () => {
    // Set up defaults
    const defaultNpcDir = path.join(tmpDir, 'defaults', CAMPAIGN, 'npcs');
    writeJson(path.join(defaultNpcDir, 'pip.json'), makeNpc());

    // Snapshot to session
    snapshotToSession(tmpDir, 'sess-1', EMAIL, CAMPAIGN);

    // Modify session copy
    const sessNpcPath = path.join(getSessionNpcsDir(tmpDir, 'sess-1'), 'pip.json');
    const sessNpc = JSON.parse(fs.readFileSync(sessNpcPath, 'utf-8'));
    sessNpc.hitPoints.current = 3;
    fs.writeFileSync(sessNpcPath, JSON.stringify(sessNpc, null, 2));

    // Without sessionDbId — loads from defaults (15 HP)
    const defaultNpcs = loadNpcs(tmpDir, EMAIL, CAMPAIGN);
    expect(defaultNpcs[0].hitPoints.current).toBe(15);

    // With sessionDbId — loads from session dir (3 HP)
    const sessNpcs = loadNpcs(tmpDir, EMAIL, CAMPAIGN, 'sess-1');
    expect(sessNpcs[0].hitPoints.current).toBe(3);
  });

  it('returns empty array for non-existent directory', () => {
    expect(loadNpcs(tmpDir, 'nobody@test.com', 'missing')).toEqual([]);
  });
});

describe('buildSystemPrompt', () => {
  beforeEach(() => {
    writeJson(path.join(getPlayerCharactersDir(tmpDir, EMAIL, CAMPAIGN), 'bramble.json'), makeCharacter());
    // NPCs now come from campaign defaults
    const defaultNpcDir = path.join(tmpDir, 'defaults', CAMPAIGN, 'npcs');
    writeJson(path.join(defaultNpcDir, 'pip.json'), makeNpc());
  });

  it('includes character name and stats', () => {
    const prompt = buildSystemPrompt(tmpDir, 'char-1', null, EMAIL, CAMPAIGN);
    expect(prompt).toContain('Bramble Thornwick');
    expect(prompt).toContain('Level 3');
    expect(prompt).toContain('Druid');
    expect(prompt).toContain('HP: 25/25');
  });

  it('includes NPC companion details', () => {
    const prompt = buildSystemPrompt(tmpDir, 'char-1', null, EMAIL, CAMPAIGN);
    expect(prompt).toContain('Pip Whistledown');
    expect(prompt).toContain('Rogue');
    expect(prompt).toContain('Cheerful trickster');
    expect(prompt).toContain('Secretly a prince');
  });

  it('uses player library paths when no sessionDbId', () => {
    const prompt = buildSystemPrompt(tmpDir, 'char-1', null, EMAIL, CAMPAIGN);
    expect(prompt).toContain('data/players/hero-test-com/demo/characters/');
    expect(prompt).toContain('data/defaults/demo/npcs');
    // With no active session, the Server Context block shows a pending placeholder
    // ('data/sessions/<session-id>/'); game-state file paths stay in the player
    // library / defaults, so no CONCRETE session directory should ever appear.
    expect(prompt).toContain('(pending');
    expect(prompt).toContain('data/sessions/<session-id>/');
    expect(prompt).not.toMatch(/data\/sessions\/(?!<session-id>)/);
  });

  it('uses session paths when sessionDbId is provided', () => {
    snapshotToSession(tmpDir, 'sess-abc', EMAIL, CAMPAIGN);
    const prompt = buildSystemPrompt(tmpDir, 'char-1', null, EMAIL, CAMPAIGN, undefined, 'sess-abc');
    expect(prompt).toContain('data/sessions/sess-abc/characters/');
    expect(prompt).toContain('data/sessions/sess-abc/npcs/');
  });

  it('marks NPC as replaced when companion player has own character', () => {
    const companionPlayers = [{
      playerEmail: 'alice@test.com',
      playerName: 'Alice',
      companionNpcId: 'npc-1',
      companionCharacterName: 'Grimjaw Bonecrusher',
      companionCharacterId: 'comp-char-1',
    }];

    const prompt = buildSystemPrompt(tmpDir, 'char-1', null, EMAIL, CAMPAIGN, companionPlayers);
    expect(prompt).toContain('~~Pip Whistledown~~');
    expect(prompt).toContain('REPLACED by **Grimjaw Bonecrusher**');
    expect(prompt).toContain('controlled by companion player Alice');
    expect(prompt).toContain('Pip Whistledown is NOT in the party');
  });

  it('marks NPC as player-controlled when companion has no own character', () => {
    const companionPlayers = [{
      playerEmail: 'alice@test.com',
      playerName: 'Alice',
      companionNpcId: 'npc-1',
      companionCharacterName: null,
      companionCharacterId: null,
    }];

    const prompt = buildSystemPrompt(tmpDir, 'char-1', null, EMAIL, CAMPAIGN, companionPlayers);
    expect(prompt).toContain('CONTROLLED BY COMPANION PLAYER Alice');
    expect(prompt).toContain('controlled by a human companion player, not by you');
  });

  it('includes DM personality settings', () => {
    const prompt = buildSystemPrompt(tmpDir, 'char-1', null, EMAIL, CAMPAIGN);
    expect(prompt).toContain('Aim for roughly 500 words per response');
    expect(prompt).toContain('Difficulty preference: 50/100');
    expect(prompt).toContain('Player agency: collaborative');
  });

  it('includes rules reference paths', () => {
    const prompt = buildSystemPrompt(tmpDir, 'char-1', null, EMAIL, CAMPAIGN);
    expect(prompt).toContain('data/rules/combat.json');
    expect(prompt).toContain('data/rules/leveling.json');
    expect(prompt).toContain('data/rules/spells.json');
  });

  it('includes multiplayer companion actions documentation when companions are present', () => {
    const companionPlayers = [{
      playerEmail: 'alice@test.com', playerName: 'Alice', companionNpcId: 'npc-1',
      companionCharacterName: null, companionCharacterId: null,
    }];
    const prompt = buildSystemPrompt(tmpDir, 'char-1', null, EMAIL, CAMPAIGN, companionPlayers);
    expect(prompt).toContain('--- Companion Actions ---');
    expect(prompt).toContain('companion players');
  });

  it('includes the companion block when the host configured open slots (no one joined yet)', () => {
    const companionConfig = { states: { 'npc-1': 'player' }, reservations: {} };
    const prompt = buildSystemPrompt(tmpDir, 'char-1', null, EMAIL, CAMPAIGN, undefined, undefined, companionConfig);
    expect(prompt).toContain('--- Companion Actions ---');
  });

  it('omits the multiplayer companion block for solo sessions', () => {
    const prompt = buildSystemPrompt(tmpDir, 'char-1', null, EMAIL, CAMPAIGN);
    expect(prompt).not.toContain('--- Companion Actions ---');
    expect(prompt).not.toContain('## Multiplayer Companion Actions');
  });

  it('includes post-encounter checklist', () => {
    const prompt = buildSystemPrompt(tmpDir, 'char-1', null, EMAIL, CAMPAIGN);
    expect(prompt).toContain('Post-Encounter Checklist');
    expect(prompt).toContain('AwardXP');
  });

  it('instructs AwardPartyXP for normal awards with no contradictory AwardXP instruction', () => {
    const prompt = buildSystemPrompt(tmpDir, 'char-1', null, EMAIL, CAMPAIGN);
    // The old prompt said "for XP, use the AwardXP tool" in one section and
    // "use AwardPartyXP" in another — the discouraged single-target tool won half
    // the time. The restructured prompt must never instruct AwardXP for normal awards.
    expect(prompt).not.toMatch(/for XP,? use the AwardXP tool/i);
    expect(prompt).toContain('AwardPartyXP');
    expect(prompt).toMatch(/AwardXP.*ONLY for rare individual corrections/s);
  });

  it('stays within the prompt token budget (~2.5k tokens for the stable prompt)', () => {
    // Regression guard against prompt re-bloat: the solo stable prompt was ~18k chars
    // (~4.5k tokens) before the restructure; keep it under ~11k chars (~2.7k tokens).
    const prompt = buildStableSystemPrompt(tmpDir, EMAIL, CAMPAIGN, undefined, undefined, false);
    expect(prompt.length).toBeLessThan(11000);
  });

  it('handles missing character gracefully', () => {
    const prompt = buildSystemPrompt(tmpDir, 'nonexistent', null, EMAIL, CAMPAIGN);
    expect(prompt).toContain('Dungeon Master');
    expect(prompt).not.toContain('Bramble Thornwick');
  });

  it('handles no NPCs gracefully', () => {
    // Remove all default NPC files
    const defaultNpcDir = path.join(tmpDir, 'defaults', CAMPAIGN, 'npcs');
    for (const f of fs.readdirSync(defaultNpcDir)) fs.rmSync(path.join(defaultNpcDir, f));

    const prompt = buildSystemPrompt(tmpDir, 'char-1', null, EMAIL, CAMPAIGN);
    expect(prompt).toContain('Bramble Thornwick');
    expect(prompt).not.toContain('## NPC Companions');
  });

  describe('turn pacing rules scale with playerAgency (autonomy derived from it)', () => {
    function buildWithAgency(agency) {
      writeJson(path.join(tmpDir, 'dm-settings.json'), {
        humor: 50, drama: 50, responseLength: 'standard', difficulty: 50,
        horror: 20, puzzleFocus: 50,
        tone: 'balanced', narrationStyle: 'descriptive', playerAgency: agency,
      });
      return buildSystemPrompt(tmpDir, 'char-1', null, EMAIL, CAMPAIGN);
    }

    it('includes low-autonomy pacing rules for railroaded agency (autonomy 0)', () => {
      const prompt = buildWithAgency('railroaded');
      expect(prompt).toContain('Response Scope & Turn Pacing');
      expect(prompt).toContain('Maximum 2 location transitions');
    });

    it('includes medium-autonomy pacing rules for collaborative agency (autonomy 50)', () => {
      const prompt = buildWithAgency('collaborative');
      expect(prompt).toContain('Response Scope & Turn Pacing');
      expect(prompt).toContain('Maximum 1 location transition');
      expect(prompt).toContain('No narrative chaining');
    });

    it('includes high-autonomy pacing rules for sandbox agency (autonomy 100)', () => {
      const prompt = buildWithAgency('sandbox');
      expect(prompt).toContain('Response Scope & Turn Pacing');
      expect(prompt).toContain('ZERO unsolicited transitions');
      expect(prompt).toContain('LITERAL CONFIRMATIONS');
      expect(prompt).toContain('STOP EARLY');
    });

    it('derives autonomy from agency even when a stale numeric playerAutonomy disagrees', () => {
      // playerAgency=sandbox (→100) must win over a contradictory stored playerAutonomy=0
      writeJson(path.join(tmpDir, 'dm-settings.json'), {
        humor: 50, drama: 50, responseLength: 'standard', difficulty: 50,
        horror: 20, puzzleFocus: 50, playerAutonomy: 0,
        tone: 'balanced', narrationStyle: 'descriptive', playerAgency: 'sandbox',
      });
      const prompt = buildSystemPrompt(tmpDir, 'char-1', null, EMAIL, CAMPAIGN);
      expect(prompt).toContain('ZERO unsolicited transitions');
      expect(prompt).not.toContain('Maximum 2 location transitions');
    });

    it('places pacing rules before the server context block', () => {
      const prompt = buildWithAgency('collaborative');
      const pacingIndex = prompt.indexOf('Response Scope & Turn Pacing');
      const serverContextIndex = prompt.indexOf('Server Context');
      expect(pacingIndex).toBeGreaterThan(-1);
      expect(serverContextIndex).toBeGreaterThan(-1);
      expect(pacingIndex).toBeLessThan(serverContextIndex);
    });
  });

  it('migrates legacy verbosity setting to responseLength', () => {
    writeJson(path.join(tmpDir, 'dm-settings.json'), {
      humor: 50, drama: 50, verbosity: 80, difficulty: 50,
      horror: 20, puzzleFocus: 50, playerAutonomy: 50,
      tone: 'balanced', narrationStyle: 'descriptive', playerAgency: 'collaborative',
    });
    const prompt = buildSystemPrompt(tmpDir, 'char-1', null, EMAIL, CAMPAIGN);
    expect(prompt).toContain('Aim for roughly 750 words per response');
  });

  it('uses dmPersonality parameter when provided instead of loading from files', () => {
    const dmPersonality = {
      humor: 80, drama: 90, responseLength: 'epic', difficulty: 75,
      horror: 60, puzzleFocus: 30, playerAutonomy: 50,
      tone: 'noir', narrationStyle: 'atmospheric', playerAgency: 'collaborative',
    };
    const prompt = buildSystemPrompt(tmpDir, 'char-1', null, EMAIL, CAMPAIGN, undefined, undefined, undefined, dmPersonality);
    expect(prompt).toContain('Aim for roughly 1000 words per response');
    expect(prompt).toContain('Difficulty preference: 75/100');
  });
});

describe('loadScenario', () => {
  it('loads scenario from campaign scenarios directory', () => {
    const scenarioDir = path.join(tmpDir, 'campaigns', CAMPAIGN, 'scenarios');
    writeJson(path.join(scenarioDir, 'test-quest.json'), {
      id: 'quest-1',
      title: 'The Lost Mine',
      synopsis: 'Find the lost mine of Phandelver',
      hook: 'A dwarf hires you',
    });

    const scenario = loadScenario(tmpDir, 'quest-1', CAMPAIGN);
    expect(scenario).not.toBeNull();
    expect(scenario.title).toBe('The Lost Mine');
    expect(scenario.synopsis).toContain('Phandelver');
  });

  it('returns null for non-existent scenario', () => {
    expect(loadScenario(tmpDir, 'nonexistent', CAMPAIGN)).toBeNull();
  });
});

describe('UpdateWorldState MCP tool', () => {
  it('persists worldState (incl. keyFacts) to data/sessions/<id>/session.json', async () => {
    const { DmEngine } = require('../dm-engine');
    const sessionId = 'ws-tool-test';
    const sessionFile = path.join(tmpDir, 'sessions', sessionId, 'session.json');
    writeJson(sessionFile, { id: sessionId, messages: [] });

    const engine = new DmEngine(tmpDir);
    const server = engine._getMcpToolServer(EMAIL, CAMPAIGN, sessionId);
    const toolEntry = server.instance._registeredTools['UpdateWorldState'];
    expect(toolEntry).toBeTruthy();

    const res = await toolEntry.handler({
      location: 'Saltmere town square',
      keyFacts: ['Kesh Bloodtide — half-orc, leads the Saltmere Reavers; 100 gp bounty'],
    }, {});

    expect(res.isError).toBeFalsy();
    const saved = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
    expect(saved.worldState.location).toBe('Saltmere town square');
    expect(saved.worldState.keyFacts).toEqual(['Kesh Bloodtide — half-orc, leads the Saltmere Reavers; 100 gp bounty']);
  });

  it('merges keyFacts into existing worldState without dropping other fields', async () => {
    const { DmEngine } = require('../dm-engine');
    const sessionId = 'ws-tool-merge';
    const sessionFile = path.join(tmpDir, 'sessions', sessionId, 'session.json');
    writeJson(sessionFile, {
      id: sessionId,
      messages: [],
      worldState: { location: 'Old Lighthouse', recentEvents: ['Beacon restored'] },
    });

    const engine = new DmEngine(tmpDir);
    const server = engine._getMcpToolServer(EMAIL, CAMPAIGN, sessionId);
    const toolEntry = server.instance._registeredTools['UpdateWorldState'];

    const res = await toolEntry.handler({ keyFacts: ['Warden Callis — keeper of the Old Lighthouse'] }, {});

    expect(res.isError).toBeFalsy();
    const saved = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
    expect(saved.worldState.location).toBe('Old Lighthouse');
    expect(saved.worldState.recentEvents).toEqual(['Beacon restored']);
    expect(saved.worldState.keyFacts).toEqual(['Warden Callis — keeper of the Old Lighthouse']);
  });
});
