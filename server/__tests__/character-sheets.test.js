import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import express from 'express';

const { ensurePlayerDataExists, getPlayerCharactersDir, getPlayerNpcsDir, snapshotToSession, getSessionCharactersDir, getSessionNpcsDir } = require('../player-data');
const { requirePlayer } = require('../player-auth');

let tmpDir;
let server;
let baseUrl;

const HOST = { email: 'host@test.com', name: 'Host Player', role: 'player' };
const COMPANION = { email: 'alice@test.com', name: 'Alice', role: 'player' };

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function setupPlayers(dataDir) {
  writeJson(path.join(dataDir, 'players.json'), {
    [HOST.email]: HOST,
    [COMPANION.email]: COMPANION,
  });
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
    subrace: 'Forest',
    class: 'Rogue',
    level: 2,
    background: 'Urchin',
    alignment: 'Chaotic Good',
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
    equipment: ['Thieves Tools', 'Dagger'],
    weapons: ['Shortsword', 'Dagger'],
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

function req(method, urlPath, { headers } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, baseUrl);
    const options = {
      method: method.toUpperCase(),
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      headers: { 'Content-Type': 'application/json', ...headers },
    };
    const r = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch { parsed = data; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    r.on('error', reject);
    r.end();
  });
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudedm-chars-test-'));
  setupPlayers(tmpDir);

  // Set up character and NPC files for HOST
  ensurePlayerDataExists(tmpDir, HOST.email, 'demo');
  writeJson(path.join(getPlayerCharactersDir(tmpDir, HOST.email, 'demo'), 'bramble.json'), makeCharacter());
  writeJson(path.join(getPlayerCharactersDir(tmpDir, HOST.email, 'demo'), 'grimjaw.json'), makeCharacter({
    id: 'char-2', name: 'Grimjaw Bonecrusher', race: 'Half-Orc', class: 'Fighter', level: 4,
    hitPoints: { current: 40, max: 40 }, armorClass: 16,
  }));
  writeJson(path.join(getPlayerNpcsDir(tmpDir, HOST.email, 'demo'), 'pip.json'), makeNpc());
  writeJson(path.join(getPlayerNpcsDir(tmpDir, HOST.email, 'demo'), 'drak.json'), makeNpc({
    id: 'npc-2', name: 'Drak Ironforge', race: 'Dwarf', class: 'Cleric', level: 3,
    hitPoints: { current: 28, max: 28 }, armorClass: 18,
  }));

  // Set up character files for COMPANION
  ensurePlayerDataExists(tmpDir, COMPANION.email, 'demo');
  writeJson(path.join(getPlayerCharactersDir(tmpDir, COMPANION.email, 'demo'), 'luna.json'), makeCharacter({
    id: 'char-3', name: 'Luna Starweaver', race: 'Elf', class: 'Wizard', level: 3,
    hitPoints: { current: 18, max: 18 }, armorClass: 12,
  }));

  // Set up defaults directory (needed for provisionPlayerDefaults)
  writeJson(path.join(tmpDir, 'defaults', 'demo', 'characters', 'bramble.json'), makeCharacter());
  writeJson(path.join(tmpDir, 'defaults', 'demo', 'npcs', 'pip.json'), makeNpc());
  writeJson(path.join(tmpDir, 'defaults', 'demo', 'npcs', 'drak.json'), makeNpc({
    id: 'npc-2', name: 'Drak Ironforge', race: 'Dwarf', class: 'Cleric', level: 3,
    hitPoints: { current: 28, max: 28 }, armorClass: 18,
  }));

  // Create Express app with character and NPC routes
  const charactersRouter = require('../routes/characters')(tmpDir);
  const npcsRouter = require('../routes/npcs')(tmpDir);
  const app = express();
  app.use(express.json());
  app.use((r, res, next) => { r.campaignId = r.get('x-campaign-id') || 'demo'; next(); });
  app.use('/api/characters', charactersRouter);
  app.use('/api/npcs', npcsRouter);

  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Character API — host views their characters', () => {
  it('GET /api/characters returns all characters for the host', async () => {
    const res = await req('GET', '/api/characters', {
      headers: { 'x-player-email': HOST.email, 'x-campaign-id': 'demo' },
    });

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    const names = res.body.map(c => c.name).sort();
    expect(names).toEqual(['Bramble Thornwick', 'Grimjaw Bonecrusher']);
  });

  it('GET /api/characters/:id returns a single character', async () => {
    const list = await req('GET', '/api/characters', {
      headers: { 'x-player-email': HOST.email, 'x-campaign-id': 'demo' },
    });
    const bramble = list.body.find(c => c.name === 'Bramble Thornwick');

    const res = await req('GET', `/api/characters/${bramble.id}`, {
      headers: { 'x-player-email': HOST.email, 'x-campaign-id': 'demo' },
    });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Bramble Thornwick');
    expect(res.body.hitPoints.current).toBe(25);
    expect(res.body.level).toBe(3);
  });

  it('reflects file updates when character is modified (simulating DM edit)', async () => {
    // Simulate the DM editing the character file (as happens during gameplay)
    const charPath = path.join(getPlayerCharactersDir(tmpDir, HOST.email, 'demo'), 'bramble.json');
    const char = JSON.parse(fs.readFileSync(charPath, 'utf-8'));
    char.hitPoints.current = 12;
    char.level = 4;
    char.equipment.push('Healing Potion');
    fs.writeFileSync(charPath, JSON.stringify(char, null, 2));

    // API should reflect the updated values
    const res = await req('GET', `/api/characters/${char.id}`, {
      headers: { 'x-player-email': HOST.email, 'x-campaign-id': 'demo' },
    });

    expect(res.status).toBe(200);
    expect(res.body.hitPoints.current).toBe(12);
    expect(res.body.level).toBe(4);
    expect(res.body.equipment).toContain('Healing Potion');
  });
});

describe('Companion/NPC API — host views companions', () => {
  it('GET /api/npcs returns all NPCs without dmNotes', async () => {
    const res = await req('GET', '/api/npcs', {
      headers: { 'x-player-email': HOST.email, 'x-campaign-id': 'demo' },
    });

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    const names = res.body.map(n => n.name).sort();
    expect(names).toEqual(['Drak Ironforge', 'Pip Whistledown']);
    // dmNotes should be stripped for player-facing view
    expect(res.body[0].dmNotes).toBeUndefined();
    expect(res.body[1].dmNotes).toBeUndefined();
  });

  it('GET /api/npcs/:id returns single NPC without dmNotes', async () => {
    const res = await req('GET', '/api/npcs/npc-1', {
      headers: { 'x-player-email': HOST.email, 'x-campaign-id': 'demo' },
    });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Pip Whistledown');
    expect(res.body.hitPoints.current).toBe(15);
    expect(res.body.dmNotes).toBeUndefined();
  });

  it('reflects file updates when NPC is modified (simulating DM edit)', async () => {
    // Simulate DM editing NPC during gameplay
    const npcPath = path.join(getPlayerNpcsDir(tmpDir, HOST.email, 'demo'), 'pip.json');
    const npc = JSON.parse(fs.readFileSync(npcPath, 'utf-8'));
    npc.hitPoints.current = 3;
    npc.equipment.push('Stolen Ruby');
    fs.writeFileSync(npcPath, JSON.stringify(npc, null, 2));

    const res = await req('GET', '/api/npcs/npc-1', {
      headers: { 'x-player-email': HOST.email, 'x-campaign-id': 'demo' },
    });

    expect(res.status).toBe(200);
    expect(res.body.hitPoints.current).toBe(3);
    expect(res.body.equipment).toContain('Stolen Ruby');
  });
});

describe('Companion player views their own characters', () => {
  it('companion sees their own character pool (including provisioned defaults)', async () => {
    const res = await req('GET', '/api/characters', {
      headers: { 'x-player-email': COMPANION.email, 'x-campaign-id': 'demo' },
    });

    expect(res.status).toBe(200);
    // Companion gets their own Luna plus any defaults provisioned from data/defaults/
    const names = res.body.map(c => c.name);
    expect(names).toContain('Luna Starweaver');
  });

  it('companion sees updated character after DM modifies it', async () => {
    const charPath = path.join(getPlayerCharactersDir(tmpDir, COMPANION.email, 'demo'), 'luna.json');
    const char = JSON.parse(fs.readFileSync(charPath, 'utf-8'));
    char.hitPoints.current = 8;
    char.level = 4;
    char.equipment.push('Wand of Magic Missiles');
    fs.writeFileSync(charPath, JSON.stringify(char, null, 2));

    const res = await req('GET', `/api/characters/${char.id}`, {
      headers: { 'x-player-email': COMPANION.email, 'x-campaign-id': 'demo' },
    });

    expect(res.status).toBe(200);
    expect(res.body.hitPoints.current).toBe(8);
    expect(res.body.level).toBe(4);
    expect(res.body.equipment).toContain('Wand of Magic Missiles');
  });

  it('companion sees host NPCs (their campaign companions)', async () => {
    // Companion needs NPCs provisioned in their own directory
    // (provisionPlayerDefaults copies from defaults)
    const res = await req('GET', '/api/npcs', {
      headers: { 'x-player-email': COMPANION.email, 'x-campaign-id': 'demo' },
    });

    expect(res.status).toBe(200);
    // Should have NPCs from defaults (provisioned on first access)
    expect(res.body.length).toBeGreaterThan(0);
  });
});

describe('Session-scoped character isolation', () => {
  it('session snapshot has independent character state', async () => {
    const sessionId = 'test-session-1';
    snapshotToSession(tmpDir, HOST.email, 'demo', sessionId);

    // Modify session-scoped character
    const sessCharPath = path.join(getSessionCharactersDir(tmpDir, HOST.email, 'demo', sessionId), 'bramble.json');
    const sessChar = JSON.parse(fs.readFileSync(sessCharPath, 'utf-8'));
    sessChar.hitPoints.current = 5;
    sessChar.level = 6;
    sessChar.equipment.push('Legendary Sword');
    fs.writeFileSync(sessCharPath, JSON.stringify(sessChar, null, 2));

    // Global character via API should be unchanged
    const res = await req('GET', '/api/characters/char-1', {
      headers: { 'x-player-email': HOST.email, 'x-campaign-id': 'demo' },
    });
    expect(res.status).toBe(200);
    expect(res.body.hitPoints.current).toBe(25); // original
    expect(res.body.level).toBe(3); // original
    expect(res.body.equipment).not.toContain('Legendary Sword');

    // Session-scoped file has the modifications
    const sessData = JSON.parse(fs.readFileSync(sessCharPath, 'utf-8'));
    expect(sessData.hitPoints.current).toBe(5);
    expect(sessData.level).toBe(6);
    expect(sessData.equipment).toContain('Legendary Sword');
  });

  it('session snapshot has independent NPC state', async () => {
    const sessionId = 'test-session-2';
    snapshotToSession(tmpDir, HOST.email, 'demo', sessionId);

    // Modify session-scoped NPC
    const sessNpcPath = path.join(getSessionNpcsDir(tmpDir, HOST.email, 'demo', sessionId), 'pip.json');
    const sessNpc = JSON.parse(fs.readFileSync(sessNpcPath, 'utf-8'));
    sessNpc.hitPoints.current = 0;
    sessNpc.status = 'dead';
    fs.writeFileSync(sessNpcPath, JSON.stringify(sessNpc, null, 2));

    // Global NPC via API should be unchanged
    const res = await req('GET', '/api/npcs/npc-1', {
      headers: { 'x-player-email': HOST.email, 'x-campaign-id': 'demo' },
    });
    expect(res.status).toBe(200);
    expect(res.body.hitPoints.current).toBe(15);
    expect(res.body.status).toBe('alive');
  });
});

describe('Player data isolation', () => {
  it('host cannot see companion characters', async () => {
    const res = await req('GET', '/api/characters', {
      headers: { 'x-player-email': HOST.email, 'x-campaign-id': 'demo' },
    });

    const names = res.body.map(c => c.name);
    expect(names).not.toContain('Luna Starweaver');
  });

  it('companion has independent character copies (not shared with host)', async () => {
    // Modify the host's Bramble
    const hostCharPath = path.join(getPlayerCharactersDir(tmpDir, HOST.email, 'demo'), 'bramble.json');
    const hostChar = JSON.parse(fs.readFileSync(hostCharPath, 'utf-8'));
    hostChar.hitPoints.current = 1;
    hostChar.level = 10;
    fs.writeFileSync(hostCharPath, JSON.stringify(hostChar, null, 2));

    // Companion's copy (provisioned from defaults) should NOT reflect host's changes
    const res = await req('GET', '/api/characters', {
      headers: { 'x-player-email': COMPANION.email, 'x-campaign-id': 'demo' },
    });
    const companionBramble = res.body.find(c => c.name === 'Bramble Thornwick');
    if (companionBramble) {
      // If companion has a Bramble (from defaults), it should be the original stats
      expect(companionBramble.hitPoints.current).toBe(25);
      expect(companionBramble.level).toBe(3);
    }

    // Host's Grimjaw should NOT appear in companion's pool (not in defaults)
    const names = res.body.map(c => c.name);
    expect(names).not.toContain('Grimjaw Bonecrusher');
  });

  it('guest cannot access characters', async () => {
    const res = await req('GET', '/api/characters', {
      headers: { 'x-player-email': 'guest', 'x-campaign-id': 'demo' },
    });
    expect(res.status).toBe(401);
  });
});
